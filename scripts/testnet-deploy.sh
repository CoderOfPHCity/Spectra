#!/usr/bin/env bash
# Install the AgentRegistry contract on Casper testnet using casper-client.
#
# Prereqs:
#   1. casper-client on PATH   (cargo install casper-client --version 5.0.1 --locked)
#   2. A key pair:             casper-client keygen ./keys
#   3. Fund ./keys/public_key_hex at https://testnet.cspr.live/tools/faucet
#   4. Built wasm:             ./scripts/build-contract.sh
#
# Config via env (defaults shown):
set -euo pipefail

NODE="${CSPR_NODE_ADDRESS:-http://135.181.182.154:7777}"   # open testnet RPC, no token
CHAIN="${CASPER_NETWORK_NAME:-casper-test}"
SECRET_KEY="${DEPLOYER_SECRET_KEY:-./keys/secret_key.pem}"
PUBLIC_KEY="${DEPLOYER_PUBLIC_KEY:-./keys/public_key.pem}"
WASM="${WASM_PATH:-contracts/agent-registry/agent-registry.wasm}"
PAYMENT="${INSTALL_PAYMENT_MOTES:-300000000000}"           # 300 CSPR; bump if it fails on gas

command -v casper-client >/dev/null || { echo "casper-client not on PATH"; exit 1; }
[ -f "$SECRET_KEY" ] || { echo "No key at $SECRET_KEY — run: casper-client keygen ./keys"; exit 1; }
[ -f "$WASM" ]       || { echo "No wasm at $WASM — run ./scripts/build-contract.sh"; exit 1; }

echo "==> Installing $WASM"
echo "    node:  $NODE"
echo "    chain: $CHAIN"
OUT=$(casper-client put-deploy \
  --node-address "$NODE" \
  --chain-name "$CHAIN" \
  --secret-key "$SECRET_KEY" \
  --payment-amount "$PAYMENT" \
  --session-path "$WASM")

HASH=$(echo "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['deploy_hash'])")
echo "==> deploy_hash: $HASH"

echo "==> Waiting for finalization (~1-2 min)..."
for i in $(seq 1 40); do
  sleep 5
  RES=$(casper-client get-deploy --node-address "$NODE" "$HASH" 2>/dev/null || true)
  STATE=$(echo "$RES" | python3 -c "
import sys,json
try:
  r=json.load(sys.stdin)['result']['execution_results']
  if not r: print('pending'); exit()
  x=r[0]['result']
  print('success' if 'Success' in x else 'failure:'+json.dumps(x.get('Failure',{}))[:200])
except Exception: print('pending')" 2>/dev/null || echo pending)
  echo "    [$i] $STATE"
  case "$STATE" in
    success) break ;;
    failure:*) echo "$STATE"; exit 1 ;;
  esac
done

echo "==> Reading contract hash from deployer's named keys"
casper-client get-entity \
  --node-address "$NODE" \
  --entity-identifier "$PUBLIC_KEY" \
| python3 -c "
import sys,json
d=json.load(sys.stdin)['result']
nks=d.get('entity',{}).get('named_keys') or d.get('named_keys') or []
for nk in nks:
  if 'agent_registry' in nk.get('name',''):
    print('   ',nk['name'],'=',nk['key'])
"

echo ""
echo "==> Set AGENT_REGISTRY_HASH in agent/.env to the agent_registry_contract_hash above"
echo "    (strip any 'hash-'/'contract-' prefix), then register the agent:"
echo ""
echo "    casper-client put-deploy --node-address $NODE --chain-name $CHAIN \\"
echo "      --secret-key $SECRET_KEY --payment-amount 3000000000 \\"
echo "      --session-hash <CONTRACT_HASH> --session-entry-point register_agent \\"
echo "      -a \"agent_id:string='spectra-routing-guard-v1'\" -a \"stake_motes:u512='0'\""
