import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { parseSleeptimeMs } from "../src/core/duration.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext, ExtensionToolContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import type { Settings } from "../src/core/settings-schema.ts";
import timeAwarenessExtension from "../src/extensions/time-awareness/index.ts";

async function loadExtension(settings: Partial<Settings["timeAwareness"]>) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		timeAwarenessExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:test>",
	);
	runtime.getSettings = () => ({ timeAwareness: settings }) as unknown as Settings;
	const sessionManager = SessionManager.inMemory();
	return { extension, runtime, sessionManager };
}

function makeContext(sessionManager: SessionManager): ExtensionContext & ExtensionToolContext {
	return { sessionManager } as unknown as ExtensionContext & ExtensionToolContext;
}

type TestMessage = {
	role: string;
	content: string | Array<{ type: string; text?: string }>;
	timestamp: number;
};

function userMessage(text: string, timestamp: number): TestMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function textOf(message: TestMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

describe("parseSleeptimeMs", () => {
	it("sums sleep-style tokens", () => {
		expect(parseSleeptimeMs("1h 30m")).toBe(90 * 60_000);
		expect(parseSleeptimeMs("45s")).toBe(45_000);
		expect(parseSleeptimeMs("5.5m")).toBe(330_000);
		expect(parseSleeptimeMs("2d")).toBe(2 * 86_400_000);
	});

	it("rejects invalid and non-positive durations", () => {
		expect(parseSleeptimeMs("abc")).toBeUndefined();
		expect(parseSleeptimeMs("1x")).toBeUndefined();
		expect(parseSleeptimeMs("0m")).toBeUndefined();
		expect(parseSleeptimeMs("")).toBeUndefined();
	});
});

describe("time-awareness context decoration", () => {
	it("off mode leaves messages untouched", async () => {
		const { extension, sessionManager } = await loadExtension({ mode: "off" });
		const handler = extension.handlers.get("context")![0]!;
		const messages = [
			userMessage("first", Date.now() - 86_400_000),
			userMessage("second", Date.now() - 60_000),
			userMessage("third", Date.now()),
		];
		await handler({ type: "context", messages: messages as AgentMessage[] }, makeContext(sessionManager));
		expect(textOf(messages[2])).toBe("third");
	});

	it("always mode decorates the trailing user message with both elapsed spans", async () => {
		const { extension, sessionManager } = await loadExtension({ mode: "always" });
		const handler = extension.handlers.get("context")![0]!;
		const now = Date.now();
		const messages = [userMessage("first", now - 3_600_000), userMessage("second", now - 900_000)];
		await handler({ type: "context", messages: messages as AgentMessage[] }, makeContext(sessionManager));
		const decorated = textOf(messages[1]);
		expect(decorated).toContain("second");
		expect(decorated).toMatch(
			/\[time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \| \+1h since previous message \| \+/,
		);
		// History is never rewritten.
		expect(textOf(messages[0])).toBe("first");
	});

	it("auto mode skips decoration below the threshold and decorates past it", async () => {
		const { extension, sessionManager } = await loadExtension({ mode: "auto", threshold: "10m" });
		const handler = extension.handlers.get("context")![0]!;
		const now = Date.now();
		const below = [userMessage("first", now - 60_000), userMessage("second", now)];
		await handler({ type: "context", messages: below as AgentMessage[] }, makeContext(sessionManager));
		expect(textOf(below[1])).toBe("second");

		const above = [userMessage("first", now - 11 * 60_000), userMessage("second", now)];
		await handler({ type: "context", messages: above as AgentMessage[] }, makeContext(sessionManager));
		expect(textOf(above[1])).toContain("since previous message");
	});

	it("auto mode decorates the first message of a session with the absolute time only", async () => {
		const { extension, sessionManager } = await loadExtension({ mode: "auto" });
		const handler = extension.handlers.get("context")![0]!;
		const messages = [userMessage("only", Date.now())];
		await handler({ type: "context", messages: messages as AgentMessage[] }, makeContext(sessionManager));
		const decorated = textOf(messages[0]);
		expect(decorated).toMatch(/\[time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/);
		expect(decorated).not.toContain("since");
	});

	it("never decorates non-user trailing messages", async () => {
		const { extension, sessionManager } = await loadExtension({ mode: "always" });
		const handler = extension.handlers.get("context")![0]!;
		const assistantMessage: TestMessage = {
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			timestamp: Date.now(),
		};
		const messages: AgentMessage[] = [userMessage("first", Date.now() - 60_000), assistantMessage] as AgentMessage[];
		await handler({ type: "context", messages: messages as AgentMessage[] }, makeContext(sessionManager));
		expect(textOf(messages[1] as TestMessage)).toBe("working");
	});

	it("throws a usage error for an invalid threshold", async () => {
		const { extension, sessionManager } = await loadExtension({ mode: "auto", threshold: "soon" });
		const handler = extension.handlers.get("context")![0]!;
		const messages = [userMessage("first", Date.now()), userMessage("second", Date.now())];
		expect(() =>
			handler({ type: "context", messages: messages as AgentMessage[] }, makeContext(sessionManager)),
		).toThrow("timeAwareness.threshold");
	});
});

describe("time tool and command", () => {
	it("reports now, session start, and the last message time", async () => {
		const { extension, sessionManager } = await loadExtension({ mode: "off" });
		const tool = extension.tools.get("time")!.definition;
		const result = await tool.execute("call-1", {}, undefined, undefined, makeContext(sessionManager));
		const text = textOf({ role: "user", content: result.content, timestamp: 0 });
		expect(text).toMatch(/^now: \d{4}-\d{2}-\d{2}T/);
		expect(text).toContain("session start:");
		// Fresh session with no messages: no last-message line.
		expect(text).not.toContain("last message:");
	});
});

describe("settings defaults", () => {
	it("default to off with a 10m threshold", () => {
		expect(SETTINGS_DEFAULTS.timeAwareness).toEqual({ mode: "off", threshold: "10m" });
	});
});
