import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	private readonly getLines: () => string[];
	constructor(getLines: () => string[]) {
		this.getLines = getLines;
	}
	render(_width: number): string[] {
		return this.getLines();
	}
	invalidate(): void {}
}

function stripTrailingEmpty(lines: string[]): string[] {
	const result = [...lines];
	while (result.length > 0 && result[result.length - 1].trim() === "") result.pop();
	return result;
}

/**
 * Render the given lines into a fresh terminal with a fresh TUI (no incremental
 * renders) and return the full scroll buffer. This is the ground truth that
 * incremental rendering must reproduce exactly: the differential renderer may never
 * leave stale fragments, duplicate lines, or blank rows compared to a clean render.
 */
async function referenceRender(lines: string[], cols: number, rows: number): Promise<string[]> {
	const terminal = new VirtualTerminal(cols, rows);
	const tui = new TuiMainScreen(terminal);
	tui.addChild(new TestComponent(() => lines));
	tui.start();
	await terminal.waitForRender();
	const buffer = stripTrailingEmpty(terminal.getScrollBuffer());
	tui.stop();
	return buffer;
}

async function assertMatchesReference(
	terminal: VirtualTerminal,
	lines: string[],
	cols: number,
	rows: number,
	context: string,
): Promise<void> {
	const got = stripTrailingEmpty(terminal.getScrollBuffer());
	const expected = await referenceRender(lines, cols, rows);
	const total = Math.max(got.length, expected.length);
	for (let i = 0; i < total; i++) {
		const g = got[i] ?? "<none>";
		const e = expected[i] ?? "<none>";
		assert.strictEqual(g, e, `${context}: scroll buffer row ${i} differs\n  got:      '${g}'\n  expected: '${e}'`);
	}
}

/** Log lines that wrap to multiple rows at width 22 and exceed the viewport height. */
function makeLog(): string[] {
	const log: string[] = [];
	for (let i = 0; i < 12; i++) log.push(`L${i}:${"x".repeat(14 + (i % 3) * 18)}`);
	return log;
}

describe("TUI wrapped-line scrollback integrity (wrapping disabled)", () => {
	it("streams a line with embedded newlines across an exact-width boundary without corrupting the scrollback", async () => {
		const cols = 22;
		const rows = 6;
		const log = makeLog();
		const terminal = new VirtualTerminal(cols, rows);
		const tui = new TuiMainScreen(terminal);
		let stream = "";
		tui.addChild(new TestComponent(() => [...log, stream]));
		tui.start();
		await terminal.waitForRender();

		// "second parag" fills the last segment exactly to the terminal width (10 retained
		// columns + 12 chars = 22): the wrap stays pending and must not count as a row.
		// Beyond it ("paragraph and more") the line genuinely grows in row count while
		// pinned to the viewport bottom, which must scroll real content - never blanks.
		const tokens =
			"streaming output text with some words that wrap around the edge and newlines\n\nsecond paragraph and more";
		for (let step = 0; step < tokens.length; step++) {
			stream += tokens[step];
			tui.requestRender();
			await terminal.waitForRender();
		}
		await assertMatchesReference(terminal, [...log, stream], cols, rows, "after full stream");
		tui.stop();
	});

	it("matches the reference at the exact-fill step where the pending wrap must not add a row", async () => {
		const cols = 22;
		const rows = 6;
		const log = makeLog();
		const terminal = new VirtualTerminal(cols, rows);
		const tui = new TuiMainScreen(terminal);
		let stream = "";
		tui.addChild(new TestComponent(() => [...log, stream]));
		tui.start();
		await terminal.waitForRender();

		const tokens = "streaming output text with some words that wrap around the edge and newlines\n\nsecond parag";
		for (let step = 0; step < tokens.length; step++) {
			stream += tokens[step];
			tui.requestRender();
			await terminal.waitForRender();
		}
		// At this length the last segment ends exactly at the width boundary. The terminal
		// shows 30 rows, not 31 - a spurious extra row here used to push a blank row into
		// the scrollback and shift the whole stream down by one.
		await assertMatchesReference(terminal, [...log, stream], cols, rows, "at exact-fill step");
		tui.stop();
	});

	it("does not leave stale fragments when a mid-array deletion shifts multi-row lines", async () => {
		const cols = 30;
		const rows = 8;
		// Lines 0..5 wrap to several rows; #29 (one row) is deleted from the middle, which
		// shifts every following line up by one row. All shifted lines happen to be one
		// row each, so per-index offset comparison cannot detect the shift - the
		// differential path must still rewrite every row the new content occupies.
		const before = [
			"#0 yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\nffffffffffffffffffffff",
			"#15 xxxxxxxxxxxxxxxxxxxxxxgggggggggggggggggggggggggggggg",
			"#16 xxxxxx#32",
			"#22 xxxx",
			"#24 xxxxxx\nffffffffff",
			"#28 zzzzzzzzzzzzzzzzzzzzzzzzzz",
			"#29 xxxxxxxx#37",
			"#30 ccccccccccccccccccccc",
			"#31 xxxxxxxxxxxx",
			"#33 xxxx",
			"#34 ccccccccccccccccccccccccc",
			"#35 zzzzzzzzzzzzzzzzzzzzzzzzzz",
			"#36 xxxxxxxxxxxxxxgggggggggggggggggggggggggggggg",
		];
		const after = [
			"#0 yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\nffffffffffffffffffffff",
			"#15 xxxxxxxxxxxxxxxxxxxxxxgggggggggggggggggggggggggggggg",
			"#16 xxxxxx#32",
			"#22 xxxx",
			"#24 xxxxxx\nffffffffff",
			"#28 zzzzzzzzzzzzzzzzzzzzzzzzzz",
			"#30 ccccccccccccccccccccc",
			"#31 xxxxxxxxxxxx",
			"#33 xxxx",
			"#34 ccccccccccccccccccccccccc",
			"#35 zzzzzzzzzzzzzzzzzzzzzzzzzz",
			"#36 xxxxxxxxxxxxxxgggggggggggggggggggggggggggggg",
		];
		const terminal = new VirtualTerminal(cols, rows);
		const tui = new TuiMainScreen(terminal);
		let current = before;
		tui.addChild(new TestComponent(() => current));
		tui.start();
		await terminal.waitForRender();

		current = after;
		tui.requestRender();
		await terminal.waitForRender();
		await assertMatchesReference(terminal, after, cols, rows, "after mid-array deletion");
		tui.stop();
	});

	it("streams markdown with hard line breaks over a scrolled log without doubling lines", async () => {
		const cols = 40;
		const rows = 8;
		const log: string[] = [];
		for (let i = 0; i < 15; i++) log.push(`log line ${i} ${"x".repeat(20 + (i % 4) * 10)}`);
		// Two trailing spaces create a hard line break; markdown renders the paragraph as
		// a single line with an embedded \n, which used to be undercounted and doubled.
		const full = [
			"Here is a paragraph that is long enough to wrap around the terminal edge.  ",
			"And a hard line break after it.",
			"",
			"Second paragraph with **bold** and *italic* text that also wraps around.",
			"",
			"Third paragraph ends the stream nicely.",
		].join("\n");
		const terminal = new VirtualTerminal(cols, rows);
		const tui = new TuiMainScreen(terminal);
		let markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
		tui.addChild(new TestComponent(() => [...log, ...markdown.render(cols)]));
		tui.start();
		await terminal.waitForRender();

		for (let step = 0; step < full.length; step++) {
			markdown = new Markdown(full.slice(0, step + 1), 0, 0, defaultMarkdownTheme);
			tui.requestRender();
			await terminal.waitForRender();
		}
		await assertMatchesReference(terminal, [...log, ...markdown.render(cols)], cols, rows, "after markdown stream");
		tui.stop();
	});

	it("keeps the scrollback aligned when a bottom line shrinks back below the viewport", async () => {
		const cols = 22;
		const rows = 6;
		const log = makeLog();
		const terminal = new VirtualTerminal(cols, rows);
		const tui = new TuiMainScreen(terminal);
		let stream = "";
		tui.addChild(new TestComponent(() => [...log, stream]));
		tui.start();
		await terminal.waitForRender();

		// Grow a multi-row embedded-newline line, then replace it with a short line: all
		// wrapped rows of the old content must be cleared, and the trailing rows cleared
		// without scrolling stale content around.
		const grown = "first segment wrapping badly around the edge\n\nsecond segment also wrapping around";
		for (const ch of grown) {
			stream += ch;
			tui.requestRender();
			await terminal.waitForRender();
		}
		stream = "short";
		tui.requestRender();
		await terminal.waitForRender();
		await assertMatchesReference(terminal, [...log, stream], cols, rows, "after shrink");
		tui.stop();
	});
});
