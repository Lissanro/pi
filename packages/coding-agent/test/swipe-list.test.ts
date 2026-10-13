import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { parseSwipeSearchChars, searchSwipeMessage, summarizeSwipeMessage } from "../src/core/swipe-list.ts";
import { parseSwipeSelector } from "../src/core/swipe-selector.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("parseSwipeSelector", () => {
	it("parses integers, ranges, and -N", () => {
		expect(parseSwipeSelector("3", 5)).toEqual([3]);
		expect(parseSwipeSelector("2-3,5", 8)).toEqual([2, 3, 5]);
		expect(parseSwipeSelector("3-1", 5)).toEqual([1, 2, 3]);
		expect(parseSwipeSelector("-2", 5)).toEqual([4, 5]);
		expect(parseSwipeSelector("1-2,-1", 4)).toEqual([1, 2, 4]);
		expect(parseSwipeSelector("2,2,1", 3)).toEqual([1, 2]);
	});

	it("rejects out-of-range and malformed tokens", () => {
		expect(() => parseSwipeSelector("", 3)).toThrow(/Empty swipe selector/);
		expect(() => parseSwipeSelector("0", 3)).toThrow(/out of range/);
		expect(() => parseSwipeSelector("4", 3)).toThrow(/out of range/);
		expect(() => parseSwipeSelector("-4", 3)).toThrow(/out of range/);
		expect(() => parseSwipeSelector("2-9", 3)).toThrow(/out of range/);
		expect(() => parseSwipeSelector("abc", 3)).toThrow(/Invalid swipe selector/);
	});
});

describe("summarizeSwipeMessage", () => {
	const message = fauxAssistantMessage([
		fauxThinking("thinking about the answer in some depth"),
		fauxText("the visible answer"),
		fauxToolCall("read", { path: "/very/long/path/to/a/file" }, { id: "tc1" }),
	]);

	it("summarizes all sections by default", () => {
		const lines = summarizeSwipeMessage(message, undefined, 256);
		expect(lines).toEqual([
			"reasoning: thinking about the answer in some depth",
			"content: the visible answer",
			'read({"path":"/very/long/path/to/a/file"})',
		]);
	});

	it("filters sections and truncates with an ellipsis", () => {
		expect(summarizeSwipeMessage(message, ["content"], 256)).toEqual(["content: the visible answer"]);
		expect(summarizeSwipeMessage(message, ["reasoning"], 10)).toEqual(["reasoning: thinking a…"]);
		expect(summarizeSwipeMessage(message, ["tool"], 10)).toEqual(['read({"path":"/…)']);
	});

	it("handles plain user text", () => {
		expect(summarizeSwipeMessage({ role: "user", content: "hello", timestamp: 1 }, undefined, 256)).toEqual([
			"content: hello",
		]);
	});

	it("omits empty sections", () => {
		const plain = fauxAssistantMessage("just text");
		expect(summarizeSwipeMessage(plain, undefined, 256)).toEqual(["content: just text"]);
	});
});

describe("parseSwipeSearchChars", () => {
	it("parses +N, -N, and -N,+N", () => {
		expect(parseSwipeSearchChars("+64", 256)).toEqual({ before: 0, after: 64, caseSensitive: true });
		expect(parseSwipeSearchChars("-64", 256)).toEqual({ before: 64, after: 256, caseSensitive: true });
		expect(parseSwipeSearchChars("-64,+32", 256)).toEqual({ before: 64, after: 32, caseSensitive: true });
		expect(parseSwipeSearchChars("abc", 256)).toBeUndefined();
		expect(parseSwipeSearchChars("64", 256)).toBeUndefined();
	});
});

describe("searchSwipeMessage", () => {
	const message = fauxAssistantMessage([
		fauxThinking("Needle in reasoning, and another Needle"),
		fauxText("a needle in content"),
		fauxToolCall("grep", { pattern: "needle" }, { id: "tc1" }),
	]);

	it("finds matches across reasoning, content, and tool calls", () => {
		const lines = searchSwipeMessage(message, "Needle", { before: 0, after: 10, caseSensitive: true });
		expect(lines).toEqual(["reasoning: Needle in reason…", "reasoning: …Needle"]);
	});

	it("is case-insensitive for isearch", () => {
		const lines = searchSwipeMessage(message, "needle", { before: 0, after: 0, caseSensitive: false });
		expect(lines.length).toBe(4);
		expect(lines[0]).toBe("reasoning: Needle…");
		expect(lines[2]).toBe("content: …needle…");
	});

	it("honors before/after context with ellipses", () => {
		const lines = searchSwipeMessage(message, "another", { before: 5, after: 5, caseSensitive: true });
		expect(lines).toEqual(["reasoning: … and another Need…"]);
	});

	it("returns no lines when nothing matches", () => {
		expect(searchSwipeMessage(message, "absent", { before: 0, after: 10, caseSensitive: true })).toEqual([]);
		expect(searchSwipeMessage(message, "", { before: 0, after: 10, caseSensitive: true })).toEqual([]);
	});
});

describe("swipeSummaryChars setting", () => {
	it("defaults to 256 and persists overrides", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-swipe-settings-"));
		tempDirs.push(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		expect(settingsManager.getSwipeSummaryChars()).toBe(256);
		settingsManager.setSwipeSummaryChars(64);
		expect(settingsManager.getSwipeSummaryChars()).toBe(64);
	});
});
