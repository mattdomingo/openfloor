import { describe, expect, it } from "vitest";
import { formatDuration, formatShortDate, formatShortDateLocal, formatShortTime, formatShortTimeLocal } from "@/lib/date-format";

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

describe("formatDuration", () => {
  it("renders sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("switches to minutes at the one-minute boundary", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(3599)).toBe("59m");
  });

  it("switches to hours-and-minutes at the one-hour boundary", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(5400)).toBe("1h 30m");
  });
});
