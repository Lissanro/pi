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
import { XMLParser } from "fast-xml-parser";

export interface ParsedEditBlock {
	id: number;
	role: "user" | "assistant";
	content: (TextContent | ThinkingContent | ToolCall | ImageContent)[];
}

interface OrderedNode {
	":@"?: Record<string, unknown>;
	[key: string]: unknown;
}

function escapeXmlText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(text: string): string {
	return escapeXmlText(text).replace(/"/g, "&quot;");
}

function getNodeText(node: OrderedNode | unknown): string {
	if (typeof node === "string") return node;
	if (node && typeof node === "object" && "#text" in node) {
		return String((node as Record<string, unknown>)["#text"]);
	}
	return "";
}

function getChildText(children: OrderedNode[] | unknown): string {
	if (!Array.isArray(children)) return "";
	return children.map(getNodeText).join("");
}

function getAttributes(node: OrderedNode | undefined): Record<string, string> {
	if (!node || typeof node !== "object" || !node[":@"]) return {};
	const attrs = node[":@"] as Record<string, unknown>;
	const result: Record<string, string> = {};
	for (const key of Object.keys(attrs)) {
		result[key] = String(attrs[key] ?? "");
	}
	return result;
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

	const parser = new XMLParser({
		preserveOrder: true,
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
		isArray: () => true,
		parseTagValue: false,
	});

	let parsed: unknown;
	try {
		parsed = parser.parse(`<root>${trimmed}</root>`);
	} catch {
		return [];
	}

	if (!Array.isArray(parsed)) return [];

	const blocks: ParsedEditBlock[] = [];
	const root = parsed[0];
	if (!root || typeof root !== "object") return [];
	const rootChildren = root.root as OrderedNode[] | undefined;
	if (!Array.isArray(rootChildren)) return [];

	for (const node of rootChildren) {
		if (!node || typeof node !== "object" || !("pi_edit" in node)) continue;

		const attrs = getAttributes(node);
		const id = Number.parseInt(attrs["@_id"] ?? "", 10);
		const role = attrs["@_role"];
		if (Number.isNaN(id) || (role !== "user" && role !== "assistant")) continue;

		const children = node.pi_edit as OrderedNode[] | undefined;
		const content = parseEditContent(children ?? [], role);
		blocks.push({ id, role, content });
	}

	return blocks;
}

function parseEditContent(
	children: OrderedNode[],
	role: "user" | "assistant",
): (TextContent | ThinkingContent | ToolCall | ImageContent)[] {
	const blocks: (TextContent | ThinkingContent | ToolCall | ImageContent)[] = [];

	for (const child of children) {
		if (!child || typeof child !== "object") continue;

		if ("#text" in child) {
			const text = getNodeText(child);
			if (text.trim().length > 0) {
				blocks.push({ type: "text", text });
			}
			continue;
		}

		if ("reasoning_content" in child) {
			if (role !== "assistant") continue;
			const attrs = getAttributes(child);
			const thinking = getChildText(child.reasoning_content);
			const block: ThinkingContent = { type: "thinking", thinking };
			const signature = attrs["@_signature"];
			if (signature) block.thinkingSignature = signature;
			if (attrs["@_redacted"] === "true") block.redacted = true;
			blocks.push(block);
			continue;
		}

		if ("tool_call" in child) {
			if (role !== "assistant") continue;
			const attrs = getAttributes(child);
			const id = attrs["@_id"] ?? "";
			const name = attrs["@_name"] ?? "";
			const thoughtSignature = attrs["@_thoughtSignature"];
			const argsText = getChildText(child.tool_call);
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(argsText) as Record<string, unknown>;
			} catch {
				args = {};
			}
			const block: ToolCall = { type: "toolCall", id, name, arguments: args };
			if (thoughtSignature) block.thoughtSignature = thoughtSignature;
			blocks.push(block);
			continue;
		}

		if ("image" in child) {
			if (role !== "user") continue;
			const attrs = getAttributes(child);
			const data = getChildText(child.image);
			const mimeType = attrs["@_mimeType"] || attrs["@_mime_type"] || "image/png";
			blocks.push({ type: "image", data, mimeType });
		}
	}

	return blocks;
}

/**
 * Format an existing message as an edit XML block with the given id.
 * Returns `null` for roles that are not directly editable (e.g. toolResult).
 */
export function formatMessageForEdit(id: number, message: AgentMessage): string | null {
	switch (message.role) {
		case "user":
			return formatUserMessageForEdit(id, message as UserMessage);
		case "assistant":
			return formatAssistantMessageForEdit(id, message as AssistantMessage);
		default:
			return null;
	}
}

function formatUserMessageForEdit(id: number, message: UserMessage): string {
	const content =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	let inner = "";
	for (const block of content) {
		if (block.type === "text") {
			inner += escapeXmlText(block.text);
		} else if (block.type === "image") {
			inner += `<image mimeType="${escapeXmlAttr(block.mimeType)}">${block.data}</image>`;
		}
	}
	return `<pi_edit id="${id}" role="user">${inner}</pi_edit>`;
}

function formatAssistantMessageForEdit(id: number, message: AssistantMessage): string {
	let inner = "";
	for (const block of message.content) {
		if (block.type === "thinking") {
			let attrs = "";
			if (block.thinkingSignature) attrs += ` signature="${escapeXmlAttr(block.thinkingSignature)}"`;
			if (block.redacted) attrs += ` redacted="true"`;
			inner += `<reasoning_content${attrs}>${escapeXmlText(block.thinking)}</reasoning_content>`;
		} else if (block.type === "text") {
			inner += escapeXmlText(block.text);
		} else if (block.type === "toolCall") {
			let attrs = ` id="${escapeXmlAttr(block.id)}" name="${escapeXmlAttr(block.name)}"`;
			if (block.thoughtSignature) attrs += ` thoughtSignature="${escapeXmlAttr(block.thoughtSignature)}"`;
			inner += `<tool_call${attrs}>${escapeXmlText(JSON.stringify(block.arguments))}</tool_call>`;
		}
	}
	return `<pi_edit id="${id}" role="assistant">${inner}</pi_edit>`;
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
