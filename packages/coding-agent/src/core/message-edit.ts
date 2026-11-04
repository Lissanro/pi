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
	JsonObject,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai/compat";

export interface ParsedEditBlock {
	id: number;
	role: "user" | "assistant";
	/** Explicit aborted state from the `<pi_edit>` tag; undefined when not present. */
	aborted?: "true" | "false";
	content: (TextContent | ThinkingContent | ToolCall | ImageContent)[];
	/** Tool results carried with their tool calls; undefined when the block has none. */
	toolResults?: ParsedToolResult[];
}

/**
 * A `<pi_swipe timestamp="..." role="...">` block: an in-place edit of one
 * existing swipe version. The timestamp identifies the version (its entry
 * timestamp); applying the block never creates a new version and never
 * changes the version's position.
 */
export interface ParsedSwipeBlock {
	timestamp: string;
	role: "user" | "assistant";
	/** Explicit aborted state from the `<pi_swipe>` tag; undefined when not present. */
	aborted?: "true" | "false";
	content: (TextContent | ThinkingContent | ToolCall | ImageContent)[];
	/** Tool results carried with their tool calls; undefined when the block has none. */
	toolResults?: ParsedToolResult[];
}

/**
 * A tool result carried by an edit block next to its tool call, so the call
 * and its result are offered and applied as one unit.
 */
export interface ParsedToolResult {
	/** The tool call id the result answers. */
	id: string;
	content: (TextContent | ImageContent)[];
	/** True when the result is an error result. */
	isError: boolean;
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

/** Normalize an `aborted` attribute value (true/false or 1/0) to a canonical boolean string. */
function parseAbortedAttr(value: string | undefined): "true" | "false" | undefined {
	if (value === "true" || value === "1") return "true";
	if (value === "false" || value === "0") return "false";
	return undefined;
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

function findBlockClose(text: string, startPos: number, tagName: string): { start: number; end: number } | undefined {
	let pos = startPos;
	while (pos < text.length) {
		const tag = findNextTag(text, pos);
		if (!tag) return undefined;
		if (tag.name === tagName && tag.isClosing) {
			let after = tag.end;
			while (after < text.length && /\s/.test(text[after])) after++;
			if (
				after >= text.length ||
				text.slice(after, after + 8) === "<pi_edit" ||
				text.slice(after, after + 9) === "<pi_swipe"
			) {
				return { start: tag.start, end: tag.end };
			}
		}
		pos = tag.end;
	}
	return undefined;
}

function findFirstOpeningTag(
	text: string,
	pos: number,
	tagName: string,
): { start: number; end: number; attributes: Record<string, string> } | undefined {
	let p = pos;
	while (p < text.length) {
		const tag = findNextTag(text, p);
		if (!tag) return undefined;
		if (tag.name === tagName && !tag.isClosing) {
			return { start: tag.start, end: tag.end, attributes: tag.attributes };
		}
		p = tag.end;
	}
	return undefined;
}

function findFirstClosingTag(text: string, pos: number, tagName: string): { start: number; end: number } | undefined {
	let p = pos;
	while (p < text.length) {
		const tag = findNextTag(text, p);
		if (!tag) return undefined;
		if (tag.name === tagName && tag.isClosing) return { start: tag.start, end: tag.end };
		p = tag.end;
	}
	return undefined;
}

/**
 * Find the last closing tag of `tagName` located at or after `fromPos` but
 * strictly before `beforePos`. Returns undefined if none exists.
 */
function findLastClosingTagBefore(
	text: string,
	fromPos: number,
	beforePos: number,
	tagName: string,
): { start: number; end: number } | undefined {
	let last: { start: number; end: number } | undefined;
	let p = fromPos;
	while (p < beforePos && p < text.length) {
		const tag = findNextTag(text, p);
		if (!tag || tag.start >= beforePos) break;
		if (tag.name === tagName && tag.isClosing) last = { start: tag.start, end: tag.end };
		p = tag.end;
	}
	return last;
}

/**
 * Returns true if the given text starts with a `<pi_edit>` or `<pi_swipe>`
 * tag (after optional leading whitespace). Messages that contain one later in
 * the text are treated as normal messages, not edit commands.
 */
export function isMessageEdit(text: string): boolean {
	return /^<pi_(edit|swipe)[>\s/]/.test(text.trimStart());
}

/**
 * Parse all `<pi_edit>` and `<pi_swipe>` blocks from the start of the text.
 * Returns empty blocks if parsing fails or no valid blocks are found; any
 * invalid block or trailing content invalidates the whole text.
 */
export function parseMessageEditsAndSwipes(text: string): { edits: ParsedEditBlock[]; swipes: ParsedSwipeBlock[] } {
	const empty: { edits: ParsedEditBlock[]; swipes: ParsedSwipeBlock[] } = { edits: [], swipes: [] };
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("<pi_edit") && !trimmed.startsWith("<pi_swipe")) return empty;

	const result = { edits: [] as ParsedEditBlock[], swipes: [] as ParsedSwipeBlock[] };
	let pos = 0;

	while (pos < trimmed.length) {
		const openTag = findNextTag(trimmed, pos);
		if (!openTag || openTag.isClosing || (openTag.name !== "pi_edit" && openTag.name !== "pi_swipe")) return empty;

		const role = openTag.attributes.role;
		if (role !== "user" && role !== "assistant") return empty;

		const close = findBlockClose(trimmed, openTag.end, openTag.name);
		if (!close) return empty;

		const content = trimmed.slice(openTag.end, close.start);
		const parsed = parseInnerContent(content, role);
		const aborted = parseAbortedAttr(openTag.attributes.aborted);
		if (openTag.name === "pi_edit") {
			const id = Number.parseInt(openTag.attributes.id ?? "", 10);
			if (Number.isNaN(id)) return empty;
			const block: ParsedEditBlock = { id, role, aborted, content: parsed.content };
			if (parsed.toolResults.length > 0) block.toolResults = parsed.toolResults;
			result.edits.push(block);
		} else {
			const timestamp = openTag.attributes.timestamp ?? "";
			if (timestamp === "") return empty;
			const block: ParsedSwipeBlock = { timestamp, role, aborted, content: parsed.content };
			if (parsed.toolResults.length > 0) block.toolResults = parsed.toolResults;
			result.swipes.push(block);
		}

		pos = close.end;
		while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
	}

	return result;
}

/**
 * Parse all `<pi_edit>` blocks from the start of the text. Returns an empty
 * array if parsing fails or no valid blocks are found.
 */
export function parseMessageEdits(text: string): ParsedEditBlock[] {
	return parseMessageEditsAndSwipes(text).edits;
}

function parseInnerContent(
	content: string,
	role: "user" | "assistant",
): { content: (TextContent | ThinkingContent | ToolCall | ImageContent)[]; toolResults: ParsedToolResult[] } {
	const blocks: (TextContent | ThinkingContent | ToolCall | ImageContent)[] = [];
	let rest = content;

	if (role === "assistant") {
		const leadingWhitespace = rest.match(/^\s*/)?.[0] ?? "";
		// The formatted tag may carry attributes (`signature="..."` and/or
		// `redacted="true"`), so match the opening tag with optional attributes
		// rather than the exact attribute-less tag.
		const reasoningOpenMatch = rest.slice(leadingWhitespace.length).match(/^<pi_reasoning_content(\s[^>]*)?>/);
		if (reasoningOpenMatch) {
			const openStart = leadingWhitespace.length;
			const openEnd = openStart + reasoningOpenMatch[0].length;
			// The first closing is found without treating any other tag as a
			// boundary: until it is found, `<pi_content>` / `<pi_tool_call>` tags
			// inside the reasoning text are stray content being discussed.
			const firstClose = findFirstClosingTag(rest, openEnd, "pi_reasoning_content");
			if (firstClose) {
				// With the reasoning block confirmed, later sections become valid
				// boundaries. The reasoning close is the furthest one that is still
				// before the main content / tool call sections, so stray reasoning
				// tags inside the reasoning text do not split it and stray tags in
				// the main content are excluded.
				const contentOpen = findFirstOpeningTag(rest, firstClose.end, "pi_content");
				const toolOpen = findFirstOpeningTag(rest, firstClose.end, "pi_tool_call");
				const boundary = Math.min(contentOpen?.start ?? rest.length, toolOpen?.start ?? rest.length);
				const reasoningClose =
					findLastClosingTagBefore(rest, openEnd, boundary, "pi_reasoning_content") ?? firstClose;
				const thinking = rest.slice(openEnd, reasoningClose.start);
				const reasoningOpen = findNextTag(rest, openStart);
				const reasoningAttrs = reasoningOpen?.attributes ?? {};
				const block: ThinkingContent = { type: "thinking", thinking };
				if (reasoningAttrs.signature) block.thinkingSignature = reasoningAttrs.signature;
				if (reasoningAttrs.redacted === "true") block.redacted = true;
				blocks.push(block);
				rest = rest.slice(reasoningClose.end);
			}
		}
	}

	// Main content section. Current format wraps it in `<pi_content>...</pi_content>`;
	// older messages used bare text followed by trailing special blocks, which is
	// still supported below as a fallback.
	const leadingWs = rest.match(/^\s*/)?.[0] ?? "";
	const contentOpenMatch = rest.slice(leadingWs.length).match(/^<pi_content(\s[^>]*)?>/);
	if (contentOpenMatch) {
		const openStart = leadingWs.length;
		const openEnd = openStart + contentOpenMatch[0].length;
		const firstClose = findFirstClosingTag(rest, openEnd, "pi_content");
		if (firstClose) {
			const specialOpen =
				role === "assistant"
					? findFirstSpecialTagOpen(rest, firstClose.end, ["pi_tool_call", "pi_tool_result"])
					: findFirstOpeningTag(rest, firstClose.end, "pi_image");
			const boundary = specialOpen?.start ?? rest.length;
			const contentClose = findLastClosingTagBefore(rest, openEnd, boundary, "pi_content") ?? firstClose;
			const text = rest.slice(openEnd, contentClose.start);
			if (text.trim().length > 0) blocks.push({ type: "text", text });
			if (role === "assistant") {
				const parsed = parseAssistantSpecialBlocks(rest.slice(contentClose.end));
				blocks.push(...parsed.toolCalls);
				return { content: blocks, toolResults: parsed.toolResults };
			}
			blocks.push(...parseSpecialBlocksForward(rest.slice(contentClose.end), "pi_image", role));
			return { content: blocks, toolResults: [] };
		}
		// No closing `<pi_content>`: treat everything as raw text.
		const text = rest.slice(openEnd);
		if (text.trim().length > 0) blocks.push({ type: "text", text });
		return { content: blocks, toolResults: [] };
	}

	// Legacy bare-text format: text runs up to the trailing special blocks.
	if (role === "assistant") {
		const { toolCalls, toolResults, textEnd } = parseTrailingAssistantSpecialBlocks(rest);
		const text = rest.slice(0, textEnd);
		if (text.trim().length > 0) blocks.push({ type: "text", text });
		blocks.push(...toolCalls);
		return { content: blocks, toolResults };
	}
	const { specialBlocks, textEnd } = parseTrailingSpecialBlocks(rest, "pi_image", role);
	const text = rest.slice(0, textEnd);
	if (text.trim().length > 0) blocks.push({ type: "text", text });
	blocks.push(...specialBlocks);
	return { content: blocks, toolResults: [] };
}

/** Find the first opening tag of one of the given tag names at or after `pos`. */
function findFirstSpecialTagOpen(text: string, pos: number, tagNames: string[]): TagMatch | undefined {
	let p = pos;
	while (p < text.length) {
		const tag = findNextTag(text, p);
		if (!tag) return undefined;
		if (!tag.isClosing && tagNames.includes(tag.name)) return tag;
		p = tag.end;
	}
	return undefined;
}

/**
 * Parse the assistant special-block region (everything after the
 * `<pi_content>` wrapper): `<pi_tool_call>` blocks, each optionally followed
 * by its `<pi_tool_result>`, in document order. Each block's closing tag is
 * the furthest closing still before the next block opening, so stray closing
 * tags inside a block body (e.g. in tool call JSON or result text) are
 * ignored.
 */
function parseAssistantSpecialBlocks(region: string): { toolCalls: ToolCall[]; toolResults: ParsedToolResult[] } {
	const toolCalls: ToolCall[] = [];
	const toolResults: ParsedToolResult[] = [];
	let pos = 0;
	while (pos < region.length) {
		const open = findNextTag(region, pos);
		if (!open) break;
		if (open.isClosing || (open.name !== "pi_tool_call" && open.name !== "pi_tool_result")) {
			pos = open.end;
			continue;
		}
		const firstClose = findFirstClosingTag(region, open.end, open.name);
		if (!firstClose) break;
		const nextBlockOpen = findFirstSpecialTagOpen(region, firstClose.end, ["pi_tool_call", "pi_tool_result"]);
		const boundary = nextBlockOpen?.start ?? region.length;
		const close = findLastClosingTagBefore(region, open.end, boundary, open.name) ?? firstClose;
		const inner = region.slice(open.end, close.start);
		if (open.name === "pi_tool_call") {
			let args: JsonObject = {};
			try {
				args = JSON.parse(inner) as JsonObject;
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
			toolCalls.push(toolCall);
		} else {
			toolResults.push({
				id: open.attributes.id ?? "",
				content: parseToolResultContent(inner),
				isError: open.attributes.isError === "true",
			});
		}
		pos = close.end;
	}
	return { toolCalls, toolResults };
}

/**
 * Parse the text and `<pi_image>` blocks of a `<pi_tool_result>` body, in
 * document order.
 */
function parseToolResultContent(inner: string): (TextContent | ImageContent)[] {
	const blocks: (TextContent | ImageContent)[] = [];
	let textStart = 0;
	let pos = 0;
	while (pos < inner.length) {
		const open = findNextTag(inner, pos);
		if (!open || open.isClosing || open.name !== "pi_image") break;
		const text = inner.slice(textStart, open.start);
		if (text.trim().length > 0) blocks.push({ type: "text", text });
		const firstClose = findFirstClosingTag(inner, open.end, "pi_image");
		if (!firstClose) break;
		const nextOpen = findFirstOpeningTag(inner, firstClose.end, "pi_image");
		const boundary = nextOpen?.start ?? inner.length;
		const close = findLastClosingTagBefore(inner, open.end, boundary, "pi_image") ?? firstClose;
		blocks.push({
			type: "image",
			data: inner.slice(open.end, close.start),
			mimeType: open.attributes.mimeType || open.attributes.mime_type || "image/png",
		});
		pos = close.end;
		textStart = pos;
	}
	const text = inner.slice(textStart);
	if (text.trim().length > 0) blocks.push({ type: "text", text });
	return blocks;
}

/**
 * Parse the trailing assistant special blocks (legacy bare-text format):
 * `<pi_tool_call>` and `<pi_tool_result>` blocks at the end of the content.
 * Returns their text end and the blocks oldest-first.
 */
function parseTrailingAssistantSpecialBlocks(content: string): {
	toolCalls: ToolCall[];
	toolResults: ParsedToolResult[];
	textEnd: number;
} {
	const toolCalls: ToolCall[] = [];
	const toolResults: ParsedToolResult[] = [];
	let end = content.length;
	while (true) {
		while (end > 0 && /\s/.test(content[end - 1])) end--;
		const tagName =
			end >= 15 && content.slice(end - 15, end) === "</pi_tool_call>"
				? ("pi_tool_call" as const)
				: end >= 17 && content.slice(end - 17, end) === "</pi_tool_result>"
					? ("pi_tool_result" as const)
					: undefined;
		if (!tagName) break;
		const closeStart = end - `</${tagName}>`.length;
		const open = findPreviousOpeningTag(content, closeStart, tagName);
		if (!open) break;
		const inner = content.slice(open.end, closeStart);
		if (tagName === "pi_tool_call") {
			let args: JsonObject = {};
			try {
				args = JSON.parse(inner) as JsonObject;
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
			toolCalls.unshift(toolCall);
		} else {
			toolResults.unshift({
				id: open.attributes.id ?? "",
				content: parseToolResultContent(inner),
				isError: open.attributes.isError === "true",
			});
		}
		end = open.start;
	}
	return { toolCalls, toolResults, textEnd: end };
}

/**
 * Parse special blocks (`<pi_tool_call>` / `<pi_image>`) from a region that
 * contains only special blocks (the content after a `<pi_content>` wrapper).
 * Each block's closing tag is the furthest closing still before the next block
 * opening, so stray closing tags inside a block body (e.g. in tool call JSON)
 * are ignored.
 */
function parseSpecialBlocksForward(
	region: string,
	tagName: string,
	role: "user" | "assistant",
): (ToolCall | ImageContent)[] {
	const blocks: (ToolCall | ImageContent)[] = [];
	let pos = 0;
	while (pos < region.length) {
		const open = findFirstOpeningTag(region, pos, tagName);
		if (!open) break;
		const firstClose = findFirstClosingTag(region, open.end, tagName);
		if (!firstClose) break;
		const nextOpen = findFirstOpeningTag(region, firstClose.end, tagName);
		const boundary = nextOpen?.start ?? region.length;
		const close = findLastClosingTagBefore(region, open.end, boundary, tagName) ?? firstClose;
		const inner = region.slice(open.end, close.start);

		if (role === "assistant") {
			let args: JsonObject = {};
			try {
				args = JSON.parse(inner) as JsonObject;
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
			blocks.push(toolCall);
		} else {
			const mimeType = open.attributes.mimeType || open.attributes.mime_type || "image/png";
			blocks.push({ type: "image", data: inner, mimeType });
		}
		pos = close.end;
	}
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
			let args: JsonObject = {};
			try {
				args = JSON.parse(argsText) as JsonObject;
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
 * Format the inner content of a message as XML (without the `<pi_edit>`
 * wrapper). For assistant messages, the tool results from `toolResults`
 * (keyed by tool call id) are emitted after their tool call. Returns `null`
 * for roles that are not directly editable (e.g. toolResult).
 */
export function formatMessageContent(
	message: AgentMessage,
	toolResults?: ReadonlyMap<string, ToolResultMessage>,
): string | null {
	switch (message.role) {
		case "user":
			return formatUserMessageContent(message as UserMessage);
		case "assistant":
			return formatAssistantMessageContent(message as AssistantMessage, toolResults);
		default:
			return null;
	}
}

/**
 * Format an existing message as an edit XML block with the given id. Tool
 * results from `toolResults` are included so the message and its results are
 * edited as one unit. Returns `null` for roles that are not directly
 * editable (e.g. toolResult).
 */
export function formatMessageForEdit(
	id: number,
	message: AgentMessage,
	toolResults?: ReadonlyMap<string, ToolResultMessage>,
): string | null {
	const content = formatMessageContent(message, toolResults);
	if (content === null) return null;
	const role = message.role === "user" ? "user" : "assistant";
	let attrs = ` id="${id}" role="${role}"`;
	if (message.role === "assistant") {
		const aborted = (message as AssistantMessage).stopReason === "aborted";
		attrs += ` aborted="${aborted ? "true" : "false"}"`;
	}
	return `<pi_edit${attrs}>${content}</pi_edit>`;
}

/**
 * Format an existing message as a `<pi_swipe>` block for in-place editing of
 * one swipe version. The timestamp identifies the version on apply and keeps
 * its position stable. Tool results from `toolResults` are included. Returns
 * `null` for roles that are not editable.
 */
export function formatMessageForSwipe(
	timestamp: string,
	message: AgentMessage,
	toolResults?: ReadonlyMap<string, ToolResultMessage>,
): string | null {
	const content = formatMessageContent(message, toolResults);
	if (content === null) return null;
	const role = message.role === "user" ? "user" : "assistant";
	let attrs = ` timestamp="${escapeXmlAttr(timestamp)}" role="${role}"`;
	if (message.role === "assistant") {
		const aborted = (message as AssistantMessage).stopReason === "aborted";
		attrs += ` aborted="${aborted ? "true" : "false"}"`;
	}
	return `<pi_swipe${attrs}>${content}</pi_swipe>`;
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

function formatAssistantMessageContent(
	message: AssistantMessage,
	toolResults?: ReadonlyMap<string, ToolResultMessage>,
): string {
	let inner = "";
	let textBuffer = "";
	for (const block of message.content) {
		if (block.type === "thinking") {
			let attrs = "";
			if (block.thinkingSignature) attrs += ` signature="${escapeXmlAttr(block.thinkingSignature)}"`;
			if (block.redacted) attrs += ` redacted="true"`;
			inner += `<pi_reasoning_content${attrs}>${block.thinking}</pi_reasoning_content>`;
		} else if (block.type === "text") {
			textBuffer += block.text;
		} else if (block.type === "toolCall") {
			if (textBuffer.length > 0) {
				inner += `<pi_content>${textBuffer}</pi_content>`;
				textBuffer = "";
			}
			let attrs = ` id="${escapeXmlAttr(block.id)}" name="${escapeXmlAttr(block.name)}"`;
			if (block.thoughtSignature) attrs += ` thoughtSignature="${escapeXmlAttr(block.thoughtSignature)}"`;
			inner += `<pi_tool_call${attrs}>${JSON.stringify(block.arguments)}</pi_tool_call>`;
			const result = toolResults?.get(block.id);
			if (result) inner += formatToolResultBlock(result);
		}
	}
	if (textBuffer.length > 0) {
		inner += `<pi_content>${textBuffer}</pi_content>`;
	}
	return inner;
}

/**
 * Format a tool result as a `<pi_tool_result>` block. The id attributes the
 * result to its tool call; isError is present only for error results.
 */
function formatToolResultBlock(result: ToolResultMessage): string {
	let inner = "";
	for (const block of result.content) {
		if (block.type === "text") {
			inner += block.text;
		} else {
			inner += `<pi_image mimeType="${escapeXmlAttr(block.mimeType)}">${block.data}</pi_image>`;
		}
	}
	let attrs = ` id="${escapeXmlAttr(result.toolCallId)}"`;
	if (result.isError) attrs += ` isError="true"`;
	return `<pi_tool_result${attrs}>${inner}</pi_tool_result>`;
}

/**
 * Build a `Message` from a parsed edit block and optional base assistant fields.
 * For new assistant messages (negative ids) baseAssistant must be provided.
 */
export function editBlockToMessage(
	block: ParsedEditBlock | ParsedSwipeBlock,
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
