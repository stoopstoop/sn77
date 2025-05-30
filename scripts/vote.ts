import { Contract, Wallet, JsonRpcProvider, ethers } from 'ethers';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Keyring } from '@polkadot/keyring';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.tao'), override: true });

const {
  ETH_PRIVKEY,
  BT_PRIVKEY,
  CLAIM_VOTE_ADDRESS,
  RPC_URL = 'http://127.0.0.1:9944/',
} = process.env;

type CliArgs = { votes: string; 'rpc-url': string };
const argv = yargs(hideBin(process.argv))
  .option('votes', {
    alias: 'v',
    type: 'string',
    description: 'Vote message string poolId,weight;...',
    demandOption: true,
  })
  .option('rpc-url', {
    type: 'string',
    description: 'RPC URL',
    default: RPC_URL,
  })
  .help()
  .alias('help', 'h')
  .parseSync() as unknown as CliArgs;

const loadAbi = (contract: string): any => {
  const abiPath = path.resolve(process.cwd(), `artifacts/contracts/${contract}.sol/${contract}.json`);
  if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contract} at ${abiPath}`);
  return JSON.parse(fs.readFileSync(abiPath, 'utf8')).abi;
};

async function main(): Promise<[void, Error | null]> {
  if (!ETH_PRIVKEY) return [undefined, new Error('ETH_PRIVKEY missing')];
  if (!BT_PRIVKEY) return [undefined, new Error('BT_PRIVKEY missing')];
  if (!CLAIM_VOTE_ADDRESS) return [undefined, new Error('CLAIM_VOTE_ADDRESS missing')];

  console.log(`rpc: ${argv['rpc-url']}`);

  const provider = new JsonRpcProvider(argv['rpc-url']);
  const evmWallet = new Wallet(ETH_PRIVKEY, provider);
  console.log(`evm address: ${await evmWallet.getAddress()}`);

  const claimVoteAbi = loadAbi('ClaimVote');
  const claimVote = new Contract(CLAIM_VOTE_ADDRESS, claimVoteAbi, evmWallet);

  const keyring = new Keyring({ type: 'ed25519' });
  const btPair = keyring.addFromUri(BT_PRIVKEY);
  const btPubHex = u8aToHex(btPair.publicKey);

  const msgBytes = stringToU8a(argv.votes);
  const sigHex = u8aToHex(btPair.sign(msgBytes));

  console.log('sending vote...');
  try {
    const tx = await claimVote.updatePositions(argv.votes, sigHex, btPubHex);
    console.log(`tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt?.status === 1) console.log('vote submitted');
    else return [undefined, new Error('tx reverted')];
  } catch (err) {
    return [undefined, err as Error];
  }
  return [undefined, null];
}

(async () => {
  const [, err] = await main();
  if (err) {
    console.error('error:', err.message);
    process.exit(1);
  }
})(); 