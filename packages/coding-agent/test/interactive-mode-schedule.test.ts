import { describe, expect, test, vi } from "vitest";
import {
	InteractiveMode,
	parseScheduleWhen,
	type ScheduledMessage,
} from "../src/modes/interactive/interactive-mode.ts";

describe("parseScheduleWhen", () => {
	test("empty spec schedules for when the current task completes", () => {
		expect(parseScheduleWhen("")).toEqual({ type: "settled" });
		expect(parseScheduleWhen("   ")).toEqual({ type: "settled" });
	});

	test("positive integer schedules a message count", () => {
		expect(parseScheduleWhen("3")).toEqual({ type: "messages", remaining: 3 });
		expect(parseScheduleWhen("1")).toEqual({ type: "messages", remaining: 1 });
	});

	test("zero or negative counts are invalid", () => {
		expect(parseScheduleWhen("0")).toBeUndefined();
		expect(parseScheduleWhen("-1")).toBeUndefined();
	});

	test("sleep-style durations schedule a relative time", () => {
		const before = Date.now();
		const hour = parseScheduleWhen("1h");
		const after = Date.now();
		expect(hour?.type).toBe("time");
		if (hour?.type === "time") {
			expect(hour.at).toBeGreaterThanOrEqual(before + 3_600_000);
			expect(hour.at).toBeLessThanOrEqual(after + 3_600_000);
		}

		const minutes = parseScheduleWhen("5.5m");
		expect(minutes?.type).toBe("time");
		if (minutes?.type === "time") {
			expect(minutes.at).toBeGreaterThanOrEqual(before + 330_000);
		}

		expect(parseScheduleWhen("30s")?.type).toBe("time");
		expect(parseScheduleWhen("2d")?.type).toBe("time");
	});

	test("multiple duration tokens are summed like sleep(1)", () => {
		const before = Date.now();
		const result = parseScheduleWhen("1h 30m");
		expect(result?.type).toBe("time");
		if (result?.type === "time") {
			expect(result.at).toBeGreaterThanOrEqual(before + 5_400_000);
		}
	});

	test("zero durations are invalid", () => {
		expect(parseScheduleWhen("0s")).toBeUndefined();
	});

	test("absolute datetime schedules a time", () => {
		const result = parseScheduleWhen("2999-01-01 00:34");
		expect(result?.type).toBe("time");
		if (result?.type === "time") {
			expect(result.at).toBe(new Date(2999, 0, 1, 0, 34, 0).getTime());
		}
	});

	test("absolute datetime with seconds", () => {
		const result = parseScheduleWhen("2999-01-01 10:14:30");
		expect(result?.type).toBe("time");
		if (result?.type === "time") {
			expect(result.at).toBe(new Date(2999, 0, 1, 10, 14, 30).getTime());
		}
	});

	test("past datetime is invalid", () => {
		expect(parseScheduleWhen("2000-01-01 00:00")).toBeUndefined();
	});

	test("date-less time in the future today schedules for today", () => {
		const now = new Date();
		const future = new Date(now.getTime() + 60_000);
		const spec = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
		const result = parseScheduleWhen(spec);
		expect(result?.type).toBe("time");
		if (result?.type === "time") {
			const at = new Date(result.at);
			expect(at.getFullYear()).toBe(now.getFullYear());
			expect(at.getMonth()).toBe(now.getMonth());
			expect(at.getDate()).toBe(now.getDate());
			expect(at.getHours()).toBe(future.getHours());
			expect(at.getMinutes()).toBe(future.getMinutes());
		}
	});

	test("date-less time already passed today schedules for the next day", () => {
		const now = new Date();
		// Use a time two minutes in the past.
		const past = new Date(now.getTime() - 120_000);
		const spec = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
		const result = parseScheduleWhen(spec);
		expect(result?.type).toBe("time");
		if (result?.type === "time") {
			const at = new Date(result.at);
			if (past.getDate() === now.getDate()) {
				// past is earlier today, so the time already passed -> next day.
				const expected = new Date(
					now.getFullYear(),
					now.getMonth(),
					now.getDate() + 1,
					past.getHours(),
					past.getMinutes(),
					0,
				);
				expect(at.getTime()).toBe(expected.getTime());
			} else {
				// Crossed midnight: the spec time is still in the future today.
				const expected = new Date(
					now.getFullYear(),
					now.getMonth(),
					now.getDate(),
					past.getHours(),
					past.getMinutes(),
					0,
				);
				expect(at.getTime()).toBe(expected.getTime());
			}
		}
	});

	test("date-less time with seconds schedules a time", () => {
		const now = new Date();
		const future = new Date(now.getTime() + 120_000);
		const spec = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}:${String(future.getSeconds()).padStart(2, "0")}`;
		const result = parseScheduleWhen(spec);
		expect(result?.type).toBe("time");
		if (result?.type === "time") {
			const at = new Date(result.at);
			expect(at.getFullYear()).toBe(now.getFullYear());
			expect(at.getMonth()).toBe(now.getMonth());
			expect(at.getDate()).toBe(now.getDate());
			expect(at.getHours()).toBe(future.getHours());
			expect(at.getMinutes()).toBe(future.getMinutes());
			expect(at.getSeconds()).toBe(future.getSeconds());
		}
	});

	test("garbage specifications are invalid", () => {
		expect(parseScheduleWhen("tomorrow")).toBeUndefined();
		expect(parseScheduleWhen("5x")).toBeUndefined();
		expect(parseScheduleWhen("1h tomorrow")).toBeUndefined();
		expect(parseScheduleWhen("hello world")).toBeUndefined();
	});
});

type ScheduleCommandContext = {
	showStatus: (message: string) => void;
	scheduledMessages: ScheduledMessage[];
	nextScheduleId: number;
	session: { isIdle: boolean };
	cancelScheduledMessages: (count: number) => void;
	cancelScheduledMessageById: (id: number) => void;
	listScheduledMessages: () => void;
	scheduledMessageDescription: (entry: ScheduledMessage) => string;
	quotedListText: (text: string) => string;
	deliverScheduledEntry: (entry: ScheduledMessage) => void;
};

const schedulePrototype = InteractiveMode.prototype as unknown as {
	handleScheduleCommand: (this: ScheduleCommandContext, arg: string) => Promise<void>;
	listScheduledMessages: (this: ScheduleCommandContext) => void;
	cancelScheduledMessageById: (this: ScheduleCommandContext, id: number) => void;
	scheduledMessageDescription: (this: ScheduleCommandContext, entry: ScheduledMessage) => string;
	quotedListText: (this: ScheduleCommandContext, text: string) => string;
};

describe("InteractiveMode /schedule command dispatch", () => {
	test("cancels the last N scheduled messages for a -N spec", async () => {
		const cancelScheduledMessages = vi.fn();
		const context: ScheduleCommandContext = {
			showStatus: vi.fn(),
			scheduledMessages: [],
			nextScheduleId: 1,
			session: { isIdle: true },
			cancelScheduledMessages,
			cancelScheduledMessageById: vi.fn(),
			listScheduledMessages: vi.fn(),
			scheduledMessageDescription: schedulePrototype.scheduledMessageDescription as (
				entry: ScheduledMessage,
			) => string,
			quotedListText: schedulePrototype.quotedListText as (text: string) => string,
			deliverScheduledEntry: vi.fn(),
		};
		await schedulePrototype.handleScheduleCommand.call(context, "-2");
		expect(cancelScheduledMessages).toHaveBeenCalledWith(2);
	});

	test("lists scheduled messages for the list and l specs", async () => {
		for (const spec of ["list", "l", "LIST"]) {
			const listScheduledMessages = vi.fn();
			const context: ScheduleCommandContext = {
				showStatus: vi.fn(),
				scheduledMessages: [],
				nextScheduleId: 1,
				session: { isIdle: true },
				cancelScheduledMessages: vi.fn(),
				cancelScheduledMessageById: vi.fn(),
				listScheduledMessages,
				scheduledMessageDescription: schedulePrototype.scheduledMessageDescription as (
					entry: ScheduledMessage,
				) => string,
				quotedListText: schedulePrototype.quotedListText as (text: string) => string,
				deliverScheduledEntry: vi.fn(),
			};
			await schedulePrototype.handleScheduleCommand.call(context, spec);
			expect(listScheduledMessages).toHaveBeenCalled();
		}
	});

	test("cancels a scheduled message by id for a cancel <id> spec", async () => {
		const cancelScheduledMessageById = vi.fn();
		const context: ScheduleCommandContext = {
			showStatus: vi.fn(),
			scheduledMessages: [],
			nextScheduleId: 1,
			session: { isIdle: true },
			cancelScheduledMessages: vi.fn(),
			cancelScheduledMessageById,
			listScheduledMessages: vi.fn(),
			scheduledMessageDescription: schedulePrototype.scheduledMessageDescription as (
				entry: ScheduledMessage,
			) => string,
			quotedListText: schedulePrototype.quotedListText as (text: string) => string,
			deliverScheduledEntry: vi.fn(),
		};
		await schedulePrototype.handleScheduleCommand.call(context, "cancel 3");
		expect(cancelScheduledMessageById).toHaveBeenCalledWith(3);
	});
});

describe("InteractiveMode scheduled message listing and id cancellation", () => {
	test("lists no scheduled messages", () => {
		const showStatus = vi.fn();
		const context: ScheduleCommandContext = {
			showStatus,
			scheduledMessages: [],
			nextScheduleId: 1,
			session: { isIdle: true },
			cancelScheduledMessages: vi.fn(),
			cancelScheduledMessageById: vi.fn(),
			listScheduledMessages: vi.fn(),
			scheduledMessageDescription: schedulePrototype.scheduledMessageDescription as (
				entry: ScheduledMessage,
			) => string,
			quotedListText: schedulePrototype.quotedListText as (text: string) => string,
			deliverScheduledEntry: vi.fn(),
		};
		schedulePrototype.listScheduledMessages.call(context);
		expect(showStatus).toHaveBeenCalledWith("No scheduled messages");
	});

	test("lists scheduled messages with id, action, and trigger", () => {
		const showStatus = vi.fn();
		const context: ScheduleCommandContext = {
			showStatus,
			scheduledMessages: [
				{ id: 1, text: "", when: { type: "settled" }, isContinue: true },
				{ id: 2, text: "check", when: { type: "time", at: Date.now() + 60_000 } },
			],
			nextScheduleId: 3,
			session: { isIdle: true },
			cancelScheduledMessages: vi.fn(),
			cancelScheduledMessageById: vi.fn(),
			listScheduledMessages: vi.fn(),
			scheduledMessageDescription: schedulePrototype.scheduledMessageDescription as (
				entry: ScheduledMessage,
			) => string,
			quotedListText: schedulePrototype.quotedListText as (text: string) => string,
			deliverScheduledEntry: vi.fn(),
		};
		schedulePrototype.listScheduledMessages.call(context);
		expect(showStatus).toHaveBeenCalled();
		const message = showStatus.mock.calls[0][0] as string;
		expect(message).toContain("Scheduled messages:");
		expect(message).toContain("1: continue when the current task completes");
		expect(message).toContain('2: message "check" for ');
	});

	test("cancels a scheduled message by id", () => {
		const showStatus = vi.fn();
		const entry: ScheduledMessage = { id: 1, text: "", when: { type: "settled" }, isContinue: true };
		const context: ScheduleCommandContext = {
			showStatus,
			scheduledMessages: [entry],
			nextScheduleId: 2,
			session: { isIdle: true },
			cancelScheduledMessages: vi.fn(),
			cancelScheduledMessageById: vi.fn(),
			listScheduledMessages: vi.fn(),
			scheduledMessageDescription: schedulePrototype.scheduledMessageDescription as (
				entry: ScheduledMessage,
			) => string,
			quotedListText: schedulePrototype.quotedListText as (text: string) => string,
			deliverScheduledEntry: vi.fn(),
		};
		schedulePrototype.cancelScheduledMessageById.call(context, 1);
		expect(context.scheduledMessages).toHaveLength(0);
		expect(showStatus).toHaveBeenCalledWith("Cancelled scheduled message 1");
	});

	test("shows status when cancelling an unknown scheduled message id", () => {
		const showStatus = vi.fn();
		const context: ScheduleCommandContext = {
			showStatus,
			scheduledMessages: [],
			nextScheduleId: 1,
			session: { isIdle: true },
			cancelScheduledMessages: vi.fn(),
			cancelScheduledMessageById: vi.fn(),
			listScheduledMessages: vi.fn(),
			scheduledMessageDescription: schedulePrototype.scheduledMessageDescription as (
				entry: ScheduledMessage,
			) => string,
			quotedListText: schedulePrototype.quotedListText as (text: string) => string,
			deliverScheduledEntry: vi.fn(),
		};
		schedulePrototype.cancelScheduledMessageById.call(context, 99);
		expect(context.scheduledMessages).toHaveLength(0);
		expect(showStatus).toHaveBeenCalledWith("No scheduled message with id 99");
	});
});
