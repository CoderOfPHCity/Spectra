# Spectra

Spectra is a Casper-network autonomous analytical agent that sits between a
trader and [CSPR.trade](https://cspr.trade). A trader asks for a swap; the
agent analyzes it through CSPR.trade's MCP server, returns a **go / caution /
no-go** recommendation, charges for the analysis via an
[x402](https://x402.org) micropayment, and records the outcome in an on-chain
reputation registry.

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

## How it works

### Components

- **RoutingGuardAgent** (`agent/index.js`) — a Node/Express server exposing
  `POST /route`. It runs the analysis, enforces the x402 paywall, serves the
  dashboard, and streams live events over WebSocket.
- **AgentRegistry** (`contracts/agent-registry/`) — a Casper Wasm contract: a
  minimal, ERC-8004-inspired registry where agents register an identity, post
  an optional CSPR stake, and accumulate an auditable record of total jobs,
  success rate, and fees earned.
- **Dashboard** (`dashboard/`) — a single HTML page (served at `/`) that
  listens to the agent's WebSocket feed and shows the live routing feed,
  price-impact warnings, and reputation score. `dashboard/pay.mjs` is the
  browser-side x402 client (Casper Wallet signing).
- **CSPR.trade MCP** — the DEX's public MCP server (24 read-only market and
  analysis tools). The agent talks to it over plain JSON-RPC; no API key.
- **CSPR.cloud x402 Facilitator** — hosted infrastructure that verifies and
  settles the micropayment on-chain. Nothing to self-host.

### The `/route` lifecycle

1. Trader `POST`s a swap (`token_in`, `token_out`, `amount`). With no payment
   header, the agent replies **402** with an x402 `PaymentRequirements` object
   and a `requestId`.
2. The trader's wallet signs the payment and replays the request with
   `X-PAYMENT` and `X-PAYMENT-REQUEST-ID` headers.
3. The agent **verifies then settles** the payment via the facilitator, using
   the *exact* `PaymentRequirements` it quoted for that `requestId` (kept in a
   short-lived in-memory map so verify/settle check what the client actually
   paid against).
4. It runs the analysis through CSPR.trade MCP and returns the recommendation.
5. It records the outcome on the AgentRegistry contract (`update_reputation`).

### Decision logic

- **Price-impact shield** — the Casper-relevant equivalent of MEV protection.
  Calls `estimate_price_impact`: **blocked** at `impact ≥ IMPACT_BLOCK` (5%),
  **caution** at `impact ≥ IMPACT_WARN` (1%), otherwise **proceed**.
- **Optimal sizing** — when impact is too high, a bounded bisection against
  `estimate_price_impact` suggests the largest amount that stays under the warn
  threshold.
- **Volatility** — realized volatility from CSPR.trade price history
  (`get_pair_price_history`, falling back to `get_token_price_history`).

### Reputation

Two scores, intentionally distinct: a fast in-memory EMA the agent shows
immediately, and the canonical success-rate record the contract keeps
on-chain. See [`docs/DECISIONS.md`](docs/DECISIONS.md) for the full rationale.

## Repo layout

```
agent/                     RoutingGuardAgent (Node/Express + WebSocket)
contracts/agent-registry/  Casper Wasm reputation contract (Rust)
  src/main.rs              the contract
  client/                  casper-js-sdk deploy/query scripts
  Dockerfile               build the wasm with only Docker
dashboard/                 live dashboard + browser x402 client
scripts/                   build-contract.sh, testnet-deploy.sh
docs/                      DECISIONS.md, DEPLOY-TESTNET.md
```

## Prerequisites

- **Node.js 18+** — to run the agent and dashboard.
- **rustup** — to build the contract natively (or use Docker instead; see
  below). The correct nightly toolchain is pinned in
  `contracts/agent-registry/rust-toolchain.toml` and installed automatically.
- **casper-client 5.0.1** — to deploy to testnet:
  `cargo install casper-client --version 5.0.1 --locked`.

## Run the agent + dashboard

```bash
cd agent
cp .env.example .env
npm install
npm start
```

Open http://localhost:3001 for the dashboard. Hit the API directly with:

```bash
curl -s -X POST http://localhost:3001/route \
  -H 'Content-Type: application/json' \
  -d '{"token_in":"CSPR","token_out":"USDC","amount":"5000"}' | jq
```

Without a payment this returns **402** — that's the paywall working. To try
the full analysis pipeline without wiring up a wallet, set `DEMO_MODE=true` in
`.env` and call `POST /demo/route` (same analysis, x402 skipped — never deploy
this way).

Without `AGENT_REGISTRY_HASH` set, the agent runs with local-only reputation
scoring (no on-chain writes) — handy for trying it out before deploying the
contract.

## Build the contract

Native (toolchain auto-selected from `rust-toolchain.toml`):

```bash
./scripts/build-contract.sh          # -> contracts/agent-registry/agent-registry.wasm
```

Or with only Docker installed (no local Rust):

```bash
docker build -f contracts/agent-registry/Dockerfile \
  -o contracts/agent-registry contracts/agent-registry
```

## Deploy to testnet

Testnet runs Casper 2.0, which matches the contract's build. Deploy with
`casper-client`:

```bash
casper-client keygen ./keys                       # make a key
# fund ./keys/public_key_hex at https://testnet.cspr.live/tools/faucet
./scripts/build-contract.sh
DEPLOYER_SECRET_KEY=./keys/secret_key.pem \
DEPLOYER_PUBLIC_KEY=./keys/public_key.pem \
./scripts/testnet-deploy.sh
```

The script installs the wasm, waits for finalization, and prints the
`agent_registry_contract_hash`. Put that into `agent/.env` as
`AGENT_REGISTRY_HASH`, and point `AGENT_PRIVATE_KEY_PATH` at the key that
should sign the agent's `update_reputation` deploys.

Full walkthrough (funding, register_agent, node choice, the CSPR.cloud token
caveat): [`docs/DEPLOY-TESTNET.md`](docs/DEPLOY-TESTNET.md).

## Configuration

Key `agent/.env` values (see `agent/.env.example` for all):

| Variable | Purpose |
|---|---|
| `PORT` | HTTP/WebSocket port (default 3001) |
| `AGENT_WALLET_PUBLIC_KEY` | `payTo` address in every payment challenge |
| `AGENT_REGISTRY_HASH` | deployed contract hash; blank = local-only reputation |
| `AGENT_PRIVATE_KEY_PATH` | key that signs `update_reputation` deploys |
| `CSPR_NODE_RPC` | Casper node RPC endpoint |
| `X402_FACILITATOR` | hosted x402 facilitator URL |
| `CSPR_TRADE_MCP_URL` | CSPR.trade MCP server |
| `ROUTING_FEE_MOTES` | fee charged per `/route` call |
| `IMPACT_WARN` / `IMPACT_BLOCK` | price-impact thresholds (%) |

## Out of scope for this MVP

- **No yield-monitor / LP-reallocation agent.** Scope is the single Routing
  Guard; the LP-related MCP tools are under development.
- **No end-user private-key handling.** Users pay via their own Casper wallet
  extension. The agent's key is only ever used to sign its own
  `update_reputation` deploys.
