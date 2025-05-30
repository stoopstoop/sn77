import fs from 'fs';
import path from 'path';
import { Wallet, ethers } from 'ethers';
import readline from 'readline';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { blake2AsU8a, encodeAddress } from '@polkadot/util-crypto';
import { hexToU8a, stringToU8a } from '@polkadot/util';

type CliArgs = {
  'private-key'?: string;
  mnemonic?: string;
};

const argv = yargs(hideBin(process.argv))
  .option('private-key', {
    alias: 'p',
    type: 'string',
    description: 'Provide an existing private key',
    conflicts: 'mnemonic',
  })
  .option('mnemonic', {
    alias: 'm',
    type: 'string',
    description: 'Provide an existing mnemonic phrase',
    conflicts: 'private-key',
  })
  .help()
  .alias('help', 'h')
  .parseSync() as unknown as CliArgs;

const prompt = (q: string): Promise<string> =>
  new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, a => {
      rl.close();
      resolve(a);
    });
  });

dotenv.config();

async function main(): Promise<[void, Error | null]> {
  const existing = process.env.PRIVATE_KEY;
  if (existing) {
    const yn = (await prompt('A private key already exists in .env, overwrite? (y/n): ')).toLowerCase();
    if (yn !== 'y') return [undefined, null];
  }

  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  let mnemonic: string | null = null;

  try {
    if (argv['private-key']) {
      wallet = new Wallet(argv['private-key']);
    } else if (argv.mnemonic) {
      wallet = Wallet.fromPhrase(argv.mnemonic);
      mnemonic = argv.mnemonic;
    } else {
      wallet = Wallet.createRandom();
      mnemonic = wallet.mnemonic?.phrase ?? null;
    }
  } catch (err) {
    return [undefined, err as Error];
  }

  const privateKey = wallet.privateKey;
  const address = wallet.address;

  let ss58Address = '';
  try {
    const prefix = stringToU8a('evm:');
    const addrBytes = hexToU8a(address);
    const combined = new Uint8Array(prefix.length + addrBytes.length);
    combined.set(prefix);
    combined.set(addrBytes, prefix.length);
    const substrateId = blake2AsU8a(combined);
    ss58Address = encodeAddress(substrateId, 42);
  } catch {}

  console.log(`wallet address: ${address}`);
  if (ss58Address) console.log(`ss58 address: ${ss58Address}`);

  const keysDir = path.join(process.cwd(), '.keys');
  fs.mkdirSync(keysDir, { recursive: true });

  const keyPath = path.join(keysDir, `key-${address}.json`);
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ address, privateKey, mnemonic, ss58Address: ss58Address || null }, null, 2)
  );
  console.log(`key saved to ${keyPath}`);

  const envPath = path.join(process.cwd(), '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const upd = (key: string, val: string | undefined): void => {
    if (!val) return;
    const regex = new RegExp(`${key}=.*(?:\r?\n|$)`, 'i');
    env = regex.test(env) ? env.replace(regex, `${key}=${val}\n`) : `${env}${key}=${val}\n`;
  };
  upd('PRIVATE_KEY', privateKey);
  upd('ADDRESS', address);
  if (ss58Address) upd('SS58_ADDRESS', ss58Address);
  fs.writeFileSync(envPath, env.trim() + '\n');
  console.log('.env updated');

  if (mnemonic) console.log(`mnemonic: ${mnemonic}`);
  console.log('keep these credentials safe');
  return [undefined, null];
}

(async () => {
  const [, err] = await main();
  if (err) {
    console.error('error:', err.message);
    process.exit(1);
  }
})(); 