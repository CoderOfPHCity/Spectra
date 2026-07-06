// Installs (deploys) the AgentRegistry contract to Casper testnet.
//
// Usage:
//   DEPLOYER_PRIVATE_KEY_PATH=./keys/secret_key.pem node install.mjs
//
// Prerequisites:
//   1. Build the contract:  ../../scripts/build-contract.sh
//      (produces ../agent-registry.wasm)
//   2. Fund the deployer account on testnet (https://testnet.cspr.live
//      faucet) with enough CSPR to cover the ~150 CSPR payment amount
//      typically required to install a contract of this size — adjust
//      PAYMENT_AMOUNT below once you know your actual gas cost.

import { loadSdk, loadKeyPair, readWasm, waitForDeploy, CSPR_NODE_RPC, NETWORK_NAME } from './common.mjs'
import pkg from 'casper-js-sdk'
const { CasperClient, DeployUtil, RuntimeArgs, CLValueBuilder, Keys } = pkg
const PAYMENT_AMOUNT = BigInt(process.env.INSTALL_PAYMENT_MOTES || '150000000000') // 150 CSPR

async function main() {
  const { CasperClient, DeployUtil } = await loadSdk()
  const client = new CasperClient(CSPR_NODE_RPC)
  const keyPair = await loadKeyPair()

  const wasm = readWasm('../agent-registry.wasm')

  const deploy = DeployUtil.makeDeploy(
    new DeployUtil.DeployHeader(keyPair.publicKey, Date.now(), 1_800_000, 10, [], NETWORK_NAME),
    DeployUtil.ExecutableDeployItem.newModuleBytes(wasm, DeployUtil.RuntimeArgs.fromMap({})),
    DeployUtil.standardPayment(PAYMENT_AMOUNT)
  )

  const signed = client.signDeploy(deploy, keyPair)
  const deployHash = await client.putDeploy(signed)

  console.log(`Install deploy sent: ${deployHash}`)
  console.log('Waiting for finalization...')

  const result = await waitForDeploy(client, deployHash)
  console.log('Installed. Execution result:')
  console.log(JSON.stringify(result, null, 2))
  console.log('\nLook for a named key like "agent_registry_package_hash" on the')
  console.log('deployer account (via CSPR.live or `casper-client get-account-info`)')
  console.log('to find the contract package hash, then set AGENT_REGISTRY_HASH in')
  console.log('agent/.env to the specific contract-hash version, e.g.:')
  console.log('  casper-client get-account-info --node-address ' + CSPR_NODE_RPC + ' ...')
}

main().catch((err) => {
  console.error('Install failed:', err)
  process.exit(1)
})
