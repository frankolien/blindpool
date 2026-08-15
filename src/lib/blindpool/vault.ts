// Local custody of bet secrets.
//
// A Blindpool position is a commitment, and the only thing that can open it is the
// (side, nonce, secret) triple held by the bettor. There is no on-chain account to
// recover it from and no server that has a copy — that absence is the design, not an
// oversight, and it is why no shadow account is needed.
//
// The consequence is blunt and must be surfaced in the UI: lose this and the stake is
// unrecoverable. Clear the browser store before revealing and the bet forfeits.

import type { BetSecret } from "./epoch";
import { computeCommitment } from "./epoch";
import type { Side } from "./market";

const STORAGE_KEY = "blindpool.positions.v1";

export interface StoredPosition {
  commitment: string;
  marketId: string;
  epoch: number;
  denomination: string; // bigint as decimal string — JSON cannot carry bigint
  side: Side;
  nonce: string;
  secret: string;
  createdAt: number;
  revealedAt?: number;
  claimedAt?: number;
}

export function toStored(
  bet: BetSecret,
  marketId: string,
  epoch: number,
  denomination: bigint,
): StoredPosition {
  return {
    commitment: computeCommitment(bet),
    marketId,
    epoch,
    denomination: denomination.toString(),
    side: bet.side,
    nonce: bet.nonce.toString(),
    secret: bet.secret.toString(),
    createdAt: Date.now(),
  };
}

export function toBetSecret(p: StoredPosition): BetSecret {
  return { side: p.side, nonce: BigInt(p.nonce), secret: BigInt(p.secret) };
}

/** Never throws: a corrupt or unavailable store must not take the app down. */
export function loadPositions(): StoredPosition[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredPosition[]) : [];
  } catch {
    return [];
  }
}

export function savePosition(p: StoredPosition): StoredPosition[] {
  const all = loadPositions();
  // Commitment is the identity — re-saving the same bet updates rather than duplicates.
  const next = [...all.filter((x) => x.commitment !== p.commitment), p];
  persist(next);
  return next;
}

export function markPosition(
  commitment: string,
  patch: Partial<Pick<StoredPosition, "revealedAt" | "claimedAt">>,
): StoredPosition[] {
  const next = loadPositions().map((p) =>
    p.commitment === commitment ? { ...p, ...patch } : p,
  );
  persist(next);
  return next;
}

function persist(positions: StoredPosition[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Quota or private-mode failure. Swallowed deliberately: the caller has already
    // shown the user their secret to back up, and throwing here would lose the bet
    // they just placed rather than degrade to a manual copy.
  }
}

/**
 * A plain-text backup of one position.
 *
 * Offered as a copyable block rather than a file download: an artifact viewer sandbox
 * blocks page-initiated downloads, and more importantly a user who pastes this somewhere
 * they control is likelier to still have it in an hour than one who accepts a download
 * into a folder they forget.
 */
export function exportPosition(p: StoredPosition): string {
  return [
    "BLINDPOOL POSITION — keep this until you have claimed.",
    "Anyone holding it learns which side you took. Losing it forfeits the stake.",
    "",
    `market:      ${p.marketId}`,
    `epoch:       ${p.epoch}`,
    `commitment:  ${p.commitment}`,
    `side:        ${p.side}`,
    `denomination:${p.denomination}`,
    `nonce:       ${p.nonce}`,
    `secret:      ${p.secret}`,
  ].join("\n");
}
