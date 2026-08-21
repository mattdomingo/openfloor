import { describe, expect, it } from "vitest";
import { currentMonth, effectivePlan, PLAN_LIMITS, UPGRADE_URL, type Plan, type PlanStatus } from "@/lib/plans";

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

describe("UPGRADE_URL", () => {
  it("is the configured Stripe payment link", () => {
    expect(UPGRADE_URL).toBe("https://buy.stripe.com/fZudR93OAaWMehu35t4F200");
  });
});
