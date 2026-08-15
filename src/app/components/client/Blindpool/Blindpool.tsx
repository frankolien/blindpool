"use client";

import { useCallback, useMemo, useState } from "react";
import BetPanel from "./BetPanel";
import PositionsPanel from "./PositionsPanel";
import type { EpochSchedule } from "@/lib/blindpool/epoch";

/**
 * The full arc: seal a bet, wait for the epoch, reveal, claim.
 *
 * Epochs are short here so the flow is demonstrable in one sitting. On a real market they
 * are a privacy parameter, not a UX one — short epochs mean small anonymity sets and
 * fine-grained timing, long ones mean better privacy and a worse-feeling market
 * (spec/THREAT_MODEL.md §4.7).
 */
export default function Blindpool() {
  // Anchored once per mount so the countdown is stable across renders.
  const schedule: EpochSchedule = useMemo(
    () => ({
      startedAt: Math.floor(Date.now() / 1000),
      durationSeconds: 120,
      revealWindowSeconds: 120,
    }),
    [],
  );

  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <>
      <BetPanel epoch={0} onSaved={refresh} />
      <PositionsPanel key={version} schedule={schedule} />
    </>
  );
}
