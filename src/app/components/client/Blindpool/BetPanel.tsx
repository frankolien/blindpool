"use client";

import { useMemo, useState } from "react";
import styles from "../../../uni.module.css";
import {
  assessAnonymity,
  computeCommitment,
  createBetSecret,
  MIN_SAFE_ANONYMITY_SET,
  TRANCHES,
  type BetSecret,
  type ObservedCommit,
} from "@/lib/blindpool/epoch";
import { buildBetActions } from "@/lib/blindpool/bet";
import { savePosition, toStored } from "@/lib/blindpool/vault";
import type { Side } from "@/lib/blindpool/market";
import { useStrk20Capability } from "@/lib/blindpool/useStrk20Capability";
import { useStoreWallet } from "../../Wallet/walletContext";
import * as constants from "@/utils/constants";

const DECIMALS = 10n ** 18n;
const label = (t: bigint) => `${t / DECIMALS}`;
const short = (h: string) => (h.length <= 18 ? h : `${h.slice(0, 10)}…${h.slice(-6)}`);

/**
 * Placing a sealed bet.
 *
 * The panel deliberately shows the user three things before they can sign: the commitment
 * that would actually be published, how many identical commits they would hide among, and
 * what happens if they never come back to reveal. A privacy claim the user cannot inspect
 * is a claim they cannot check.
 *
 * The BlindpoolAnonymizer does not exist yet (spec/CONTRACTS.md), so signing is disabled
 * and labelled as such. Everything above that line is real: the commitment is a genuine
 * Poseidon hash and the action list is the one that will be submitted.
 */
export default function BetPanel({
  observed = [],
  epoch = 0,
  onSaved,
}: {
  /** Commits already seen on-chain this epoch. Empty until the market contract is live. */
  observed?: ObservedCommit[];
  epoch?: number;
  /** Fired after a local preview is stored, so the positions list can refresh. */
  onSaved?: () => void;
}) {
  const strk20 = useStrk20Capability();
  const isConnected = useStoreWallet((s) => s.isConnected);

  const [side, setSide] = useState<Side>("YES");
  const [tranche, setTranche] = useState<bigint>(TRANCHES[1]);
  // One secret per side/tranche selection so the displayed commitment is stable while the
  // user reads it, and regenerated whenever the bet changes.
  const [secret, setSecret] = useState<BetSecret>(() => createBetSecret("YES"));

  const pick = (nextSide: Side, nextTranche: bigint) => {
    setSide(nextSide);
    setTranche(nextTranche);
    setSecret({ ...createBetSecret(nextSide), side: nextSide });
  };

  const commitment = useMemo(
    () => computeCommitment({ ...secret, side }),
    [secret, side],
  );
  const anonymity = useMemo(
    () => assessAnonymity(observed, epoch, tranche),
    [observed, epoch, tranche],
  );

  // Built eagerly so a composition error surfaces here rather than at signing time.
  const actions = useMemo(() => {
    try {
      return buildBetActions({
        anonymizer: "0x0",
        token: constants.addrSTRK,
        marketId: 1,
        epoch,
        tranche,
        secret: { ...secret, side },
      });
    } catch {
      return null;
    }
  }, [epoch, tranche, secret, side]);

  return (
    <div className={styles.panel}>
      <div className={styles.inputBlock}>
        <div className={styles.inputLabel}>Sealed bet · epoch {epoch}</div>

        <div className={styles.bpSides}>
          {(["YES", "NO"] as Side[]).map((s) => (
            <button
              key={s}
              className={`${styles.bpSide} ${side === s ? styles.bpSideActive : ""}`}
              onClick={() => pick(s, tranche)}
            >
              {s}
            </button>
          ))}
        </div>

        <div className={styles.bpTranches}>
          {TRANCHES.map((t) => (
            <button
              key={t.toString()}
              className={`${styles.bpTranche} ${tranche === t ? styles.bpTrancheActive : ""}`}
              onClick={() => pick(side, t)}
            >
              {label(t)} STRK
            </button>
          ))}
        </div>

        <div className={styles.subLine}>
          <span>Fixed tranches only — arbitrary amounts fingerprint you</span>
        </div>
      </div>

      {/* What actually gets published. The side is not in it, and that is the point. */}
      <div className={styles.receipt}>
        <div className={styles.receiptHead}>
          <span className={styles.receiptIcon}>◈</span>
          <span>Published on-chain</span>
        </div>
        <div className={styles.receiptRows}>
          <div className={styles.receiptRow}>
            <span className={styles.receiptLabel}>Commitment</span>
            <span className={styles.receiptValue}>{short(commitment)}</span>
          </div>
          <div className={styles.receiptRow}>
            <span className={styles.receiptLabel}>Denomination</span>
            <span className={styles.receiptValue}>{label(tranche)} STRK</span>
          </div>
          <div className={styles.receiptRow}>
            <span className={styles.receiptLabel}>Your side</span>
            <span className={styles.receiptValue}>not published until epoch close</span>
          </div>
        </div>
      </div>

      {/* Anonymity set, before signing rather than after. */}
      <div className={`${styles.bpMeter} ${anonymity.safe ? styles.bpMeterOk : styles.bpMeterWarn}`}>
        <div className={styles.bpMeterK}>
          <span className={styles.bpMeterNum}>{anonymity.k}</span>
          <span className={styles.bpMeterUnit}>
            identical commit{anonymity.k === 1 ? "" : "s"} this epoch
          </span>
        </div>
        <div className={styles.bpMeterBar} aria-hidden>
          <span
            className={styles.bpMeterFill}
            style={{
              width: `${Math.min(100, (anonymity.k / MIN_SAFE_ANONYMITY_SET) * 100)}%`,
            }}
          />
        </div>
        <div className={styles.bpMeterMsg}>{anonymity.message}</div>
      </div>

      <div className={styles.warn}>
        You must return after this epoch closes to reveal. A bet that is never revealed
        forfeits its stake to the winning side — that is the cost of sealing the epoch.
      </div>

      <button className={styles.btnCta} disabled title="BlindpoolAnonymizer is not deployed yet">
        {!isConnected
          ? "Connect a wallet"
          : !strk20.supported
            ? "Wallet cannot place private bets"
            : actions
              ? "Place sealed bet — anonymizer not deployed"
              : "Invalid bet"}
      </button>

      {/* Honest stand-in while the contract does not exist: stores the position locally so
          the reveal and claim flow can be seen end to end. Labelled as a local preview
          rather than dressed up as a bet — a demo that implies an on-chain action that did
          not happen is worse than one that admits the gap. */}
      <button
        className={styles.btn}
        onClick={() => {
          savePosition(toStored({ ...secret, side }, "1", epoch, tranche));
          onSaved?.();
        }}
      >
        Preview locally — stores the position, sends no transaction
      </button>
    </div>
  );
}
