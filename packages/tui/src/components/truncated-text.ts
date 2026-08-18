import type { Component } from "../tui.ts";
import { isPadLinesToWidth, padLineToWidth, truncateToWidth } from "../utils.ts";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const result: string[] = [];

		// Empty line padded to width
		const emptyLine = " ".repeat(width);

		// Add vertical padding above
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		const padEnabled = isPadLinesToWidth();

		// Calculate available width after horizontal padding
		const availableWidth = padEnabled ? Math.max(1, width - this.paddingX * 2) : width;

		// Take only the first line (stop at newline)
		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		if (padEnabled) {
			// Add horizontal padding and pad to exactly width characters
			const leftPadding = " ".repeat(this.paddingX);
			const rightPadding = " ".repeat(this.paddingX);
			result.push(padLineToWidth(leftPadding + displayText + rightPadding, width));
		} else {
			// No padding: raw content, no margins, no trailing spaces
			result.push(displayText);
		}

		// Add vertical padding below
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}
