import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type HeartbeatEntry,
	InteractiveMode,
	parseHeartbeatFile,
	parseHeartbeatSpec,
	serializeHeartbeats,
} from "../src/modes/interactive/interactive-mode.ts";

describe("parseHeartbeatSpec", () => {
	it("parses a sleep-style duration into an interval", () => {
		expect(parseHeartbeatSpec("3h")).toEqual({ type: "interval", intervalMs: 10_800_000 });
		expect(parseHeartbeatSpec("30s")).toEqual({ type: "interval", intervalMs: 30_000 });
		expect(parseHeartbeatSpec("5.5m")).toEqual({ type: "interval", intervalMs: 330_000 });
		expect(parseHeartbeatSpec("2d")).toEqual({ type: "interval", intervalMs: 172_800_000 });
	});

	it("sums multiple duration tokens like sleep(1)", () => {
		expect(parseHeartbeatSpec("1h 30m")).toEqual({ type: "interval", intervalMs: 5_400_000 });
		expect(parseHeartbeatSpec("1h 30m 20s")).toEqual({ type: "interval", intervalMs: 5_420_000 });
	});

	it("parses a date-less local time into a daily beat", () => {
		expect(parseHeartbeatSpec("15:23")).toEqual({ type: "daily", hh: 15, mm: 23, ss: 0 });
		expect(parseHeartbeatSpec("15:23:45")).toEqual({ type: "daily", hh: 15, mm: 23, ss: 45 });
		expect(parseHeartbeatSpec("9:05")).toEqual({ type: "daily", hh: 9, mm: 5, ss: 0 });
	});

	it("rejects invalid clock times", () => {
		expect(parseHeartbeatSpec("24:00")).toBeUndefined();
		expect(parseHeartbeatSpec("15:60")).toBeUndefined();
		expect(parseHeartbeatSpec("15:23:60")).toBeUndefined();
	});

	it("rejects absolute dates (one-shot belongs to /schedule)", () => {
		expect(parseHeartbeatSpec("2026-08-08 15:23")).toBeUndefined();
		expect(parseHeartbeatSpec("2026-08-08 15:23:45")).toBeUndefined();
	});

	it("rejects zero durations and garbage", () => {
		expect(parseHeartbeatSpec("0s")).toBeUndefined();
		expect(parseHeartbeatSpec("tomorrow")).toBeUndefined();
		expect(parseHeartbeatSpec("5x")).toBeUndefined();
		expect(parseHeartbeatSpec("")).toBeUndefined();
		expect(parseHeartbeatSpec("hello world")).toBeUndefined();
	});
});

describe("parseHeartbeatFile", () => {
	it("parses a single header with a text block", () => {
		const content = "/heartbeat 5m\nThis is text for the heartbeat.\n";
		expect(parseHeartbeatFile(content)).toEqual([{ spec: "5m", text: "This is text for the heartbeat." }]);
	});

	it("strips trailing newlines but preserves internal newlines", () => {
		const content = "/heartbeat 5m\nline one\n\nline two\n\n\n";
		expect(parseHeartbeatFile(content)).toEqual([{ spec: "5m", text: "line one\n\nline two" }]);
	});

	it("treats invalid /heartbeat lines as text of the current block", () => {
		const content =
			"/heartbeat 23:10\nAnother text with invalid /heartbeat slash command.\n\n/heartbeat - this is not valide one either, and still part of the text block\n";
		expect(parseHeartbeatFile(content)).toEqual([
			{
				spec: "23:10",
				text: "Another text with invalid /heartbeat slash command.\n\n/heartbeat - this is not valide one either, and still part of the text block",
			},
		]);
	});

	it("starts a new block at each valid header", () => {
		const content = "/heartbeat 5m\nfirst\n\n/heartbeat 15:23\nsecond\n";
		expect(parseHeartbeatFile(content)).toEqual([
			{ spec: "5m", text: "first" },
			{ spec: "15:23", text: "second" },
		]);
	});

	it("yields a bare continue for a header immediately followed by another header", () => {
		const content = "/heartbeat 3h\n/heartbeat 15:23\nwake\n";
		expect(parseHeartbeatFile(content)).toEqual([
			{ spec: "3h", text: "" },
			{ spec: "15:23", text: "wake" },
		]);
	});

	it("ignores preamble before the first header", () => {
		const content = "# notes\njust text\n/heartbeat 5m\nreal\n";
		expect(parseHeartbeatFile(content)).toEqual([{ spec: "5m", text: "real" }]);
	});

	it("normalizes CRLF line endings", () => {
		const content = "/heartbeat 5m\r\none\r\n\r\ntwo\r\n";
		expect(parseHeartbeatFile(content)).toEqual([{ spec: "5m", text: "one\n\ntwo" }]);
	});

	it("returns empty for a file with no valid headers", () => {
		expect(parseHeartbeatFile("no headers here\n/heartbeat invalid\n")).toEqual([]);
	});
});

describe("serializeHeartbeats", () => {
	it("serializes a message beat and a bare-continue beat", () => {
		const entries: HeartbeatEntry[] = [mkEntry(1, "5m", "This is text for the heartbeat."), mkEntry(2, "3h", "")];
		expect(serializeHeartbeats(entries)).toBe("/heartbeat 5m\nThis is text for the heartbeat.\n\n/heartbeat 3h\n");
	});

	it("round-trips through parseHeartbeatFile", () => {
		const entries: HeartbeatEntry[] = [
			mkEntry(1, "5m", "line one\n\nline two"),
			mkEntry(2, "23:10", "Another text with invalid /heartbeat slash command.\n\n/heartbeat - not a header"),
		];
		expect(parseHeartbeatFile(serializeHeartbeats(entries))).toEqual([
			{ spec: "5m", text: "line one\n\nline two" },
			{ spec: "23:10", text: "Another text with invalid /heartbeat slash command.\n\n/heartbeat - not a header" },
		]);
	});
});

function mkEntry(id: number, spec: string, text: string): HeartbeatEntry {
	const schedule = parseHeartbeatSpec(spec)!;
	return {
		id,
		text,
		intervalMs: schedule.type === "interval" ? schedule.intervalMs : null,
		dailyAt: schedule.type === "daily" ? { hh: schedule.hh, mm: schedule.mm, ss: schedule.ss } : null,
		spec,
		paused: false,
		nextFireAt: null,
		isContinue: text === "",
	};
}

/** Run fn in a fresh temp directory that is removed afterwards. */
async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hb-"));
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const heartbeatPrototype = InteractiveMode.prototype as unknown as {
	handleHeartbeatCommand: (this: HeartbeatCommandContext, arg: string) => Promise<void>;
	scheduleHeartbeat: (this: HeartbeatCommandContext, spec: string, text: string) => void;
	createHeartbeatEntry: (this: HeartbeatCommandContext, spec: string, text: string) => HeartbeatEntry | null;
	cancelHeartbeats: (this: HeartbeatCommandContext, count: number) => void;
	cancelHeartbeatByIds: (this: HeartbeatCommandContext, spec: string) => void;
	pauseHeartbeats: (this: HeartbeatCommandContext, spec: string) => void;
	continueHeartbeats: (this: HeartbeatCommandContext, spec: string) => void;
	listHeartbeats: (this: HeartbeatCommandContext) => void;
	setHeartbeatPaused: (this: HeartbeatCommandContext, entry: HeartbeatEntry, paused: boolean) => void;
	fireHeartbeat: (this: HeartbeatCommandContext, id: number) => void;
	armHeartbeat: (this: HeartbeatCommandContext, entry: HeartbeatEntry) => void;
	saveHeartbeatsFromArg: (this: HeartbeatCommandContext, spec: string) => Promise<void>;
	loadHeartbeatsFromArg: (this: HeartbeatCommandContext, spec: string) => Promise<void>;
	loadHeartbeatsFromPath: (
		this: HeartbeatCommandContext,
		resolvedPath: string,
		displayPath: string,
		silentIfMissing: boolean,
	) => Promise<void>;
	resolveHeartbeatPath: (this: HeartbeatCommandContext, arg: string, cwd: string) => string;
	parseHeartbeatIds: (this: HeartbeatCommandContext, spec: string, keyword: string) => number[] | null;
	heartbeatDescription: (entry: HeartbeatEntry) => string;
	heartbeatTimeLeft: (entry: HeartbeatEntry) => string;
	quotedListText: (text: string) => string;
};

type HeartbeatCommandContext = {
	showStatus: (message: string) => void;
	heartbeats: HeartbeatEntry[];
	nextHeartbeatId: number;
	session: { isStreaming: boolean; isCompacting: boolean };
	sessionManager: { getCwd: () => string };
	armHeartbeat: (entry: HeartbeatEntry) => void;
	setHeartbeatPaused: (entry: HeartbeatEntry, paused: boolean) => void;
	cancelHeartbeats: (count: number) => void;
	cancelHeartbeatByIds: (spec: string) => void;
	pauseHeartbeats: (spec: string) => void;
	continueHeartbeats: (spec: string) => void;
	listHeartbeats: () => void;
	scheduleHeartbeat: (spec: string, text: string) => void;
	createHeartbeatEntry: (spec: string, text: string) => HeartbeatEntry | null;
	fireHeartbeat: (id: number) => void;
	saveHeartbeatsFromArg: (spec: string) => Promise<void>;
	loadHeartbeatsFromArg: (spec: string) => Promise<void>;
	loadHeartbeatsFromPath: (resolvedPath: string, displayPath: string, silentIfMissing: boolean) => Promise<void>;
	resolveHeartbeatPath: (arg: string, cwd: string) => string;
	parseHeartbeatIds: (spec: string, keyword: string) => number[] | null;
	handleHeartbeatCommand: (arg: string) => Promise<void>;
	deferOrRunScheduledAction: (entry: HeartbeatEntry & { when: { type: "time"; at: number } }) => void;
	deliverScheduledMessage: (text: string) => void;
	heartbeatDescription: (entry: HeartbeatEntry) => string;
	heartbeatTimeLeft: (entry: HeartbeatEntry) => string;
	quotedListText: (text: string) => string;
};

/**
 * Build a context whose logic methods run the real InteractiveMode
 * implementation bound to the context, while the side-effect boundaries
 * (showStatus, armHeartbeat, the scheduler delivery hooks, session, cwd) are
 * stubs so no real timers or delivery happen.
 */
function makeContext(overrides: Partial<HeartbeatCommandContext> = {}): HeartbeatCommandContext {
	const context: HeartbeatCommandContext = {
		showStatus: vi.fn(),
		heartbeats: [],
		nextHeartbeatId: 1,
		session: { isStreaming: false, isCompacting: false },
		sessionManager: { getCwd: () => "/tmp" },
		armHeartbeat: vi.fn(),
		deferOrRunScheduledAction: vi.fn(),
		deliverScheduledMessage: vi.fn(),
		setHeartbeatPaused: vi.fn(),
		cancelHeartbeats: vi.fn(),
		cancelHeartbeatByIds: vi.fn(),
		pauseHeartbeats: vi.fn(),
		continueHeartbeats: vi.fn(),
		listHeartbeats: vi.fn(),
		scheduleHeartbeat: vi.fn(),
		createHeartbeatEntry: vi.fn(),
		fireHeartbeat: vi.fn(),
		saveHeartbeatsFromArg: vi.fn(),
		loadHeartbeatsFromArg: vi.fn(),
		loadHeartbeatsFromPath: vi.fn(),
		resolveHeartbeatPath: vi.fn(),
		parseHeartbeatIds: vi.fn(),
		handleHeartbeatCommand: vi.fn(),
		heartbeatDescription: (entry) => heartbeatPrototype.heartbeatDescription(entry),
		heartbeatTimeLeft: (entry) => heartbeatPrototype.heartbeatTimeLeft(entry),
		quotedListText: (text) => heartbeatPrototype.quotedListText(text),
		...overrides,
	};

	const proto = heartbeatPrototype;
	context.handleHeartbeatCommand = (arg) => proto.handleHeartbeatCommand.call(context, arg);
	context.scheduleHeartbeat = (spec, text) => proto.scheduleHeartbeat.call(context, spec, text);
	context.createHeartbeatEntry = (spec, text) => proto.createHeartbeatEntry.call(context, spec, text);
	context.cancelHeartbeats = (count) => proto.cancelHeartbeats.call(context, count);
	context.cancelHeartbeatByIds = (spec) => proto.cancelHeartbeatByIds.call(context, spec);
	context.pauseHeartbeats = (spec) => proto.pauseHeartbeats.call(context, spec);
	context.continueHeartbeats = (spec) => proto.continueHeartbeats.call(context, spec);
	context.listHeartbeats = () => proto.listHeartbeats.call(context);
	context.setHeartbeatPaused = (entry, paused) => proto.setHeartbeatPaused.call(context, entry, paused);
	context.fireHeartbeat = (id) => proto.fireHeartbeat.call(context, id);
	context.saveHeartbeatsFromArg = (spec) => proto.saveHeartbeatsFromArg.call(context, spec);
	context.loadHeartbeatsFromArg = (spec) => proto.loadHeartbeatsFromArg.call(context, spec);
	context.loadHeartbeatsFromPath = (resolvedPath, displayPath, silentIfMissing) =>
		proto.loadHeartbeatsFromPath.call(context, resolvedPath, displayPath, silentIfMissing);
	context.resolveHeartbeatPath = (arg, cwd) => proto.resolveHeartbeatPath.call(context, arg, cwd);
	context.parseHeartbeatIds = (spec, keyword) => proto.parseHeartbeatIds.call(context, spec, keyword);
	return context;
}

describe("InteractiveMode /heartbeat command dispatch", () => {
	it("cancels the last N heartbeats for a -N spec", async () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b")] });
		await context.handleHeartbeatCommand("-1");
		expect(context.heartbeats.map((e) => e.id)).toEqual([1]);
	});

	it("lists active heartbeats when given no spec and no message", async () => {
		const context = makeContext();
		await context.handleHeartbeatCommand("");
		expect(context.showStatus).toHaveBeenCalledWith("No active heartbeats");
	});

	it("lists for the list and l specs", async () => {
		for (const spec of ["list", "l", "LIST"]) {
			const context = makeContext();
			await context.handleHeartbeatCommand(spec);
			expect(context.showStatus).toHaveBeenCalledWith("No active heartbeats");
		}
	});

	it("schedules a heartbeat from the first-line spec and message payload", async () => {
		const context = makeContext();
		await context.handleHeartbeatCommand("3h\ncheck the queue");
		expect(context.heartbeats).toHaveLength(1);
		expect(context.heartbeats[0].text).toBe("check the queue");
		expect(context.heartbeats[0].spec).toBe("3h");
		expect(context.showStatus).toHaveBeenCalledWith("Scheduled heartbeat every 3h");
	});

	it("dispatches cancel by id", async () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b")] });
		await context.handleHeartbeatCommand("cancel 1");
		expect(context.heartbeats.map((e) => e.id)).toEqual([2]);
	});

	it("dispatches pause to pause all", async () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b")] });
		await context.handleHeartbeatCommand("pause");
		expect(context.heartbeats.every((e) => e.paused)).toBe(true);
	});

	it("dispatches continue to resume paused beats", async () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({ armHeartbeat, heartbeats: [mkEntry(1, "3h", "a")] });
		context.heartbeats[0].paused = true;
		await context.handleHeartbeatCommand("continue");
		expect(context.heartbeats[0].paused).toBe(false);
		expect(armHeartbeat).toHaveBeenCalledWith(context.heartbeats[0]);
	});

	it("saves to HEARTBEAT.md on save", async () => {
		await withTempDir(async (dir) => {
			const context = makeContext({
				sessionManager: { getCwd: () => dir },
				heartbeats: [mkEntry(1, "3h", "check the queue")],
			});
			await context.handleHeartbeatCommand("save");
			const written = fs.readFileSync(path.join(dir, "HEARTBEAT.md"), "utf8");
			expect(written).toBe("/heartbeat 3h\ncheck the queue\n");
		});
	});

	it("loads from HEARTBEAT.md on load", async () => {
		await withTempDir(async (dir) => {
			fs.writeFileSync(path.join(dir, "HEARTBEAT.md"), "/heartbeat 3h\ncheck the queue\n");
			const context = makeContext({ sessionManager: { getCwd: () => dir } });
			await context.handleHeartbeatCommand("load");
			expect(context.heartbeats).toHaveLength(1);
			expect(context.heartbeats[0].text).toBe("check the queue");
			expect(context.heartbeats[0].spec).toBe("3h");
		});
	});

	it("shows usage for an invalid spec", async () => {
		const context = makeContext();
		await context.handleHeartbeatCommand("2026-08-08 15:23\nwake");
		expect(context.heartbeats).toHaveLength(0);
		expect(context.showStatus).toHaveBeenCalledWith(
			"Usage: /heartbeat [list | cancel <id> | pause [id...] | continue [id...] | save [path] | load [path] | -N | duration e.g. 3h | HH:MM[:SS]] with the message on the following line(s); no message = continue",
		);
	});
});

describe("InteractiveMode heartbeat scheduling", () => {
	it("schedules an interval heartbeat and marks it as a bare continue when message-less", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({ armHeartbeat });
		context.scheduleHeartbeat("3h", "");
		expect(context.heartbeats).toHaveLength(1);
		expect(context.heartbeats[0].intervalMs).toBe(10_800_000);
		expect(context.heartbeats[0].dailyAt).toBeNull();
		expect(context.heartbeats[0].isContinue).toBe(true);
		expect(context.heartbeats[0].spec).toBe("3h");
		expect(context.heartbeats[0].paused).toBe(false);
		expect(armHeartbeat).toHaveBeenCalledWith(context.heartbeats[0]);
		expect(context.showStatus).toHaveBeenCalledWith("Scheduled heartbeat every 3h");
	});

	it("schedules a daily-at heartbeat with a message payload", () => {
		const context = makeContext();
		context.scheduleHeartbeat("15:23", "wake up");
		expect(context.heartbeats).toHaveLength(1);
		expect(context.heartbeats[0].dailyAt).toEqual({ hh: 15, mm: 23, ss: 0 });
		expect(context.heartbeats[0].intervalMs).toBeNull();
		expect(context.heartbeats[0].isContinue).toBe(false);
	});

	it("shows usage for an invalid spec", () => {
		const context = makeContext();
		context.scheduleHeartbeat("2026-08-08 15:23", "wake");
		expect(context.heartbeats).toHaveLength(0);
		expect(context.showStatus).toHaveBeenCalledWith(
			"Usage: /heartbeat [list | cancel <id> | pause [id...] | continue [id...] | save [path] | load [path] | -N | duration e.g. 3h | HH:MM[:SS]] with the message on the following line(s); no message = continue",
		);
	});
});

describe("InteractiveMode heartbeat cancellation", () => {
	it("cancels the last N heartbeats", () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "5s", "")] });
		context.cancelHeartbeats(1);
		expect(context.heartbeats).toHaveLength(0);
		expect(context.showStatus).toHaveBeenCalledWith("Cancelled 1 heartbeat");
	});

	it("shows status when there are no heartbeats to cancel", () => {
		const context = makeContext();
		context.cancelHeartbeats(1);
		expect(context.showStatus).toHaveBeenCalledWith("No heartbeats to cancel");
	});

	it("cancels heartbeats by comma-separated ids", () => {
		const context = makeContext({
			heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b"), mkEntry(3, "1h", "c")],
		});
		context.cancelHeartbeatByIds("cancel 1,3");
		expect(context.heartbeats.map((e) => e.id)).toEqual([2]);
		expect(context.showStatus).toHaveBeenCalledWith("Cancelled 2 heartbeats");
	});

	it("reports missing ids alongside removed ones", () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "3h", "a")] });
		context.cancelHeartbeatByIds("cancel 1,9");
		expect(context.heartbeats).toHaveLength(0);
		expect(context.showStatus).toHaveBeenCalledWith("Cancelled 1 heartbeat; no heartbeat with id 9");
	});

	it("shows usage when cancel has no ids", () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "3h", "a")] });
		context.cancelHeartbeatByIds("cancel");
		expect(context.heartbeats).toHaveLength(1);
		expect(context.showStatus).toHaveBeenCalledWith("Usage: /heartbeat cancel <id[,id...]>");
	});
});

describe("InteractiveMode heartbeat pause and continue", () => {
	it("pauses all heartbeats when no ids are given", () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b")] });
		context.pauseHeartbeats("pause");
		expect(context.heartbeats.every((e) => e.paused)).toBe(true);
		expect(context.showStatus).toHaveBeenCalledWith("Paused 2 heartbeats");
	});

	it("pauses only the given comma-separated ids", () => {
		const context = makeContext({
			heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b"), mkEntry(3, "1h", "c")],
		});
		context.pauseHeartbeats("pause 1,3");
		expect(context.heartbeats[0].paused).toBe(true);
		expect(context.heartbeats[1].paused).toBe(false);
		expect(context.heartbeats[2].paused).toBe(true);
		expect(context.showStatus).toHaveBeenCalledWith("Paused 2 heartbeats");
	});

	it("reports when pausing unknown ids", () => {
		const context = makeContext({ heartbeats: [mkEntry(1, "3h", "a")] });
		context.pauseHeartbeats("pause 9");
		expect(context.heartbeats[0].paused).toBe(false);
		expect(context.showStatus).toHaveBeenCalledWith("No heartbeat with id 9");
	});

	it("continues all paused heartbeats when no ids are given", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({
			armHeartbeat,
			heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b")],
		});
		context.heartbeats[0].paused = true;
		context.heartbeats[1].paused = true;
		context.continueHeartbeats("continue");
		expect(context.heartbeats.every((e) => !e.paused)).toBe(true);
		expect(armHeartbeat).toHaveBeenCalledTimes(2);
		expect(context.showStatus).toHaveBeenCalledWith("Continued 2 heartbeats");
	});

	it("continues only the given ids", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({
			armHeartbeat,
			heartbeats: [mkEntry(1, "3h", "a"), mkEntry(2, "15:23", "b")],
		});
		context.heartbeats[0].paused = true;
		context.heartbeats[1].paused = true;
		context.continueHeartbeats("continue 1");
		expect(context.heartbeats[0].paused).toBe(false);
		expect(context.heartbeats[1].paused).toBe(true);
		expect(armHeartbeat).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith("Continued 1 heartbeat");
	});

	it("armHeartbeat sets nextFireAt and a timer for an armed beat", () => {
		const entry = mkEntry(1, "5m", "hi");
		const context = makeContext();
		heartbeatPrototype.armHeartbeat.call(context, entry);
		expect(entry.nextFireAt).toBeGreaterThan(Date.now());
		expect(entry.timer).toBeDefined();
		if (entry.timer) clearTimeout(entry.timer);
	});

	it("armHeartbeat leaves a paused beat unarmmed", () => {
		const entry = mkEntry(1, "5m", "hi");
		entry.paused = true;
		const context = makeContext();
		heartbeatPrototype.armHeartbeat.call(context, entry);
		expect(entry.nextFireAt).toBeNull();
		expect(entry.timer).toBeUndefined();
	});
});

describe("InteractiveMode heartbeat listing", () => {
	it("lists time left for armed beats and paused for paused beats", () => {
		const now = Date.now();
		const showStatus = vi.fn();
		const context = makeContext({
			showStatus,
			heartbeats: [
				{ ...mkEntry(1, "5m", "hi"), paused: false, nextFireAt: now + 300_000 },
				{ ...mkEntry(2, "15:23", ""), paused: true, nextFireAt: null },
			],
		});
		context.listHeartbeats();
		const message = showStatus.mock.calls[0][0] as string;
		expect(message).toMatch(/^Active heartbeats \(each beat fires when the session is idle\):\n/);
		expect(message).toContain('1: every 5m - message "hi" (in 5m)');
		expect(message).toContain("2: daily at 15:23 - continue (paused)");
	});

	it("lists when there are no active heartbeats", () => {
		const context = makeContext();
		context.listHeartbeats();
		expect(context.showStatus).toHaveBeenCalledWith("No active heartbeats");
	});
});

describe("InteractiveMode heartbeat firing", () => {
	it("skips delivery and re-arms when the session is streaming", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({
			armHeartbeat,
			deliverScheduledMessage: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			session: { isStreaming: true, isCompacting: false },
			heartbeats: [mkEntry(1, "5m", "hi")],
		});
		context.fireHeartbeat(1);
		expect(context.deliverScheduledMessage).not.toHaveBeenCalled();
		expect(context.deferOrRunScheduledAction).not.toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(context.heartbeats[0]);
	});

	it("skips delivery and re-arms when compacting", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({
			armHeartbeat,
			deliverScheduledMessage: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			session: { isStreaming: false, isCompacting: true },
			heartbeats: [mkEntry(1, "5m", "hi")],
		});
		context.fireHeartbeat(1);
		expect(context.deliverScheduledMessage).not.toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(context.heartbeats[0]);
	});

	it("delivers a message beat when idle", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({
			armHeartbeat,
			deliverScheduledMessage: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			heartbeats: [mkEntry(1, "5m", "hi")],
		});
		context.fireHeartbeat(1);
		expect(context.deliverScheduledMessage).toHaveBeenCalledWith("hi");
		expect(context.deferOrRunScheduledAction).not.toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(context.heartbeats[0]);
	});

	it("runs a bare continue for a message-less beat when idle", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({
			armHeartbeat,
			deliverScheduledMessage: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			heartbeats: [mkEntry(1, "5m", "")],
		});
		context.fireHeartbeat(1);
		expect(context.deliverScheduledMessage).not.toHaveBeenCalled();
		expect(context.deferOrRunScheduledAction).toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(context.heartbeats[0]);
	});

	it("does nothing for a paused beat", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({
			armHeartbeat,
			deliverScheduledMessage: vi.fn(),
			heartbeats: [{ ...mkEntry(1, "5m", "hi"), paused: true }],
		});
		context.fireHeartbeat(1);
		expect(context.deliverScheduledMessage).not.toHaveBeenCalled();
		expect(armHeartbeat).not.toHaveBeenCalled();
		expect(context.heartbeats[0].timer).toBeUndefined();
	});

	it("does nothing for an unknown heartbeat id", () => {
		const armHeartbeat = vi.fn();
		const context = makeContext({ armHeartbeat, heartbeats: [] });
		context.fireHeartbeat(99);
		expect(armHeartbeat).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode heartbeat persistence", () => {
	it("saves all active heartbeats to a file", async () => {
		await withTempDir(async (dir) => {
			const context = makeContext({
				sessionManager: { getCwd: () => dir },
				heartbeats: [mkEntry(1, "5m", "line one\n\nline two"), mkEntry(2, "15:23", "")],
			});
			await context.saveHeartbeatsFromArg("save");
			const written = fs.readFileSync(path.join(dir, "HEARTBEAT.md"), "utf8");
			expect(written).toBe("/heartbeat 5m\nline one\n\nline two\n\n/heartbeat 15:23\n");
		});
	});

	it("saves to a custom path relative to the cwd", async () => {
		await withTempDir(async (dir) => {
			const context = makeContext({
				sessionManager: { getCwd: () => dir },
				heartbeats: [mkEntry(1, "3h", "check")],
			});
			await context.saveHeartbeatsFromArg("save beats.md");
			expect(fs.readFileSync(path.join(dir, "beats.md"), "utf8")).toBe("/heartbeat 3h\ncheck\n");
		});
	});

	it("reports when there is nothing to save", async () => {
		await withTempDir(async (dir) => {
			const context = makeContext({ sessionManager: { getCwd: () => dir }, heartbeats: [] });
			await context.saveHeartbeatsFromArg("save");
			expect(context.showStatus).toHaveBeenCalledWith("No active heartbeats to save");
		});
	});

	it("loads and appends heartbeats from a file", async () => {
		await withTempDir(async (dir) => {
			fs.writeFileSync(
				path.join(dir, "HEARTBEAT.md"),
				"/heartbeat 5m\nThis is text for the heartbeat.\n\n/heartbeat 23:10\nwake\n",
			);
			const context = makeContext({ sessionManager: { getCwd: () => dir } });
			await context.loadHeartbeatsFromArg("load");
			expect(context.heartbeats).toHaveLength(2);
			expect(context.heartbeats[0].spec).toBe("5m");
			expect(context.heartbeats[0].text).toBe("This is text for the heartbeat.");
			expect(context.heartbeats[1].spec).toBe("23:10");
			expect(context.heartbeats[1].text).toBe("wake");
		});
	});

	it("silently skips a missing file when silentIfMissing is set", async () => {
		await withTempDir(async (dir) => {
			const context = makeContext({ sessionManager: { getCwd: () => dir } });
			await context.loadHeartbeatsFromPath(path.join(dir, "HEARTBEAT.md"), "HEARTBEAT.md", true);
			expect(context.heartbeats).toHaveLength(0);
			expect(context.showStatus).not.toHaveBeenCalled();
		});
	});

	it("round-trips save then load through a file", async () => {
		await withTempDir(async (dir) => {
			const saveContext = makeContext({
				sessionManager: { getCwd: () => dir },
				heartbeats: [
					mkEntry(1, "5m", "line one\n\nline two"),
					mkEntry(2, "23:10", "Another text with invalid /heartbeat slash command.\n\n/heartbeat - not a header"),
				],
			});
			await saveContext.saveHeartbeatsFromArg("save");

			const loadContext = makeContext({ sessionManager: { getCwd: () => dir } });
			await loadContext.loadHeartbeatsFromArg("load");
			expect(loadContext.heartbeats).toHaveLength(2);
			expect(loadContext.heartbeats[0].text).toBe("line one\n\nline two");
			expect(loadContext.heartbeats[1].text).toBe(
				"Another text with invalid /heartbeat slash command.\n\n/heartbeat - not a header",
			);
		});
	});
});
