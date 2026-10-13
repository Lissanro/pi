/**
 * Pure listing and search logic for /swipe list and /swipe search|isearch.
 * Extracts section texts from a swipe version's message and produces summary
 * or match-snippet lines; the TUI adds headers and separators and renders the
 * result into the chat.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, ToolCall } from "@earendil-works/pi-ai";

export type SwipeSection = "reasoning" | "content" | "tool";

const ALL_SECTIONS: SwipeSection[] = ["reasoning", "content", "tool"];

export function parseSwipeSection(token: string): SwipeSection {
	if (token === "reasoning" || token === "content" || token === "tool") {
		return token;
	}
	throw new Error(`Invalid swipe list section: ${token} (expected content, reasoning, or tool)`);
}

interface SwipeTexts {
	reasoning: string;
	content: string;
	tools: ToolCall[];
}

/** Concatenated section texts of a swipe version's message. */
function swipeTexts(message: AgentMessage): SwipeTexts {
	const texts: SwipeTexts = { reasoning: "", content: "", tools: [] };
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		texts.content = typeof content === "string" ? content : "";
		return texts;
	}
	const reasoningParts: string[] = [];
	const contentParts: string[] = [];
	for (const block of content as Array<{ type: string; thinking?: unknown; text?: unknown }>) {
		if (block.type === "thinking" && typeof block.thinking === "string") {
			reasoningParts.push(block.thinking);
		} else if (block.type === "text" && typeof block.text === "string") {
			contentParts.push(block.text);
		} else if (block.type === "toolCall") {
			texts.tools.push(block as unknown as ToolCall);
		}
	}
	texts.reasoning = reasoningParts.join("\n\n");
	texts.content = contentParts.join("\n\n");
	return texts;
}

/** First `chars` characters of a text, with an ellipsis when truncated. */
function head(text: string, chars: number): string {
	if (text.length <= chars) return text;
	return `${text.slice(0, chars)}…`;
}

/**
 * Summary lines of one swipe version (without the header): reasoning first
 * chars, content first chars, and one line per tool call
 * `name(args first chars)`. Tool call outputs are never included.
 */
export function summarizeSwipeMessage(
	message: AgentMessage,
	sections: SwipeSection[] | undefined,
	chars: number,
): string[] {
	const include = sections && sections.length > 0 ? sections : ALL_SECTIONS;
	const texts = swipeTexts(message);
	const lines: string[] = [];
	if (include.includes("reasoning") && texts.reasoning !== "") {
		lines.push(`reasoning: ${head(texts.reasoning, chars)}`);
	}
	if (include.includes("content") && texts.content !== "") {
		lines.push(`content: ${head(texts.content, chars)}`);
	}
	if (include.includes("tool")) {
		for (const toolCall of texts.tools) {
			lines.push(`${toolCall.name}(${head(JSON.stringify(toolCall.arguments), chars)})`);
		}
	}
	return lines;
}

export interface SwipeSearchSpec {
	/** Characters of context before each match (default: 0). */
	before: number;
	/** Characters of context after each match (default: the swipeSummaryChars setting). */
	after: number;
	caseSensitive: boolean;
}

/**
 * Parse the char spec of /swipe search: `+64` shows 64 chars after a match
 * and none before; `-64` shows 64 before and the default after; `-64,+64`
 * sets both. Returns undefined when the token is not a char spec.
 */
export function parseSwipeSearchChars(token: string, defaultAfter: number): SwipeSearchSpec | undefined {
	const match = /^([+-]\d+)(?:,([+-]\d+))?$/.exec(token);
	if (!match) return undefined;
	const spec: SwipeSearchSpec = { before: 0, after: defaultAfter, caseSensitive: true };
	const apply = (part: string): void => {
		const value = Number.parseInt(part.slice(1), 10);
		if (part.startsWith("+")) {
			spec.after = value;
		} else {
			spec.before = value;
		}
	};
	apply(match[1]);
	if (match[2]) {
		apply(match[2]);
	}
	return spec;
}

/** One labeled searchable text of a swipe version. */
function searchableParts(message: AgentMessage): Array<{ label: string; text: string }> {
	const texts = swipeTexts(message);
	const parts: Array<{ label: string; text: string }> = [];
	if (texts.reasoning !== "") {
		parts.push({ label: "reasoning", text: texts.reasoning });
	}
	if (texts.content !== "") {
		parts.push({ label: "content", text: texts.content });
	}
	for (const toolCall of texts.tools) {
		parts.push({ label: toolCall.name, text: `${toolCall.name}(${JSON.stringify(toolCall.arguments)})` });
	}
	return parts;
}

/**
 * Match-snippet lines of one swipe version for /swipe search: for every
 * match across reasoning, content, and tool call name+arguments JSON (not
 * tool outputs), one line `<label>: …<before><match><after>…`. Empty when
 * nothing matches.
 */
export function searchSwipeMessage(message: AgentMessage, query: string, spec: SwipeSearchSpec): string[] {
	if (query === "") return [];
	const lines: string[] = [];
	for (const part of searchableParts(message)) {
		const haystack = spec.caseSensitive ? part.text : part.text.toLowerCase();
		const needle = spec.caseSensitive ? query : query.toLowerCase();
		let from = 0;
		for (;;) {
			const index = haystack.indexOf(needle, from);
			if (index < 0) break;
			const start = Math.max(0, index - spec.before);
			const end = Math.min(part.text.length, index + query.length + spec.after);
			const snippet = `${start > 0 ? "…" : ""}${part.text.slice(start, end)}${end < part.text.length ? "…" : ""}`;
			lines.push(`${part.label}: ${snippet}`);
			from = index + needle.length;
		}
	}
	return lines;
}
