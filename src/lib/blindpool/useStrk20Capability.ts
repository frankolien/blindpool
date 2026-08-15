"use client";

import { useMemo } from "react";
import { useStoreWallet } from "@/app/components/Wallet/walletContext";
import { strk20Capability, type Strk20Capability } from "./capability";

/**
 * STRK20 capability of the connected wallet.
 *
 * Reads the spec list that `SelectWallet` already captured from
 * `walletV6.supportedSpecs()` at connect time — no extra wallet call, and specifically no
 * `strk20Balances` probe, which would prompt the user to disclose their shielded balances
 * just to answer a yes/no the version string already answers.
 */
export function useStrk20Capability(): Strk20Capability {
  const specs = useStoreWallet((state) => state.walletApiList);
  return useMemo(() => strk20Capability(specs), [specs]);
}
