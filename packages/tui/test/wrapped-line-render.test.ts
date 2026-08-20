import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("TUI wrapped-line differential rendering (wrapping disabled)", () => {
	it("positions a later changed line below a wrapped (multi-row) line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Middle line is wider than the 20-col terminal, so it wraps to two rows.
		const wide = "A".repeat(30);
		component.lines = ["Header", wide, "Footer"];
		tui.start();
		await terminal.waitForRender();

		// Initial render: Header (row0), wide wraps to rows 1-2, Footer on row 3.
		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Header"), `row0: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("AAA"), `row1 (wide first fragment): ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("AAA"), `row2 (wide second fragment): ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("Footer"), `row3: ${viewport[3]}`);

		// Change the last line: the differential renderer must move to the correct
		// terminal row (below the wrapped wide line) and rewrite it there.
		component.lines = ["Header", wide, "CHANGED"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport[3]?.includes("CHANGED"), `row3 should be CHANGED, got: ${viewport[3]}`);
		assert.ok(viewport[4]?.trim() === "", `row4 should be empty, got: ${viewport[4]}`);
		// The wrapped wide line must stay intact across rows 1-2.
		assert.ok(viewport[1]?.includes("AAA"), `row1 wide fragment preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("AAA"), `row2 wide fragment preserved: ${viewport[2]}`);
		assert.ok(!viewport.join("\n").includes("Footer"), "no stale Footer should remain");

		tui.stop();
	});

	it("does not duplicate a wrapped line when it shrinks to a single row", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// First render: a wide line wrapped to two rows, then a footer below it.
		const wide = "B".repeat(30);
		component.lines = ["Top", wide, "Footer"];
		tui.start();
		await terminal.waitForRender();

		// Shrink the wide line to a short one: the wrapped second row must not linger.
		component.lines = ["Top", "Short", "Footer"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[1]?.includes("Short"), `row1: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Footer"), `row2 should be Footer (wide's second row cleared): ${viewport[2]}`);
		assert.ok(!viewport.join("\n").includes("B".repeat(2)), "no stale wide fragments should remain");

		tui.stop();
	});
});
