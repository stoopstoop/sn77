/**
 * Retrieve the ss58 address from a public key
 */

type Result = [string | null, Error | null]

import { encodeAddress } from '@polkadot/util-crypto'
import { hexToU8a, isHex } from '@polkadot/util'

const convert = (hex: string): Result => {
  if (!isHex(hex) || hex.length !== 66) return [null, new Error('invalid hex public key')] // 0x + 64 chars
  try {
    const pubKey = hexToU8a(hex)
    const ss58 = encodeAddress(pubKey, 42)
    return [ss58, null]
  } catch (e: any) {
    return [null, e]
  }
}

const main = () => {
  const hex = process.argv[2]
  if (!hex) {
    console.error('usage: bunx tsx scripts/check-key.ts <hexPublicKey>')
    process.exit(1)
  }
  const [addr, err] = convert(hex)
  if (err) {
    console.error(err.message)
    process.exit(1)
  }
  console.log(addr)
}

main()