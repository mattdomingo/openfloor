import { describe, expect, it } from "vitest";
import { AVATAR_MAX_ZOOM, avatarCropRect } from "@/lib/avatar-crop";

const base = { viewport: 320, zoom: 1, offsetX: 0, offsetY: 0 };

describe("avatar crop geometry", () => {
  it("covers the window from the centre of a landscape picture at rest", () => {
    const rect = avatarCropRect({ ...base, naturalWidth: 1600, naturalHeight: 800 });
    // Cover scale is driven by the short edge, so the full height is used and
    // the crop is a centred square of that height.
    expect(rect.sourceSize).toBeCloseTo(800);
    expect(rect.sourceY).toBeCloseTo(0);
    expect(rect.sourceX).toBeCloseTo(400);
    expect(rect.displayWidth).toBeCloseTo(640);
    expect(rect.displayHeight).toBeCloseTo(320);
  });

  it("takes the whole of a square picture at rest", () => {
    const rect = avatarCropRect({ ...base, naturalWidth: 900, naturalHeight: 900 });
    expect(rect.sourceX).toBeCloseTo(0);
    expect(rect.sourceY).toBeCloseTo(0);
    expect(rect.sourceSize).toBeCloseTo(900);
  });

  it("halves the source square at 2x zoom", () => {
    const rect = avatarCropRect({ ...base, naturalWidth: 900, naturalHeight: 900, zoom: 2 });
    expect(rect.sourceSize).toBeCloseTo(450);
    expect(rect.sourceX).toBeCloseTo(225);
    expect(rect.sourceY).toBeCloseTo(225);
  });

  it("pans within the picture and reports the offset it used", () => {
    const rect = avatarCropRect({ ...base, naturalWidth: 900, naturalHeight: 900, zoom: 2, offsetX: -160 });
    expect(rect.offsetX).toBeCloseTo(-160);
    // Dragging the picture left moves the crop right by the same distance in
    // source pixels: 160 CSS px at scale 320/900*2.
    expect(rect.sourceX).toBeCloseTo(225 + 160 / ((320 / 900) * 2));
  });

  it("never lets the window see past an edge, however far it is dragged", () => {
    for (const offsetX of [-100_000, 100_000]) {
      const rect = avatarCropRect({ ...base, naturalWidth: 1600, naturalHeight: 800, offsetX });
      expect(rect.sourceX).toBeGreaterThanOrEqual(0);
      expect(rect.sourceX + rect.sourceSize).toBeLessThanOrEqual(1600 + 1e-9);
    }
  });

  it("has no pan travel at rest zoom on a square picture", () => {
    const rect = avatarCropRect({ ...base, naturalWidth: 900, naturalHeight: 900, offsetX: 90, offsetY: -90 });
    expect(rect.offsetX).toBeCloseTo(0);
    expect(rect.offsetY).toBeCloseTo(0);
  });

  it("clamps zoom to the supported range", () => {
    const tooFar = avatarCropRect({ ...base, naturalWidth: 900, naturalHeight: 900, zoom: 40 });
    const atMax = avatarCropRect({ ...base, naturalWidth: 900, naturalHeight: 900, zoom: AVATAR_MAX_ZOOM });
    expect(tooFar.sourceSize).toBeCloseTo(atMax.sourceSize);
    const tooClose = avatarCropRect({ ...base, naturalWidth: 900, naturalHeight: 900, zoom: 0.1 });
    expect(tooClose.sourceSize).toBeCloseTo(900);
  });

  it("returns an empty rect for a picture that never decoded", () => {
    expect(avatarCropRect({ ...base, naturalWidth: 0, naturalHeight: 0 }).sourceSize).toBe(0);
  });
});
