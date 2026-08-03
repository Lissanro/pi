/**
 * Regression test for compaction cache fidelity: the compaction summarization request
 * MUST be byte-identical to the normal chat prefix up to the cut point
 * (system prompt + the head messages exactly as a normal turn would send them),
 * with only the summarize instruction appended at the end. If the head diverges,
 * the provider KV cache is lost and every interaction after compaction re-prefills.
 */
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

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

/** Seed `pairs` user/assistant message pairs and sync agent.state.messages. */
function seedPairs(harness: Harness, pairs: number): void {
	const now = Date.now();
	for (let i = 0; i < pairs; i++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `user message ${i}` }],
			timestamp: now - (pairs - i) * 1000,
		});
		const assistant = fauxAssistantMessage(`assistant message ${i}`, {
			stopReason: "stop",
			timestamp: now - (pairs - i) * 1000 + 1,
		});
		assistant.usage = createUsage(10);
		harness.sessionManager.appendMessage(assistant);
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** Capture the summarization request context and return a canned summary. */
function captureSummarizationRequest(
	harness: Harness,
	onCapture: (context: Context) => void,
): void {
	harness.session.agent.streamFunction = (model, context: Context, _options: SimpleStreamOptions) => {
		onCapture(context);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = { ...fauxAssistantMessage("the summary"), usage: createUsage(10) };
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

describe("compaction cache fidelity", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("after a prior compaction, the request keeps the prior summary in its prefix (no 22K divergence)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const now = Date.now();
		// Two pairs to be summarized by the PRIOR compaction.
		harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "old user 0" }], timestamp: now - 6000 });
		const a0 = fauxAssistantMessage("old assistant 0", { stopReason: "stop", timestamp: now - 5000 });
		a0.usage = createUsage(10);
		harness.sessionManager.appendMessage(a0);
		// Kept tail that survives the PRIOR compaction.
		harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: now - 3000 });
		const aKept = fauxAssistantMessage("kept assistant", { stopReason: "stop", timestamp: now - 2000 });
		aKept.usage = createUsage(10);
		harness.sessionManager.appendMessage(aKept);
		const firstKeptEntryId = harness.sessionManager.getEntries().at(-1)!.id;
		harness.sessionManager.appendCompaction("prior summary", firstKeptEntryId, 100, undefined, false);
		harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "new user" }], timestamp: now - 500 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const agent = harness.session.agent;
		const transformed = agent.transformContext ? await agent.transformContext(agent.state.messages, undefined) : agent.state.messages;
		const expectedFirst = (await agent.convertToLlm(transformed))[0];

		let captured: Context | undefined;
		captureSummarizationRequest(harness, (ctx) => {
			captured = ctx;
		});

		await harness.session.compact({ keepRecentMessages: 1 });

		expect(captured).toBeDefined();
		// The first content message of the request MUST be the prior compactionSummary
		// (so it byte-matches the cached normal-chat prefix). Skipping it is the 22K divergence.
		expect(captured!.messages[0]).toEqual(expectedFirst);
	});

	it("summarization request head is byte-identical to the normal chat prefix", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		// 3 user/assistant pairs = 6 messages. Keep the last 2, summarize the first 4.
		seedPairs(harness, 3);

		const agent = harness.session.agent;

		// The normal chat the summary must byte-match: system prompt + the full
		// session messages exactly as a normal turn would send them (pre-compaction).
		const expectedSystem = agent.state.systemPrompt;
		const transformed = agent.transformContext
			? await agent.transformContext(agent.state.messages, undefined)
			: agent.state.messages;
		const expectedLlm = await agent.convertToLlm(transformed);

		let captured: Context | undefined;
		captureSummarizationRequest(harness, (ctx) => {
			captured = ctx;
		});

		await harness.session.compact({ keepRecentMessages: 2 });

		expect(captured).toBeDefined();

		expect(captured!.systemPrompt).toBe(expectedSystem);
		// Drop the trailing summarize instruction; the rest must be a PREFIX of
		// the normal chat (nothing injected before the head, nothing skipped).
		const capturedHead = captured!.messages.slice(0, -1);
		expect(capturedHead.length).toBeLessThanOrEqual(expectedLlm.length);
		expect(capturedHead).toEqual(expectedLlm.slice(0, capturedHead.length));
	});
});
