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
}

main()
//01DFD43349Cc7E21835DDcc605a904b11Dc6Fa2dfe1292F126eE670DE9f6a623D3//rm -f ~/.cargo/.package-cache