import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** Extract and join text from message content. */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/**
 * Serialize message content into the text a model tokenizer would count, plus the
 * number of image blocks. `contentText` only keeps `text` blocks, which is fine
 * for display but drops reasoning (thinking), tool calls, and images - all of
 * which occupy tokens in the real prompt. This includes thinking text and tool
 * call names/arguments so the `/tokenize` count reflects what the model sees;
 * images are not text and are counted separately (caller applies an estimate).
 */
export function contentToTokenizeText(content: string | readonly Content[]): { text: string; imageCount: number } {
	if (typeof content === "string") return { text: content, imageCount: 0 };
	let text = "";
	let imageCount = 0;
	for (const block of content) {
		switch (block.type) {
			case "text":
				text += block.text;
				break;
			case "thinking":
				text += block.thinking;
				break;
			case "toolCall":
				text += `${block.name}\n${JSON.stringify(block.arguments)}`;
				break;
			case "image":
				imageCount++;
				break;
		}
	}
	return { text, imageCount };
}

/** Render a system message as a complete prompt: its content followed by its sections. */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Render a later system message for APIs that accept system messages mid-conversation.
 * Section changes are framed by name so the model can relate them to the leading prompt.
 * This framing is request-time only and may change between versions.
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content);
	if (text.length > 0) parts.push(text);
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join("\n\n");
}
