import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
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
			'<pi_edit id="0" role="assistant"><pi_reasoning_content>think</pi_reasoning_content>answer</pi_edit>',
		);
	});

	it("formats an assistant message with a tool call", () => {
		const message = fauxAssistantMessage([fauxText("ok"), fauxToolCall("read", { path: "/foo" }, { id: "call_1" })], {
			timestamp: 1,
		});
		const xml = formatMessageForEdit(0, message);
		expect(xml).toContain('<pi_edit id="0" role="assistant">');
		expect(xml).toContain("ok");
		expect(xml).toContain('<pi_tool_call id="call_1" name="read">');
		expect(xml).toContain('"path":"/foo"');
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

	it("edits the latest message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("user");

		const result = harness.session.applyMessageEdits('<pi_edit id="0" role="assistant">edited hi</pi_edit>');
		expect(result).toEqual({ edited: 1, added: 0 });
		expect(getAssistantTexts(harness)).toEqual(["edited hi"]);
	});

	it("edits the message before the latest", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("user");

		const result = harness.session.applyMessageEdits('<pi_edit id="1" role="user">edited user</pi_edit>');
		expect(result).toEqual({ edited: 1, added: 0 });
		expect(getMessageText(harness.session.messages[0])).toBe("edited user");
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
		expect(result).toEqual({ edited: 1, added: 0 });
		expect(getAssistantTexts(harness)).toEqual(["edited ok"]);
	});

	it("adds new messages with negative ids", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("user");

		const result = harness.session.applyMessageEdits(
			'<pi_edit id="-1" role="assistant">new assistant</pi_edit><pi_edit id="-2" role="user">new user</pi_edit>',
		);
		expect(result).toEqual({ edited: 0, added: 2 });
		const texts = harness.session.messages.map((m) => getMessageText(m));
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
		expect(result).toEqual({ edited: 1, added: 1 });
		const texts = harness.session.messages.map((m) => getMessageText(m));
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
		expect((assistantMessage as { stopReason?: string }).stopReason).toBe("toolUse");
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

	it("getEditableMessageText returns text for the indexed message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");

		expect(harness.session.getEditableMessageText(0)).toBe("ok");
		expect(harness.session.getEditableMessageText(1)).toBe("hello");
		expect(harness.session.getEditableMessageText(5)).toBeUndefined();
	});

	it("getEditableMessageText includes tool calls for assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxText("Let me check."), fauxToolCall("bash", { command: "ls" }, { id: "call_1" })]),
		]);
		await harness.session.prompt("check");

		const text = harness.session.getEditableMessageText(0);
		expect(text).toContain("Let me check.");
		expect(text).toContain('<tool_call id="call_1" name="bash">');
		expect(text).toContain('"command":"ls"');
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
});
