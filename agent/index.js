/**
 * RoutingGuardAgent — Spectra
 *
 * Sits between user and CSPR.trade DEX.
 * Every routing recommendation is gated behind an x402 micropayment.
 *
 * DATA FLOW:
 *   User POST /route → 402 + PaymentRequirements (+ requestId)
 *   User pays via Casper wallet extension → replays with X-PAYMENT
 *     and X-PAYMENT-REQUEST-ID headers
 *   Agent verifies via CSPR.cloud x402 Facilitator (using the SAME
 *     PaymentRequirements that were quoted for that requestId)
 *   Agent runs analysis via CSPR.trade MCP (24 tools)
 *   Agent updates reputation on the Casper AgentRegistry contract
 *   Returns: { recommendation, quote, impact, optimalSize, agentScore }
 *
 * NOTE ON HARDENING vs. the original MVP sketch:
 *   - The original 402 → verify/settle flow rebuilt PaymentRequirements
 *     with a different resource id at each step ("verify" as a literal
 *     string), so the object the facilitator validated against didn't
 *     match what the client was quoted. This version stores the exact
 *     PaymentRequirements issued for each requestId and requires the
 *     client to echo that id back, so verify/settle always check the
 *     payment against the requirements the client actually saw.
 *   - _computeVolatility now prefers get_pair_price_history (the pair
 *     actually being traded) and falls back to get_token_price_history,
 *     matching the decision doc ("Oracle Logic: get_pair_price_history").
 *   - _suggestOptimalSize now does a bounded bisection against
 *     estimate_price_impact instead of a flat 50% haircut.
 */

import express          from 'express'
import { EventEmitter } from 'events'
import { randomUUID }   from 'crypto'
import axios            from 'axios'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import dotenv           from 'dotenv'
dotenv.config()

const PORT             = process.env.PORT || 3001
const AGENT_ID         = process.env.AGENT_ID || 'spectra-routing-guard-v1'
const AGENT_WALLET     = process.env.AGENT_WALLET_PUBLIC_KEY || ''
const REGISTRY_HASH    = process.env.AGENT_REGISTRY_HASH || ''
const CSPR_NODE_RPC    = process.env.CSPR_NODE_RPC  || 'https://node.testnet.cspr.cloud'
const X402_FACILITATOR = process.env.X402_FACILITATOR || 'https://x402-facilitator.cspr.cloud'
const MCP_URL          = process.env.CSPR_TRADE_MCP_URL || 'https://mcp.cspr.trade/mcp'

const ROUTING_FEE_MOTES = BigInt(process.env.ROUTING_FEE_MOTES || '100000000') // 0.1 CSPR
const IMPACT_WARN       = parseFloat(process.env.IMPACT_WARN || '1.0')   // % warn
const IMPACT_BLOCK      = parseFloat(process.env.IMPACT_BLOCK || '5.0')  // % block
const VOLATILITY_HOURS  = parseInt(process.env.VOLATILITY_HOURS || '24')
const OPTIMAL_SIZE_ITERATIONS = parseInt(process.env.OPTIMAL_SIZE_ITERATIONS || '5')
const PAYMENT_REQUIREMENT_TTL_MS = 60_000

// ── MCP HTTP client (no SDK dep required — plain JSON-RPC over HTTP) ──────────
class MCPClient {
  constructor() { this.msgId = 1 }

  async call(tool, args = {}) {
    const body = {
      jsonrpc: '2.0',
      id:      this.msgId++,
      method:  'tools/call',
      params:  { name: tool, arguments: args },
    }
    const res = await axios.post(MCP_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    })
    const data = res.data
    if (data.error) throw new Error(`MCP error: ${JSON.stringify(data.error)}`)
    const content = data.result?.content || []
    const text    = content.find(c => c.type === 'text')?.text
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }
}

const mcp = new MCPClient()

function extractImpact(data) {
  return parseFloat(
    data?.price_impact_percent ??
    data?.priceImpact ??
    data?.impact ?? 0
  )
}

// X-PAYMENT is base64-encoded JSON per the x402 spec — the facilitator
// expects the decoded object, not the raw header string.
function decodePaymentHeader(paymentHeader) {
  return JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'))
}

// ── Agent ─────────────────────────────────────────────────────────────────────
class RoutingGuardAgent extends EventEmitter {
  constructor() {
    super()
    this.agentId = AGENT_ID
    this.stats   = {
      requestsReceived: 0,
      requestsPaid:     0,
      routesBlocked:    0,
      routesApproved:   0,
      feesMotes:        0n,
      repScore:         800,
      totalJobs:        0,
    }
  }

  // ── x402: build PaymentRequirements (402 response body) ──────────────────
  buildPaymentRequirements(requestId) {
    return {
      scheme:            'exact',
      network:           'casper:testnet',
      maxAmountRequired: ROUTING_FEE_MOTES.toString(),
      resource:          `spectra:routing:${requestId}`,
      description:       'Spectra routing analysis fee — 0.1 CSPR',
      mimeType:          'application/json',
      payTo:             AGENT_WALLET,
      maxTimeoutSeconds: 60,
      asset: {
        type:     'native',
        symbol:   'CSPR',
        decimals: 9,
      },
      extra: {
        name:        'Spectra Routing Guard',
        version:     '1',
        facilitator: X402_FACILITATOR,
      },
    }
  }

  // ── x402: verify with CSPR.cloud facilitator ─────────────────────────────
  // Per the x402 spec, the facilitator expects the DECODED payment payload
  // (X-PAYMENT is base64-encoded JSON), not the raw header string, under
  // {x402Version, paymentPayload, paymentRequirements} — not the informal
  // {paymentHeader, requirements} shape this used to send.
  async verifyPayment(paymentHeader, requirements) {
    try {
      const paymentPayload = decodePaymentHeader(paymentHeader)
      const res = await axios.post(
        `${X402_FACILITATOR}/verify`,
        { x402Version: 1, paymentPayload, paymentRequirements: requirements },
        { timeout: 10000 }
      )
      // Field name isn't 100% confirmed across facilitator implementations —
      // check both spellings seen in the wild.
      return res.data?.isValid === true || res.data?.valid === true
    } catch (err) {
      log(`[x402] verify error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`)
      return false
    }
  }

  // ── x402: settle onchain via facilitator ──────────────────────────────────
  async settlePayment(paymentHeader, requirements) {
    try {
      const paymentPayload = decodePaymentHeader(paymentHeader)
      const res = await axios.post(
        `${X402_FACILITATOR}/settle`,
        { x402Version: 1, paymentPayload, paymentRequirements: requirements },
        { timeout: 20000 }
      )
      return {
        success: res.data?.success === true,
        deployHash: res.data?.transaction || res.data?.deployHash || null,
      }
    } catch (err) {
      log(`[x402] settle error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`)
      return { success: false, deployHash: null }
    }
  }

  // ── Core analysis ─────────────────────────────────────────────────────────
  async analyzeRoute({ tokenIn, tokenOut, amount, senderPublicKey }) {
    const jobId = randomUUID().slice(0, 8)
    log(`[route] ${jobId} | ${tokenIn}→${tokenOut} | ${amount}`)

    let blocked = false
    let impact  = 0
    let recommendation = 'proceed'

    try {
      // 1. Price impact shield (primary MEV equivalent on Casper)
      const impactData = await mcp.call('estimate_price_impact', {
        token_in:  tokenIn,
        token_out: tokenOut,
        amount:    String(amount),
      }).catch(() => null)

      impact = extractImpact(impactData)

      // 2. Full trade analysis
      const analysis = await mcp.call('analyze_trade', {
        token_in:  tokenIn,
        token_out: tokenOut,
        amount:    String(amount),
      }).catch(() => null)

      // 3. Base quote
      const quote = await mcp.call('get_quote', {
        token_in:  tokenIn,
        token_out: tokenOut,
        amount:    String(amount),
        type:      'exact_in',
      }).catch(() => null)

      // 4. Slippage estimate
      const slippage = await mcp.call('estimate_slippage', {
        token_in:  tokenIn,
        token_out: tokenOut,
        amount:    String(amount),
      }).catch(() => null)

      // 5. Historical volatility (pair-first) → optimal swap size
      const volatility  = await this._computeVolatility(tokenIn, tokenOut)
      const optimalSize = await this._suggestOptimalSize(tokenIn, tokenOut, amount, impact)

      // 6. Decision
      if (impact >= IMPACT_BLOCK) {
        blocked = true
        recommendation = 'blocked'
      } else if (impact >= IMPACT_WARN) {
        recommendation = 'caution'
      } else {
        recommendation = analysis?.recommendation || 'proceed'
      }

      // 7. Onchain reputation update
      await this._updateReputation(jobId, !blocked, Number(ROUTING_FEE_MOTES))

      this.stats.totalJobs++
      this.stats.feesMotes += ROUTING_FEE_MOTES
      if (blocked) this.stats.routesBlocked++
      else         this.stats.routesApproved++

      const result = {
        jobId,
        tokenIn, tokenOut, amount,
        recommendation,
        blocked,
        warned:       impact >= IMPACT_WARN && !blocked,
        priceImpact:  impact,
        quote,
        slippage:     slippage || null,
        analysis:     analysis || null,
        volatility:   volatility.toFixed(2) + '%',
        optimalSize,
        agentScore:   this.stats.repScore,
        agentId:      this.agentId,
        ts:           Date.now(),
      }

      this.emit('job_complete', result)
      log(`[route] ${jobId} done | impact:${impact.toFixed(2)}% | ${recommendation}`)
      return result

    } catch (err) {
      log(`[route] ${jobId} error: ${err.message}`)
      await this._updateReputation(jobId, false, 0)
      throw err
    }
  }

  // ── Realized volatility from CSPR.trade MCP price history ────────────────
  // Prefers the actual pair being traded (get_pair_price_history); falls
  // back to single-token history if the pair isn't available.
  async _computeVolatility(tokenIn, tokenOut) {
    try {
      let candles = null

      const pairHistory = await mcp.call('get_pair_price_history', {
        token_a:  tokenIn,
        token_b:  tokenOut,
        interval: '1h',
        limit:    VOLATILITY_HOURS,
      }).catch(() => null)

      candles = Array.isArray(pairHistory) ? pairHistory : (pairHistory?.candles || null)

      if (!candles || candles.length < 2) {
        const tokenHistory = await mcp.call('get_token_price_history', {
          token:    tokenIn,
          interval: '1h',
          limit:    VOLATILITY_HOURS,
        }).catch(() => null)
        candles = Array.isArray(tokenHistory) ? tokenHistory : (tokenHistory?.candles || [])
      }

      const closes = candles
        .map(c => parseFloat(c.close || c.c || 0))
        .filter(v => v > 0)

      if (closes.length < 2) return 0

      const logReturns = []
      for (let i = 1; i < closes.length; i++)
        logReturns.push(Math.log(closes[i] / closes[i - 1]))

      const mean     = logReturns.reduce((s, v) => s + v, 0) / logReturns.length
      const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / logReturns.length
      return Math.sqrt(variance * 24) * 100  // daily vol %
    } catch { return 0 }
  }

  // ── Suggest reduced swap size if impact too high ──────────────────────────
  // Bounded bisection against estimate_price_impact: finds the largest
  // amount (within OPTIMAL_SIZE_ITERATIONS calls) whose impact stays
  // under IMPACT_WARN. Falls back to the requested amount untouched
  // when it's already under the warn threshold.
  async _suggestOptimalSize(tokenIn, tokenOut, requestedAmount, currentImpact) {
    if (currentImpact < IMPACT_WARN) return requestedAmount

    let lo = 0
    let hi = requestedAmount
    let best = requestedAmount * 0.1 // conservative floor if every probe fails

    for (let i = 0; i < OPTIMAL_SIZE_ITERATIONS; i++) {
      const mid = (lo + hi) / 2
      const data = await mcp.call('estimate_price_impact', {
        token_in:  tokenIn,
        token_out: tokenOut,
        amount:    String(mid),
      }).catch(() => null)

      if (data === null) break // MCP unreachable — stop probing, return best-so-far

      const midImpact = extractImpact(data)
      if (midImpact < IMPACT_WARN) { best = mid; lo = mid }
      else                          { hi = mid }
    }

    return Math.floor(best)
  }

  // ── AgentRegistry onchain reputation update ───────────────────────────────
  async _updateReputation(jobId, success, feeEarned) {
    // Update local score always (fast EMA-style score used for immediate
    // display; the AgentRegistry contract independently tracks a raw
    // success-rate score on-chain — the two are allowed to diverge
    // slightly since one is a live local heuristic and the other is the
    // canonical, auditable record).
    const perfScore = success ? 950 : 500
    const prev = this.stats.repScore
    const jobs = this.stats.totalJobs
    this.stats.repScore = jobs === 0
      ? perfScore
      : Math.round((prev * jobs + perfScore) / (jobs + 1))

    if (!REGISTRY_HASH) {
      log(`[rep] local only — score: ${this.stats.repScore}`)
      return
    }

    // Build Casper deploy — requires casper-js-sdk. Loaded via require()
    // rather than import() because casper-js-sdk (2.x) is a CommonJS
    // package and Node's ESM interop can silently fail to resolve named
    // exports like CasperClient (surfacing as "CasperClient is not a
    // constructor") — require() sidesteps that.
    try {
      const { createRequire } = await import('module')
      const require = createRequire(import.meta.url)
      const { CasperClient, DeployUtil, RuntimeArgs, CLValueBuilder, Keys } = require('casper-js-sdk')

      const client  = new CasperClient(CSPR_NODE_RPC)
      const keyPair = Keys.Ed25519.loadKeyPairFromPrivateFile(
        process.env.AGENT_PRIVATE_KEY_PATH
      )

      const args = RuntimeArgs.fromMap({
        agent_id:         CLValueBuilder.string(this.agentId),
        success:          CLValueBuilder.bool(success),
        fee_earned_motes: CLValueBuilder.u512(feeEarned),
      })

      const networkName = process.env.CASPER_NETWORK_NAME || 'casper-test'
      const deploy = DeployUtil.makeDeploy(
        new DeployUtil.DeployHeader(
          keyPair.publicKey,
          Date.now(),
          1_800_000,
          10,
          [],
          networkName
        ),
        DeployUtil.ExecutableDeployItem.newStoredContractByHash(
          Uint8Array.from(Buffer.from(REGISTRY_HASH, 'hex')),
          'update_reputation',
          args
        ),
        DeployUtil.standardPayment(3_000_000_000n)
      )

      const signed    = client.signDeploy(deploy, keyPair)
      const deployHash = await client.putDeploy(signed)
      log(`[rep] onchain tx: ${deployHash} | score: ${this.stats.repScore}`)

    } catch (err) {
      log(`[rep] onchain failed (${err.message.slice(0, 60)}) — local only`)
    }
  }

  getStatus() {
    return {
      agentId:        this.agentId,
      wallet:         AGENT_WALLET || 'not set',
      repScore:       this.stats.repScore,
      totalJobs:      this.stats.totalJobs,
      requestsPaid:   this.stats.requestsPaid,
      routesBlocked:  this.stats.routesBlocked,
      routesApproved: this.stats.routesApproved,
      feesEarned:     (Number(this.stats.feesMotes) / 1e9).toFixed(4) + ' CSPR',
      blockRate:      this.stats.totalJobs > 0
        ? ((this.stats.routesBlocked / this.stats.totalJobs) * 100).toFixed(1) + '%'
        : '0%',
      // sent so the dashboard's shield gauge always reflects the agent's
      // actual configured thresholds, not hardcoded guesses
      impactWarn:     IMPACT_WARN,
      impactBlock:    IMPACT_BLOCK,
      routingFeeCspr: (Number(ROUTING_FEE_MOTES) / 1e9).toFixed(4),
    }
  }
}

// ── Express + WebSocket server ────────────────────────────────────────────────
const agent  = new RoutingGuardAgent()
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })

app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PAYMENT, X-PAYMENT-REQUEST-ID')
  next()
})

// Broadcast to dashboard
function broadcast(msg) {
  const data = JSON.stringify(msg)
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data) })
}
agent.on('job_complete', (data) => broadcast({ type: 'job', ...data }))
setInterval(() => broadcast({ type: 'status', ...agent.getStatus(), ts: Date.now() }), 2000)

// send an immediate status snapshot to newly-connected dashboards
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'status', ...agent.getStatus(), ts: Date.now() }))
})

// ── x402 middleware ───────────────────────────────────────────────────────────
// Pending challenges are kept in memory, keyed by requestId, so that the
// PaymentRequirements the client pays against are byte-for-byte identical
// to the ones checked at verify/settle time.
const pendingRequirements = new Map() // requestId -> { requirements, expiresAt }

function cleanupExpiredRequirements() {
  const now = Date.now()
  for (const [id, entry] of pendingRequirements) {
    if (entry.expiresAt < now) pendingRequirements.delete(id)
  }
}

async function x402Gate(req, res, next) {
  agent.stats.requestsReceived++
  cleanupExpiredRequirements()

  const paymentHeader = req.headers['x-payment']
  const requestId      = req.headers['x-payment-request-id']

  if (!paymentHeader) {
    const newId = randomUUID()
    const requirements = agent.buildPaymentRequirements(newId)
    pendingRequirements.set(newId, {
      requirements,
      expiresAt: Date.now() + PAYMENT_REQUIREMENT_TTL_MS,
    })
    return res.status(402).json({
      error: 'Payment Required',
      x402Version: 1,
      requestId: newId,
      accepts: [requirements],
    })
  }

  const pending = requestId && pendingRequirements.get(requestId)
  if (!pending) {
    return res.status(400).json({
      error: 'Missing or expired X-PAYMENT-REQUEST-ID — request a fresh 402 challenge',
    })
  }

  const { requirements } = pending
  const valid = await agent.verifyPayment(paymentHeader, requirements)
  if (!valid) return res.status(402).json({ error: 'Invalid payment', x402Version: 1 })

  const settlement = await agent.settlePayment(paymentHeader, requirements)
  if (!settlement.success) return res.status(402).json({ error: 'Settlement failed', x402Version: 1 })

  pendingRequirements.delete(requestId)
  agent.stats.requestsPaid++
  req.deployHash = settlement.deployHash
  next()
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/route', x402Gate, async (req, res) => {
  const { token_in, token_out, amount, sender_public_key } = req.body
  if (!token_in || !token_out || !amount)
    return res.status(400).json({ error: 'token_in, token_out, amount required' })

  try {
    const result = await agent.analyzeRoute({
      tokenIn: token_in, tokenOut: token_out,
      amount: parseFloat(amount), senderPublicKey: sender_public_key,
    })
    if (req.deployHash)
      res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ success: true, deployHash: req.deployHash, network: 'casper:testnet' }))
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/status',  (req, res) => res.json(agent.getStatus()))
app.get('/health',      (req, res) => res.json({ ok: true }))
app.get('/pay.mjs', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  try {
    res.send(readFileSync(join(__dirname, '../dashboard/pay.mjs'), 'utf-8'))
  } catch {
    res.status(404).send('// pay.mjs not found')
  }
})

// ── Demo-only route (bypasses x402) ───────────────────────────────────────────
// For recording a walkthrough without wiring up a live wallet-signing flow.
// Shows the exact same analysis pipeline and dashboard updates as /route —
// just skips the payment gate. NOT mounted unless DEMO_MODE=true, and never
// intended for production use (anyone could call it for free).
if (process.env.DEMO_MODE === 'true') {
  log('⚠ DEMO_MODE=true — /demo/route is live and bypasses x402. Do not deploy this way.')
  app.post('/demo/route', async (req, res) => {
    const { token_in, token_out, amount } = req.body
    if (!token_in || !token_out || !amount)
      return res.status(400).json({ error: 'token_in, token_out, amount required' })
    try {
      const result = await agent.analyzeRoute({
        tokenIn: token_in, tokenOut: token_out, amount: parseFloat(amount),
      })
      res.json({ ...result, note: 'DEMO_MODE — x402 payment was skipped for this call' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
}

// Serve dashboard
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
app.get('/', (req, res) => {
  try {
    res.send(readFileSync(join(__dirname, '../dashboard/index.html'), 'utf-8'))
  } catch { res.send('Dashboard not found — run npm run dashboard') }
})

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`Spectra RoutingGuardAgent on :${PORT}`)
  log(`  POST /route      — x402-gated routing analysis`)
  log(`  GET  /api/status — agent status`)
  log(`  x402 Facilitator: ${X402_FACILITATOR}`)
  log(`  CSPR.trade MCP:   ${MCP_URL}`)
  log(`  Casper testnet:   ${CSPR_NODE_RPC}`)
})

export { agent }

function log(msg) {
  process.stdout.write(`[RoutingGuard ${new Date().toISOString().slice(11,23)}] ${msg}\n`)
}