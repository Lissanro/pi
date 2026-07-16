import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string, timestamp: number) {
	return { role: "user" as const, content: text, timestamp };
}

function assistantMessage(
	content: AssistantMessage["content"],
	timestamp: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "llama-server",
		model: "test",
		usage: createUsage(),
		stopReason,
		timestamp,
	};
}

describe("SessionManager.removeLastMessages", () => {
	it("removes the last message", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("hello", 1));
		session.appendMessage(assistantMessage([{ type: "text", text: "hi" }], 2));

		expect(session.buildSessionContext().messages).toHaveLength(2);

		const removed = session.removeLastMessages(1);

		expect(removed).toBe(1);
		const messages = session.buildSessionContext().messages;
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
	});

	it("removes the last N messages", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage([{ type: "text", text: "b" }], 2));
		session.appendMessage(userMessage("c", 3));
		session.appendMessage(assistantMessage([{ type: "text", text: "d" }], 4));

		const removed = session.removeLastMessages(2);

		expect(removed).toBe(2);
		const messages = session.buildSessionContext().messages;
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");
	});

	it("skips harness messages when counting and removes trailing harness messages", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("hello", 1));
		// Harness message: aborted assistant with no content
		session.appendMessage(assistantMessage([], 2, "aborted"));

		// Only the user message is non-harness; /delete 1 removes it and the trailing harness
		const removed = session.removeLastMessages(1);

		expect(removed).toBe(1);
		expect(session.buildSessionContext().messages).toHaveLength(0);
		expect(session.getBranch()).toHaveLength(0);
	});

	it("removes a real assistant message and trailing harness message after it", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("hello", 1));
		session.appendMessage(assistantMessage([{ type: "text", text: "real response" }], 2));
		// Trailing harness message after the real assistant message
		session.appendMessage(assistantMessage([], 3, "aborted"));

		const removed = session.removeLastMessages(1);

		expect(removed).toBe(1);
		const messages = session.buildSessionContext().messages;
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
	});

	it("keeps harness messages before the deletion point", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("hello", 1));
		// Harness message before the real assistant message
		session.appendMessage(assistantMessage([], 2, "aborted"));
		session.appendMessage(assistantMessage([{ type: "text", text: "real response" }], 3));

		// /delete 1 removes the real assistant message; the harness before it stays
		const removed = session.removeLastMessages(1);

		expect(removed).toBe(1);
		const messages = session.buildSessionContext().messages;
		// user + the kept harness assistant message (content []) remain
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");
	});

	it("removes more than available deletes all non-harness messages", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage([{ type: "text", text: "b" }], 2));

		const removed = session.removeLastMessages(10);

		expect(removed).toBe(2);
		expect(session.buildSessionContext().messages).toHaveLength(0);
	});

	it("returns 0 when there are no non-harness messages", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(assistantMessage([], 1, "aborted"));

		const removed = session.removeLastMessages(1);

		expect(removed).toBe(0);
		// The harness entry is unchanged
		expect(session.getBranch()).toHaveLength(1);
	});

	it("returns 0 for count < 1", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));

		expect(session.removeLastMessages(0)).toBe(0);
		expect(session.removeLastMessages(-1)).toBe(0);
		expect(session.buildSessionContext().messages).toHaveLength(1);
	});

	it("removes non-message entries trailing the deletion point", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("hello", 1));
		session.appendMessage(assistantMessage([{ type: "text", text: "response" }], 2));
		// Trailing non-message entry after the assistant message
		session.appendThinkingLevelChange("high");

		const removed = session.removeLastMessages(1);

		expect(removed).toBe(1);
		// The assistant message AND the trailing thinking_level_change are removed
		expect(session.getEntries()).toHaveLength(1);
		expect(session.getEntries()[0].type).toBe("message");
	});

	it("keeps non-message entries before the deletion point", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("hello", 1));
		session.appendThinkingLevelChange("high");
		session.appendMessage(assistantMessage([{ type: "text", text: "response" }], 3));

		const removed = session.removeLastMessages(1);

		expect(removed).toBe(1);
		// user + thinking_level_change remain; assistant removed
		expect(session.getEntries()).toHaveLength(2);
		expect(session.getEntries().some((e) => e.type === "thinking_level_change")).toBe(true);
	});

	it("removes branched descendants of deleted entries", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMessage("hello", 1));
		const assistantId = session.appendMessage(assistantMessage([{ type: "text", text: "first branch" }], 2));
		// Branch from the user message, creating a sibling branch
		session.branch(userId);
		const assistant2Id = session.appendMessage(assistantMessage([{ type: "text", text: "second branch" }], 3));

		// Leaf path is [user, assistant2]; the first assistant is a branched descendant of user.
		expect(session.getBranch()).toHaveLength(2);

		// /delete 2 removes both leaf-path messages (user, assistant2) and the
		// branched descendant (first assistant) whose parent (user) was removed.
		const removed = session.removeLastMessages(2);

		expect(removed).toBe(2);
		expect(session.getBranch()).toHaveLength(0);
		expect(session.getEntries().some((e) => e.id === assistantId)).toBe(false);
		expect(session.getEntries().some((e) => e.id === assistant2Id)).toBe(false);
	});
});
