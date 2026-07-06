import { createRequire } from 'module'
import { mkdirSync, writeFileSync, existsSync } from 'fs'

const require = createRequire(import.meta.url)
const { Keys } = require('casper-js-sdk')

const OUT_DIR = './keys'

function main() {
  const keyPair = Keys.Ed25519.new()
  const publicKeyHex = keyPair.publicKey.toHex()

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  writeFileSync(`${OUT_DIR}/public_key.pem`, keyPair.exportPublicKeyInPem())
  writeFileSync(`${OUT_DIR}/secret_key.pem`, keyPair.exportPrivateKeyInPem())
  writeFileSync(`${OUT_DIR}/public_key_hex`, publicKeyHex)

  console.log('Public key (hex):')
  console.log(`  ${publicKeyHex}`)
  console.log('')
  console.log('1. Fund at https://testnet.cspr.live -> Faucet (paste the hex above)')
  console.log('2. Set AGENT_WALLET_PUBLIC_KEY to that hex in agent/.env')
  console.log('3. Copy this keys/ folder into agent/ (or point AGENT_PRIVATE_KEY_PATH here)')
}

main()
//01DFD43349Cc7E21835DDcc605a904b11Dc6Fa2dfe1292F126eE670DE9f6a623D3