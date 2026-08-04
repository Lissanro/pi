/**
 * Message edit XML format for the `/edit` command.
 *
 * Edit messages start with `<pi_edit>` and contain one or more blocks like
 * `<pi_edit id="N" role="assistant">...</pi_edit>` or
 * `<pi_edit id="N" role="user">...</pi_edit>`. Positive ids replace existing
 * messages counting from the latest message (0 = latest). Negative ids add new
 * messages, sorted by id in descending order.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	UserMessage,
} from "@earendil-works/pi-ai/compat";

export interface ParsedEditBlock {
	id: number;
	role: "user" | "assistant";
	content: (TextContent | ThinkingContent | ToolCall | ImageContent)[];
}

interface TagMatch {
	name: string;
	attributes: Record<string, string>;
	start: number;
	end: number;
	isClosing: boolean;
}

function escapeXmlAttr(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseTag(tagText: string): { name: string; attributes: Record<string, string>; isClosing: boolean } {
	const isClosing = tagText.startsWith("</");
	const inner = tagText.slice(isClosing ? 2 : 1, -1).trim();
	const nameMatch = inner.match(/^[\w:-]+/);
	const name = nameMatch?.[0] ?? "";
	const attrString = inner.slice(name.length).trim();
	const attributes: Record<string, string> = {};
	const attrRegex = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
	let match: RegExpExecArray | null = attrRegex.exec(attrString);
	while (match !== null) {
		const attrName = match[1];
		const attrValue = match[2] ?? match[3] ?? "";
		attributes[attrName] = attrValue;
		match = attrRegex.exec(attrString);
	}
	return { name, attributes, isClosing };
}

function findNextTag(text: string, pos: number): TagMatch | undefined {
	const start = text.indexOf("<", pos);
	if (start === -1) return undefined;

	let i = start + 1;
	let inQuote: string | undefined;
	while (i < text.length) {
		const ch = text[i];
		if (inQuote) {
			if (ch === inQuote) inQuote = undefined;
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === ">") {
			break;
		}
		i++;
	}
	if (i >= text.length) return undefined;

	const tagText = text.slice(start, i + 1);
	const parsed = parseTag(tagText);
	return { ...parsed, start, end: i + 1 };
}

function findBlockClose(text: string, startPos: number): { start: number; end: number } | undefined {
	let pos = startPos;
	while (pos < text.length) {
		const tag = findNextTag(text, pos);
		if (!tag) return undefined;
		if (tag.name === "pi_edit" && tag.isClosing) {
			let after = tag.end;
			while (after < text.length && /\s/.test(text[after])) after++;
			if (after >= text.length || text.slice(after, after + 8) === "<pi_edit") {
				return { start: tag.start, end: tag.end };
			}
		}
		pos = tag.end;
	}
	return undefined;
}

function findLastTagClose(text: string, tagName: string): { start: number; end: number } | undefined {
	let last: { start: number; end: number } | undefined;
	let pos = 0;
	while (pos < text.length) {
		const tag = findNextTag(text, pos);
		if (!tag) break;
		if (tag.name === tagName && tag.isClosing) {
			last = { start: tag.start, end: tag.end };
		}
		pos = tag.end;
	}
	return last;
}

/**
 * Returns true if the given text starts with a `<pi_edit>` tag (after optional
 * leading whitespace). Messages that contain `<pi_edit>` later in the text are
 * treated as normal messages, not edit commands.
 */
export function isMessageEdit(text: string): boolean {
	return /^<pi_edit[>\s/]/.test(text.trimStart());
}

/**
 * Parse all `<pi_edit>` blocks from the start of the text. Returns an empty
 * array if parsing fails or no valid blocks are found.
 */
export function parseMessageEdits(text: string): ParsedEditBlock[] {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("<pi_edit")) return [];

	const blocks: ParsedEditBlock[] = [];
	let pos = 0;

	while (pos < trimmed.length) {
		const openTag = findNextTag(trimmed, pos);
		if (!openTag || openTag.name !== "pi_edit" || openTag.isClosing) return [];

		const id = Number.parseInt(openTag.attributes.id ?? "", 10);
		const role = openTag.attributes.role;
		if (Number.isNaN(id) || (role !== "user" && role !== "assistant")) return [];

		const close = findBlockClose(trimmed, openTag.end);
		if (!close) return [];

		const content = trimmed.slice(openTag.end, close.start);
		const parsedContent = parseInnerContent(content, role);
		blocks.push({ id, role, content: parsedContent });

		pos = close.end;
		while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
	}

	return blocks;
}

function parseInnerContent(
	content: string,
	role: "user" | "assistant",
): (TextContent | ThinkingContent | ToolCall | ImageContent)[] {
	const blocks: (TextContent | ThinkingContent | ToolCall | ImageContent)[] = [];

	if (role === "assistant") {
		const leadingWhitespace = content.match(/^\s*/)?.[0] ?? "";
		const afterWhitespace = content.slice(leadingWhitespace.length);
		// The formatted tag may carry attributes (`signature="..."` and/or
		// `redacted="true"`), so match the opening tag with optional attributes
		// rather than the exact attribute-less tag.
		const reasoningOpenMatch = afterWhitespace.match(/^<pi_reasoning_content(\s[^>]*)?>/);
		if (reasoningOpenMatch) {
			const reasoningClose = findLastTagClose(content, "pi_reasoning_content");
			if (reasoningClose) {
				const openEnd = leadingWhitespace.length + reasoningOpenMatch[0].length;
				const thinking = content.slice(openEnd, reasoningClose.start);
				const reasoningOpen = findNextTag(content, leadingWhitespace.length);
				const reasoningAttrs = reasoningOpen?.attributes ?? {};
				const block: ThinkingContent = { type: "thinking", thinking };
				if (reasoningAttrs.signature) block.thinkingSignature = reasoningAttrs.signature;
				if (reasoningAttrs.redacted === "true") block.redacted = true;
				blocks.push(block);
				content = content.slice(reasoningClose.end);
			}
		}
	}

	const specialTagName = role === "assistant" ? "pi_tool_call" : "pi_image";
	const { specialBlocks, textEnd } = parseTrailingSpecialBlocks(content, specialTagName, role);

	const text = content.slice(0, textEnd);
	if (text.trim().length > 0) {
		blocks.push({ type: "text", text });
	}
	blocks.push(...specialBlocks);
	return blocks;
}

function parseTrailingSpecialBlocks(
	content: string,
	tagName: string,
	role: "user" | "assistant",
): { specialBlocks: (ToolCall | ImageContent)[]; textEnd: number } {
	const specialBlocks: (ToolCall | ImageContent)[] = [];
	let end = content.length;

	while (true) {
		while (end > 0 && /\s/.test(content[end - 1])) end--;
		const closeText = `</${tagName}>`;
		if (end < closeText.length || content.slice(end - closeText.length, end) !== closeText) break;
		const closeStart = end - closeText.length;
		const open = findPreviousOpeningTag(content, closeStart, tagName);
		if (!open) break;

		if (role === "assistant") {
			const argsText = content.slice(open.end, closeStart);
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(argsText) as Record<string, unknown>;
			} catch {
				args = {};
			}
			const toolCall: ToolCall = {
				type: "toolCall",
				id: open.attributes.id ?? "",
				name: open.attributes.name ?? "",
				arguments: args,
			};
			if (open.attributes.thoughtSignature) toolCall.thoughtSignature = open.attributes.thoughtSignature;
			specialBlocks.unshift(toolCall);
		} else {
			const data = content.slice(open.end, closeStart);
			const mimeType = open.attributes.mimeType || open.attributes.mime_type || "image/png";
			specialBlocks.unshift({ type: "image", data, mimeType });
		}

		end = open.start;
	}

	return { specialBlocks, textEnd: end };
}

function findPreviousOpeningTag(
	text: string,
	beforePos: number,
	tagName: string,
): { start: number; end: number; attributes: Record<string, string> } | undefined {
	let lastOpening: { start: number; end: number; attributes: Record<string, string> } | undefined;
	let pos = 0;
	while (pos < beforePos) {
		const tag = findNextTag(text, pos);
		if (!tag || tag.start >= beforePos) break;
		if (tag.name === tagName && !tag.isClosing) {
			lastOpening = { start: tag.start, end: tag.end, attributes: tag.attributes };
		}
		pos = tag.end;
	}
	return lastOpening;
}

/**
 * Format the inner content of a message as XML (without the `<pi_edit>` wrapper).
 * Returns `null` for roles that are not directly editable (e.g. toolResult).
 */
export function formatMessageContent(message: AgentMessage): string | null {
	switch (message.role) {
		case "user":
			return formatUserMessageContent(message as UserMessage);
		case "assistant":
			return formatAssistantMessageContent(message as AssistantMessage);
		default:
			return null;
	}
}

/**
 * Format an existing message as an edit XML block with the given id.
 * Returns `null` for roles that are not directly editable (e.g. toolResult).
 */
export function formatMessageForEdit(id: number, message: AgentMessage): string | null {
	const content = formatMessageContent(message);
	if (content === null) return null;
	const role = message.role === "user" ? "user" : "assistant";
	return `<pi_edit id="${id}" role="${role}">${content}</pi_edit>`;
}

function formatUserMessageContent(message: UserMessage): string {
	const content =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	let inner = "";
	for (const block of content) {
		if (block.type === "text") {
			inner += block.text;
		} else if (block.type === "image") {
			inner += `<pi_image mimeType="${escapeXmlAttr(block.mimeType)}">${block.data}</pi_image>`;
		}
	}
	return inner;
}

function formatAssistantMessageContent(message: AssistantMessage): string {
	let inner = "";
	for (const block of message.content) {
		if (block.type === "thinking") {
			let attrs = "";
			if (block.thinkingSignature) attrs += ` signature="${escapeXmlAttr(block.thinkingSignature)}"`;
			if (block.redacted) attrs += ` redacted="true"`;
			inner += `<pi_reasoning_content${attrs}>${block.thinking}</pi_reasoning_content>`;
		} else if (block.type === "text") {
			inner += block.text;
		} else if (block.type === "toolCall") {
			let attrs = ` id="${escapeXmlAttr(block.id)}" name="${escapeXmlAttr(block.name)}"`;
			if (block.thoughtSignature) attrs += ` thoughtSignature="${escapeXmlAttr(block.thoughtSignature)}"`;
			inner += `<pi_tool_call${attrs}>${JSON.stringify(block.arguments)}</pi_tool_call>`;
		}
	}
	return inner;
}

/**
 * Build a `Message` from a parsed edit block and optional base assistant fields.
 * For new assistant messages (negative ids) baseAssistant must be provided.
 */
export function editBlockToMessage(
	block: ParsedEditBlock,
	baseAssistant?: Pick<AssistantMessage, "api" | "provider" | "model" | "usage" | "timestamp">,
): Message {
	const timestamp = baseAssistant?.timestamp ?? Date.now();

	if (block.role === "user") {
		return {
			role: "user",
			content: block.content.filter((c): c is TextContent | ImageContent => c.type === "text" || c.type === "image"),
			timestamp,
		};
	}

	const assistantContent = block.content.filter(
		(c): c is TextContent | ThinkingContent | ToolCall =>
			c.type === "text" || c.type === "thinking" || c.type === "toolCall",
	);
	const hasToolCall = assistantContent.some((c) => c.type === "toolCall");
	const stopReason: AssistantMessage["stopReason"] = hasToolCall ? "toolUse" : "stop";

	if (baseAssistant) {
		return {
			role: "assistant",
			content: assistantContent,
			api: baseAssistant.api,
			provider: baseAssistant.provider,
			model: baseAssistant.model,
			usage: baseAssistant.usage,
			stopReason,
			timestamp: baseAssistant.timestamp,
		};
	}

	throw new Error("Cannot create assistant message without base assistant fields");
}
