#!/usr/bin/env bash
#
# Declare and deploy Blindpool. Sepolia by default — mainnet requires an explicit
# NETWORK=mainnet, because deploying an unaudited contract to mainnet should take a
# deliberate act rather than a default.
#
#   export ALCHEMY_KEY=...           # never committed
#   ./scripts/deploy.sh              # sepolia
#   NETWORK=mainnet ./scripts/deploy.sh
#
# Prints the class hash and contract address, and appends them to ../strk20.json.

set -euo pipefail

NETWORK="${NETWORK:-sepolia}"
: "${ALCHEMY_KEY:?set ALCHEMY_KEY (get one free at https://www.alchemy.com)}"

case "$NETWORK" in
  sepolia) RPC_HOST="starknet-sepolia" ;;
  mainnet) RPC_HOST="starknet-mainnet" ;;
  *) echo "NETWORK must be sepolia or mainnet, got '$NETWORK'" >&2; exit 1 ;;
esac

export STARKNET_RPC="https://${RPC_HOST}.g.alchemy.com/starknet/version/rpc/v0_10/${ALCHEMY_KEY}"

# Constructor arguments. The pool is the ONLY address allowed to call privacy_invoke —
# get this wrong and either nothing works or, worse, anyone can drive the contract.
POOL_MAINNET="0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a"
POOL_SEPOLIA="${POOL_SEPOLIA:-0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91}"
STRK_MAINNET="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"

if [ "$NETWORK" = "mainnet" ]; then
  POOL="$POOL_MAINNET"
  TOKEN="${TOKEN:-$STRK_MAINNET}"
  echo "⚠️  MAINNET. This contract custodies stakes. Deploy only after an audit."
  read -r -p "Type 'mainnet' to continue: " confirm
  [ "$confirm" = "mainnet" ] || { echo "aborted"; exit 1; }
else
  POOL="$POOL_SEPOLIA"
  TOKEN="${TOKEN:?set TOKEN to the STRK address on sepolia}"
fi

ADMIN="${ADMIN:?set ADMIN to the address that will create and resolve markets}"

echo "network:  $NETWORK"
echo "pool:     $POOL"
echo "token:    $TOKEN"
echo "admin:    $ADMIN"
echo

scarb build

echo "→ declaring…"
DECLARE_OUT=$(sncast --profile "$NETWORK" declare --contract-name Blindpool 2>&1) || {
  # A re-declare of an unchanged class is not a failure — reuse the existing hash.
  echo "$DECLARE_OUT" | grep -qi "is already declared" || { echo "$DECLARE_OUT"; exit 1; }
}
echo "$DECLARE_OUT"
CLASS_HASH=$(echo "$DECLARE_OUT" | grep -oE '0x[0-9a-fA-F]{40,}' | head -1)
[ -n "$CLASS_HASH" ] || { echo "could not parse class hash" >&2; exit 1; }

echo "→ deploying…"
DEPLOY_OUT=$(sncast --profile "$NETWORK" deploy \
  --class-hash "$CLASS_HASH" \
  --constructor-calldata "$POOL" "$ADMIN" "$TOKEN")
echo "$DEPLOY_OUT"
ADDRESS=$(echo "$DEPLOY_OUT" | grep -oE 'contract_address: 0x[0-9a-fA-F]+' | grep -oE '0x[0-9a-fA-F]+' | head -1)

echo
echo "class hash: $CLASS_HASH"
echo "address:    $ADDRESS"

# Only mainnet deployments belong in strk20.json — that file is the sprint's record of
# what is live, and listing a sepolia address there would misreport it.
if [ "$NETWORK" = "mainnet" ] && [ -n "$ADDRESS" ]; then
  node -e '
    const fs = require("fs");
    const p = "../strk20.json";
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!j.contracts.includes(process.argv[1])) j.contracts.push(process.argv[1]);
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    console.log("recorded in strk20.json:", process.argv[1]);
  ' "$ADDRESS"
fi
