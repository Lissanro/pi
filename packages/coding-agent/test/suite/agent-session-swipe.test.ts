import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function visibleTexts(harness: Harness): string[] {
	return harness.session.messages.filter((m) => m.role !== "system").map((m) => getMessageText(m));
}

describe("AgentSession swipe", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("finds the latest response as the only version", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer v1")]);
		await harness.session.prompt("question");

		const group = harness.session.getSwipeGroup();
		expect(group).toBeDefined();
		expect(group!.versions).toHaveLength(1);
		expect(group!.currentIndex).toBe(0);
	});

	it("returns no group when the tail is a user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		expect(harness.session.getSwipeGroup()).toBeUndefined();
	});

	it("treats an aborted message with tool calls and no results as one swipeable message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxText("partial"), fauxToolCall("read", { path: "/a" }, { id: "tc1" })], {
				stopReason: "aborted",
			}),
		);
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		const group = harness.session.getSwipeGroup();
		expect(group).toBeDefined();
		expect(group!.versions).toHaveLength(1);
		expect(group!.currentIndex).toBe(0);
	});

	it("treats trailing tool results as part of the swipe unit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

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
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		const group = harness.session.getSwipeGroup();
		expect(group).toBeDefined();
		expect(group!.versions).toHaveLength(1);
	});

	it("regenerates the latest response and keeps the old version as a branch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer v1"), fauxAssistantMessage("answer v2")]);
		await harness.session.prompt("question");

		const group = harness.session.getSwipeGroup()!;
		await harness.session.regenerateSwipe(group);

		expect(visibleTexts(harness)).toEqual(["question", "answer v2"]);
		const updated = harness.session.getSwipeGroup()!;
		expect(updated.versions).toHaveLength(2);
		expect(updated.currentIndex).toBe(1);
	});

	it("navigates between versions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer v1"), fauxAssistantMessage("answer v2")]);
		await harness.session.prompt("question");
		await harness.session.regenerateSwipe(harness.session.getSwipeGroup()!);
		expect(visibleTexts(harness)).toEqual(["question", "answer v2"]);

		// Back to v1.
		let group = harness.session.getSwipeGroup()!;
		expect(harness.session.goToSwipeVersion(group, 0)).toBe(true);
		expect(visibleTexts(harness)).toEqual(["question", "answer v1"]);
		group = harness.session.getSwipeGroup()!;
		expect(group.currentIndex).toBe(0);
		expect(group.versions).toHaveLength(2);

		// Forward to v2.
		expect(harness.session.goToSwipeVersion(group, 1)).toBe(true);
		expect(visibleTexts(harness)).toEqual(["question", "answer v2"]);

		// Out-of-range and same-index navigations are no-ops.
		group = harness.session.getSwipeGroup()!;
		expect(harness.session.goToSwipeVersion(group, 2)).toBe(false);
		expect(harness.session.goToSwipeVersion(group, 1)).toBe(false);
		expect(harness.session.goToSwipeVersion(group, -1)).toBe(false);
	});

	it("resumes the whole branch when navigating to a version", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("answer v1"),
			fauxAssistantMessage("follow-up v1"),
			fauxAssistantMessage("answer v2"),
		]);
		await harness.session.prompt("question");
		await harness.session.prompt("follow-up");

		// Regenerate only the latest response: everything before it stays.
		await harness.session.regenerateSwipe(harness.session.getSwipeGroup()!);
		expect(visibleTexts(harness)).toEqual(["question", "answer v1", "follow-up", "answer v2"]);

		// Navigating back to the other version resumes its branch with the full
		// prior conversation.
		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(2);
		expect(harness.session.goToSwipeVersion(group, 0)).toBe(true);
		expect(visibleTexts(harness)).toEqual(["question", "answer v1", "follow-up", "follow-up v1"]);
	});
});
