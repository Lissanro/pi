import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function visibleTexts(harness: Harness): string[] {
	return harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m));
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

		expect(harness.session.softDeleteLastMessages(1)).toBe(1);
		expect(visibleTexts(harness)).toEqual(["first question", "first answer", "second question"]);

		// Edit indices no longer count the deleted message: index 0 is the user message.
		expect(getMessageText(harness.session.getEditableMessage(0)!.message)).toBe("second question");
		expect(harness.session.getEditableMessagesContaining("second answer")).toHaveLength(0);

		// The entry is still in the session log, marked deleted.
		const deleted = harness.sessionManager.getDeletedEntries();
		expect(deleted).toHaveLength(1);
		expect(deleted[0].type).toBe("message");
		expect(getMessageText((deleted[0] as { message: Parameters<typeof getMessageText>[0] }).message)).toBe(
			"second answer",
		);
		expect(deleted[0].deletedAt).toBeDefined();
	});

	it("restores batched deletions context-earlier first", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("question");

		expect(harness.session.softDeleteLastMessages(2)).toBe(2);
		expect(visibleTexts(harness)).toEqual([]);

		// The user question (context-earlier) comes back first.
		expect(harness.session.restoreDeletedMessages(1)).toBe(1);
		expect(visibleTexts(harness)).toEqual(["question"]);
		expect(harness.session.restoreDeletedMessages(1)).toBe(1);
		expect(visibleTexts(harness)).toEqual(["question", "answer"]);
		expect(harness.session.restoreDeletedMessages(1)).toBe(0);
	});

	it("restores separate deletes in LIFO order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("question");

		expect(harness.session.softDeleteLastMessages(1)).toBe(1); // answer
		expect(harness.session.softDeleteLastMessages(1)).toBe(1); // question
		expect(visibleTexts(harness)).toEqual([]);

		expect(harness.session.restoreDeletedMessages(1)).toBe(1);
		expect(visibleTexts(harness)).toEqual(["question"]);
		expect(harness.session.restoreDeletedMessages(1)).toBe(1);
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

		expect(harness.session.restoreDeletedMessages(1)).toBe(1);
		expect(visibleTexts(harness)).toEqual(["first question", "first answer", "second question", "second answer"]);
	});

	it("delete count spans only visible entries across a soft-deleted range", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a3")]);
		await harness.session.prompt("q1");
		await harness.session.prompt("q2");
		await harness.session.prompt("q3");

		expect(harness.session.softDeleteLastMessages(2)).toBe(2); // a3, q3 hidden
		expect(harness.session.softDeleteLastMessages(2)).toBe(2); // a2, q2 hidden
		expect(visibleTexts(harness)).toEqual(["q1", "a1"]);

		expect(harness.session.restoreDeletedMessages(4)).toBe(4);
		expect(visibleTexts(harness)).toEqual(["q1", "a1", "q2", "a2", "q3", "a3"]);
	});
});
