# Spectra — architecture decisions

This records the questions that had to be settled before writing any
code, and what was decided. It exists so a future contributor (or a
future you) doesn't have to re-derive *why* the project looks the way
it does.

## 1. Core routing pattern: agent-mediated routing (Option A)

Casper is a Uniswap-v2-style AMM with no hook lifecycle — there's no
Casper equivalent of `beforeSwap`/`afterSwap` for an agent to embed
itself inside. Three options were on the table:

- **A — Agent-mediated routing.** The agent sits between user and
  CSPR.trade. The user asks for a route; the agent analyzes it via MCP
  and returns advice, paid via x402. **Chosen.**
- **B — Continuous yield monitor.** Agent watches pool state and
  reallocates LP positions, charging per action. Deferred — no yield
  monitor in this MVP.
- **C — Pre-trade guard with x402 paywall.** Functionally very close to
  A; A was chosen as the clearer framing.

## 2. Single agent for the MVP

Only the **Routing Guard** ships. A yield-monitoring agent was
considered but explicitly cut from scope to keep the MVP focused.

## 3. MEV logic → Price Impact Shield

Casper has no public mempool and uses FIFO-ish ordering, so classic MEV
(sandwich attacks, frontrunning via mempool visibility) doesn't apply
the way it does on EVM chains. The equivalent, real risk on an AMM like
CSPR.trade is **price impact** on large swaps. `MEVShieldAgent` became
a **price impact shield**: it calls `estimate_price_impact` (and
factors in `analyze_trade`'s recommendation) and either blocks
(`impact ≥ IMPACT_BLOCK`), warns (`impact ≥ IMPACT_WARN`), or approves
a trade.

## 4. Oracle logic → volatility-based optimal sizing

`PriceOracleAgent`'s job maps cleanly: instead of simulating prices, it
pulls real history via `get_pair_price_history` (falling back to
`get_token_price_history` if the pair isn't available) to compute
realized volatility, and uses that alongside a bounded bisection against
`estimate_price_impact` to suggest a reduced trade size when the
requested amount would land in "caution" or "blocked" territory. Fee
optimization isn't meaningful here since CSPR.trade has fixed fees, so
this became slippage/impact optimization instead.

## 5. Reputation system → minimal ERC-8004-inspired registry

ERC-8004 (Ethereum's "Trustless Agents" proposal) and ERC-3643 (T-REX,
a full identity/compliance standard) were both considered. ERC-3643's
full stack — `IdentityRegistry`, `ClaimTopicsRegistry`, `Compliance`
contracts, per-agent `Identity` contracts — was judged out of scope for
an MVP: it's a compliance layer for regulated token transfers, not an
agent reputation system, and deploying it natively on Casper would mean
building most of it from scratch.

Instead, `contracts/agent-registry` is a **small, purpose-built Casper
Wasm contract** that borrows only the part of ERC-8004 that matters
here: agents register an identity, post an optional stake, and build an
auditable on-chain record of total jobs, success rate, and fees earned.
Any agent can register and compete on that record — that's the whole
trust model. See the module docs at the top of
`contracts/agent-registry/src/main.rs` for the exact entry points.

## 6. x402 payment: hosted facilitator, routing recommendation as the paid resource

- **Paid resource:** the routing recommendation returned by `/route`.
  (LP-reallocation-per-action and "MEV analysis result" were both
  discussed as alternatives; since there's no LP-reallocation agent in
  this MVP, the routing recommendation is the only paid resource in
  practice.)
- **Facilitator:** CSPR.cloud runs a **hosted** x402 facilitator at
  `https://x402-facilitator.cspr.cloud` for both mainnet and testnet —
  no need to run one. This is Option B from the facilitator question
  (shared/hosted infra over self-hosting or mocking).
- **Signing:** there's no private key available for end users in this
  system, so payment signing happens **client-side via a Casper wallet
  extension**, not a key the agent holds. The agent's own
  `AGENT_PRIVATE_KEY_PATH` key is only used to sign the agent's own
  `update_reputation` deploys to the registry contract.

One correctness fix made relative to the original sketch: the 402
challenge and the subsequent verify/settle calls must check the *same*
`PaymentRequirements` object (same resource id, same everything) or a
facilitator doing real validation would reject the mismatch. The agent
now keeps a short-lived in-memory map from `requestId` →
`PaymentRequirements` and requires the client to echo the `requestId`
back via an `X-PAYMENT-REQUEST-ID` header when it replays with
`X-PAYMENT`.

## 7. Dashboard: kept, re-pointed at Casper

Same HTML/WebSocket approach as the original design, showing the live
routing feed, price-impact warnings, and reputation score — just
listening to the same agent process's WebSocket server instead of Arc
chain events, since all the relevant state (jobs, price impact,
reputation) now lives in the Node process and the registry contract
rather than in EVM event logs.

## 8. Token scope for the MVP

The default worked example throughout is the `CSPR/USDC` pair — the
agent itself is token-agnostic (`token_in`/`token_out` are just
whatever identifiers CSPR.trade's MCP tools expect), but CSPR/USDC is
the pair used in examples and testing.
