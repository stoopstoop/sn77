import { Keyring } from '@polkadot/keyring'
import { hexToU8a, isHex } from '@polkadot/util'
import { cryptoWaitReady } from '@polkadot/util-crypto'

type Result = [string | null, Error | null]

const convert = async (hex: string): Promise<Result> => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!isHex(`0x${clean}`) || (clean.length !== 64 && clean.length !== 128)) return [null, new Error('invalid hex private key')] // 32 or 64 bytes
  try {
    await cryptoWaitReady()
    const seed = hexToU8a(`0x${clean.slice(0, 64)}`) // ed25519 seed = first 32 bytes
    const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 })
    const pair = keyring.addFromSeed(seed)
    return [pair.address, null]
  } catch (e: any) {
    return [null, e]
  }
}

const main = async () => {
  const hex = process.argv[2]
  if (!hex) {
    console.error('usage: bunx tsx scripts/check-priv-key.ts <hexPrivateKey>')
    process.exit(1)
  }
  const [addr, err] = await convert(hex)
  if (err) {
    console.error(err.message)
    process.exit(1)
  }
  console.log(addr)
}

main() 