import { describe, expect, test } from "vitest";
import { parseScheduleWhen } from "../src/modes/interactive/interactive-mode.ts";

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

	test("garbage specifications are invalid", () => {
		expect(parseScheduleWhen("tomorrow")).toBeUndefined();
		expect(parseScheduleWhen("5x")).toBeUndefined();
		expect(parseScheduleWhen("1h tomorrow")).toBeUndefined();
		expect(parseScheduleWhen("hello world")).toBeUndefined();
	});
});
