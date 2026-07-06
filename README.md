# Spectra

Spectra is a Casper-network port of an autonomous analytical intelligence agent that sits between a trader and
[CSPR.trade](https://cspr.trade), analyzes a proposed swap through
CSPR.trade's MCP server, and returns a go/no-go recommendation —
gated behind an [x402](https://x402.org) micropayment and backed by an
on-chain reputation record.



```
┌──────────┐   POST /route     ┌────────────────────┐   MCP tools    ┌───────────────┐
│  Trader  │ ─────────────────▶│  RoutingGuardAgent  │───────────────▶│  CSPR.trade   │
│ (wallet) │◀───── 402 ─────── │   (Node/Express)    │◀───────────────│  MCP (24 tools)│
└──────────┘   pay, replay     └─────────┬───────────┘   quotes/impact └───────────────┘
                w/ X-PAYMENT             │
                                          │ verify/settle          update_reputation
                                          ▼                              │
                              ┌───────────────────────┐                  ▼
                              │ CSPR.cloud x402        │        ┌────────────────────┐
                              │ Facilitator (hosted)   │        │  AgentRegistry      │
                              └───────────────────────┘        │  (Casper Wasm       │
                                                                 │  contract)          │
                              ┌───────────────────────┐        └────────────────────┘
                              │  Dashboard (HTML/WS)   │◀── live job + status feed
                              └───────────────────────┘
```

## Quickstart (agent + dashboard)

```bash
cd agent
cp .env.example .env      
npm install
npm start
```

```bash
curl -s -X POST http://localhost:3001/route \
  -H 'Content-Type: application/json' \
  -d '{"token_in":"CSPR","token_out":"USDC","amount":"5000"}' | jq
```

Without `AGENT_REGISTRY_HASH` set, the agent runs with local-only
reputation scoring (no on-chain writes) — useful for trying it out
before deploying the contract.

## Deploying the AgentRegistry contract

```bash
rustup target add wasm32-unknown-unknown
./scripts/build-contract.sh              

cd contracts/agent-registry/client
npm install
DEPLOYER_PRIVATE_KEY_PATH=./keys/secret_key.pem node install.mjs
# note the contract hash it prints, then:
AGENT_REGISTRY_HASH=<hash> node register-agent.mjs
```

Put the resulting contract hash into `agent/.env` as
`AGENT_REGISTRY_HASH`, and point `AGENT_PRIVATE_KEY_PATH` at the same
(or a delegated) key the agent should sign `update_reputation` deploys
with.

**Before you deploy for real:** the contract was written to the
documented shape of `casper-contract 4.0` / `casper-types 4.0.3` but
has not been compiled in this sandboxed environment (no network access
to fetch crates.io dependencies here). Run `cargo build --release
--target wasm32-unknown-unknown` locally first and fix up anything that
drifted against your exact pinned versions — see the comment at the top
of `contracts/agent-registry/src/main.rs` for the one spot
(`storage::new_locked_contract`'s argument count) most likely to need a
small adjustment across point releases. The same caveat applies to the
casper-js-sdk client scripts in `contracts/agent-registry/client/` —
they're written to the documented v2 API shape but unverified against a
live node from here.

## What's deliberately out of scope for this MVP

- **No yield-monitor agent / LP reallocation.** The decision doc scoped
  this down to a single agent (Routing Guard). `optimal_liquidity_amounts`
  and the LP-related MCP tools are under development.
- **No private key handling for end users.** Users pay via their own
  Casper wallet extension; the agent's private key (`AGENT_PRIVATE_KEY_PATH`)
  is only ever used to sign the agent's own `update_reputation` deploys.


