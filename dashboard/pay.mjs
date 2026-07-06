// Spectra — browser x402 payment client
//
// Flow: connect Casper Wallet -> POST /route (get 402 + requestId) ->
// build a TransferAuthorization (casper-eip-712's domain-separated typed
// data, the Casper-native analogue of EIP-3009's TransferWithAuthorization)
// -> sign its hash via the wallet's signMessage -> replay /route with
// X-PAYMENT + X-PAYMENT-REQUEST-ID headers.
//
// HONEST FLAG: everything through "compute the hash" is built on confirmed
// docs (casper-ecosystem/casper-eip-712's own README). The one unverified
// step is exactly how Casper Wallet's signMessage relates to that hash —
// some wallets sign a message string verbatim, others prepend a fixed
// prefix first (the same way Ethereum's personal_sign prepends
// "\x19Ethereum Signed Message:\n"). If the facilitator's /verify call
// rejects with a signature-mismatch error specifically (as opposed to a
// missing-field/shape error), this is the first thing to revisit — check
// `curl -s https://x402-facilitator.cspr.cloud/supported` for any documented
// prefix convention, or inspect what casper-wallet-sdk's own examples do
// with a signMessage result before treating it as a signature over a raw
// digest.

import { CLPublicKey } from 'https://esm.sh/casper-js-sdk@2.15.4'
import {
  TransferAuthorizationTypes,
  hashTypedData,
} from 'https://esm.sh/@casper-ecosystem/casper-eip-712'

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomNonceHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return bytesToHex(bytes)
}

function accountHashHexFromPublicKeyHex(publicKeyHex) {
  // toAccountHashStr() returns "account-hash-<hex>" — TransferAuthorization
  // wants the bare 32-byte hash, hex-encoded, no prefix.
  const full = CLPublicKey.fromHex(publicKeyHex).toAccountHashStr()
  return full.replace('account-hash-', '')
}

async function getProvider() {
  if (!window.CasperWalletProvider) {
    throw new Error('Casper Wallet extension not found — install it from casperwallet.io')
  }
  return window.CasperWalletProvider()
}

async function connectWallet() {
  const provider = await getProvider()
  await provider.requestConnection()
  const publicKeyHex = await provider.getActivePublicKey()
  return { provider, publicKeyHex }
}

/**
 * Runs the full pay-and-analyze flow.
 * @param {{tokenIn: string, tokenOut: string, amount: string|number}} params
 * @param {(status: string) => void} onStatus - called with human-readable progress
 * @returns {Promise<object>} the analysis result from /route
 */
export async function payAndAnalyze({ tokenIn, tokenOut, amount }, onStatus = () => {}) {
  onStatus('Connecting to Casper Wallet…')
  const { provider, publicKeyHex } = await connectWallet()

  onStatus('Requesting payment challenge…')
  const initialRes = await fetch('/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token_in: tokenIn, token_out: tokenOut, amount: String(amount) }),
  })

  if (initialRes.status !== 402) {
    // Already paid / demo mode / unexpected — just return whatever came back.
    return initialRes.json()
  }

  const challenge = await initialRes.json()
  const requestId = challenge.requestId
  const requirements = challenge.accepts[0]

  onStatus('Building payment authorization…')
  const fromAccountHash = accountHashHexFromPublicKeyHex(publicKeyHex)
  const toAccountHash = accountHashHexFromPublicKeyHex(requirements.payTo)

  const nowSeconds = Math.floor(Date.now() / 1000)
  const authorization = {
    from: fromAccountHash,
    to: toAccountHash,
    value: requirements.maxAmountRequired, // motes, as a decimal string
    validAfter: String(nowSeconds - 60),   // small clock-skew buffer
    validBefore: String(nowSeconds + requirements.maxTimeoutSeconds),
    nonce: randomNonceHex(),
  }

  const domain = {
    name: requirements.extra?.name || 'Spectra Routing Guard',
    version: requirements.extra?.version || '1',
    chain_name: requirements.network, // already CAIP-2 form, e.g. "casper:casper-test"
  }

  const digest = hashTypedData(domain, TransferAuthorizationTypes, 'TransferAuthorization', authorization)
  const digestHex = typeof digest === 'string' ? digest : bytesToHex(digest)

  onStatus('Waiting for signature in Casper Wallet…')
  const signResult = await provider.signMessage(digestHex, publicKeyHex)
  if (signResult.cancelled) {
    throw new Error('Payment signature was cancelled in the wallet')
  }

  const paymentPayload = {
    x402Version: 2,
    scheme: requirements.scheme,
    network: requirements.network,
    payload: {
      x402Version: 2,
      signature: signResult.signatureHex,
      authorization,
      signer: publicKeyHex,
    },
  }

  const xPaymentHeader = btoa(JSON.stringify(paymentPayload))

  onStatus('Submitting paid request…')
  const paidRes = await fetch('/route', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PAYMENT': xPaymentHeader,
      'X-PAYMENT-REQUEST-ID': requestId,
    },
    body: JSON.stringify({ token_in: tokenIn, token_out: tokenOut, amount: String(amount) }),
  })

  const result = await paidRes.json()
  if (!paidRes.ok) {
    throw new Error(result.error || `Payment failed (HTTP ${paidRes.status})`)
  }

  onStatus('Done — payment settled, analysis complete.')
  return result
}