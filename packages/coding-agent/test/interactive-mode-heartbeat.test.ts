import { describe, expect, it, vi } from "vitest";
import { type HeartbeatEntry, InteractiveMode, parseHeartbeatSpec } from "../src/modes/interactive/interactive-mode.ts";

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

type HeartbeatCommandContext = {
	showStatus: (message: string) => void;
	heartbeats: HeartbeatEntry[];
	nextHeartbeatId: number;
	session: { isStreaming: boolean; isCompacting: boolean };
	armHeartbeat: (entry: HeartbeatEntry) => void;
	cancelHeartbeats: (count: number) => void;
	listHeartbeats: () => void;
	scheduleHeartbeat: (spec: string, text: string) => void;
	deferOrRunScheduledAction: (entry: HeartbeatEntry & { when: { type: "time"; at: number } }) => void;
	deliverScheduledMessage: (text: string) => void;
	heartbeatDescription: (entry: HeartbeatEntry) => string;
	nextHeartbeatFireTime: (entry: HeartbeatEntry) => string;
};

const heartbeatPrototype = InteractiveMode.prototype as unknown as {
	handleHeartbeatCommand: (this: HeartbeatCommandContext, arg: string) => Promise<void>;
	cancelHeartbeats: (this: HeartbeatCommandContext, count: number) => void;
	listHeartbeats: (this: HeartbeatCommandContext) => void;
	scheduleHeartbeat: (this: HeartbeatCommandContext, spec: string, text: string) => void;
	armHeartbeat: (this: HeartbeatCommandContext, entry: HeartbeatEntry) => void;
	fireHeartbeat: (this: HeartbeatCommandContext, id: number) => void;
	heartbeatDescription: (entry: HeartbeatEntry) => string;
	nextHeartbeatFireTime: (entry: HeartbeatEntry) => string;
};

describe("InteractiveMode /heartbeat command dispatch", () => {
	it("cancels the last N heartbeats for a -N spec", async () => {
		const cancelHeartbeats = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats,
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		await heartbeatPrototype.handleHeartbeatCommand.call(context, "-2");
		expect(cancelHeartbeats).toHaveBeenCalledWith(2);
		expect(context.scheduleHeartbeat).not.toHaveBeenCalled();
	});

	it("lists active heartbeats when given no spec and no message", async () => {
		const listHeartbeats = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats: vi.fn(),
			listHeartbeats,
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		await heartbeatPrototype.handleHeartbeatCommand.call(context, "");
		expect(listHeartbeats).toHaveBeenCalled();
		expect(context.scheduleHeartbeat).not.toHaveBeenCalled();
	});

	it("schedules a heartbeat from the first-line spec and message payload", async () => {
		const scheduleHeartbeat = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat,
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		await heartbeatPrototype.handleHeartbeatCommand.call(context, "3h\ncheck the queue");
		expect(scheduleHeartbeat).toHaveBeenCalledWith("3h", "check the queue");
	});
});

describe("InteractiveMode heartbeat scheduling", () => {
	it("schedules an interval heartbeat and marks it as a bare continue when message-less", () => {
		const armHeartbeat = vi.fn();
		const showStatus = vi.fn();
		const heartbeats: HeartbeatEntry[] = [];
		const context: HeartbeatCommandContext = {
			showStatus,
			heartbeats,
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat,
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.scheduleHeartbeat.call(context, "3h", "");
		expect(heartbeats).toHaveLength(1);
		expect(heartbeats[0].intervalMs).toBe(10_800_000);
		expect(heartbeats[0].dailyAt).toBeNull();
		expect(heartbeats[0].isContinue).toBe(true);
		expect(armHeartbeat).toHaveBeenCalledWith(heartbeats[0]);
		expect(showStatus).toHaveBeenCalledWith("Scheduled heartbeat every 3h");
	});

	it("schedules a daily-at heartbeat with a message payload", () => {
		const heartbeats: HeartbeatEntry[] = [];
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats,
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.scheduleHeartbeat.call(context, "15:23", "wake up");
		expect(heartbeats).toHaveLength(1);
		expect(heartbeats[0].dailyAt).toEqual({ hh: 15, mm: 23, ss: 0 });
		expect(heartbeats[0].intervalMs).toBeNull();
		expect(heartbeats[0].isContinue).toBe(false);
	});

	it("shows usage for an invalid spec", () => {
		const showStatus = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus,
			heartbeats: [],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.scheduleHeartbeat.call(context, "2026-08-08 15:23", "wake");
		expect(context.heartbeats).toHaveLength(0);
		expect(showStatus).toHaveBeenCalledWith(
			"Usage: /heartbeat [duration e.g. 3h | HH:MM[:SS]] with the message on the following line(s); no message = continue",
		);
	});
});

describe("InteractiveMode heartbeat cancellation and listing", () => {
	it("cancels the last N heartbeats", () => {
		const showStatus = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus,
			heartbeats: [{ id: 1, text: "", intervalMs: 1000, dailyAt: null, isContinue: true }],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.cancelHeartbeats.call(context, 1);
		expect(context.heartbeats).toHaveLength(0);
		expect(showStatus).toHaveBeenCalledWith("Cancelled 1 heartbeat");
	});

	it("shows status when there are no heartbeats to cancel", () => {
		const showStatus = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus,
			heartbeats: [],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.cancelHeartbeats.call(context, 1);
		expect(showStatus).toHaveBeenCalledWith("No heartbeats to cancel");
	});

	it("lists active heartbeats with schedule and next fire time", () => {
		const showStatus = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus,
			heartbeats: [{ id: 1, text: "", intervalMs: 1000, dailyAt: null, isContinue: true }],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat: vi.fn(),
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.listHeartbeats.call(context);
		expect(showStatus).toHaveBeenCalled();
		const message = showStatus.mock.calls[0][0] as string;
		expect(message).toMatch(/^Heartbeat 1: every 1s \(next /);
	});
});

describe("InteractiveMode heartbeat firing", () => {
	it("skips delivery and re-arms when the session is streaming", () => {
		const armHeartbeat = vi.fn();
		const deliverScheduledMessage = vi.fn();
		const deferOrRunScheduledAction = vi.fn();
		const entry: HeartbeatEntry = { id: 1, text: "hi", intervalMs: 1000, dailyAt: null };
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [entry],
			nextHeartbeatId: 1,
			session: { isStreaming: true, isCompacting: false },
			armHeartbeat,
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction,
			deliverScheduledMessage,
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.fireHeartbeat.call(context, 1);
		expect(deliverScheduledMessage).not.toHaveBeenCalled();
		expect(deferOrRunScheduledAction).not.toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(entry);
	});

	it("skips delivery and re-arms when compacting", () => {
		const armHeartbeat = vi.fn();
		const deliverScheduledMessage = vi.fn();
		const deferOrRunScheduledAction = vi.fn();
		const entry: HeartbeatEntry = { id: 1, text: "hi", intervalMs: 1000, dailyAt: null };
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [entry],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: true },
			armHeartbeat,
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction,
			deliverScheduledMessage,
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.fireHeartbeat.call(context, 1);
		expect(deliverScheduledMessage).not.toHaveBeenCalled();
		expect(deferOrRunScheduledAction).not.toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(entry);
	});

	it("delivers a message beat when idle", () => {
		const deliverScheduledMessage = vi.fn();
		const deferOrRunScheduledAction = vi.fn();
		const armHeartbeat = vi.fn();
		const entry: HeartbeatEntry = { id: 1, text: "hi", intervalMs: 1000, dailyAt: null };
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [entry],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat,
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction,
			deliverScheduledMessage,
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.fireHeartbeat.call(context, 1);
		expect(deliverScheduledMessage).toHaveBeenCalledWith("hi");
		expect(deferOrRunScheduledAction).not.toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(entry);
	});

	it("runs a bare continue for a message-less beat when idle", () => {
		const deliverScheduledMessage = vi.fn();
		const deferOrRunScheduledAction = vi.fn();
		const armHeartbeat = vi.fn();
		const entry: HeartbeatEntry = { id: 1, text: "", intervalMs: 1000, dailyAt: null, isContinue: true };
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [entry],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat,
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction,
			deliverScheduledMessage,
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.fireHeartbeat.call(context, 1);
		expect(deliverScheduledMessage).not.toHaveBeenCalled();
		expect(deferOrRunScheduledAction).toHaveBeenCalled();
		expect(armHeartbeat).toHaveBeenCalledWith(entry);
	});

	it("does nothing for an unknown heartbeat id", () => {
		const armHeartbeat = vi.fn();
		const context: HeartbeatCommandContext = {
			showStatus: vi.fn(),
			heartbeats: [],
			nextHeartbeatId: 1,
			session: { isStreaming: false, isCompacting: false },
			armHeartbeat,
			cancelHeartbeats: vi.fn(),
			listHeartbeats: vi.fn(),
			scheduleHeartbeat: vi.fn(),
			deferOrRunScheduledAction: vi.fn(),
			deliverScheduledMessage: vi.fn(),
			heartbeatDescription: heartbeatPrototype.heartbeatDescription,
			nextHeartbeatFireTime: heartbeatPrototype.nextHeartbeatFireTime as (entry: HeartbeatEntry) => string,
		};
		heartbeatPrototype.fireHeartbeat.call(context, 99);
		expect(armHeartbeat).not.toHaveBeenCalled();
	});
});
