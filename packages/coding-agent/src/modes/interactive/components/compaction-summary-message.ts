import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { customMessageBg, customMessageSeparatorBg, getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a compaction message. The summary is always shown
 * expanded: it sits at the top of the chat, before the preserved tail, so
 * there is no reason to collapse it. The context mirror that duplicated the
 * preserved tail was removed once the summary started rendering at its real
 * position. Uses same background color as custom messages for visual
 * consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, customMessageBg());
		this.setSeparatorBg(customMessageSeparatorBg());
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(
			new Markdown(`**Compacted from ${tokenStr} tokens**\n\n${this.message.summary}`, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);

		this.addChild(content);
	}
}
