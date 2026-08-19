import { describe, expect, it } from "vitest";
import { formatShortDate, formatShortTime } from "@/lib/date-format";

describe("deterministic date formatting", () => {
  it("formats dates in UTC instead of the host timezone", () => {
    const timestamp = Date.UTC(2026, 7, 19, 0, 30);

    expect(formatShortDate(timestamp)).toBe("Aug 19");
    expect(formatShortTime(timestamp)).toBe("12:30 AM");
  });
});
