// Registers an agent with the AgentRegistry contract, optionally posting
// a CSPR stake pulled from the caller's own main purse.
//
// Usage:
//   AGENT_REGISTRY_HASH=<hex hash, no "hash-" prefix> \
//   AGENT_ID=spectra-routing-guard-v1 \
//   STAKE_MOTES=0 \
//   node register-agent.mjs

import {
  loadSdk, loadKeyPair, getMainPurse, waitForDeploy, CSPR_NODE_RPC, NETWORK_NAME,
} from './common.mjs'

const REGISTRY_HASH = process.env.AGENT_REGISTRY_HASH
const AGENT_ID       = process.env.AGENT_ID || 'spectra-routing-guard-v1'
const STAKE_MOTES    = BigInt(process.env.STAKE_MOTES || '0')
const PAYMENT_AMOUNT = BigInt(process.env.PAYMENT_MOTES || '3000000000') // 3 CSPR gas

async function main() {
  if (!REGISTRY_HASH) throw new Error('Set AGENT_REGISTRY_HASH first (see install.mjs output)')

  const { CasperClient, DeployUtil, RuntimeArgs, CLValueBuilder } = await loadSdk()
  const client = new CasperClient(CSPR_NODE_RPC)
  const keyPair = await loadKeyPair()

  const args = { agent_id: CLValueBuilder.string(AGENT_ID), stake_motes: CLValueBuilder.u512(STAKE_MOTES) }

  if (STAKE_MOTES > 0n) {
    const mainPurse = await getMainPurse(client, keyPair.publicKey)
    args.source_purse = CLValueBuilder.uref(mainPurse.data ?? mainPurse, mainPurse.accessRights ?? 7)
  }

  const deploy = DeployUtil.makeDeploy(
    new DeployUtil.DeployHeader(keyPair.publicKey, Date.now(), 1_800_000, 10, [], NETWORK_NAME),
    DeployUtil.ExecutableDeployItem.newStoredContractByHash(
      Uint8Array.from(Buffer.from(REGISTRY_HASH, 'hex')),
      'register_agent',
      RuntimeArgs.fromMap(args)
    ),
    DeployUtil.standardPayment(PAYMENT_AMOUNT)
  )

  const signed = client.signDeploy(deploy, keyPair)
  const deployHash = await client.putDeploy(signed)
  console.log(`register_agent deploy sent: ${deployHash}`)

  const result = await waitForDeploy(client, deployHash)
  console.log('Registered. Execution result:')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('register_agent failed:', err)
  process.exit(1)
})
