import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Message,
	type ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatMessageContent,
	formatMessageForEdit,
	isMessageEdit,
	parseMessageEdits,
} from "../../src/core/message-edit.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

describe("message edit XML format", () => {
	it("formats a simple user message", () => {
		const message: AgentMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
		expect(formatMessageForEdit(0, message)).toBe('<pi_edit id="0" role="user">hello</pi_edit>');
	});

	it("preserves raw text including angle brackets and ampersands", () => {
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "a < b & c > d" }],
			timestamp: 1,
		};
		expect(formatMessageForEdit(0, message)).toBe('<pi_edit id="0" role="user">a < b & c > d</pi_edit>');
	});

	it("formats a user message with an image", () => {
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look:" },
				{ type: "image", data: "base64abc", mimeType: "image/png" },
			],
			timestamp: 1,
		};
		expect(formatMessageForEdit(2, message)).toBe(
			'<pi_edit id="2" role="user">look:<pi_image mimeType="image/png">base64abc</pi_image></pi_edit>',
		);
	});

	it("formats an assistant message with reasoning and text", () => {
		const message = fauxAssistantMessage([fauxThinking("think"), fauxText("answer")], { timestamp: 1 });
		expect(formatMessageForEdit(0, message)).toBe(
			'<pi_edit id="0" role="assistant" aborted="false"><pi_reasoning_content>think</pi_reasoning_content><pi_content>answer</pi_content></pi_edit>',
		);
	});

	it("formats an assistant message with a tool call", () => {
		const message = fauxAssistantMessage([fauxText("ok"), fauxToolCall("read", { path: "/foo" }, { id: "call_1" })], {
			timestamp: 1,
		});
		const xml = formatMessageForEdit(0, message);
		expect(xml).toBe(
			'<pi_edit id="0" role="assistant" aborted="false"><pi_content>ok</pi_content><pi_tool_call id="call_1" name="read">{"path":"/foo"}</pi_tool_call></pi_edit>',
		);
	});

	it("formats an aborted assistant message with aborted=true", () => {
		const message = fauxAssistantMessage([fauxText("partial")], { timestamp: 1, stopReason: "aborted" });
		expect(formatMessageForEdit(0, message)).toBe(
			'<pi_edit id="0" role="assistant" aborted="true"><pi_content>partial</pi_content></pi_edit>',
		);
	});

	it("formats tool results after their tool calls", () => {
		const message = fauxAssistantMessage(
			[
				fauxText("ok"),
				fauxToolCall("bash", { command: "ls" }, { id: "tc1" }),
				fauxToolCall("read", { path: "/a" }, { id: "tc2" }),
			],
			{ timestamp: 1 },
		);
		const results = new Map<string, ToolResultMessage>([
			[
				"tc1",
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "line one\nline two" }],
					isError: false,
					timestamp: 1,
				},
			],
			[
				"tc2",
				{
					role: "toolResult",
					toolCallId: "tc2",
					toolName: "read",
					content: [{ type: "text", text: "boom" }],
					isError: true,
					timestamp: 1,
				},
			],
		]);
		expect(formatMessageForEdit(0, message, results)).toBe(
			'<pi_edit id="0" role="assistant" aborted="false"><pi_content>ok</pi_content><pi_tool_call id="tc1" name="bash">{"command":"ls"}</pi_tool_call><pi_tool_result id="tc1">line one\nline two</pi_tool_result><pi_tool_call id="tc2" name="read">{"path":"/a"}</pi_tool_call><pi_tool_result id="tc2" isError="true">boom</pi_tool_result></pi_edit>',
		);
	});

	it("omits results that have no entry in the tool result map", () => {
		const message = fauxAssistantMessage(
			[fauxToolCall("bash", { command: "ls" }, { id: "tc1" }), fauxToolCall("read", { path: "/a" }, { id: "tc2" })],
			{ timestamp: 1 },
		);
		const results = new Map<string, ToolResultMessage>([
			[
				"tc1",
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 1,
				},
			],
		]);
		const xml = formatMessageForEdit(0, message, results);
		expect(xml).toContain('<pi_tool_result id="tc1">ok</pi_tool_result>');
		expect(xml).not.toContain('id="tc2" isError');
		expect(xml?.match(/<pi_tool_result /g)).toHaveLength(1);
	});

	it("formats tool result image content as pi_image blocks", () => {
		const message = fauxAssistantMessage([fauxToolCall("screenshot", {}, { id: "tc1" })], { timestamp: 1 });
		const results = new Map<string, ToolResultMessage>([
			[
				"tc1",
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "screenshot",
					content: [
						{ type: "text", text: "captured" },
						{ type: "image", data: "base64abc", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 1,
				},
			],
		]);
		expect(formatMessageForEdit(0, message, results)).toBe(
			'<pi_edit id="0" role="assistant" aborted="false"><pi_tool_call id="tc1" name="screenshot">{}</pi_tool_call><pi_tool_result id="tc1">captured<pi_image mimeType="image/png">base64abc</pi_image></pi_tool_result></pi_edit>',
		);
	});

	it("returns null for non-editable roles", () => {
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 1,
		};
		expect(formatMessageForEdit(0, toolResult)).toBeNull();
	});

	it("formatMessageContent returns inner content without pi_edit wrapper", () => {
		const message = fauxAssistantMessage([fauxText("hello"), fauxToolCall("bash", { command: "ls" }, { id: "c1" })]);
		const content = formatMessageContent(message);
		expect(content).toContain("hello");
		expect(content).toContain('<pi_tool_call id="c1" name="bash">');
		expect(content).not.toContain("<pi_edit");
	});
});

describe("message edit XML parsing", () => {
	it("parses a user edit block", () => {
		const blocks = parseMessageEdits('<pi_edit id="0" role="user">hello</pi_edit>');
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toEqual({
			id: 0,
			role: "user",
			content: [{ type: "text", text: "hello" }],
		});
	});

	it("preserves raw text including XML entities and angle brackets", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="user">See <https://example.com> and a < b & c > d &lt; &amp;gt;</pi_edit>',
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.content).toEqual([
			{ type: "text", text: "See <https://example.com> and a < b & c > d &lt; &amp;gt;" },
		]);
	});

	it("treats nested pi_edit tags as raw text", () => {
		const blocks = parseMessageEdits('<pi_edit id="0" role="user">discuss <pi_edit>inner</pi_edit> text</pi_edit>');
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.content).toEqual([{ type: "text", text: "discuss <pi_edit>inner</pi_edit> text" }]);
	});

	it("parses an assistant edit block with reasoning and text", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_reasoning_content>think</pi_reasoning_content>answer</pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "text", text: "answer" },
		]);
	});

	it("parses a signed reasoning block (with signature attribute) as thinking, not raw XML", () => {
		const xml =
			'<pi_edit id="0" role="assistant"><pi_reasoning_content signature="reasoning_content">think</pi_reasoning_content>answer</pi_edit>';
		const blocks = parseMessageEdits(xml);
		expect(blocks[0]?.content).toEqual([
			{ type: "thinking", thinking: "think", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer" },
		]);
	});

	it("parses multiple edit blocks", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="1" role="user">first</pi_edit><pi_edit id="0" role="assistant">second</pi_edit>',
		);
		expect(blocks).toHaveLength(2);
		expect(blocks.map((b) => b.id)).toEqual([1, 0]);
	});

	it("ignores leading whitespace before the first pi_edit tag", () => {
		const blocks = parseMessageEdits('  \n<pi_edit id="-1" role="user">new</pi_edit>');
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.id).toBe(-1);
	});

	it("returns empty when pi_edit appears after other text", () => {
		expect(parseMessageEdits('discuss <pi_edit id="0" role="user">x</pi_edit>')).toHaveLength(0);
	});

	it("ignores pi_tool_call in the middle of text", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant">discuss <pi_tool_call id="c1" name="read">{"path":"/foo"}</pi_tool_call> topic</pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{
				type: "text",
				text: 'discuss <pi_tool_call id="c1" name="read">{"path":"/foo"}</pi_tool_call> topic',
			},
		]);
	});

	it("parses trailing tool calls after text", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant">ok<pi_tool_call id="call_1" name="read">{"path":"/foo"}</pi_tool_call></pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/foo" } },
		]);
	});

	it("parses multiple trailing tool calls", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant">ok<pi_tool_call id="c1" name="read">{"path":"/a"}</pi_tool_call><pi_tool_call id="c2" name="bash">{"command":"ls"}</pi_tool_call></pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
		]);
	});

	it("parses tool results carried with their tool calls", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_tool_call id="tc1" name="bash">{"command":"ls"}</pi_tool_call><pi_tool_result id="tc1" isError="true">line one</pi_tool_result></pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }]);
		expect(blocks[0]?.toolResults).toEqual([
			{ id: "tc1", content: [{ type: "text", text: "line one" }], isError: true },
		]);
	});

	it("parses multiple tool calls with interleaved results in pi_content format", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_content>ok</pi_content><pi_tool_call id="c1" name="read">{"path":"/a"}</pi_tool_call><pi_tool_result id="c1">ra</pi_tool_result><pi_tool_call id="c2" name="bash">{"command":"ls"}</pi_tool_call><pi_tool_result id="c2">rb</pi_tool_result></pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
		]);
		expect(blocks[0]?.toolResults).toEqual([
			{ id: "c1", content: [{ type: "text", text: "ra" }], isError: false },
			{ id: "c2", content: [{ type: "text", text: "rb" }], isError: false },
		]);
	});

	it("parses tool result image content", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_tool_call id="tc1" name="shot">{}</pi_tool_call><pi_tool_result id="tc1">captured<pi_image mimeType="image/png">base64abc</pi_image></pi_tool_result></pi_edit>',
		);
		expect(blocks[0]?.toolResults).toEqual([
			{
				id: "tc1",
				content: [
					{ type: "text", text: "captured" },
					{ type: "image", data: "base64abc", mimeType: "image/png" },
				],
				isError: false,
			},
		]);
	});

	it("ignores a pi_tool_result in the middle of legacy text", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant">discuss <pi_tool_result id="tc1">out</pi_tool_result> topic</pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "text", text: 'discuss <pi_tool_result id="tc1">out</pi_tool_result> topic' },
		]);
		expect(blocks[0]?.toolResults).toBeUndefined();
	});

	it("round-trips a tool call with its result through format and parse", () => {
		const message = fauxAssistantMessage([fauxText("ok"), fauxToolCall("bash", { command: "ls" }, { id: "tc1" })], {
			timestamp: 1,
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "bash",
			content: [{ type: "text", text: "a <b> & c" }],
			isError: false,
			timestamp: 1,
		};
		const xml = formatMessageForEdit(0, message, new Map([["tc1", result]]));
		const blocks = parseMessageEdits(xml!);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
		]);
		expect(blocks[0]?.toolResults).toEqual([
			{ id: "tc1", content: [{ type: "text", text: "a <b> & c" }], isError: false },
		]);
		// Formatting the parsed unit again is stable.
		expect(formatMessageForEdit(0, message, new Map([["tc1", result]])!)).toBe(xml);
	});

	it("parses an assistant message with pi_content wrapping the main text", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_reasoning_content>think</pi_reasoning_content><pi_content>answer</pi_content></pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "text", text: "answer" },
		]);
	});

	it("does not split the reasoning block on stray reasoning tags inside it", () => {
		// The thinking text itself discusses `<pi_reasoning_content>` tags, so it
		// contains stray opening and closing tags. The real close is the last one.
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_reasoning_content>The <pi_reasoning_content> and </pi_reasoning_content> tags should not split me</pi_reasoning_content>answer</pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{
				type: "thinking",
				thinking: "The <pi_reasoning_content> and </pi_reasoning_content> tags should not split me",
			},
			{ type: "text", text: "answer" },
		]);
	});

	it("excludes stray reasoning tags in pi_content-wrapped main text", () => {
		// The main text mentions `</pi_reasoning_content>` literally; the pi_content
		// wrapper marks the boundary so the reasoning block is not extended into it.
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_reasoning_content>think</pi_reasoning_content><pi_content>mention </pi_reasoning_content> here</pi_content></pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "text", text: "mention </pi_reasoning_content> here" },
		]);
	});

	it("parses tool call JSON containing stray closing tags", () => {
		const blocks = parseMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_content>ok</pi_content><pi_tool_call id="c1" name="read">{"note":"a </pi_tool_call> inside"}</pi_tool_call></pi_edit>',
		);
		expect(blocks[0]?.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { note: "a </pi_tool_call> inside" } },
		]);
	});

	it("round-trips the pi_content format through format and parse", () => {
		const message = fauxAssistantMessage([fauxThinking("think"), fauxText("answer")], { timestamp: 1 });
		const xml = formatMessageForEdit(0, message);
		expect(xml).not.toBeNull();
		const blocks = parseMessageEdits(xml!);
		expect(blocks[0]?.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "text", text: "answer" },
		]);
	});
});

describe("isMessageEdit", () => {
	it("detects edit messages starting with pi_edit", () => {
		expect(isMessageEdit('<pi_edit id="0" role="user">x</pi_edit>')).toBe(true);
		expect(isMessageEdit('  <pi_edit id="0" role="user">x</pi_edit>')).toBe(true);
	});

	it("rejects messages with pi_edit later in text", () => {
		expect(isMessageEdit('hello <pi_edit id="0" role="user">x</pi_edit>')).toBe(false);
	});

	it("rejects similar tag names", () => {
		expect(isMessageEdit("<pi_editor>not an edit</pi_editor>")).toBe(false);
	});
});

describe("AgentSession.applyMessageEdits", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("creates a new swipe version when editing the latest message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("user");

		const result = harness.session.applyMessageEdits('<pi_edit id="0" role="assistant">edited hi</pi_edit>');
		expect(result).toEqual({ edited: 0, added: 0, versioned: 1, swiped: 0 });
		// The original version stays as the previous swipe (on its branch); the
		// edited message is the new current version.
		expect(getAssistantTexts(harness)).toEqual(["edited hi"]);
		const group = harness.session.getSwipeGroup();
		expect(group?.versions).toHaveLength(2);
		expect(group?.currentIndex).toBe(1);
		expect(getMessageText(group!.versions[0].message)).toBe("hi");
	});

	it("edits the message before the latest", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("user");

		const result = harness.session.applyMessageEdits('<pi_edit id="1" role="user">edited user</pi_edit>');
		expect(result).toEqual({ edited: 1, added: 0, versioned: 0, swiped: 0 });
		expect(getMessageText(harness.session.messages[1])).toBe("edited user");
		expect(getAssistantTexts(harness)).toEqual(["first"]);
	});

	it("skips harness messages when counting", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("user");

		// Append a harness message (empty assistant message).
		harness.session.agent.state.messages.push({
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		});

		const result = harness.session.applyMessageEdits('<pi_edit id="0" role="assistant">edited ok</pi_edit>');
		expect(result).toEqual({ edited: 0, added: 0, versioned: 1, swiped: 0 });
		expect(getAssistantTexts(harness)).toEqual(["edited ok"]);
		const group = harness.session.getSwipeGroup();
		expect(group?.versions).toHaveLength(2);
		expect(getMessageText(group!.versions[0].message)).toBe("ok");
	});

	it("adds new messages with negative ids", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("user");

		const result = harness.session.applyMessageEdits(
			'<pi_edit id="-1" role="assistant">new assistant</pi_edit><pi_edit id="-2" role="user">new user</pi_edit>',
		);
		expect(result).toEqual({ edited: 0, added: 2, versioned: 0, swiped: 0 });
		const texts = harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m));
		expect(texts).toEqual(["user", "hi", "new assistant", "new user"]);
	});

	it("edits and adds in one command", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("user");

		const result = harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant">edited hi</pi_edit><pi_edit id="-1" role="user">new user</pi_edit>',
		);
		expect(result).toEqual({ edited: 0, added: 1, versioned: 1, swiped: 0 });
		// The id=0 edit becomes a new version (the original stays as the
		// previous swipe on its branch), and the negative id appends after it.
		const texts = harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m));
		expect(texts).toEqual(["user", "edited hi", "new user"]);
	});

	it("throws when a positive id is out of range", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("user", { expandPromptTemplates: false });
		expect(() => harness.session.applyMessageEdits('<pi_edit id="5" role="user">x</pi_edit>')).toThrow(
			"No message to edit at id=5",
		);
	});

	it("round-trips a user message with an image", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("user", { expandPromptTemplates: false });

		const xml = '<pi_edit id="0" role="user">look:<pi_image mimeType="image/png">base64abc</pi_image></pi_edit>';
		harness.session.applyMessageEdits(xml);

		const userMessage = harness.session.messages.find((m) => m.role === "user");
		expect(userMessage?.content).toEqual([
			{ type: "text", text: "look:" },
			{ type: "image", data: "base64abc", mimeType: "image/png" },
		]);
	});

	it("round-trips an assistant message with a tool call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("user");

		const xml =
			'<pi_edit id="0" role="assistant">ok<pi_tool_call id="call_1" name="read">{"path":"/foo"}</pi_tool_call></pi_edit>';
		harness.session.applyMessageEdits(xml);

		const assistantMessage = harness.session.messages.find((m) => m.role === "assistant");
		expect(assistantMessage?.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/foo" } },
		]);
		// The edited message keeps its original completed status; the aborted state
		// is only set explicitly via the aborted attribute on the edit tag.
		expect((assistantMessage as { stopReason?: string }).stopReason).toBe("stop");
	});

	it("preserves harness messages when editing earlier messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("user");

		// Append a harness message (empty assistant) after the real assistant message.
		const harnessMessage: AgentMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		harness.session.sessionManager.appendMessage(harnessMessage as Message);
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		harness.session.applyMessageEdits('<pi_edit id="1" role="user">edited user</pi_edit>');

		const assistantMessages = harness.session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages).toHaveLength(2);
		expect(getMessageText(assistantMessages[0])).toBe("ok");
		expect(getMessageText(assistantMessages[1])).toBe("");
	});

	it("getEditableMessage returns messages counting from the latest", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("user");

		const latest = harness.session.getEditableMessage(0);
		expect(latest?.message.role).toBe("assistant");
		expect(getMessageText(latest!.message)).toBe("ok");

		const previous = harness.session.getEditableMessage(1);
		expect(previous?.message.role).toBe("user");
		expect(getMessageText(previous!.message)).toBe("user");
	});

	it("getEditableMessageText returns raw text for the indexed message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");

		expect(harness.session.getEditableMessageText(0)).toBe("ok");
		expect(harness.session.getEditableMessageText(1)).toBe("hello");
		expect(harness.session.getEditableMessageText(5)).toBeUndefined();
	});

	it("getEditableMessageText does not double-escape XML entities", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage([fauxText("&gt; &amp;gt;")])]);
		await harness.session.prompt("check");

		expect(harness.session.getEditableMessageText(0)).toBe("&gt; &amp;gt;");
	});

	it("getEditableMessageText ignores tool calls and reasoning blocks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxText("Let me check."), fauxToolCall("bash", { command: "ls" }, { id: "call_1" })]),
		]);
		await harness.session.prompt("check");

		expect(harness.session.getEditableMessageText(0)).toBe("Let me check.");
	});

	it("getLastAssistantText skips harness messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("real")]);
		await harness.session.prompt("user");

		// Append a harness message (empty assistant) after the real assistant message.
		const harnessMessage: AgentMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		harness.session.sessionManager.appendMessage(harnessMessage as Message);
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		expect(harness.session.getLastAssistantText()).toBe("real");
	});

	it("throws while streaming", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Simulate an active agent run by pushing a message and marking the session busy.
		await harness.session.prompt("user", { expandPromptTemplates: false });
		(harness.session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive = true;
		expect(() => harness.session.applyMessageEdits('<pi_edit id="0" role="user">x</pi_edit>')).toThrow(
			"Cannot edit messages while the agent is running",
		);
	});

	it("keeps the original completed status on a trailing edited assistant message without tool calls", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("original answer")]);
		await harness.session.prompt("question");

		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_content>edited answer</pi_content></pi_edit>',
		);
		const edited = harness.session.messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
		expect(getMessageText(edited)).toBe("edited answer");
		// The original was completed; editing must not flip it to aborted.
		expect(edited.stopReason).toBe("stop");
	});

	it("keeps the original completed status on an edited assistant message with an unanswered tool call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("original answer")]);
		await harness.session.prompt("question");

		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_content>edited</pi_content><pi_tool_call id="tc1" name="read">{"path":"/a"}</pi_tool_call></pi_edit>',
		);
		const edited = harness.session.messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
		expect(edited.stopReason).toBe("stop");
	});

	it("marks an edited assistant message aborted when the edit tag sets aborted=true", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("original answer")]);
		await harness.session.prompt("question");

		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant" aborted="true"><pi_content>edited answer</pi_content></pi_edit>',
		);
		const edited = harness.session.messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
		expect(getMessageText(edited)).toBe("edited answer");
		expect(edited.stopReason).toBe("aborted");
	});

	it("marks an edited assistant message aborted when the edit tag sets aborted=1", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("original answer")]);
		await harness.session.prompt("question");

		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant" aborted="1"><pi_content>edited answer</pi_content></pi_edit>',
		);
		const edited = harness.session.messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
		expect(edited.stopReason).toBe("aborted");
	});

	it("copies a trailing assistant message's tool results onto a new id=0 swipe version", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("user", { expandPromptTemplates: false });
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: "/foo" }, { id: "tc1" })], {
				stopReason: "toolUse",
			}) as Message,
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_tool_call id="tc1" name="read">{"path":"/foo"}</pi_tool_call></pi_edit>',
		);

		// The new swipe version keeps its own copy of the tool result.
		const resultAfter = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(resultAfter).toHaveLength(1);
		expect((resultAfter[0] as { toolCallId?: string }).toolCallId).toBe("tc1");
		expect(getMessageText(resultAfter[0])).toBe("file contents");
		// Both the original and the new version are present as a swipe group.
		expect(harness.session.getSwipeGroup()!.versions).toHaveLength(2);
	});

	function seedToolCallUnit(harness: Harness, resultText: string, toolCallId = "tc1"): void {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "question" }],
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxText("reading"), fauxToolCall("read", { path: "/foo" }, { id: toolCallId })], {
				stopReason: "toolUse",
			}) as Message,
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: resultText }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;
	}

	it("edits a tool result in place with its message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Two turns: the second keeps the first mid-transcript so id=1 edits
		// in place instead of versioning.
		seedToolCallUnit(harness, "original result");
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "question two" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("second answer") as Message);
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		// Editable: second answer (0), question two (1), reading (2), question (3).
		harness.session.applyMessageEdits(
			'<pi_edit id="2" role="assistant" aborted="false"><pi_content>looking now</pi_content><pi_tool_call id="tc1" name="read">{"path":"/foo"}</pi_tool_call><pi_tool_result id="tc1" isError="true">edited result</pi_tool_result></pi_edit>',
		);

		const edited = harness.session.messages.filter((m) => m.role === "assistant")[0] as AssistantMessage;
		expect(getMessageText(edited)).toBe("looking now");
		const results = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(getMessageText(results[0])).toBe("edited result");
		expect((results[0] as { isError?: boolean }).isError).toBe(true);
		// The later turn is untouched.
		expect(getAssistantTexts(harness)).toEqual(["looking now", "second answer"]);
	});

	it("applies result overrides to the new swipe version's copies on id=0", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		seedToolCallUnit(harness, "file contents");

		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_content>reading</pi_content><pi_tool_call id="tc1" name="read">{"path":"/foo"}</pi_tool_call><pi_tool_result id="tc1">overridden result</pi_tool_result></pi_edit>',
		);

		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(2);
		// The current (new) version carries the override.
		expect(getMessageText(harness.session.messages.filter((m) => m.role === "toolResult")[0])).toBe(
			"overridden result",
		);
		// The original version keeps its own result.
		harness.session.goToSwipeVersion(group, 0);
		expect(getMessageText(harness.session.messages.filter((m) => m.role === "toolResult")[0])).toBe("file contents");
	});

	it("keeps the original version's result for a tool call removed from the id=0 message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		seedToolCallUnit(harness, "r1");
		const assistant = harness.session.messages.filter((m) => m.role === "assistant")[0] as AssistantMessage;
		assistant.content.push(fauxToolCall("read", { path: "/bar" }, { id: "tc2" }));
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc2",
			toolName: "read",
			content: [{ type: "text", text: "r2" }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		// The edit drops tc2; its result must not be copied onto the new version.
		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_content>reading</pi_content><pi_tool_call id="tc1" name="read">{"path":"/foo"}</pi_tool_call><pi_tool_result id="tc1">r1 edited</pi_tool_result></pi_edit>',
		);

		const current = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(current).toHaveLength(1);
		expect((current[0] as { toolCallId?: string }).toolCallId).toBe("tc1");
		expect(getMessageText(current[0])).toBe("r1 edited");
		const group = harness.session.getSwipeGroup()!;
		harness.session.goToSwipeVersion(group, 0);
		expect(harness.session.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
	});

	it("appends a result for a new tool call on an id=0 edit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		seedToolCallUnit(harness, "r1");

		harness.session.applyMessageEdits(
			'<pi_edit id="0" role="assistant"><pi_content>reading</pi_content><pi_tool_call id="tc1" name="read">{"path":"/foo"}</pi_tool_call><pi_tool_result id="tc1">r1 kept</pi_tool_result><pi_tool_call id="tc2" name="bash">{"command":"date"}</pi_tool_call><pi_tool_result id="tc2">new result</pi_tool_result></pi_edit>',
		);

		const results = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(2);
		const byId = new Map(results.map((m) => [(m as { toolCallId: string }).toolCallId, m]));
		expect(getMessageText(byId.get("tc1")!)).toBe("r1 kept");
		expect(getMessageText(byId.get("tc2")!)).toBe("new result");
		expect((byId.get("tc2")! as { toolName?: string }).toolName).toBe("bash");
	});

	it("appends tool results after a new message with a negative id", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("existing answer")]);
		await harness.session.prompt("question");

		harness.session.applyMessageEdits(
			'<pi_edit id="-1" role="assistant"><pi_content>new message</pi_content><pi_tool_call id="nc1" name="bash">{"command":"date"}</pi_tool_call><pi_tool_result id="nc1">new result</pi_tool_result></pi_edit>',
		);

		const tail = harness.session.messages.slice(-2);
		expect((tail[0] as AssistantMessage).stopReason).toBe("aborted");
		expect(getMessageText(tail[0])).toBe("new message");
		expect(tail[1].role).toBe("toolResult");
		expect((tail[1] as { toolCallId: string }).toolCallId).toBe("nc1");
		expect((tail[1] as { toolName?: string }).toolName).toBe("bash");
		expect(getMessageText(tail[1])).toBe("new result");
	});

	it("applies pi_swipe result edits in place without versioning", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		seedToolCallUnit(harness, "original");
		const group = harness.session.getSwipeGroup()!;
		const timestamp = group.versions[0].timestamp;

		const result = harness.session.applyMessageEdits(
			`<pi_swipe timestamp="${timestamp}" role="assistant"><pi_content>swiped</pi_content><pi_tool_call id="tc1" name="read">{"path":"/foo"}</pi_tool_call><pi_tool_result id="tc1">swiped result</pi_tool_result></pi_swipe>`,
		);
		expect(result.swiped).toBe(1);
		expect(result.versioned).toBe(0);
		expect(getMessageText(harness.session.messages.filter((m) => m.role === "assistant")[0])).toBe("swiped");
		const results = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(getMessageText(results[0])).toBe("swiped result");
	});

	it("formatEditableMessageForEdit includes the message's tool results", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		seedToolCallUnit(harness, "the result text");
		const xml = harness.session.formatEditableMessageForEdit(0);
		expect(xml).toContain('<pi_tool_call id="tc1" name="read">');
		expect(xml).toContain('<pi_tool_result id="tc1">the result text</pi_tool_result>');
	});

	it("formatSwipeMessageForEdit includes the version's tool results", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		seedToolCallUnit(harness, "the result text");
		const version = harness.session.getSwipeGroup()!.versions[0];
		const xml = harness.session.formatSwipeMessageForEdit(version.id);
		expect(xml).toContain(`<pi_swipe timestamp="${version.timestamp}"`);
		expect(xml).toContain('<pi_tool_result id="tc1">the result text</pi_tool_result>');
		expect(harness.session.formatSwipeMessageForEdit("nope")).toBeNull();
	});

	it("keeps the original status on a swipe-edited assistant version whose last tool call has a result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("original answer")]);
		await harness.session.prompt("question");

		// A tool result answering tc1 follows the assistant message: it is complete.
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		// A pi_swipe block edits the version in place (no new version created).
		const timestamp = harness.session.getSwipeGroup()!.versions[0].timestamp;
		const result = harness.session.applyMessageEdits(
			`<pi_swipe timestamp="${timestamp}" role="assistant"><pi_content>edited</pi_content><pi_tool_call id="tc1" name="read">{"path":"/a"}</pi_tool_call></pi_swipe>`,
		);
		expect(result.swiped).toBe(1);
		expect(result.versioned).toBe(0);
		const edited = harness.session.messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
		expect(edited.stopReason).toBe("stop");
		expect(getMessageText(edited)).toBe("edited");
		expect(harness.session.getSwipeGroup()!.versions).toHaveLength(1);
	});

	it("keeps stop on a mid-transcript edited assistant message without tool calls", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		// Edit the first assistant message (from-latest index 2 over editable
		// user+assistant messages: user1=3, asst1=2, user2=1, asst2=0). More
		// messages follow it, so it stays a completed message.
		harness.session.applyMessageEdits(
			'<pi_edit id="2" role="assistant"><pi_content>edited first</pi_content></pi_edit>',
		);
		const first = harness.session.messages.filter((m) => m.role === "assistant")[0] as AssistantMessage;
		expect(getMessageText(first)).toBe("edited first");
		expect(first.stopReason).toBe("stop");
	});
});

describe("AgentSession.getEditableMessagesContaining", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("returns chronological matches with indices counting from the latest", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("needles in hay"), fauxAssistantMessage("more hay")]);
		await harness.session.prompt("find the needle");
		await harness.session.prompt("again");

		const matches = harness.session.getEditableMessagesContaining("needle");
		expect(matches).toHaveLength(2);
		// Editable messages: "find the needle"(3), "needles in hay"(2), "again"(1), "more hay"(0).
		expect(matches[0].index).toBe(3);
		expect(getMessageText(matches[0].message)).toBe("find the needle");
		expect(matches[1].index).toBe(2);
		expect(getMessageText(matches[1].message)).toBe("needles in hay");
		// Indices match getEditableMessage()'s numbering.
		expect(harness.session.getEditableMessage(2)?.entryId).toBe(matches[1].entryId);
	});

	it("returns no matches when nothing contains the substring", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("user");

		expect(harness.session.getEditableMessagesContaining("absent")).toEqual([]);
	});

	it("skips harness messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("real")]);
		await harness.session.prompt("user");

		const harnessMessage: AgentMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		harness.session.sessionManager.appendMessage(harnessMessage as Message);
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		expect(harness.session.getEditableMessagesContaining("real")).toHaveLength(1);
	});

	it("matches thinking content and tool call arguments", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([
				fauxThinking("secret plan"),
				fauxText("answer"),
				fauxToolCall("read", { path: "/foo" }, { id: "call_1" }),
			]),
		]);
		await harness.session.prompt("user");

		expect(harness.session.getEditableMessagesContaining("secret plan")).toHaveLength(1);
		expect(harness.session.getEditableMessagesContaining('{"path":"/foo"}')).toHaveLength(1);
		expect(harness.session.getEditableMessagesContaining("pi_reasoning_content")).toHaveLength(1);
	});

	it("matches text that only appears in a tool result and selects the owning message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "list the vault" }],
			timestamp: now - 2000,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxText("here you go"), fauxToolCall("bash", { command: "ls" }, { id: "tc1" })], {
				stopReason: "toolUse",
			}) as Message,
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "bash",
			content: [{ type: "text", text: "uranus_processor_v2_outdoors.png\nuranus_processor_v2.py" }],
			isError: false,
			timestamp: now - 1000,
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		// The file name only exists in the tool result; the match must select
		// the assistant message that owns the call.
		const matches = harness.session.getEditableMessagesContaining("uranus_processor_v2_outdoors.png");
		expect(matches).toHaveLength(1);
		expect(matches[0].index).toBe(0);
		expect(getMessageText(matches[0].message)).toBe("here you go");
		// Message text and user text still match as before.
		expect(harness.session.getEditableMessagesContaining("here you go")).toHaveLength(1);
		expect(harness.session.getEditableMessagesContaining("list the vault")[0]?.index).toBe(1);
	});

	it("matches a pasted pi_edit block from /copy or /edit output", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([
				fauxThinking("secret plan"),
				fauxText("answer"),
				fauxToolCall("read", { path: "/foo" }, { id: "call_1" }),
			]),
		]);
		await harness.session.prompt("user");

		// /edit output now carries the tool results with the message as one
		// unit; the pasted block round-trips through the search.
		const pasted = harness.session.formatEditableMessageForEdit(0);
		expect(pasted).toContain("<pi_tool_result");
		const matches = harness.session.getEditableMessagesContaining(pasted!);
		expect(matches).toHaveLength(1);
		expect(matches[0].index).toBe(0);
	});

	it("getCopyableMessagesContaining includes tool results and carries editable indices", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("fence here")]);
		await harness.session.prompt("user with fence");
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "bash",
			content: [{ type: "text", text: "result with fence" }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		const matches = harness.session.getCopyableMessagesContaining("fence");
		expect(matches).toHaveLength(3);
		// Chronological: user (index 1), assistant (index 0), toolResult (no index).
		expect(matches[0].editableIndex).toBe(1);
		expect(matches[1].editableIndex).toBe(0);
		expect(matches[2].editableIndex).toBeUndefined();
		expect(matches[2].message.role).toBe("toolResult");
	});
});

describe("AgentSession.deleteMessage", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("deletes a middle message while preserving later messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		const target = harness.session.getEditableMessagesContaining("first answer");
		expect(target).toHaveLength(1);
		expect(harness.session.deleteMessage(target[0].entryId)).toBe(true);

		const texts = harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m));
		expect(texts).toEqual(["first question", "second question", "second answer"]);
		// Session log agrees with agent state.
		const branchTexts = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.filter((entry) => entry.message.role !== "system")
			.map((entry) => getMessageText(entry.message));
		expect(branchTexts).toEqual(["first question", "second question", "second answer"]);
	});

	it("deletes the latest message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("only answer")]);
		await harness.session.prompt("only question");

		const target = harness.session.getEditableMessage(0);
		expect(harness.session.deleteMessage(target!.entryId)).toBe(true);
		expect(harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m))).toEqual([
			"only question",
		]);
	});

	it("returns false for unknown or non-message entries", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("user");

		expect(harness.session.deleteMessage("nonexistent-id")).toBe(false);
		expect(harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m))).toEqual([
			"user",
			"ok",
		]);
	});
});
