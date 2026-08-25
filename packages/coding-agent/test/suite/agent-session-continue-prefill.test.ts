import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	fauxAssistantMessage,
	type Message,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession continue with prefill", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("deletes the prefill from the session and continues with returnPrefill", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Initial prompt to get an assistant message in the session.
		harness.setResponses([fauxAssistantMessage("Partial response")]);
		await harness.session.prompt("Hello");

		// The session has [user, assistant].
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		const prefill = harness.session.messages[1];
		expect(prefill?.role).toBe("assistant");

		// Switch to an openai-completions model and a mock stream that captures
		// returnPrefill and the LLM context messages.
		let capturedReturnPrefill: boolean | undefined;
		let capturedContextMessages: Message[] | undefined;
		const prefillText = getMessageText(prefill!);
		harness.session.agent.streamFunction = ((_model, context, options) => {
			capturedReturnPrefill = options?.returnPrefill;
			capturedContextMessages = context.messages;
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("Unexpected event type");
				},
			);
			queueMicrotask(() => {
				// With return_prefill the provider echoes the prefill before new tokens.
				stream.push({
					type: "done",
					reason: "stop",
					message: fauxAssistantMessage(`${prefillText} continued`),
				});
			});
			return stream;
		}) as StreamFn;
		harness.session.agent.state.model = { ...harness.session.agent.state.model, api: "openai-completions" };

		// Delete the prefill (last assistant message) from the session log and agent state.
		const removed = harness.session.deleteLastMessages(1);
		expect(removed).toBe(1);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user"]);

		// Continue with the prefill.
		await harness.session.agent.continue(prefill!);

		// returnPrefill was forwarded to the stream function.
		expect(capturedReturnPrefill).toBe(true);
		// The prefill was the last message in the LLM context.
		expect(capturedContextMessages?.length).toBe(2);
		const contextLast = capturedContextMessages?.[1];
		expect(contextLast?.role).toBe("assistant");
		expect(getMessageText(contextLast)).toBe("Partial response");
		// The session has the echoed prefill plus newly generated tokens.
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[1]!)).toBe("Partial response continued");
	});

	it("falls back to normal continue when the last message is a user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("First response"), fauxAssistantMessage("Second response")]);
		await harness.session.prompt("Hello");

		// Session has [user, assistant]. Continue normally (no prefill) from the
		// assistant message is not the path here — we test user-last continue by
		// deleting the assistant and continuing from the user message.
		harness.session.deleteLastMessages(1);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user"]);

		await harness.session.agent.continue();

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[1]!)).toBe("Second response");
	});
});
