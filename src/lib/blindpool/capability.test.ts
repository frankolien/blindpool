// Property tests for STRK20 capability detection (plan §6.2).
//
// The safety property here is not "does it detect Ready" — it is that an unparseable or
// hostile version string can never crash wallet connection, and can never be mistaken for
// support. A false positive would mean offering private bets to a wallet that cannot
// place them; a crash would mean the whole app dies on an unknown wallet.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  compareSpecVersion,
  meetsSpecFloor,
  parseSpecVersion,
  strk20Capability,
  STRK20_MIN_SPEC,
} from "./capability";

describe("parseSpecVersion", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseSpecVersion(s)).not.toThrow();
      }),
    );
  });

  it("round-trips well-formed versions", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 50 }),
        fc.nat({ max: 50 }),
        fc.nat({ max: 50 }),
        (a, b, c) => {
          const v = parseSpecVersion(`${a}.${b}.${c}`);
          expect(v).toEqual({ major: a, minor: b, patch: c, prerelease: [] });
        },
      ),
    );
  });

  it("tolerates a leading v and a missing patch", () => {
    expect(parseSpecVersion("v0.10.3")).toEqual({ major: 0, minor: 10, patch: 3, prerelease: [] });
    expect(parseSpecVersion("0.8")).toEqual({ major: 0, minor: 8, patch: 0, prerelease: [] });
    expect(parseSpecVersion(" 0.10.3 ")?.patch).toBe(3);
  });

  it("captures prerelease identifiers", () => {
    expect(parseSpecVersion("0.10.4-rc.1")?.prerelease).toEqual(["rc", "1"]);
  });

  it("rejects junk", () => {
    for (const s of ["", "abc", "x.y.z", "..", "-1.0.0"]) {
      expect(parseSpecVersion(s)).toBeNull();
    }
  });
});

describe("compareSpecVersion", () => {
  const cmp = (a: string, b: string) =>
    compareSpecVersion(parseSpecVersion(a)!, parseSpecVersion(b)!);

  it("orders by major, minor, then patch", () => {
    expect(cmp("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(cmp("0.10.3", "0.9.9")).toBeGreaterThan(0);
    expect(cmp("0.10.4", "0.10.3")).toBeGreaterThan(0);
    expect(cmp("0.10.3", "0.10.3")).toBe(0);
  });

  it("compares 0.10 above 0.9 — not lexically", () => {
    // The bug this guards: string comparison puts "0.9" after "0.10".
    expect(cmp("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });

  it("ranks a prerelease below its release, and above the previous patch", () => {
    expect(cmp("0.10.3-rc.1", "0.10.3")).toBeLessThan(0);
    expect(cmp("0.10.4-rc.1", "0.10.3")).toBeGreaterThan(0);
    expect(cmp("0.10.3-rc.1", "0.10.3-rc.2")).toBeLessThan(0);
  });

  it("is antisymmetric", () => {
    // Normalizing sign: Math.sign(-0) is -0, which Object.is (and so toBe) separates
    // from 0. The ordering property is about direction, not the sign of zero.
    const sgn = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
    const arb = fc.constantFrom("0.9.0", "0.10.3", "0.10.3-rc.1", "0.10.4", "1.0.0");
    fc.assert(
      fc.property(arb, arb, (a, b) => {
        expect(sgn(cmp(a, b))).toBe(sgn(-cmp(b, a)));
      }),
    );
  });
});

describe("strk20Capability", () => {
  it("supports a wallet advertising the floor or newer", () => {
    for (const s of [STRK20_MIN_SPEC, "0.10.4", "0.11.0", "1.0.0"]) {
      expect(strk20Capability([s]).supported).toBe(true);
    }
  });

  it("does not support a wallet below the floor", () => {
    for (const s of ["0.8", "0.9.9", "0.10.2", "0.10.3-rc.1"]) {
      const cap = strk20Capability([s]);
      expect(cap.supported).toBe(false);
      expect(cap.reason).toBeTruthy();
    }
  });

  it("picks the highest advertised spec, regardless of list order", () => {
    const cap = strk20Capability(["0.7", "0.10.4", "0.8"]);
    expect(cap.supported).toBe(true);
    expect(cap.best).toBe("0.10.4");
  });

  it("degrades rather than crashing on empty, missing or junk lists", () => {
    for (const specs of [undefined, null, [], ["???"], ["", "  "]]) {
      const cap = strk20Capability(specs as string[] | undefined | null);
      expect(cap.supported).toBe(false);
      expect(cap.reason).toBeTruthy();
    }
  });

  it("never reports support from arbitrary strings alone", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 5 }), (specs) => {
        const cap = strk20Capability(specs);
        // Support may only ever be granted by a string that genuinely parses >= the floor.
        if (cap.supported) {
          expect(specs.some((s) => meetsSpecFloor(s))).toBe(true);
        }
      }),
    );
  });

  it("always gives the user a reason when unsupported", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 5 }), (specs) => {
        const cap = strk20Capability(specs);
        if (!cap.supported) {
          expect(cap.reason).toBeTruthy();
          // Degradation is honest: the user is told they can still read markets.
          expect(cap.reason!.toLowerCase()).toContain("browse markets");
        }
      }),
    );
  });
});
