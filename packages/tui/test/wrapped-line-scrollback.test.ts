import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import type { Terminal } from "../src/terminal.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Terminal wrapper that records how many times a scrollback-clearing \x1b[3J was
 * emitted. In Kitty, \x1b[3J resets the scroll position to the bottom, so emitting it
 * during streaming yanks a scrolled-up user out of history on every wrap boundary.
 */
class ScrollbackClearSpyTerminal implements Terminal {
	private readonly inner: VirtualTerminal;
	clearScrollbackCount = 0;

	constructor(cols: number, rows: number) {
		this.inner = new VirtualTerminal(cols, rows);
	}

	get delegate(): VirtualTerminal {
		return this.inner;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}
	stop(): void {
		this.inner.stop();
	}
	async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		await this.inner.drainInput(maxMs, idleMs);
	}
	write(data: string): void {
		if (data.includes("\x1b[3J")) this.clearScrollbackCount += 1;
		this.inner.write(data);
	}
	get columns(): number {
		return this.inner.columns;
	}
	get rows(): number {
		return this.inner.rows;
	}
	get kittyProtocolActive(): boolean {
		return this.inner.kittyProtocolActive;
	}
	moveBy(lines: number): void {
		this.inner.moveBy(lines);
	}
	hideCursor(): void {
		this.inner.hideCursor();
	}
	showCursor(): void {
		this.inner.showCursor();
	}
	clearLine(): void {
		this.inner.clearLine();
	}
	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}
	clearScreen(): void {
		this.inner.clearScreen();
	}
	setTitle(title: string): void {
		this.inner.setTitle(title);
	}
	setProgress(active: boolean): void {
		this.inner.setProgress(active);
	}
	async waitForRender(): Promise<void> {
		await this.inner.waitForRender();
	}
}

async function assertNoScrollbackClearDuringStream(
	logAbove: string[],
	logBelow: string[],
	cols: number,
	rows: number,
	context: string,
): Promise<void> {
	const terminal = new ScrollbackClearSpyTerminal(cols, rows);
	const tui = new TuiMainScreen(terminal);
	let stream = "";
	// The streaming paragraph sits in the MIDDLE with stable content below it (like the
	// assistant output above the input field). Growing it across a wrap boundary shifts
	// every following line's terminal row, which is exactly the layout-change case that
	// used to full-render (and clear scrollback) on every wrap.
	tui.addChild(new TestComponent(() => [...logAbove, stream, ...logBelow]));
	tui.start();
	await terminal.waitForRender();

	const tokens = "streaming paragraph that grows and wraps across the width boundary repeatedly";
	for (let step = 0; step < tokens.length; step++) {
		stream += tokens[step];
		tui.requestRender();
		await terminal.waitForRender();
	}
	assert.strictEqual(terminal.clearScrollbackCount, 0, `${context}: \\x1b[3J emitted during wrap-boundary streaming`);
	await assertMatchesReference(
		terminal.delegate,
		[...logAbove, stream, ...logBelow],
		cols,
		rows,
		`${context}: scroll buffer`,
	);
	tui.stop();
}

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

	it("does not clear scrollback (\\x1b[3J) when a streaming line crosses a wrap boundary", async () => {
		const cols = 30;
		const rows = 8;
		const logAbove = [
			"#0 yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
			"#1 xxxxxxxxxxxxxxxxxxxxxxgggggggggggggggggggggggggggggg",
		];
		const logBelow = ["#2 xxxxxx#32", "#3 ccccccccccccccccccccccccc", "#4 zzzzzzzzzzzzzzzzzzzzzzzzzz"];
		await assertNoScrollbackClearDuringStream(logAbove, logBelow, cols, rows, "wrap boundary streaming");
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

	it("keeps the scrollback aligned when a line fills the width exactly, ends with a newline, then the next line soft-wraps", async () => {
		const cols = 22;
		const rows = 6;
		const log = makeLog();
		const terminal = new VirtualTerminal(cols, rows);
		const tui = new TuiMainScreen(terminal);
		let stream = "";
		tui.addChild(new TestComponent(() => [...log, stream]));
		tui.start();
		await terminal.waitForRender();

		// A markdown line whose first segment fills the terminal width exactly, then a
		// newline, then a second segment that grows across the wrap boundary. Real
		// terminals resolve the pending wrap onto a fresh line, so the empty line after
		// the full-width segment must stay aligned and never be eaten on the next wrap.
		const full = `${"A".repeat(22)}\n${"B".repeat(24)}`;
		for (let step = 1; step <= full.length; step++) {
			stream = full.slice(0, step);
			tui.requestRender();
			await terminal.waitForRender();
		}
		await assertMatchesReference(terminal, [...log, stream], cols, rows, "after full-width line + newline + wrap");
		tui.stop();
	});

	it("keeps the scrollback aligned when an embedded-newline segment does not fill the width and the next segment starts on a fresh line", async () => {
		const cols = 30;
		const rows = 7;
		const log = makeLog();
		const terminal = new VirtualTerminal(cols, rows);
		const tui = new TuiMainScreen(terminal);
		let stream = "";
		tui.addChild(new TestComponent(() => [...log, stream]));
		tui.start();
		await terminal.waitForRender();

		// A markdown line with an embedded newline (e.g. a list rendered as a single line
		// with a hard break). The first segment wraps partway, then the newline must reset
		// to column 0 so the next segment starts at the left edge, not at the leftover
		// column of the previous segment.
		const full = "a. alpha item that is fairly long\nb. beta item that is also long";
		for (let step = 1; step <= full.length; step++) {
			stream = full.slice(0, step);
			tui.requestRender();
			await terminal.waitForRender();
		}
		await assertMatchesReference(terminal, [...log, stream], cols, rows, "after embedded-newline partial segment");
		tui.stop();
	});
});
