"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "../../../uni.module.css";
import {
  epochClosesAt,
  epochPhase,
  revealClosesAt,
  secondsRemaining,
  type EpochSchedule,
} from "@/lib/blindpool/epoch";
import {
  exportPosition,
  loadPositions,
  toBetSecret,
  type StoredPosition,
} from "@/lib/blindpool/vault";
import { buildClaimActions, buildRevealActions } from "@/lib/blindpool/bet";
import * as constants from "@/utils/constants";

const short = (h: string) => (h.length <= 18 ? h : `${h.slice(0, 10)}…${h.slice(-6)}`);
const fmtStrk = (wei: string) => `${BigInt(wei) / 10n ** 18n}`;

function countdown(seconds: number): string {
  if (seconds <= 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Your open positions — the reveal and claim half of the flow.
 *
 * A position lives nowhere but this browser. There is no account to recover it from,
 * which is what removes the need for a shadow account, and it is also why this panel
 * leads with the backup rather than burying it: miss the reveal window and the stake is
 * forfeited to the winning side, with no recourse.
 */
export default function PositionsPanel({
  schedule = { startedAt: 0, durationSeconds: 3600, revealWindowSeconds: 900 },
}: {
  schedule?: EpochSchedule;
}) {
  const [positions, setPositions] = useState<StoredPosition[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [shown, setShown] = useState<string | null>(null);

  // localStorage is client-only; reading during render would break the static prerender.
  useEffect(() => setPositions(loadPositions()), []);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const rows = useMemo(
    () =>
      positions.map((p) => {
        const phase = epochPhase(schedule, p.epoch, now);
        const left = secondsRemaining(schedule, p.epoch, now);
        return { p, phase, left };
      }),
    [positions, schedule, now],
  );

  if (rows.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.inputBlock}>
          <div className={styles.inputLabel}>Your positions</div>
          <div className={styles.subLine}>
            <span>
              No sealed bets yet. A position is a commitment held in this browser — it
              never touches a server, and nothing on-chain can recover it.
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.inputBlock}>
        <div className={styles.inputLabel}>Your positions</div>
        <div className={styles.subLine}>
          <span>Held in this browser only. Back each one up before its reveal window.</span>
        </div>
      </div>

      {rows.map(({ p, phase, left }) => {
        // Built eagerly so a composition error surfaces here, not at signing time.
        const actions =
          phase === "REVEAL"
            ? buildRevealActions({
                anonymizer: "0x0",
                token: constants.addrSTRK,
                marketId: p.marketId,
                secret: toBetSecret(p),
              })
            : buildClaimActions({
                anonymizer: "0x0",
                token: constants.addrSTRK,
                marketId: p.marketId,
                recipient: "0x0",
                secret: toBetSecret(p),
              });

        return (
          <div key={p.commitment} className={styles.receipt}>
            <div className={styles.receiptHead}>
              <span className={styles.receiptIcon}>
                {p.claimedAt ? "✓" : phase === "REVEAL" ? "!" : "◈"}
              </span>
              <span>
                {fmtStrk(p.denomination)} STRK · epoch {p.epoch} ·{" "}
                {p.claimedAt
                  ? "claimed"
                  : p.revealedAt
                    ? "revealed"
                    : phase === "COMMIT"
                      ? "sealed"
                      : phase === "REVEAL"
                        ? "reveal now"
                        : "forfeited"}
              </span>
            </div>

            <div className={styles.receiptRows}>
              <div className={styles.receiptRow}>
                <span className={styles.receiptLabel}>Commitment</span>
                <span className={styles.receiptValue}>{short(p.commitment)}</span>
              </div>
              <div className={styles.receiptRow}>
                <span className={styles.receiptLabel}>Your side</span>
                <span className={styles.receiptValue}>
                  {p.revealedAt ? p.side : `${p.side} — not yet public`}
                </span>
              </div>
              <div className={styles.receiptRow}>
                <span className={styles.receiptLabel}>
                  {phase === "COMMIT"
                    ? "Epoch closes in"
                    : phase === "REVEAL"
                      ? "Reveal closes in"
                      : "Window"}
                </span>
                <span className={styles.receiptValue}>
                  {phase === "SETTLED" ? "closed" : countdown(left)}
                </span>
              </div>
            </div>

            {/* The forfeiture warning is the honest cost of sealing the epoch, so it is
                loudest exactly when it can still be acted on. */}
            {phase === "REVEAL" && !p.revealedAt && (
              <div className={styles.warn}>
                Reveal within {countdown(left)} or this stake forfeits to the winning side.
              </div>
            )}
            {phase === "SETTLED" && !p.revealedAt && (
              <div className={styles.warn}>
                Never revealed — this stake was forfeited to the winning side.
              </div>
            )}

            <button
              className={styles.btnCta}
              disabled
              title="BlindpoolAnonymizer is not deployed yet"
            >
              {p.claimedAt
                ? "Claimed"
                : phase === "COMMIT"
                  ? `Sealed — reveal opens in ${countdown(left)}`
                  : phase === "REVEAL"
                    ? `Reveal (${actions.length} action) — anonymizer not deployed`
                    : `Claim — anonymizer not deployed`}
            </button>

            <button
              className={styles.btn}
              onClick={() => setShown(shown === p.commitment ? null : p.commitment)}
            >
              {shown === p.commitment ? "Hide backup" : "Show backup"}
            </button>

            {shown === p.commitment && (
              <pre className={styles.receiptNote}>{exportPosition(p)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
