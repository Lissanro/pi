import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function visibleTexts(harness: Harness): string[] {
	return harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m));
}

function lastAssistantMessage(harness: Harness): AssistantMessage {
	return harness.session.messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
}

describe("AgentSession soft delete and restore", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("soft delete hides the message from agent state and edit indices", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		expect(harness.session.softDeleteLastMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["first question", "first answer", "second question"]);

		// Edit indices no longer count the deleted message: index 0 is the user message.
		expect(getMessageText(harness.session.getEditableMessage(0)!.message)).toBe("second question");
		expect(harness.session.getEditableMessagesContaining("second answer")).toHaveLength(0);

		// The unit is still in the session log, marked deleted.
		const deleted = harness.sessionManager.getDeletedUnits();
		expect(deleted).toHaveLength(1);
		const entry = harness.sessionManager.getEntry(deleted[0].entryId);
		expect(entry?.type).toBe("message");
		expect(getMessageText((entry as { message: Parameters<typeof getMessageText>[0] }).message)).toBe(
			"second answer",
		);
		expect(entry?.deletedAt).toBeDefined();
	});

	it("restores batched deletions context-earlier first", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("question");

		expect(harness.session.softDeleteLastMessages(2)).toHaveLength(2);
		expect(visibleTexts(harness)).toEqual([]);

		// The user question (context-earlier) comes back first.
		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question"]);
		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "answer"]);
		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(0);
	});

	it("restores separate deletes in LIFO order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("question");

		expect(harness.session.softDeleteLastMessages(1)).toHaveLength(1); // answer
		expect(harness.session.softDeleteLastMessages(1)).toHaveLength(1); // question
		expect(visibleTexts(harness)).toEqual([]);

		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question"]);
		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "answer"]);
	});

	it("soft-deletes a single message by entry id", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		const target = harness.session.getEditableMessagesContaining("first answer");
		expect(target).toHaveLength(1);
		expect(harness.session.softDeleteMessage(target[0].entryId)).toBe(true);
		expect(visibleTexts(harness)).toEqual(["first question", "second question", "second answer"]);

		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["first question", "first answer", "second question", "second answer"]);
	});

	it("delete count spans only visible entries across a soft-deleted range", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a3")]);
		await harness.session.prompt("q1");
		await harness.session.prompt("q2");
		await harness.session.prompt("q3");

		expect(harness.session.softDeleteLastMessages(2)).toHaveLength(2); // a3, q3 hidden
		expect(harness.session.softDeleteLastMessages(2)).toHaveLength(2); // a2, q2 hidden
		expect(visibleTexts(harness)).toEqual(["q1", "a1"]);

		expect(harness.session.restoreDeletedMessages(4)).toHaveLength(4);
		expect(visibleTexts(harness)).toEqual(["q1", "a1", "q2", "a2", "q3", "a3"]);
	});
});

describe("AgentSession delete granularity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function toolCallHarness(): Promise<Harness> {
		const harness = await createHarness();
		harnesses.push(harness);
		// Append the transcript directly (no agent loop, so no tool execution).
		harness.sessionManager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxText("let me read"), fauxToolCall("read", { path: "/a" }, { id: "tc1" })], {
				stopReason: "toolUse",
			}),
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
		return harness;
	}

	it("deletes the tool result, then the tool call, then the message", async () => {
		const harness = await toolCallHarness();
		expect(visibleTexts(harness)).toEqual(["question", "let me read", "file contents"]);

		// 1: the tool result goes first.
		expect(harness.session.softDeleteLastMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "let me read"]);
		// The tool call block is still on the message.
		expect(lastAssistantMessage(harness).content.some((b) => b.type === "toolCall")).toBe(true);

		// 2: now the tool call block goes, but the message (and its text) stays.
		expect(harness.session.softDeleteLastMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "let me read"]);
		expect(lastAssistantMessage(harness).content.some((b) => b.type === "toolCall")).toBe(false);

		// 3: with no tool calls left, the message itself goes.
		expect(harness.session.softDeleteLastMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question"]);

		// Restore brings them back context-earlier first: message, tool call, result.
		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "let me read"]);
		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(lastAssistantMessage(harness).content.some((b) => b.type === "toolCall")).toBe(true);
		expect(harness.session.restoreDeletedMessages(1)).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "let me read", "file contents"]);
	});

	it("deleting a compaction boundary un-compacts the context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("new answer")]);
		await harness.session.prompt("old question");
		await harness.session.prompt("new question");

		// Compact: summary replaces everything before the last user message.
		const lastUserEntryId = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.at(-1)!.id;
		harness.sessionManager.appendCompaction("summary of old", lastUserEntryId, 100);
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		expect(harness.session.messages.filter((m) => m.role !== "system").map((m) => m.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
		]);

		// The compaction boundary is a deletable unit: deleting it un-compacts.
		const units = harness.session.getDeletableUnits();
		expect(units.some((unit) => unit.entry.type === "compaction")).toBe(true);
		const deleted = harness.session.softDeleteLastMessages(3);
		expect(deleted.map((unit) => unit.entry.type)).toEqual(["message", "message", "compaction"]);
		expect(visibleTexts(harness)).toEqual(["old question", "old answer"]);
	});

	it("shred removes the tool result, then the tool call, then the message permanently", async () => {
		const harness = await toolCallHarness();

		expect(harness.session.shredLastMessages(1)).toHaveLength(1); // tool result
		expect(visibleTexts(harness)).toEqual(["question", "let me read"]);
		expect(harness.session.shredLastMessages(1)).toHaveLength(1); // tool call
		expect(lastAssistantMessage(harness).content.some((b) => b.type === "toolCall")).toBe(false);
		expect(harness.session.shredLastMessages(1)).toHaveLength(1); // the message
		expect(visibleTexts(harness)).toEqual(["question"]);

		// Nothing left to restore.
		expect(harness.session.restoreDeletedMessages(3)).toHaveLength(0);
		expect(harness.sessionManager.getDeletedUnits()).toHaveLength(0);
	});
});
