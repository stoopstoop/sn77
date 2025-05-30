import { Contract, Wallet, JsonRpcProvider, ethers } from 'ethers';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Keyring } from '@polkadot/keyring';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
dotenv.config({ path: path.resolve(process.cwd(), process.env.HARDHAT_NETWORK === 'bittensorLocal' ? '.env.local' : '.env'), override: true });

const {
  ETH_PRIVKEY,
  BT_PRIVKEY,
  CLAIM_VOTE_CONTRACT_ADDRESS,
  RPC_URL = 'http://127.0.0.1:9944/',
} = process.env;

type CliArgs = { votes?: string; 'rpc-url': string };
const argv = yargs(hideBin(process.argv))
  .option('votes', {
    alias: 'v',
    type: 'string',
    description: 'Vote message string poolId,weight;...',
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

// ---- Helpers ----

const prompt = (question: string): Promise<string> => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); res(answer.trim()); });
});

/** Validate the votes string format and pool addresses. */
const validateVotes = async (
  votes: string,
  provider: JsonRpcProvider,
): Promise<Error | null> => {
  const parts = votes.split(';').filter(Boolean);
  if (parts.length === 0) return new Error('empty vote string');

  let weightSum = 0;
  const seen = new Set<string>();
  const invalidPools: string[] = [];

  for (const p of parts) {
    const [addr, weightStr] = p.split(',');
    if (!addr || !weightStr) return new Error(`segment "${p}" is not formatted as poolId,weight`);

    if (!ethers.isAddress(addr)) return new Error(`"${addr}" is not a valid address`);

    const lcAddr = addr.toLowerCase();
    if (seen.has(lcAddr)) return new Error(`duplicate pool address ${addr}`);
    seen.add(lcAddr);

    const weight = Number(weightStr);
    if (!Number.isFinite(weight) || weight < 0) return new Error(`invalid weight "${weightStr}" for ${addr}`);
    weightSum += weight;

    // Verify the address has code on chain (i.e., is a contract)
    try {
      const code = await provider.getCode(addr);
      if (code === '0x') invalidPools.push(addr);
    } catch (err) {
      return new Error(`failed to fetch code for ${addr}: ${(err as Error).message}`);
    }
  }

  if (invalidPools.length) return new Error(`the following addresses have no contract code: ${invalidPools.join(', ')}`);
  if (weightSum !== 10000) return new Error(`weights must sum to 10000, got ${weightSum}`);

  return null;
};

async function main(): Promise<[void, Error | null]> {
  if (!ETH_PRIVKEY) return [undefined, new Error('ETH_PRIVKEY not found. Please add your EVM private key to .env file')];
  if (!BT_PRIVKEY) return [undefined, new Error('BT_PRIVKEY not found. Please add your Bittensor private key to .env file')];
  if (!CLAIM_VOTE_CONTRACT_ADDRESS) return [undefined, new Error('CLAIM_VOTE_CONTRACT_ADDRESS not found. Please add the ClaimVote contract address to .env file')];

  const rpc_url = process.env.RPC_URL;
  const provider = new JsonRpcProvider(rpc_url);
  const eth_provider = new JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`);

  // --- Obtain a valid votes string (prompt if missing/invalid) ---
  let votes = argv.votes;
  while (true) {
    if (!votes) votes = await prompt('enter votes (poolId,weight;poolId,weight;...): ');
    const err = await validateVotes(votes, eth_provider);
    if (!err) break;
    console.error(`invalid votes: ${err.message}`);
    votes = undefined; // prompt again
  }

  // From here votes is guaranteed to be valid
  argv.votes = votes;

  const evmWallet = new Wallet(ETH_PRIVKEY, provider);
  console.log(`evm address: ${await evmWallet.getAddress()}`);

  const claimVoteAbi = loadAbi('ClaimVote');
  const claimVote = new Contract(CLAIM_VOTE_CONTRACT_ADDRESS, claimVoteAbi, evmWallet);

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