import { describe, expect, it } from "vitest";
import { currentMonth, effectivePlan, effectiveSeatLimit, lowHoursRemaining, PAID_PLAN_CATALOG, planHourLimit, PLAN_LIMITS, planLimitsSummary, validPaidSeatQuantity, type Plan, type PlanStatus } from "@/lib/plans";

describe("PLAN_LIMITS", () => {
  it("gives each plan the documented seat and hour caps", () => {
    expect(PLAN_LIMITS.free).toEqual({ seats: 3, hours: 2 });
    expect(PLAN_LIMITS.pro).toEqual({ seats: 5, hours: 30 });
    expect(PLAN_LIMITS.max).toEqual({ seats: 10, hours: 100 });
  });

  it("enterprise is unlimited on both axes", () => {
    expect(PLAN_LIMITS.enterprise.seats).toBe(Infinity);
    expect(PLAN_LIMITS.enterprise.hours).toBe(Infinity);
  });
});

describe("effectivePlan", () => {
  const plans: Plan[] = ["free", "pro", "max", "enterprise"];
  const nonActiveStatuses: PlanStatus[] = ["inactive", "past_due", "canceled"];

  it("grants the purchased plan only while status is active", () => {
    for (const plan of plans) {
      expect(effectivePlan(plan, "active")).toBe(plan);
    }
  });

  it("falls back to free for every non-active status, regardless of the purchased plan", () => {
    for (const plan of plans) {
      for (const status of nonActiveStatuses) {
        expect(effectivePlan(plan, status)).toBe("free");
      }
    }
  });

  it("a cancelled Max owner does not keep Max's limits", () => {
    // The specific regression this exists to prevent: a lapsed high-tier
    // plan must not leak its limits through anywhere that reads `plan`
    // without also checking `planStatus`.
    expect(effectivePlan("max", "canceled")).toBe("free");
    expect(PLAN_LIMITS[effectivePlan("max", "canceled")]).toEqual(PLAN_LIMITS.free);
  });

  it("grants @opnflr.com accounts enterprise regardless of stored plan/status", () => {
    for (const status of [...nonActiveStatuses, "active" as PlanStatus]) {
      expect(effectivePlan("free", status, "tester@opnflr.com")).toBe("enterprise");
    }
    // Case-insensitive, and independent of what upsertUser happens to store.
    expect(effectivePlan("free", "canceled", "Tester@OPNFLR.COM")).toBe("enterprise");
  });

  it("does not match lookalike or unrelated domains", () => {
    expect(effectivePlan("free", "active", "tester@notopnflr.com")).toBe("free");
    expect(effectivePlan("free", "active", "tester@opnflr.com.evil.com")).toBe("free");
    expect(effectivePlan("free", "inactive", undefined)).toBe("free");
  });
});

describe("currentMonth", () => {
  it("formats as UTC YYYY-MM", () => {
    expect(currentMonth(Date.UTC(2026, 7, 19, 12, 0))).toBe("2026-08");
  });

  it("uses UTC, not host-local, on either side of a UTC month boundary", () => {
    // 2026-08-31T23:30:00Z is still August in UTC even though it would be
    // September 1st in timezones ahead of UTC.
    expect(currentMonth(Date.UTC(2026, 7, 31, 23, 30))).toBe("2026-08");
    expect(currentMonth(Date.UTC(2026, 8, 1, 0, 30))).toBe("2026-09");
  });

  it("defaults to the real current time when called with no argument", () => {
    expect(currentMonth()).toBe(currentMonth(Date.now()));
  });
});

describe("paid seat pricing", () => {
  it("defines monthly per-seat terms and quantity bounds", () => {
    expect(PAID_PLAN_CATALOG.pro).toEqual({ unitAmountCents: 3000, currency: "usd", minimumSeats: 3, maximumSeats: 5 });
    expect(PAID_PLAN_CATALOG.max).toEqual({ unitAmountCents: 5000, currency: "usd", minimumSeats: 3, maximumSeats: 10 });
    expect(validPaidSeatQuantity("pro", 5)).toBe(true);
    expect(validPaidSeatQuantity("pro", 6)).toBe(false);
  });

  it("uses purchased seats only for active paid plans and preserves legacy grants", () => {
    expect(effectiveSeatLimit("pro", "active", 4)).toBe(4);
    expect(effectiveSeatLimit("max", "past_due", 8)).toBe(3);
    expect(effectiveSeatLimit("pro", "active", null)).toBe(5);
    expect(effectiveSeatLimit("enterprise", "active", null)).toBe(Infinity);
  });

  it("@opnflr.com accounts get unlimited seats even on a free/lapsed row", () => {
    expect(effectiveSeatLimit("free", "inactive", null, "tester@opnflr.com")).toBe(Infinity);
  });
});

describe("planHourLimit", () => {
  it("zeroes the free plan's hours once its email already spent them, and only the free plan", () => {
    expect(planHourLimit("free", true)).toBe(0);
    expect(planHourLimit("free", false)).toBe(PLAN_LIMITS.free.hours);
  });

  it("leaves every paid or enterprise plan's hours untouched by the flag", () => {
    expect(planHourLimit("pro", true)).toBe(PLAN_LIMITS.pro.hours);
    expect(planHourLimit("max", true)).toBe(PLAN_LIMITS.max.hours);
    expect(planHourLimit("enterprise", true)).toBe(Infinity);
  });
});

describe("planLimitsSummary", () => {
  it("spells out the numeric seat and hour caps for finite plans", () => {
    expect(planLimitsSummary("free")).toBe("3 seats per session, 2h of session time per month");
    expect(planLimitsSummary("pro")).toBe("5 seats per session, 30h of session time per month");
    expect(planLimitsSummary("max")).toBe("10 seats per session, 100h of session time per month");
  });

  it("describes enterprise's Infinity limits as unlimited, not as a number", () => {
    expect(planLimitsSummary("enterprise")).toBe("unlimited seats per session, unlimited session time");
  });
});

describe("low session-hour warning", () => {
  const hours = (value: number) => value * 3600;

  it("stays quiet with plenty of the month left", () => {
    expect(lowHoursRemaining(hours(1), 30)).toBeNull();
    expect(lowHoursRemaining(hours(23.9), 30)).toBeNull();
  });

  it("warns from 80% used, reporting what is left", () => {
    expect(lowHoursRemaining(hours(24), 30)).toBe(hours(6));
    expect(lowHoursRemaining(hours(29.5), 30)).toBe(hours(0.5));
  });

  it("stays quiet once the month is spent — that has its own banner", () => {
    expect(lowHoursRemaining(hours(30), 30)).toBeNull();
    expect(lowHoursRemaining(hours(40), 30)).toBeNull();
  });

  it("never warns on an unlimited plan", () => {
    expect(lowHoursRemaining(hours(9_000), Infinity)).toBeNull();
    expect(lowHoursRemaining(hours(1), 0)).toBeNull();
  });
});
