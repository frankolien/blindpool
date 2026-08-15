// STRK20 capability detection.
//
// A wallet advertises which Wallet API specs it speaks via `walletV6.supportedSpecs()`
// (already called in SelectWallet.tsx and stored on the zustand store as
// `walletApiList`). Blindpool decides what it may ask for from that list alone.
//
// The rule this enforces — least privilege: NEVER probe `strk20Balances` to find out
// whether a wallet supports STRK20. That call prompts the user to share their shielded
// balances, which is real data disclosure in exchange for a yes/no the version string
// already answers. Balance reads happen only when showing the user their own balance is
// a deliberate feature.

/** Minimum Wallet API spec that carries the STRK20 action set. */
export const STRK20_MIN_SPEC = "0.10.3";

interface SpecVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a final release. */
  prerelease: string[];
}

/**
 * Parse a spec version tolerantly: wallets report things like "0.10.3", "v0.10.3",
 * "0.10.4-rc.1" and sometimes a bare "0.8". Returns null for anything unparseable
 * rather than throwing — an unknown string must not crash wallet connection.
 */
export function parseSpecVersion(raw: string): SpecVersion | null {
  if (typeof raw !== "string") return null;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/**
 * Semver precedence, including prerelease rules: 0.10.3-rc.1 < 0.10.3 < 0.10.4-rc.1.
 * Returns <0, 0, or >0.
 */
export function compareSpecVersion(a: SpecVersion, b: SpecVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // A version with a prerelease has lower precedence than one without.
  const aPre = a.prerelease.length > 0;
  const bPre = b.prerelease.length > 0;
  if (aPre !== bPre) return aPre ? -1 : 1;
  if (!aPre) return 0;

  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // A larger set of identifiers has higher precedence when all preceding are equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** True when `raw` parses and is >= `floor`. Unparseable strings are not a match. */
export function meetsSpecFloor(raw: string, floor: string = STRK20_MIN_SPEC): boolean {
  const v = parseSpecVersion(raw);
  const f = parseSpecVersion(floor);
  if (!v || !f) return false;
  return compareSpecVersion(v, f) >= 0;
}

/** What Blindpool is allowed to do with the connected wallet. */
export interface Strk20Capability {
  /** The wallet speaks a Wallet API spec that carries the STRK20 action set. */
  supported: boolean;
  /** Highest spec the wallet advertises, for display. Null when nothing parsed. */
  best: string | null;
  /**
   * Why private actions are unavailable — rendered to the user verbatim, so it must
   * explain the situation rather than name an error code. Null when supported.
   */
  reason: string | null;
}

/**
 * Decide capability from the spec list alone.
 *
 * Degradation is intentional and total: when this returns `supported: false`, Blindpool
 * still renders every public market, its odds and its settlement — only the private
 * actions (commit, reveal, claim) are disabled. A market is readable by anyone; that is
 * the entire premise, so a wallet without privacy support is a reduced app, not a
 * broken one.
 */
export function strk20Capability(specs: readonly string[] | undefined | null): Strk20Capability {
  if (!specs || specs.length === 0) {
    return {
      supported: false,
      best: null,
      reason:
        "This wallet did not report which Starknet API versions it supports, so Blindpool " +
        "cannot tell whether it can place private bets. You can still browse markets and odds.",
    };
  }

  const parsed = specs
    .map((s) => ({ raw: s, v: parseSpecVersion(s) }))
    .filter((p): p is { raw: string; v: SpecVersion } => p.v !== null);

  if (parsed.length === 0) {
    return {
      supported: false,
      best: null,
      reason:
        "Blindpool could not read this wallet's reported API versions. You can still browse " +
        "markets and odds.",
    };
  }

  parsed.sort((a, b) => compareSpecVersion(a.v, b.v));
  const best = parsed[parsed.length - 1];

  if (meetsSpecFloor(best.raw)) {
    return { supported: true, best: best.raw, reason: null };
  }

  return {
    supported: false,
    best: best.raw,
    reason:
      `This wallet speaks Starknet API ${best.raw}, and private bets need ${STRK20_MIN_SPEC} ` +
      `or newer. Ready supports it on mainnet. You can still browse markets and odds.`,
  };
}
