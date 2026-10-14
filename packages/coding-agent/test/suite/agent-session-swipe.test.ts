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

	it("returns no group when the tail user message is the session root (no anchor)", async () => {
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

	it("prepareSwipeRegeneration synchronously removes the current version from context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer v1")]);
		await harness.session.prompt("question");
		const group = harness.session.getSwipeGroup()!;

		// The TUI renders the transcript between branching and streaming; it
		// must already exclude the old version. Rendering before the branch
		// left the old response on screen with the new one appended below it.
		harness.session.prepareSwipeRegeneration(group);
		expect(visibleTexts(harness)).toEqual(["question"]);
		expect(harness.session.sessionManager.getLeafId()).toBe(group.anchorEntryId);
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

	it("keeps the group reachable when a regeneration aborts empty", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer v1")]);
		await harness.session.prompt("question");
		expect(harness.session.getSwipeGroup()!.versions).toHaveLength(1);

		// The regeneration aborts with an empty (harness) message: it becomes a
		// degenerate version, so the group is never lost after an abort.
		harness.appendResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);
		await harness.session.regenerateSwipe(harness.session.getSwipeGroup()!);

		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(2);
		expect(group.currentIndex).toBe(1);
		// Navigating back to the real version works.
		expect(harness.session.goToSwipeVersion(group, 0)).toBe(true);
		expect(visibleTexts(harness)).toEqual(["question", "answer v1"]);
	});

	it("versions user messages via /edit; user versions are navigable but not regenerable", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("question");
		// Follow-up user message: its edits create versions.
		harness.sessionManager.appendMessage({ role: "user", content: "follow-up", timestamp: Date.now() });
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		const result = harness.session.applyMessageEdits('<pi_edit id="0" role="user">edited follow-up</pi_edit>');
		expect(result.versioned).toBe(1);
		expect(visibleTexts(harness)).toEqual(["question", "answer", "edited follow-up"]);

		const group = harness.session.getSwipeGroup()!;
		expect(group.role).toBe("user");
		expect(group.versions).toHaveLength(2);
		expect(group.currentIndex).toBe(1);
		// Navigation works.
		expect(harness.session.goToSwipeVersion(group, 0)).toBe(true);
		expect(visibleTexts(harness)).toEqual(["question", "answer", "follow-up"]);
		// Regeneration is rejected.
		await expect(harness.session.regenerateSwipe(group)).rejects.toThrow(/cannot be regenerated/i);
	});

	it("edits a non-current swipe version in place via pi_swipe", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer v1"), fauxAssistantMessage("answer v2")]);
		await harness.session.prompt("question");
		await harness.session.regenerateSwipe(harness.session.getSwipeGroup()!);
		expect(harness.session.getSwipeGroup()!.versions).toHaveLength(2);

		// Edit v1 (not current) in place: switches to it and applies, keeping
		// the version count and the version's position.
		const v1Timestamp = harness.session.getSwipeGroup()!.versions[0].timestamp;
		const result = harness.session.applyMessageEdits(
			`<pi_swipe timestamp="${v1Timestamp}" role="assistant"><pi_content>edited v1</pi_content></pi_swipe>`,
		);
		expect(result.swiped).toBe(1);
		expect(result.versioned).toBe(0);
		expect(visibleTexts(harness)).toEqual(["question", "edited v1"]);
		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(2);
		expect(group.currentIndex).toBe(0);
		expect(group.versions[0].timestamp).toBe(v1Timestamp);
	});

	it("rejects a stale pi_swipe timestamp", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("question");

		expect(() =>
			harness.session.applyMessageEdits(
				'<pi_swipe timestamp="1999-01-01T00:00:00.000Z" role="assistant">x</pi_swipe>',
			),
		).toThrow(/No swipe version with timestamp/);
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

describe("AgentSession swipe deletion", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** Three versions of the latest response; the current version is v3. */
	async function setupThreeVersions(): Promise<Harness> {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("answer v1"),
			fauxAssistantMessage("answer v2"),
			fauxAssistantMessage("answer v3"),
		]);
		await harness.session.prompt("question");
		await harness.session.regenerateSwipe(harness.session.getSwipeGroup()!);
		await harness.session.regenerateSwipe(harness.session.getSwipeGroup()!);
		expect(harness.session.getSwipeGroup()!.versions).toHaveLength(3);
		return harness;
	}

	it("deleting the message unit marks all versions; restore brings them back", async () => {
		const harness = await setupThreeVersions();

		// Consume the message unit: every version root is marked.
		const deleted = harness.session.softDeleteLastMessages(1);
		expect(deleted).toHaveLength(3);
		// With all versions deleted, the tail user message forms its own group.
		const tailGroup = harness.session.getSwipeGroup()!;
		expect(tailGroup.role).toBe("user");
		expect(tailGroup.versions).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question"]);

		// Three restores (latest deletion first) bring all versions back.
		harness.session.restoreDeletedMessages(1);
		harness.session.restoreDeletedMessages(1);
		harness.session.restoreDeletedMessages(1);
		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(3);
		expect(visibleTexts(harness)).toEqual(["question", "answer v3"]);
	});

	it("shredding the message unit removes all version subtrees permanently", async () => {
		const harness = await setupThreeVersions();

		harness.session.shredLastMessages(1);
		// With all versions removed, the tail user message forms its own group.
		expect(harness.session.getSwipeGroup()!.role).toBe("user");
		expect(visibleTexts(harness)).toEqual(["question"]);
		expect(harness.session.sessionManager.getDeletedUnits()).toHaveLength(0);

		// The versions are gone from the session tree entirely.
		const texts = harness.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role !== "system")
			.map((entry) => (entry.type === "message" ? getMessageText(entry.message) : ""));
		expect(texts).toEqual(["question"]);
	});

	it("deleteSwipeVersions marks exactly the selected versions", async () => {
		const harness = await setupThreeVersions();

		// Select versions 2 and 3 (1-based): v2 and the current v3 disappear.
		harness.session.deleteSwipeVersions([2, 3]);
		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "answer v1"]);

		// Deleted versions are listed oldest-deletion-first.
		const deleted = harness.session.getDeletedSwipeVersions();
		expect(deleted).toHaveLength(2);
		expect(deleted.map((entry) => getMessageText(entry.message))).toEqual(["answer v2", "answer v3"]);
	});

	it("restoreSwipeVersions restores by deleted-time order", async () => {
		const harness = await setupThreeVersions();

		harness.session.deleteSwipeVersions([1, 2, 3]);
		// All versions deleted: the tail user message forms its own group.
		expect(harness.session.getSwipeGroup()!.role).toBe("user");
		expect(harness.session.getDeletedSwipeVersions()).toHaveLength(3);

		// Bring back v1 to have a visible group, then restore by selector.
		harness.session.restoreSwipeVersions([1]);
		expect(harness.session.getSwipeGroup()!.versions.map((entry) => getMessageText(entry.message))).toEqual([
			"answer v1",
		]);

		// Deleted list: [v2 (older), v3 (latest)]. Selector -1 picks the latest (v3).
		const restored = harness.session.restoreSwipeVersions([harness.session.getDeletedSwipeVersions().length]);
		expect(restored.map((entry) => getMessageText(entry.message))).toEqual(["answer v3"]);
		expect(harness.session.getSwipeGroup()!.versions.map((entry) => getMessageText(entry.message))).toEqual([
			"answer v1",
			"answer v3",
		]);
	});

	it("shredSwipeVersions removes selected version subtrees only", async () => {
		const harness = await setupThreeVersions();

		harness.session.shredSwipeVersions([1, 3]);
		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "answer v2"]);
		expect(harness.session.sessionManager.getDeletedUnits()).toHaveLength(0);
	});

	it("deleting the current swipe also hides its trailing tool results", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// v1: a tool turn with a result; v2: a sibling version branching from
		// the same user message (like a regeneration). Deleting the current v2
		// marks its trailing tool results as well.
		const questionId = harness.sessionManager.appendMessage({
			role: "user",
			content: "question",
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxText("v1"), fauxToolCall("read", { path: "/a" }, { id: "tc1" })], {
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
		// Branch back to the user message so v2 is a sibling version of v1.
		harness.sessionManager.branch(questionId);
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxText("v2"), fauxToolCall("read", { path: "/b" }, { id: "tc2" })], {
				stopReason: "toolUse",
			}),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc2",
			toolName: "read",
			content: [{ type: "text", text: "more" }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.session.sessionManager.buildSessionContext().messages;

		// v1 and v2 share the same anchor (the user message): two versions.
		const group = harness.session.getSwipeGroup()!;
		expect(group.versions).toHaveLength(2);
		expect(group.currentIndex).toBe(1);

		// Deleting the current swipe (v2) hides its trailing tool result and
		// navigates to v1, whose own tool result stays visible.
		harness.session.deleteSwipeVersions([2]);
		const remaining = harness.session.getSwipeGroup()!;
		expect(remaining.versions).toHaveLength(1);
		expect(visibleTexts(harness)).toEqual(["question", "v1", "contents"]);
	});
});
