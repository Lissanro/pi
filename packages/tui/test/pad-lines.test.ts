import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import {
	isPadLinesToWidth,
	isWrapLinesToWidth,
	setPadLinesToWidth,
	setWrapLinesToWidth,
	shouldWrapLinesToWidth,
	visibleWidth,
} from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const theme = defaultMarkdownTheme;

// Text long enough to wrap at a 20-column width.
const LONG = "word word word word word word word word word word word word word word word";

afterEach(() => {
	// Restore the default (disabled) state for isolation.
	setPadLinesToWidth(false);
	setWrapLinesToWidth(false);
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

	it("Markdown paragraph stays unwrapped by default (no fake newlines)", () => {
		const long = "This is a very long single paragraph that stays on one logical line when padding is disabled.";
		const md = new Markdown(long, 1, 1, theme);
		const lines = md.render(20);

		// Content line holds the whole paragraph on a single line, no wrapping at width 20.
		const content = lines.filter((line) => line.trim() !== "");
		assert.strictEqual(content.length, 1);
		assert.strictEqual(content[0], long);
	});

	it("Markdown paragraph wraps when padLines is enabled", () => {
		setPadLinesToWidth(true);
		const long = "This is a very long single paragraph that stays on one logical line when padding is disabled.";
		const md = new Markdown(long, 1, 1, theme);
		const lines = md.render(20);

		const content = lines.filter((line) => line.trim() !== "");
		assert.ok(content.length > 1, "paragraph should wrap when padLines is enabled");
	});

	it("list stays unwrapped by default, keeping the bullet", () => {
		const md = new Markdown("- one two three four five six seven eight nine ten eleven twelve", 1, 1, theme);
		const lines = md.render(20);

		const content = lines.filter((line) => line.trim() !== "");
		assert.strictEqual(content.length, 1);
		assert.ok(content[0].includes("one"));
		assert.ok(content[0].includes("twelve"));
	});

	it("blockquote stays unwrapped by default, keeping the border prefix", () => {
		const md = new Markdown("> quoted long text that stays unwrapped across many words here", 1, 1, theme);
		const lines = md.render(20);

		const content = lines.filter((line) => line.trim() !== "");
		assert.strictEqual(content.length, 1);
		assert.ok(content[0].includes("│ "));
		assert.ok(content[0].includes("here"));
	});

	it("table keeps the real terminal width by default", () => {
		const md = new Markdown("| a | b |\n|---|---|\n| 1 | 2 |", 1, 1, theme);
		const lines = md.render(20);

		// Table borders are intact, sized to the real width.
		assert.ok(lines.some((line) => line.includes("┌─")));
		assert.ok(lines.some((line) => line.includes("│ 1 │ 2 │")));
		assert.ok(lines.some((line) => line.includes("└─")));
	});

	it("wrapLines is disabled by default", () => {
		assert.strictEqual(isWrapLinesToWidth(), false);
		assert.strictEqual(shouldWrapLinesToWidth(), false);
	});

	it("wrapLines wraps content at full width without padding", () => {
		setWrapLinesToWidth(true);
		const md = new Markdown(LONG, 1, 1, theme);
		const lines = md.render(20);

		const content = lines.filter((line) => line.trim() !== "");
		assert.ok(content.length > 1, "wrapLines should wrap content");
		// No outer margins or trailing padding: content starts at column 0.
		assert.strictEqual(content[0].trimStart().length, content[0].length);
	});

	it("padLines forces wrapLines on", () => {
		setPadLinesToWidth(true);
		assert.strictEqual(shouldWrapLinesToWidth(), true);
	});

	it("code blocks render verbatim with no leading indent", () => {
		const md = new Markdown("```js\nconst x = 1;\n```\n", 0, 0, theme);
		const lines = md.render(40);

		const content = lines.filter((line) => line.trim() !== "");
		assert.ok(content.some((line) => line.includes("const x = 1;")));
	});

	it("leading spaces do not become code blocks", () => {
		const md = new Markdown("    plain indented text\n    still plain\n", 0, 0, theme);
		const lines = md.render(40);
		const joined = lines.join("\n");

		// No triple-backtick fence is added around indented text.
		assert.ok(!joined.includes("```"), "leading spaces must not create code blocks");
		assert.ok(joined.includes("plain indented text"));
	});

	it("Box separator background colors only the first and last padding lines", () => {
		const bg = (text: string) => `\x1b[45m${text}\x1b[49m`;
		const box = new Box(1, 1, undefined);
		box.setSeparatorBg(bg);
		box.addChild(new Text("content", 0, 0));

		const lines = box.render(20);

		// First and last lines carry the separator background; the content line does not.
		assert.ok(lines[0].includes("\x1b[45m"));
		assert.ok(lines[lines.length - 1].includes("\x1b[45m"));
		assert.ok(!lines[1].includes("\x1b[45m"));
	});
});
