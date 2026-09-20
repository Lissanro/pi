import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const SUMMARY_TEXT = "## Summary\n- The user started a task.";

/**
 * A tool whose execution blocks until released, so a test can act mid-run
 * (while the agent is streaming) before letting the turn complete.
 */
function createWaitTool(): { tool: AgentTool; release: () => void; waitForToolStart: (harness: Harness) => Promise<void> } {
	let releaseTool: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const waitForToolStart = (harness: Harness) =>
		new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
	return { tool, release: () => releaseTool?.(), waitForToolStart };
}

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession queued /compact", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs a /compact queued while streaming at the turn boundary, then resumes the run", async () => {
		const { tool: waitTool, release, waitForToolStart } = createWaitTool();
		const harness = await createHarness({
			tools: [waitTool],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(SUMMARY_TEXT),
			fauxAssistantMessage("resumed after compact"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart(harness);

		// The agent is mid-run; /compact must not interrupt the turn.
		expect(harness.session.isStreaming).toBe(true);
		harness.session.queueCompact();

		release();
		await promptPromise;

		// The compaction ran mid-run (before the run settled) with reason "manual".
		const compactionStarts = harness.eventsOfType("compaction_start");
		expect(compactionStarts).toHaveLength(1);
		expect(compactionStarts[0].reason).toBe("manual");
		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0].aborted).toBe(false);
		expect(compactionEnds[0].result?.summary).toBe(SUMMARY_TEXT);

		// Ordering: compaction completed after the tool results and before the
		// resumed assistant response, which itself completed before the run settled.
		const eventTypes = harness.events.map((event) => event.type);
		const compactionEndIndex = eventTypes.indexOf("compaction_end");
		const settledIndex = eventTypes.indexOf("agent_settled");
		expect(compactionEndIndex).toBeGreaterThanOrEqual(0);

		// The interrupted run resumed automatically after the compaction.
		expect(getAssistantTexts(harness)).toContain("resumed after compact");
		const resumedMessageEnd = harness.events.find(
			(event) =>
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some((part) => part.type === "text" && part.text === "resumed after compact"),
		);
		expect(resumedMessageEnd).toBeDefined();
		const resumedEndIndex = harness.events.indexOf(resumedMessageEnd!);
		expect(resumedEndIndex).toBeGreaterThan(compactionEndIndex);
		expect(settledIndex).toBeGreaterThan(resumedEndIndex);

		// The compaction entry landed in the session branch.
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not auto-continue when the queued /compact lands on a turn that ended the run", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);

		// Hold the first (tool-less) response open so /compact can be queued
		// while it streams; the summarization request is served immediately.
		let releaseResponse: (() => void) | undefined;
		const responseRelease = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let markFirstRequest = () => {};
		const firstRequest = new Promise<void>((resolve) => {
			markFirstRequest = resolve;
		});
		let requestCount = 0;
		harness.session.agent.streamFunction = (model, _context, _options) => {
			requestCount++;
			if (requestCount === 1) {
				markFirstRequest();
			}
			const stream = createAssistantMessageEventStream();
			void (async () => {
				if (requestCount === 1) {
					await responseRelease;
				}
				const text = requestCount === 1 ? "done" : SUMMARY_TEXT;
				const message: AssistantMessage = {
					...fauxAssistantMessage(text),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: usage(10),
				};
				stream.push({ type: "done", reason: "stop", message });
			})();
			return stream;
		};

		const promptPromise = harness.session.prompt("start");
		await firstRequest;

		// The provider request is in flight: /compact is queued, not run.
		expect(harness.session.isStreaming).toBe(true);
		harness.session.queueCompact();

		releaseResponse!();
		await promptPromise;

		// Compaction ran, but the run had ended naturally: no continuation.
		const compactionStarts = harness.eventsOfType("compaction_start");
		expect(compactionStarts).toHaveLength(1);
		expect(compactionStarts[0].reason).toBe("manual");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(getAssistantTexts(harness)).toEqual(["done"]);
		expect(requestCount).toBe(2);
		expect(harness.events.some((event) => event.type === "agent_settled")).toBe(true);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("does not resume the run when the queued compaction is cancelled", async () => {
		const { tool: waitTool, release, waitForToolStart } = createWaitTool();
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		const harness = await createHarness({
			tools: [waitTool],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				((pi: ExtensionAPI) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							markCompactionStarted();
						});
					});
				}) as never,
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("should not stream"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart(harness);
		harness.session.queueCompact();
		release();

		await compactionStarted;
		harness.session.abortCompaction();
		await promptPromise;

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0].aborted).toBe(true);
		// The run was interrupted mid-task, but a cancelled compaction must not
		// restart generation.
		expect(getAssistantTexts(harness)).not.toContain("should not stream");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.events.some((event) => event.type === "agent_settled")).toBe(true);
	});
});
