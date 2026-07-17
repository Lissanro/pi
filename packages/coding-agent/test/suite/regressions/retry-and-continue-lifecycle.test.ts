import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("retry with unlimited attempts and backoff cap", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries indefinitely by default (no maxRetries limit)", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		// Provide 5 consecutive errors then a success. With the old default
		// (maxRetries: 3) only 3 retries would be attempted. With unlimited
		// retries all 5 errors are retried and the 6th call succeeds.
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(6);
		expect(harness.session.isRetrying).toBe(false);
		const startEvents = harness.eventsOfType("auto_retry_start");
		expect(startEvents.map((event) => event.attempt)).toEqual([1, 2, 3, 4, 5]);
		// maxAttempts should be Infinity (unlimited)
		expect(startEvents[0]?.maxAttempts).toBe(Number.POSITIVE_INFINITY);
	});

	it("caps exponential backoff delay at maxDelayMs", async () => {
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 5, baseDelayMs: 10, maxBackoffMs: 30 },
			},
		});
		harnesses.push(harness);

		const delays: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				delays.push(event.delayMs);
			}
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		// baseDelayMs=10, maxBackoffMs=30
		// attempt 1: 10 * 2^0 = 10
		// attempt 2: 10 * 2^1 = 20
		// attempt 3: 10 * 2^2 = 40 -> capped at 30
		// attempt 4: 10 * 2^3 = 80 -> capped at 30
		// attempt 5: 10 * 2^4 = 160 -> capped at 30
		expect(delays).toEqual([10, 20, 30, 30, 30]);
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("respects explicit maxRetries when set", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		const endEvents = harness.eventsOfType("auto_retry_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]?.success).toBe(false);
		expect(endEvents[0]?.attempt).toBe(2);
	});
});

describe("session.continue lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/**
	 * Push a user message into the agent state so that continue() has a
	 * continuable last message (user or toolResult) to resume from.
	 */
	function pushUserMessage(harness: Harness, text: string): void {
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		harness.session.agent.state.messages.push(message);
	}

	it("sets isStreaming during continuation and allows steering", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// First prompt produces an assistant response.
		harness.setResponses([fauxAssistantMessage("First response")]);
		await harness.session.prompt("Hello");
		expect(harness.session.isStreaming).toBe(false);

		// Push a user message so continue() has a continuable last message.
		pushUserMessage(harness, "Continue please");

		// Use a factory that blocks until we resolve it, so we can inspect
		// isStreaming mid-flight.
		let resolveResponse: (message: ReturnType<typeof fauxAssistantMessage>) => void = () => {};
		const blockingResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			resolveResponse = resolve;
		});
		harness.setResponses([(_context, _options, _state, _model) => blockingResponse]);

		// Start continuation without awaiting it.
		const continuePromise = harness.session.continue();

		// Give the continuation a tick to start.
		await new Promise((resolve) => setTimeout(resolve, 20));

		// isStreaming should be true during continuation.
		expect(harness.session.isStreaming).toBe(true);

		// Steering should not throw while continuing.
		harness.session.steer("steering message");

		// Resolve the response to let continuation finish.
		resolveResponse(fauxAssistantMessage("Continued"));
		await continuePromise;

		expect(harness.session.isStreaming).toBe(false);
		// First prompt (1) + continuation with blocking response (1) + steering
		// message processed after the blocking response resolves (1) = 3 calls.
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("allows abort during continuation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// First prompt produces an assistant response.
		harness.setResponses([fauxAssistantMessage("First response")]);
		await harness.session.prompt("Hello");
		expect(harness.session.isStreaming).toBe(false);

		// Push a user message so continue() has a continuable last message.
		pushUserMessage(harness, "Continue please");

		// A long streamed response that we can abort mid-flight.
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		// Start continuation without awaiting it.
		const continuePromise = harness.session.continue();
		await sawMessageUpdate;

		// isStreaming should be true during continuation.
		expect(harness.session.isStreaming).toBe(true);

		// Abort should work during continuation.
		await harness.session.abort();
		await continuePromise;

		expect(harness.session.isStreaming).toBe(false);
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
