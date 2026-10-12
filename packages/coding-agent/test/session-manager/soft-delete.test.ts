import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "llama-server",
		model: "test",
		usage: createUsage(),
		stopReason: "stop",
		timestamp,
	};
}

function assistantMessageWithToolCall(text: string, toolCallId: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "/a" } },
		],
		api: "openai-completions",
		provider: "llama-server",
		model: "test",
		usage: createUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResultMessage(toolCallId: string, text: string, timestamp: number) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp,
	};
}

function contextTexts(session: SessionManager): string[] {
	return session
		.buildSessionContext()
		.messages.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => {
			if (message.role === "user") {
				return typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => (block as { text: string }).text)
							.join("");
			}
			return message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("");
		});
}

function assistantContent(session: SessionManager): AssistantMessage["content"] {
	const message = session.buildSessionContext().messages.find((m) => m.role === "assistant");
	return (message as AssistantMessage).content;
}

describe("SessionManager soft delete", () => {
	it("hides soft-deleted entries from context but keeps them in the file", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));
		session.appendMessage(userMessage("c", 3));

		const entries = session.getBranch();
		expect(session.softDeleteUnits([{ entryId: entries[2].id }])).toBe(1);

		expect(contextTexts(session)).toEqual(["a", "b"]);
		// The entry is still stored, marked with a deletion timestamp.
		expect(session.getEntries()).toHaveLength(3);
		expect(session.getEntries()[2].deletedAt).toBeDefined();
	});

	it("un-compacts the context when a compaction entry is soft-deleted", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("old question", 1));
		const keptId = session.appendMessage(assistantMessage("old answer", 2));
		session.appendCompaction("summary of old", keptId, 100);
		session.appendMessage(userMessage("new question", 4));

		// Compacted context: the summary plus the kept range.
		const compacted = session.buildSessionContext().messages;
		expect(compacted.map((message) => message.role)).toEqual(["compactionSummary", "assistant", "user"]);

		const compaction = session.getBranch().find((entry) => entry.type === "compaction");
		expect(compaction).toBeDefined();
		expect(session.softDeleteUnits([{ entryId: compaction!.id }])).toBe(1);

		// The summarized range is visible again; the summary is hidden.
		expect(contextTexts(session)).toEqual(["old question", "old answer", "new question"]);
		expect(session.getEntries().find((entry) => entry.id === compaction!.id)?.deletedAt).toBeDefined();
	});

	it("restores the latest deleted units first", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));
		session.appendMessage(userMessage("c", 3));

		const entries = session.getBranch();
		// Two separate deletes: c first, then b.
		expect(session.softDeleteUnits([{ entryId: entries[2].id }])).toBe(1);
		expect(session.softDeleteUnits([{ entryId: entries[1].id }])).toBe(1);
		expect(contextTexts(session)).toEqual(["a"]);

		// LIFO: b (deleted later) restores first.
		expect(session.restoreDeletedUnits(1)).toHaveLength(1);
		expect(contextTexts(session)).toEqual(["a", "b"]);
		expect(session.restoreDeletedUnits(1)).toHaveLength(1);
		expect(contextTexts(session)).toEqual(["a", "b", "c"]);
		expect(session.restoreDeletedUnits(1)).toHaveLength(0);
	});

	it("restores batched deletions context-earlier first when stamped in consumption order", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));

		const entries = session.getBranch();
		// Consumption order (latest in context first), as softDeleteLastMessages passes.
		expect(session.softDeleteUnits([{ entryId: entries[1].id }, { entryId: entries[0].id }])).toBe(2);
		expect(contextTexts(session)).toEqual([]);

		// a (context-earlier) restores first, keeping every intermediate state coherent.
		expect(session.restoreDeletedUnits(1)).toHaveLength(1);
		expect(contextTexts(session)).toEqual(["a"]);
		expect(session.restoreDeletedUnits(1)).toHaveLength(1);
		expect(contextTexts(session)).toEqual(["a", "b"]);
	});

	it("removeLastMessages skips soft-deleted entries when counting", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));
		session.appendMessage(userMessage("c", 3));

		const entries = session.getBranch();
		session.softDeleteUnits([{ entryId: entries[1].id }]); // b hidden

		// Hard-removing 1 counts only visible messages: removes c (and the
		// trailing path), not the hidden b.
		expect(session.removeLastMessages(1)).toBe(1);
		expect(contextTexts(session)).toEqual(["a"]);
		// b is still stored, still soft-deleted.
		expect(session.getEntry(entries[1].id)?.deletedAt).toBeDefined();
	});

	it("persists soft-deleted state across a reload", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-soft-delete-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const session = SessionManager.create(tempDir, sessionDir);
			session.appendMessage(userMessage("a", 1));
			session.appendMessage(assistantMessage("b", 2));

			const entries = session.getBranch();
			expect(session.softDeleteUnits([{ entryId: entries[1].id }])).toBe(1);

			const reopened = SessionManager.open(session.getSessionFile()!, sessionDir, tempDir);
			expect(reopened.getEntry(entries[1].id)?.deletedAt).toBeDefined();
			expect(reopened.buildSessionContext().messages).toHaveLength(1);

			expect(reopened.restoreDeletedUnits(1)).toHaveLength(1);
			expect(reopened.buildSessionContext().messages).toHaveLength(2);
			expect(reopened.getEntry(entries[1].id)?.deletedAt).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("SessionManager tool-call-level deletion", () => {
	it("hides a single soft-deleted tool call block, keeping the message", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("q", 1));
		session.appendMessage(assistantMessageWithToolCall("let me read", "tc1", 2));
		session.appendMessage(toolResultMessage("tc1", "contents", 3));

		const assistant = session.getBranch()[1];
		expect(session.softDeleteUnits([{ entryId: assistant.id, toolCallId: "tc1" }])).toBe(1);

		// The message and its text stay; the tool call block is hidden.
		expect(assistantContent(session)).toEqual([{ type: "text", text: "let me read" }]);
		// The stored entry keeps the block plus the deletion mark.
		const stored = session.getEntry(assistant.id);
		expect(stored?.type).toBe("message");
		expect((stored as { message: AssistantMessage }).message.content).toHaveLength(2);
		expect((stored as { deletedToolCalls?: Record<string, string> }).deletedToolCalls?.tc1).toBeDefined();
	});

	it("restores a soft-deleted tool call block", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("q", 1));
		session.appendMessage(assistantMessageWithToolCall("let me read", "tc1", 2));

		const assistant = session.getBranch()[1];
		session.softDeleteUnits([{ entryId: assistant.id, toolCallId: "tc1" }]);
		expect(assistantContent(session)).toHaveLength(1);

		expect(session.restoreDeletedUnits(1)).toEqual([{ entryId: assistant.id, toolCallId: "tc1" }]);
		expect(assistantContent(session)).toHaveLength(2);
		expect(session.getEntry(assistant.id)?.type).toBe("message");
		expect((session.getEntry(assistant.id) as { deletedToolCalls?: unknown }).deletedToolCalls).toBeUndefined();
	});

	it("folds tool-call deletions into the entry-level unit for restore", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("q", 1));
		session.appendMessage(assistantMessageWithToolCall("let me read", "tc1", 2));

		const assistant = session.getBranch()[1];
		session.softDeleteUnits([{ entryId: assistant.id, toolCallId: "tc1" }]);
		session.softDeleteUnits([{ entryId: assistant.id }]);

		// Only the entry-level unit is listed: restoring it restores the whole message.
		const deleted = session.getDeletedUnits();
		expect(deleted).toHaveLength(1);
		expect(deleted[0].toolCallId).toBeUndefined();
	});
});

describe("SessionManager.removeEntries", () => {
	it("removes a compaction entry and un-compacts the range", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("old question", 1));
		const keptId = session.appendMessage(assistantMessage("old answer", 2));
		session.appendCompaction("summary", keptId, 100);
		session.appendMessage(userMessage("new question", 4));

		const compaction = session.getBranch().find((entry) => entry.type === "compaction")!;
		expect(session.removeEntries([compaction.id])).toBe(1);
		expect(contextTexts(session)).toEqual(["old question", "old answer", "new question"]);
		// The compaction is gone from the active branch (the tree keeps the
		// abandoned branch with the old entry ids).
		expect(session.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("removes a tool call block from a kept message", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("q", 1));
		session.appendMessage(assistantMessageWithToolCall("let me read", "tc1", 2));
		session.appendMessage(toolResultMessage("tc1", "contents", 3));

		const assistant = session.getBranch()[1];
		expect(session.removeEntries([], new Map([[assistant.id, new Set(["tc1"])]]))).toBe(1);
		expect(assistantContent(session)).toEqual([{ type: "text", text: "let me read" }]);
		// The tool result stays; only the block is gone.
		expect(session.buildSessionContext().messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("removes multiple entries in one pass while preserving the rest", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));
		session.appendMessage(userMessage("c", 3));
		session.appendMessage(assistantMessage("d", 4));

		const entries = session.getBranch();
		expect(session.removeEntries([entries[1].id, entries[2].id])).toBe(2);
		expect(contextTexts(session)).toEqual(["a", "d"]);
	});
});
