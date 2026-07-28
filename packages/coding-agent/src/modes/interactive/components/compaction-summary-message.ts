import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { type CompactionSummaryMessage, convertToLlm } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

function formatContextMessages(messages: Message[]): string {
	return messages
		.map((m, index) => {
			const role = m.role.toUpperCase();
			const text = messageToText(m);
			return `**[${index + 1}] ${role}**\n${text}`;
		})
		.join("\n\n");
}

function messageToText(message: Message): string {
	if (message.role === "toolResult") {
		return message.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
	}
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
	}
	return assistantContentToText(message.content);
}

function assistantContentToText(content: AssistantMessage["content"]): string {
	return content
		.map((c) => {
			switch (c.type) {
				case "text":
					return c.text;
				case "toolCall":
					return `\`${c.name}(${JSON.stringify(c.arguments)})\``;
				case "thinking":
					return c.redacted ? "[thinking redacted]" : `\n<thinking>\n${c.thinking}\n</thinking>\n`;
				default:
					return `[${(c as { type: string }).type}]`;
			}
		})
		.join("\n");
}

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private contextMessages?: AgentMessage[];

	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		contextMessages?: AgentMessage[],
	) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.contextMessages = contextMessages;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			let expandedText = `**Compacted from ${tokenStr} tokens**\n\n${this.message.summary}`;
			if (this.contextMessages && this.contextMessages.length > 0) {
				expandedText += "\n\n---\n\n**Context visible to the model:**\n\n";
				expandedText += formatContextMessages(convertToLlm(this.contextMessages));
			}
			this.addChild(
				new Markdown(expandedText, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", `Compacted from ${tokenStr} tokens (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
