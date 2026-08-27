/**
 * Integration test: after compaction, the summary is tokenized via the model
 * server's /tokenize endpoint, the exact count is stored on the compaction entry,
 * and the post-compaction context usage (footer) reflects the tokenized total
 * instead of "?". A server without /tokenize leaves both as the chars/4 / "?"
 * fallback.
 */
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Seed a few messages so there is something to compact. */
function seed(harness: Harness): void {
	const now = Date.now();
	for (let i = 0; i < 4; i++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `user message ${i}` }],
			timestamp: now - (4 - i) * 1000,
		});
		const assistant = fauxAssistantMessage(`assistant message ${i}`, {
			stopReason: "stop",
			timestamp: now - (4 - i) * 1000 + 1,
		});
		assistant.usage = createUsage(10);
		harness.sessionManager.appendMessage(assistant);
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** Make the summarization (via agent.streamFunction) return a canned summary. */
function cannedSummary(harness: Harness): void {
	harness.session.agent.streamFunction = (_model, _context: Context, _options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: { ...fauxAssistantMessage("the summary"), usage: createUsage(10) },
			});
		});
		return stream;
	};
}

describe("compaction tokenization", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllGlobals();
	});

	it("stores the /tokenize count on the entry and uses it for context usage", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seed(harness);
		cannedSummary(harness);

		let tokenizeCalls = 0;
		vi.stubGlobal("fetch", (async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/tokenize")) {
				tokenizeCalls++;
				return new Response(JSON.stringify({ tokens: new Array(42).fill(0) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("unexpected", { status: 404 });
		}) as typeof globalThis.fetch);

		await harness.session.compact({ keepRecentMessages: 1 });

		expect(tokenizeCalls).toBeGreaterThanOrEqual(1);
		const entries = harness.sessionManager.getEntries();
		const compactionEntry = entries.find((e) => e.type === "compaction") as
			| ((typeof entries)[number] & { summaryTokens?: number })
			| undefined;
		expect(compactionEntry).toBeDefined();
		expect(compactionEntry!.summaryTokens).toBe(42);

		// No post-compaction assistant yet, so context usage comes from the
		// tokenized total, not "?" (percent null).
		const usage = harness.session.getContextUsage();
		expect(usage?.percent).not.toBeNull();
		expect(usage?.tokens).toBeGreaterThan(0);
	});

	it("falls back to chars/4 and a null percent when the server has no /tokenize", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seed(harness);
		cannedSummary(harness);

		vi.stubGlobal("fetch", (async () => new Response("no endpoint", { status: 404 })) as typeof globalThis.fetch);

		await harness.session.compact({ keepRecentMessages: 1 });

		const entries = harness.sessionManager.getEntries();
		const compactionEntry = entries.find((e) => e.type === "compaction") as
			| ((typeof entries)[number] & { summaryTokens?: number })
			| undefined;
		expect(compactionEntry).toBeDefined();
		expect(compactionEntry!.summaryTokens).toBeUndefined();

		// No /tokenize and no post-compaction usage: footer shows "?".
		const usage = harness.session.getContextUsage();
		expect(usage?.percent).toBeNull();
	});
});
