/**
 * Regression test: a failed or cancelled compaction must restore the kept
 * messages that were cut off by the branch. Otherwise /copy (and the whole
 * transcript) silently loses messages after a compaction error or abort.
 */

import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type StopReason,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

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

/** Seed a session with a compactable prefix and two "kept" messages. */
function seedSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "prefix user message to summarize" }],
		timestamp: now - 4000,
	});
	const prefixAssistant: AssistantMessage = {
		...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 3000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	};
	prefixAssistant.content = [{ type: "text", text: "prefix assistant reply" }];
	harness.sessionManager.appendMessage(prefixAssistant);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "keep this user message" }],
		timestamp: now - 2000,
	});
	const keptAssistant: AssistantMessage = {
		...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 1000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	};
	keptAssistant.content = [{ type: "text", text: "kept assistant reply" }];
	harness.sessionManager.appendMessage(keptAssistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** streamFunction that emits each scripted assistant message across calls. */
function useScriptedStreamFn(harness: Harness, script: AssistantMessage[]): void {
	let callCount = 0;
	const streamFunction = (model: { api: string; provider: string; id: string }) => {
		const message = script[callCount] ?? script[script.length - 1]!;
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const response = { ...message, api: model.api, provider: model.provider, model: model.id };
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				stream.push({ type: "error", reason: response.stopReason, error: response });
			} else {
				// Scripted messages always use a completed stop reason (never "pending").
				const reason = response.stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
				stream.push({ type: "done", reason, message: response });
			}
		});
		return stream;
	};
	harness.session.agent.streamFunction = streamFunction;
}

function transcriptTexts(harness: Harness): string[] {
	return harness.session.messages.map((m) => getMessageText(m)).filter((t) => t.length > 0);
}

describe("AgentSession substring /copy matching", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("substring copy matches user, assistant, tool result, and bash execution text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "user message with a ``` code block" }],
			timestamp: now - 3000,
		});
		const assistant = fauxAssistantMessage("assistant without a fence", {
			stopReason: "stop",
			timestamp: now - 2000,
		});
		assistant.usage = createUsage(10);
		harness.sessionManager.appendMessage(assistant);
		// Harness message: empty assistant with no content, must be ignored.
		const harnessMsg = fauxAssistantMessage("", { stopReason: "aborted", timestamp: now - 1500 });
		harness.sessionManager.appendMessage(harnessMsg);
		// Tool result containing a code fence.
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "bash",
			content: [{ type: "text", text: "command output with ``` a fence ```" }],
			isError: false,
			timestamp: now - 1000,
		});
		// Bash execution message containing the same fence.
		harness.sessionManager.appendMessage({
			role: "bashExecution",
			command: "grep -r fence",
			output: "found ``` fence",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: now - 500,
		} as never);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const matches = harness.session.getCopyableMessagesContaining("```");
		const matched = matches
			.map((match) => harness.session.getMessageCopyText(match.message))
			.filter((text): text is string => text !== undefined)
			.join("\n\n");
		expect(matched).toBeTruthy();
		expect(matched).toContain("user message with a ``` code block");
		expect(matched).toContain("command output with ``` a fence ```");
		// The bash execution is converted to text and matched.
		expect(matched).toContain("found ``` fence");
		// Harness and non-matching assistant messages are excluded.
		expect(matched).not.toContain("assistant without a fence");
		expect(matches).toHaveLength(3);
	});

	it("substring copy returns no matches when nothing matches", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "ordinary user message" }],
			timestamp: now - 1000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		expect(harness.session.getCopyableMessagesContaining("does not exist")).toEqual([]);
	});
});

describe("AgentSession compaction keeps kept messages on failure or cancel", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps all messages when summarization fails with a non-retryable error", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
			usage: createUsage(10),
		};
		useScriptedStreamFn(harness, [error]);

		await expect(harness.session.compact({ keepRecentMessages: 2 })).rejects.toThrow("insufficient_quota");

		const texts = transcriptTexts(harness);
		expect(texts).toContain("keep this user message");
		expect(texts).toContain("kept assistant reply");
		expect(texts).toContain("prefix user message to summarize");
	});

	it("keeps all messages when compaction is cancelled during retry backoff", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 30_000 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			usage: createUsage(10),
		};
		useScriptedStreamFn(harness, [error, error, error]);

		const compactPromise = harness.session.compact({ keepRecentMessages: 2 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();
		await expect(compactPromise).rejects.toThrow();

		const texts = transcriptTexts(harness);
		expect(texts).toContain("keep this user message");
		expect(texts).toContain("kept assistant reply");
		expect(texts).toContain("prefix user message to summarize");
	});
});
