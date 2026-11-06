import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { customMessageBg, customMessageSeparatorBg, getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

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
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;

	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
	) {
		super(outputPad, 1, customMessageBg());
		this.setSeparatorBg(customMessageSeparatorBg());
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.updateDisplay();
	}

	setExpanded(_expanded: boolean): void {
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
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
		const header = `**Compacted from ${tokenStr} tokens**\n\n`;
		const transform = createMarkdownTransform(
			"summary",
			() => false,
			this.markdownTransformers,
			this.messageId,
			this.timestamp,
		);
		content.addChild(
			new Markdown(
				this.message.summary,
				0,
				0,
				this.markdownTheme,
				{ color: (text: string) => theme.fg("customMessageText", text) },
				// Transformers see only the summary content, not Pi's header.
				{ transform: (markdown, width) => header + transform(markdown, width) },
			),
		);

		this.addChild(content);
	}
}
