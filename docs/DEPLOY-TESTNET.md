# Deploying AgentRegistry to Casper testnet

Testnet runs Casper 2.0 (`casper-test`, api 2.0.0), which matches the
contract's `casper-contract 5.1.1` build. Deploys use `casper-client`.

## 1. Install casper-client

```bash
cargo install casper-client --version 5.0.1 --locked
```

## 2. Make a key and fund it

```bash
cd contracts/agent-registry/client   # or anywhere; keys are gitignored
casper-client keygen ./keys
cat ./keys/public_key_hex
```

Paste that hex into the faucet at https://testnet.cspr.live/tools/faucet
(gives ~1000 test CSPR). Wait for the balance to land.

## 3. Build the contract

```bash
./scripts/build-contract.sh          # -> contracts/agent-registry/agent-registry.wasm
```

## 4. Deploy

```bash
DEPLOYER_SECRET_KEY=contracts/agent-registry/client/keys/secret_key.pem \
DEPLOYER_PUBLIC_KEY=contracts/agent-registry/client/keys/public_key.pem \
./scripts/testnet-deploy.sh
```

The script installs the wasm, waits for finalization, and prints the
`agent_registry_contract_hash` from your account's named keys. It also
prints the `register_agent` command to run next.

Node defaults to the open testnet RPC `http://135.181.182.154:7777`
(no token). Backups: `185.170.112.40:7777`, `65.109.115.124:7777`.
Override with `CSPR_NODE_ADDRESS=...`.

## 5. Wire it into the agent

Put the contract hash (no `hash-`/`contract-` prefix) into `agent/.env`:

```
AGENT_REGISTRY_HASH=<hash>
AGENT_PRIVATE_KEY_PATH=<path to the same secret_key.pem>
```

## Notes

- **CSPR.cloud RPC needs a token** (`node.testnet.cspr.cloud` returns 401
  without one), and casper-client can't send custom headers — hence the
  open `:7777` node above.
- The JS scripts (`install.mjs`, `register-agent.mjs`) point at CSPR.cloud
  but `casper-js-sdk` doesn't send the token, so they'd 401 as-is. The
  casper-client path above avoids that. If you want the agent's on-chain
  `update_reputation` writes to work, point `CSPR_NODE_RPC` at the open
  node too, or add the token header to the SDK client.
- If a deploy fails on gas, raise `INSTALL_PAYMENT_MOTES`.
