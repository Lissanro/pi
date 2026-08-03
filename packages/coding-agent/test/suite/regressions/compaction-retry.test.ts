/**
 * Regression test: /compact and auto-compaction should retry on transient
 * errors with exponential backoff (same behaviour as /continue).
 *
 * When the LLM backend (e.g., llama.cpp server) is restarting or temporarily
 * unavailable, compaction should not fail immediately. Instead it should retry
 * with backoff until the server recovers or the user aborts.
 */

import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_isCompactionRetryableError: (error: unknown) => boolean;
	_prepareCompactionRetry: (signal: AbortSignal) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

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

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = fauxAssistantMessage("assistant response to compact", {
		stopReason: "stop",
		timestamp: now - 500,
	});
	assistant.usage = createUsage(100);
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("classifies retryable compaction errors", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const int = harness.session as unknown as SessionWithCompactionInternals;

		// Retryable: connection errors
		expect(int._isCompactionRetryableError(new Error("Summarization failed: connection refused"))).toBe(true);
		expect(int._isCompactionRetryableError(new Error("Summarization failed: fetch failed"))).toBe(true);
		expect(int._isCompactionRetryableError(new Error("Summarization failed: 503 service unavailable"))).toBe(true);
		expect(int._isCompactionRetryableError(new Error("Summarization failed: overloaded"))).toBe(true);
		expect(int._isCompactionRetryableError(new Error("Summarization failed: timeout"))).toBe(true);

		// Non-retryable: quota/billing
		expect(int._isCompactionRetryableError(new Error("Summarization failed: insufficient_quota"))).toBe(false);
		expect(int._isCompactionRetryableError(new Error("Summarization failed: quota exceeded"))).toBe(false);

		// Non-retryable: non-error patterns
		expect(int._isCompactionRetryableError(new Error("Already compacted"))).toBe(false);
		expect(int._isCompactionRetryableError(new Error("Nothing to compact (session too small)"))).toBe(false);
	});

	it("manual compact retries on transient error and succeeds on second attempt", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 1 },
				retry: { enabled: true, baseDelayMs: 10, maxBackoffMs: 100 },
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		let callCount = 0;
		const retryStartEvents: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event.attempt);
			}
		});

		// First call fails with transient error, second succeeds
		harness.session.agent.streamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			callCount++;
			queueMicrotask(() => {
				if (callCount === 1) {
					const error: AssistantMessage = {
						...fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "connection refused",
						}),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(0),
					};
					stream.push({ type: "error", reason: "error", error });
				} else {
					const message: AssistantMessage = {
						...fauxAssistantMessage("compact summary"),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(10),
					};
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		};

		const result = await harness.session.compact();

		expect(callCount).toBe(2);
		expect(result.summary).toContain("compact summary");
		expect(retryStartEvents).toEqual([1]);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
	});

	it("manual compact retries multiple times until success", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 1 },
				retry: { enabled: true, baseDelayMs: 10, maxBackoffMs: 100 },
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		let callCount = 0;
		const retryStartEvents: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event.attempt);
			}
		});

		// Fail first two attempts, succeed on third
		harness.session.agent.streamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			callCount++;
			queueMicrotask(() => {
				if (callCount <= 2) {
					const error: AssistantMessage = {
						...fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "server error 500",
						}),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(0),
					};
					stream.push({ type: "error", reason: "error", error });
				} else {
					const message: AssistantMessage = {
						...fauxAssistantMessage("compact summary"),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(10),
					};
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		};

		const result = await harness.session.compact();

		expect(callCount).toBe(3);
		expect(result.summary).toContain("compact summary");
		expect(retryStartEvents).toEqual([1, 2]);
	});

	it("manual compact throws original error for non-retryable failures", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		// Fail with non-retryable error (quota exceeded)
		harness.session.agent.streamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const error: AssistantMessage = {
					...fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "insufficient_quota",
					}),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(0),
				};
				stream.push({ type: "error", reason: "error", error });
			});
			return stream;
		};

		const retrySpy = vi.spyOn(
			harness.session as unknown as SessionWithCompactionInternals,
			"_prepareCompactionRetry",
		);

		await expect(harness.session.compact()).rejects.toThrow(/Summarization failed.*insufficient_quota/i);
		expect(retrySpy).not.toHaveBeenCalled();
	});

	it("skips retry when retry is disabled in settings", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 1 },
				retry: { enabled: false },
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		let callCount = 0;
		harness.session.agent.streamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			callCount++;
			queueMicrotask(() => {
				const error: AssistantMessage = {
					...fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "connection refused",
					}),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(0),
				};
				stream.push({ type: "error", reason: "error", error });
			});
			return stream;
		};

		await expect(harness.session.compact()).rejects.toThrow(/connection refused/i);
		expect(callCount).toBe(1); // No retry attempted
	});

	it("auto-compaction retries on transient error and succeeds", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 1 },
				retry: { enabled: true, baseDelayMs: 10, maxBackoffMs: 100 },
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		let callCount = 0;
		const retryStartEvents: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event.attempt);
			}
		});

		// First call fails with transient error, second succeeds
		harness.session.agent.streamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			callCount++;
			queueMicrotask(() => {
				if (callCount === 1) {
					const error: AssistantMessage = {
						...fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "connection refused",
						}),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(0),
					};
					stream.push({ type: "error", reason: "error", error });
				} else {
					const message: AssistantMessage = {
						...fauxAssistantMessage("auto compact summary"),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: createUsage(10),
					};
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		};

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const result = await sessionInternals._runAutoCompaction("threshold", false);

		expect(result).toBe(false); // willRetry is false, no queued messages
		expect(callCount).toBe(2);
		expect(retryStartEvents).toEqual([1]);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.summary).toContain("auto compact summary");
	});

	it("manual compact abortCompaction cancels retry backoff", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 1 },
				retry: { enabled: true, baseDelayMs: 5000, maxBackoffMs: 30000 },
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		let _callCount = 0;
		const retryEndEvents: Array<{ success: boolean; finalError?: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push({ success: event.success, finalError: event.finalError });
			}
		});

		// Always fail with transient error
		harness.session.agent.streamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			_callCount++;
			queueMicrotask(() => {
				const error: AssistantMessage = {
					...fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "connection refused",
					}),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(0),
				};
				stream.push({ type: "error", reason: "error", error });
			});
			return stream;
		};

		// Start compact in background. Attach the rejection handler immediately
		// (before driving fake timers) so the abort rejection doesn't briefly
		// surface as an unhandled rejection while timers advance.
		const compactPromise = harness.session.compact();
		const compactOutcome = compactPromise.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		// Let first call fail and enter retry backoff
		await vi.advanceTimersByTimeAsync(0);

		// Abort during backoff
		harness.session.abortCompaction();

		// Advance time past the backoff
		await vi.advanceTimersByTimeAsync(10000);

		const outcome = await compactOutcome;
		expect(outcome.ok).toBe(false);
		expect((outcome as { ok: false; error: Error }).error.message).toBe("Compaction cancelled");

		// Verify retry was cancelled
		expect(retryEndEvents.length).toBeGreaterThanOrEqual(1);
		const cancelledEvent = retryEndEvents.find((e) => e.finalError === "Compaction retry cancelled");
		expect(cancelledEvent).toBeDefined();
	});
});
