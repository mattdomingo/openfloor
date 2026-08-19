import { describe, expect, it } from "vitest";
import { formatShortDate, formatShortDateLocal, formatShortTime, formatShortTimeLocal } from "@/lib/date-format";

describe("deterministic date formatting", () => {
  it("formats dates in UTC instead of the host timezone", () => {
    const timestamp = Date.UTC(2026, 7, 19, 0, 30);

    expect(formatShortDate(timestamp)).toBe("Aug 19");
    expect(formatShortTime(timestamp)).toBe("12:30 AM");
  });

  it("offers host-timezone variants with the same shape for post-mount rendering", () => {
    const timestamp = Date.UTC(2026, 7, 19, 0, 30);

    expect(formatShortDateLocal(timestamp)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(formatShortTimeLocal(timestamp)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});
