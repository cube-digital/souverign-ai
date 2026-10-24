import { describe, expect, it } from "vitest";
import { isDue } from "../src/proactive/schedule.js";

// Local-time dates. 2026-10-26 is a Monday, 2026-10-24 a Saturday.
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m);
const weekdays = { days: [1, 2, 3, 4, 5], time: "09:00" };

describe("isDue", () => {
  it("is due on a listed weekday inside the 30 minute window, once per slot, never when late", () => {
    expect(isDue({ ...weekdays, lastRunAt: null }, at(26, 9, 0))).toBe(true);
    expect(isDue({ ...weekdays, lastRunAt: null }, at(26, 9, 29))).toBe(true);
    expect(isDue({ ...weekdays, lastRunAt: null }, at(26, 8, 59))).toBe(false); // too early
    expect(isDue({ ...weekdays, lastRunAt: null }, at(26, 9, 31))).toBe(false); // 31 min late
    expect(isDue({ ...weekdays, lastRunAt: null }, at(24, 9, 5))).toBe(false); // Saturday
    // already ran for today's slot
    expect(isDue({ ...weekdays, lastRunAt: at(26, 9, 1) }, at(26, 9, 5))).toBe(false);
    // ran yesterday: today's slot is still open
    expect(isDue({ ...weekdays, lastRunAt: at(25, 9, 1) }, at(26, 9, 5))).toBe(true);
  });
});
