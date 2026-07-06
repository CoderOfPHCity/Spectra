// Reads an AgentRecord straight from the `agents` dictionary — a plain
// state query, no deploy or gas required. 
//
// Usage:
//   AGENT_REGISTRY_HASH=<hex hash> AGENT_ID=spectra-routing-guard-v1 node get-agent.mjs
//

import { loadSdk, CSPR_NODE_RPC } from './common.mjs'

const REGISTRY_HASH = process.env.AGENT_REGISTRY_HASH
const AGENT_ID       = process.env.AGENT_ID || 'spectra-routing-guard-v1'

async function main() {
  if (!REGISTRY_HASH) throw new Error('Set AGENT_REGISTRY_HASH first')

  const { CasperClient } = await loadSdk()
  const client = new CasperClient(CSPR_NODE_RPC)

  const stateRootHash = await client.nodeClient.getStateRootHash()

  const result = await client.nodeClient.getDictionaryItemByName(
    stateRootHash,
    REGISTRY_HASH,
    'agents',
    AGENT_ID
  )

  console.log(`AgentRecord for "${AGENT_ID}":`)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('get-agent failed:', err)
  process.exit(1)
})
