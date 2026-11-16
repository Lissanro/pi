/**
 * The `time` tool, `/time` command, and per-request time decoration as an
 * extension. The CLI loads it as a built-in extension; SDK users add
 * `createTimeAwarenessExtension()` to their extension factories.
 *
 * Before each LLM call the decoration appends a `[time: ...]` block to the
 * trailing user message so the model knows the current local time and how
 * much time has passed: heartbeat wake-ups, overnight pauses, and resumed
 * sessions become visible in-context without a tool call. Modes: off
 * (default), auto (decorate only past a gap threshold), always. Only the
 * trailing user message is decorated; history is never rewritten, so the
 * prompt-cache prefix is untouched.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { parseSleeptimeMs } from "../../core/duration.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";

const MODES = ["off", "auto", "always"] as const;
type TimeAwarenessMode = (typeof MODES)[number];

interface TimeAwarenessSettings {
	mode: TimeAwarenessMode;
	thresholdMs: number;
}

/**
 * Read and validate the timeAwareness settings block. Settings files are
 * user input and are not schema-validated at load, so both fields are
 * checked here; a bad value throws a usage error naming the setting.
 */
function readTimeAwarenessSettings(raw: unknown): TimeAwarenessSettings {
	const block = (raw ?? {}) as { mode?: unknown; threshold?: unknown };
	const mode = block.mode ?? SETTINGS_DEFAULTS.timeAwareness.mode;
	if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) {
		throw new Error(`Invalid timeAwareness.mode: ${String(mode)} (expected off, auto, or always)`);
	}
	const thresholdSpec = block.threshold ?? SETTINGS_DEFAULTS.timeAwareness.threshold;
	const thresholdMs = parseSleeptimeMs(typeof thresholdSpec === "string" ? thresholdSpec : String(thresholdSpec));
	if (thresholdMs === undefined) {
		throw new Error(
			`Invalid timeAwareness.threshold: ${String(thresholdSpec)} (sleep-style duration, e.g. "30m", "1h 30m")`,
		);
	}
	return { mode: mode as TimeAwarenessMode, thresholdMs };
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** Local ISO-8601 with offset, e.g. 2026-12-07T15:23:04+03:00. */
function formatLocalIso(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
	);
}

/** Compact elapsed time, e.g. 45s, 14m32s, 3h12m, 2d4h. */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const units: Array<[number, string]> = [
		[Math.floor(totalSeconds / 86400), "d"],
		[Math.floor((totalSeconds % 86400) / 3600), "h"],
		[Math.floor((totalSeconds % 3600) / 60), "m"],
		[totalSeconds % 60, "s"],
	];
	const parts = units
		.filter(([value]) => value > 0)
		.slice(0, 2)
		.map(([value, unit]) => `${value}${unit}`);
	return parts.length > 0 ? parts.join("") : "0s";
}

/**
 * The decoration block for the trailing user message. With no previous
 * message (session start) it carries only the absolute time; otherwise both
 * elapsed spans are included.
 */
function buildTimeBlock(now: Date, previous: AgentMessage | undefined, sessionStartMs: number | undefined): string {
	const parts = [`time: ${formatLocalIso(now)}`];
	if (previous) {
		parts.push(`+${formatElapsed(now.getTime() - previous.timestamp)} since previous message`);
		const start = sessionStartMs ?? previous.timestamp;
		parts.push(`+${formatElapsed(now.getTime() - start)} since session start`);
	}
	return `[${parts.join(" | ")}]`;
}

/** Append the block to the message's text content, keeping any images intact. */
function appendBlock(message: UserMessage, block: string): void {
	if (typeof message.content === "string") {
		message.content = `${message.content}\n\n${block}`;
		return;
	}
	const lastText = [...message.content].reverse().find((item): item is TextContent => item.type === "text");
	if (lastText) {
		lastText.text = `${lastText.text}\n\n${block}`;
	} else {
		message.content.push({ type: "text", text: block });
	}
}

function sessionStartMs(ctx: ExtensionContext): number | undefined {
	const header = ctx.sessionManager.getHeader();
	if (!header) return undefined;
	const parsed = Date.parse(header.timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Current time, session start, and the last message time, one per line. */
function buildTimeReport(now: Date, sessionManager: ReadonlySessionManager): string {
	const lines = [`now: ${formatLocalIso(now)}`];
	const header = sessionManager.getHeader();
	const startMs = header ? Date.parse(header.timestamp) : Number.NaN;
	if (!Number.isNaN(startMs)) {
		lines.push(`session start: ${formatLocalIso(new Date(startMs))} (+${formatElapsed(now.getTime() - startMs)})`);
	}
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const at = entry.message.timestamp;
			lines.push(`last message: ${formatLocalIso(new Date(at))} (+${formatElapsed(now.getTime() - at)})`);
			break;
		}
	}
	return lines.join("\n");
}

export function createTimeAwarenessExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "time",
			label: "Time",
			description:
				"Get the current local time, the session start, and how much time has passed since the last message.",
			promptGuidelines: ["Use when the current time or elapsed time matters and no time block is in context."],
			parameters: Type.Object({}),
			defaultActive: false,
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				return {
					content: [{ type: "text", text: buildTimeReport(new Date(), ctx.sessionManager) }],
					details: {},
				};
			},
		});

		pi.registerCommand("time", {
			description: "Show the current local time and elapsed session time",
			handler: async (_args, ctx) => {
				ctx.ui.notify(buildTimeReport(new Date(), ctx.sessionManager));
			},
		});

		pi.on("context", (event, ctx) => {
			const settings = readTimeAwarenessSettings(pi.getSettings().timeAwareness);
			if (settings.mode === "off") return;
			const messages = event.messages;
			if (messages.length === 0) return;
			const last = messages[messages.length - 1];
			if (last.role !== "user") return;
			const previous = messages.length >= 2 ? messages[messages.length - 2] : undefined;
			const now = new Date();
			if (settings.mode === "auto" && previous && now.getTime() - previous.timestamp <= settings.thresholdMs) {
				return;
			}
			appendBlock(last as UserMessage, buildTimeBlock(now, previous, sessionStartMs(ctx)));
		});
	};
}

export default createTimeAwarenessExtension();
