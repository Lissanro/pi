import { describe, expect, it } from "vitest";
import { type AssistantMessage, contentText, contentToTokenizeText, type ToolResultMessage } from "../src/index.ts";

const content: AssistantMessage["content"] = [
	{ type: "thinking", thinking: "reasoning" },
	{ type: "text", text: "first" },
	{ type: "toolCall", id: "1", name: "read", arguments: {} },
	{ type: "text", text: "second" },
];

describe("contentText", () => {
	it("extracts assistant text blocks", () => {
		expect(contentText(content)).toBe("first\nsecond");
	});

	it("supports custom separators", () => {
		expect(contentText(content, "")).toBe("firstsecond");
	});

	it("passes string content through", () => {
		expect(contentText("hello")).toBe("hello");
	});

	it("extracts text from tool-result content", () => {
		const toolResultContent: ToolResultMessage["content"] = [
			{ type: "text", text: "first" },
			{ type: "image", data: "...", mimeType: "image/png" },
			{ type: "text", text: "second" },
		];

		expect(contentText(toolResultContent, "")).toBe("firstsecond");
	});
});

describe("contentToTokenizeText", () => {
	it("includes thinking and tool calls, and counts images", () => {
		expect(contentToTokenizeText(content)).toEqual({
			text: "reasoningfirstread\n{}second",
			imageCount: 0,
		});
	});

	it("counts image blocks and skips their base64 data", () => {
		const imageContent: ToolResultMessage["content"] = [
			{ type: "text", text: "look" },
			{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
			{ type: "image", data: "MORE", mimeType: "image/jpeg" },
		];
		expect(contentToTokenizeText(imageContent)).toEqual({
			text: "look",
			imageCount: 2,
		});
	});

	it("passes string content through", () => {
		expect(contentToTokenizeText("hello")).toEqual({ text: "hello", imageCount: 0 });
	});
});
