// Shared helpers for the AgentRegistry deploy/interaction scripts.
//
import { readFileSync } from 'fs'
import dotenv from 'dotenv'
dotenv.config()

export const CSPR_NODE_RPC = process.env.CSPR_NODE_RPC || 'https://node.testnet.cspr.cloud'
export const NETWORK_NAME  = process.env.CASPER_NETWORK_NAME || 'casper-test'
export const KEY_PATH      = process.env.DEPLOYER_PRIVATE_KEY_PATH || './keys/secret_key.pem'

export async function loadSdk() {
  return import('casper-js-sdk')
}

export async function loadKeyPair() {
  const { Keys } = await loadSdk()
  return Keys.Ed25519.loadKeyPairFromPrivateFile(KEY_PATH)
}

export function readWasm(path = '../agent-registry.wasm') {
  return new Uint8Array(readFileSync(new URL(path, import.meta.url)))
}

/**
 * Looks up an account's main purse URef via the node's RPC — needed any
 * time an entry point (like register_agent) wants to pull CSPR from the
 * caller's own purse. The caller must be the one invoking the deploy,
 * since only they hold sufficient access rights on their main purse
 * URef to pass it as a usable argument.
 */
export async function getMainPurse(client, publicKey) {
  const stateRootHash = await client.nodeClient.getStateRootHash()
  const accountInfo = await client.nodeClient.getBlockState(
    stateRootHash,
    `account-hash-${publicKey.toAccountHashStr().replace('account-hash-', '')}`,
    []
  )
  return accountInfo.Account.mainPurse
}

export function waitForDeploy(client, deployHash, { timeoutMs = 120_000, pollMs = 4000 } = {}) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const [, raw] = await client.nodeClient.getDeployInfo(deployHash)
        const result = raw?.execution_results?.[0]?.result
        if (result) {
          if (result.Success) return resolve(result.Success)
          if (result.Failure) return reject(new Error(JSON.stringify(result.Failure)))
        }
      } catch { /* not finalized yet */ }
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for deploy'))
      setTimeout(poll, pollMs)
    }
    poll()
  })
}
