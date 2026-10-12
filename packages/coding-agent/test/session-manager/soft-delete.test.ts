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

describe("SessionManager soft delete", () => {
	it("hides soft-deleted entries from context but keeps them in the file", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));
		session.appendMessage(userMessage("c", 3));

		const entries = session.getBranch();
		expect(session.softDeleteEntries([entries[2]])).toBe(1);

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
		expect(session.softDeleteEntries([compaction!])).toBe(1);

		// The summarized range is visible again; the summary is hidden.
		expect(contextTexts(session)).toEqual(["old question", "old answer", "new question"]);
		expect(session.getEntries().find((entry) => entry.id === compaction!.id)?.deletedAt).toBeDefined();
	});

	it("restores the latest deleted entries first", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));
		session.appendMessage(userMessage("c", 3));

		const entries = session.getBranch();
		// Two separate deletes: c first, then b.
		expect(session.softDeleteEntries([entries[2]])).toBe(1);
		expect(session.softDeleteEntries([entries[1]])).toBe(1);
		expect(contextTexts(session)).toEqual(["a"]);

		// LIFO: b (deleted later) restores first.
		expect(session.restoreDeletedEntries(1)).toBe(1);
		expect(contextTexts(session)).toEqual(["a", "b"]);
		expect(session.restoreDeletedEntries(1)).toBe(1);
		expect(contextTexts(session)).toEqual(["a", "b", "c"]);
		expect(session.restoreDeletedEntries(1)).toBe(0);
	});

	it("restores batched deletions context-earlier first when stamped in consumption order", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));

		const entries = session.getBranch();
		// Consumption order (latest in context first), as softDeleteLastMessages passes.
		expect(session.softDeleteEntries([entries[1], entries[0]])).toBe(2);
		expect(contextTexts(session)).toEqual([]);

		// a (context-earlier) restores first, keeping every intermediate state coherent.
		expect(session.restoreDeletedEntries(1)).toBe(1);
		expect(contextTexts(session)).toEqual(["a"]);
		expect(session.restoreDeletedEntries(1)).toBe(1);
		expect(contextTexts(session)).toEqual(["a", "b"]);
	});

	it("removeLastMessages skips soft-deleted entries when counting", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("a", 1));
		session.appendMessage(assistantMessage("b", 2));
		session.appendMessage(userMessage("c", 3));

		const entries = session.getBranch();
		session.softDeleteEntries([entries[1]]); // b hidden

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
			expect(session.softDeleteEntries([entries[1]])).toBe(1);

			const reopened = SessionManager.open(session.getSessionFile()!, sessionDir, tempDir);
			expect(reopened.getEntry(entries[1].id)?.deletedAt).toBeDefined();
			expect(reopened.buildSessionContext().messages).toHaveLength(1);

			expect(reopened.restoreDeletedEntries(1)).toBe(1);
			expect(reopened.buildSessionContext().messages).toHaveLength(2);
			expect(reopened.getEntry(entries[1].id)?.deletedAt).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
