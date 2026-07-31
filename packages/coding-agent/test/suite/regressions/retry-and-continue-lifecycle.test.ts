import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

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

describe("retry prefill continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function getAssistantText(message: AgentMessage): string {
		if (message.role !== "assistant") return "";
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	function getMessageThinking(message: {
		role: string;
		content: string | Array<{ type: string; thinking?: string }>;
	}): string {
		if (message.role !== "assistant") return "";
		if (typeof message.content === "string") return "";
		return message.content
			.filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
			.map((block) => block.thinking)
			.join("");
	}

	it("continues a partial assistant message during retry for openai-completions providers", async () => {
		const harness = await createHarness({
			fauxApi: "openai-completions",
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		const partialText = "partial content";

		harness.setResponses([
			fauxAssistantMessage(partialText, { stopReason: "error", errorMessage: "Connection error." }),
			(context) => {
				const last = context.messages[context.messages.length - 1];
				const lastText = getMessageText(last);
				expect(lastText).toBe(partialText);
				return fauxAssistantMessage(`${lastText} continued`);
			},
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);

		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		expect(getAssistantText(lastMessage)).toBe(`${partialText} continued`);
	});

	it("preserves the original partial prefill across multiple retry failures", async () => {
		const harness = await createHarness({
			fauxApi: "openai-completions",
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		const partialText = "partial content";
		const seenPrefills: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(partialText, { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
			(context) => {
				const last = context.messages[context.messages.length - 1];
				const lastText = getMessageText(last);
				seenPrefills.push(lastText);
				return fauxAssistantMessage(`${lastText} recovered`);
			},
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(4);
		// The final retry must still use the original partial, not an empty harness.
		expect(seenPrefills).toEqual([partialText]);

		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		expect(getAssistantText(lastMessage)).toBe(`${partialText} recovered`);
	});

	it("restores the partial message when a prefill continuation fails", async () => {
		const harness = await createHarness({
			fauxApi: "openai-completions",
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		const partialText = "partial content";
		let attempt = 0;

		const factory = (context: {
			messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
		}) => {
			attempt++;
			const last = context.messages[context.messages.length - 1];
			const lastText = getMessageText(last);
			if (attempt === 1) {
				expect(lastText).toBe(partialText);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });
			}
			expect(lastText).toBe(partialText);
			return fauxAssistantMessage(`${lastText} recovered`);
		};

		harness.setResponses([
			fauxAssistantMessage(partialText, { stopReason: "error", errorMessage: "Connection error." }),
			factory,
			factory,
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);

		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		expect(getAssistantText(lastMessage)).toBe(`${partialText} recovered`);
	});

	it("clears 503-style harness errors and continues the original partial prefill", async () => {
		const harness = await createHarness({
			fauxApi: "openai-completions",
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		const partialThinking = "Plan committed. Now I need to begin implementing Stage 1.";
		const continuationThinking = " Stage 1 tasks:\n- Create project skeleton.";
		const seenPrefills: string[] = [];

		harness.setResponses([
			fauxAssistantMessage([fauxThinking(partialThinking)], {
				stopReason: "error",
				errorMessage: "terminated",
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '503: {"message":"Loading model","type":"unavailable_error","code":503}',
			}),
			(context) => {
				const last = context.messages[context.messages.length - 1];
				const lastThinking = getMessageThinking(last);
				seenPrefills.push(lastThinking);
				return fauxAssistantMessage([fauxThinking(`${lastThinking}${continuationThinking}`)], {
					stopReason: "stop",
				});
			},
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		// The 503 harness must not replace the original partial prefill.
		expect(seenPrefills).toEqual([partialThinking]);

		const messages = harness.session.messages;
		const lastMessage = messages[messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(getMessageThinking(lastMessage)).toBe(`${partialThinking}${continuationThinking}`);
		}
		// No duplicate assistant messages should remain in the transcript.
		const assistantCount = messages.filter((m) => m.role === "assistant").length;
		expect(assistantCount).toBe(1);
	});

	it("does not use prefill continuation for non-openai-completions providers", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		const partialText = "partial content";

		harness.setResponses([
			fauxAssistantMessage(partialText, { stopReason: "error", errorMessage: "Connection error." }),
			(context) => {
				const last = context.messages[context.messages.length - 1];
				// The partial assistant message should have been removed; the
				// retry continues from the user message instead.
				expect(last?.role).toBe("user");
				return fauxAssistantMessage("fresh start");
			},
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);

		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		expect(getAssistantText(lastMessage)).toBe("fresh start");
	});

	it("uses prefill continuation when the partial message contains a tool call", async () => {
		const echoSchema = Type.Object({ text: Type.String() });
		const echoTool: AgentTool<typeof echoSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.text}` }],
					details: {},
					terminate: true,
				};
			},
		};
		const harness = await createHarness({
			fauxApi: "openai-completions",
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			tools: [echoTool],
		});
		harnesses.push(harness);

		let capturedReturnPrefill: boolean | undefined;
		let capturedLastIsToolCall = false;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], {
				stopReason: "error",
				errorMessage: "Connection error.",
			}),
			(context, options) => {
				capturedReturnPrefill = options?.returnPrefill;
				const last = context.messages[context.messages.length - 1];
				capturedLastIsToolCall =
					last?.role === "assistant" &&
					Array.isArray(last.content) &&
					last.content.some((b: { type: string }) => b.type === "toolCall");
				// Echo the prefill tool call (same name) so the prefill echo verification passes.
				return fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], {
					stopReason: "toolUse",
				});
			},
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		// The retry used prefill continuation: returnPrefill was forwarded and the
		// prefill (tool call) was the last context message.
		expect(capturedReturnPrefill).toBe(true);
		expect(capturedLastIsToolCall).toBe(true);

		// The echoed tool call was executed (terminate), so the transcript ends
		// with the tool result.
		const messages = harness.session.messages;
		const lastMessage = messages[messages.length - 1];
		expect(lastMessage?.role).toBe("toolResult");
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(
			assistant && "content" in assistant
				? assistant.content.some((b: { type: string }) => b.type === "toolCall")
				: false,
		).toBe(true);
	});

	it("prefers prefill continuation over queued steering when the partial has an error", async () => {
		// Regression: when the LLM server terminates mid-stream and the user has
		// queued a steering message, the prefill continuation of the original
		// partial should take priority over delivering the steering message.
		const harness = await createHarness({
			fauxApi: "openai-completions",
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		const partialText = "partial response content";
		const continuedText = " continued after server recovery";
		const seenPrefills: string[] = [];

		harness.setResponses([
			// First call: partial response with terminated error
			fauxAssistantMessage(partialText, {
				stopReason: "error",
				errorMessage: "terminated",
			}),
			// Second call (retry): 503 still loading
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '503: {"message":"Loading model","type":"unavailable_error","code":503}',
			}),
			// Third call (retry): succeeds with prefill continuation
			(context) => {
				const last = context.messages[context.messages.length - 1];
				const lastText = getMessageText(last) as string;
				seenPrefills.push(lastText);
				return fauxAssistantMessage(`${lastText}${continuedText}`, {
					stopReason: "stop",
				});
			},
		]);

		// Queue a steering message after the first error (simulates user typing
		// during streaming, before the server terminates)
		// In the real flow this happens via session.prompt() with streamingBehavior
		// during an active stream. Here we queue it after the first LLM call fails.
		let steerQueued = false;
		// We intercept via the harness's prompt flow: the first response is the
		// terminated error. After the session processes it (but before retry),
		// we queue a steering message via the agent's steer() method.
		// The harness doesn't support mid-stream interception, so we use a
		// callback response that queues steering before returning.
		harness.setResponses([
			() => {
				// During the first LLM call, queue a steering message.
				// In the real flow this happens when the user types while streaming.
				if (!steerQueued) {
					steerQueued = true;
					harness.session.agent.steer({
						role: "user",
						content: [{ type: "text", text: "steering message" }],
						timestamp: Date.now(),
					});
				}
				return fauxAssistantMessage(partialText, {
					stopReason: "error",
					errorMessage: "terminated",
				});
			},
			// Retry calls (503 then success)
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '503: {"message":"Loading model","type":"unavailable_error","code":503}',
			}),
			(context) => {
				const last = context.messages[context.messages.length - 1];
				const lastText = getMessageText(last) as string;
				seenPrefills.push(lastText);
				return fauxAssistantMessage(`${lastText}${continuedText}`, {
					stopReason: "stop",
				});
			},
		]);

		await harness.session.prompt("test");

		// Three calls: terminated, 503, success (prefill continuation)
		expect(harness.faux.state.callCount).toBe(3);
		// The prefill must be the original partial text, NOT the steering message.
		expect(seenPrefills).toEqual([partialText]);

		// Final transcript: user prompt → successful assistant response
		const messages = harness.session.messages;
		const userMessages = messages.filter((m) => m.role === "user");
		const assistantMessages = messages.filter((m) => m.role === "assistant");
		expect(userMessages.length).toBe(1);
		expect(assistantMessages.length).toBe(1);
		expect(getMessageText(assistantMessages[0]) as string).toBe(`${partialText}${continuedText}`);
		// Steering message must NOT have been sent to the LLM.
		expect(userMessages[0]).toBeDefined();
		expect(getMessageText(userMessages[0]) as string).toBe("test");

		// Verify session log integrity: /delete should remove exactly one message
		// (the assistant response), not extra orphaned entries.
		const entriesBeforeDelete = harness.sessionManager
			.buildContextEntries()
			.filter((e) => e.type === "message").length;
		expect(entriesBeforeDelete).toBe(2); // 1 user + 1 assistant
		const removed = harness.session.deleteLastMessages(1);
		expect(removed).toBe(1);
		const entriesAfterDelete = harness.sessionManager
			.buildContextEntries()
			.filter((e) => e.type === "message").length;
		expect(entriesAfterDelete).toBe(1); // only user prompt remains
	});
});
