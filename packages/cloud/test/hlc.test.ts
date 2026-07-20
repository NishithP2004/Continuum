import { describe, expect, it } from "vitest";
import { compareHlc, nextHlc, parseHlc } from "../src/sync/hlc.js";

describe("hybrid logical clocks", () => {
  it("increments the logical component when wall time does not advance", () => {
    const first = nextHlc("device_01", undefined, 1_760_000_000_000);
    const second = nextHlc("device_01", first, 1_759_999_999_000);
    expect(first).toBe("1760000000000:0:device_01");
    expect(second).toBe("1760000000000:1:device_01");
    expect(compareHlc(first, second)).toBeLessThan(0);
  });

  it("uses node ID as a deterministic final tie breaker", () => {
    expect(compareHlc("1760000000000:1:device_01", "1760000000000:1:device_02")).toBeLessThan(0);
    expect(parseHlc("1760000000000:1:device_02")).toEqual({ physical: 1_760_000_000_000n, logical: 1n, node: "device_02" });
  });

  it("orders the full accepted physical range without number precision loss", () => {
    expect(compareHlc(
      "9999999999999999998:0:device_01",
      "9999999999999999999:0:device_01"
    )).toBeLessThan(0);
  });
});
