import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
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
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("assistant response to compact", { stopReason: "stop", timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function summaryStreamFn(harness: Harness, summary: string): void {
	harness.session.agent.streamFn = (model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

interface CompactionEndEvent {
	type: "compaction_end";
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

describe("issue #5217 compaction reason on compaction events", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports manual reason for compact()", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		summaryStreamFn(harness, "manual summary");

		await harness.session.compact();

		const events: CompactionEndEvent[] = harness.eventsOfType("compaction_end");
		expect(events.at(-1)).toMatchObject({ reason: "manual", willRetry: false });
	});

	it("reports threshold reason for auto-compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		summaryStreamFn(harness, "threshold summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const events: CompactionEndEvent[] = harness.eventsOfType("compaction_end");
		expect(events.at(-1)).toMatchObject({ reason: "threshold", willRetry: false });
	});

	it("reports overflow reason and willRetry for overflow recovery", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		summaryStreamFn(harness, "overflow summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("overflow", true);

		const events: CompactionEndEvent[] = harness.eventsOfType("compaction_end");
		expect(events.at(-1)).toMatchObject({ reason: "overflow", willRetry: true });
	});
});
