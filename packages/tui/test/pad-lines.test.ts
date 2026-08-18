import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { isPadLinesToWidth, setPadLinesToWidth, visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const theme = defaultMarkdownTheme;

afterEach(() => {
	// Restore the default (disabled) state for isolation.
	setPadLinesToWidth(false);
});

describe("padLines (default off)", () => {
	it("is disabled by default", () => {
		assert.strictEqual(isPadLinesToWidth(), false);
	});

	it("Text does not add trailing spaces or margins by default", () => {
		const text = new Text("hello", 1, 0);
		const lines = text.render(50);

		// One content line, no margins and no trailing padding.
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], "hello");
		assert.strictEqual(visibleWidth(lines[0]), 5);
	});

	it("Markdown does not add trailing spaces or margins by default", () => {
		const md = new Markdown("hello", 1, 0, theme);
		const lines = md.render(50);

		assert.ok(lines.length >= 1);
		for (const line of lines) {
			if (line === "") continue;
			// No trailing padding: line width is its content width, not the terminal width.
			assert.notStrictEqual(visibleWidth(line), 50);
		}
	});

	it("Text pads to full width when padLines is enabled", () => {
		setPadLinesToWidth(true);
		const text = new Text("hello", 1, 0);
		const lines = text.render(50);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 50);
		assert.ok(lines[0].startsWith(" hello"));
	});
});
