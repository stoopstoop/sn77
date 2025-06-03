import { Contract, Wallet, JsonRpcProvider, ethers } from 'ethers';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { encodeAddress, Keyring } from '@polkadot/keyring';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { keccak256, toUtf8Bytes } from "ethers";
dotenv.config({ path: path.resolve(process.cwd(), process.env.HARDHAT_NETWORK === 'bittensorLocal' ? '.env.local' : '.env'), override: true });

const {
  ETH_SIGN_KEY,
  MINER_COLD_PRIVKEY,
  SEVENTY_SEVEN_V1_CONTRACT_ADDRESS,
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
  // removed strict 10000 sum requirement; normalization handled later

  return null;
};

// ---- Vote utilities ----

type VoteItem = { addr: string; weight: number };

const parseVoteString = (votes: string): VoteItem[] =>
  votes
    .split(';')
    .filter(Boolean)
    .map(p => {
      const [addr, weight] = p.split(',');
      return { addr: addr.toLowerCase(), weight: Number(weight) };
    });

const votesToString = (items: VoteItem[]): string =>
  items.map(({ addr, weight }) => `${addr},${weight}`).join(';');

const normalizeWeights = (items: VoteItem[]): VoteItem[] => {
  const sum = items.reduce((acc, { weight }) => acc + weight, 0);
  if (sum === 10000) return items;

  let running = 0;
  const normalized = items.map((it, i) => {
    if (i === items.length - 1) return { ...it, weight: 10000 - running };
    const w = Math.round((it.weight * 10000) / sum);
    running += w;
    return { ...it, weight: w };
  });
  return normalized;
};

const printVotes = (items: VoteItem[]): void =>
  console.table(items.map(({ addr, weight }) => ({ Pool: addr, Weight: weight })));

async function main(): Promise<[void, Error | null]> {
  if (!ETH_SIGN_KEY) return [undefined, new Error('ETH_SIGN_KEY not found. Please add your EVM private key to .env file')];
  if (!MINER_COLD_PRIVKEY) return [undefined, new Error('MINER_COLD_PRIVKEY not found. Please add your Bittensor private key to .env file')];
  if (!SEVENTY_SEVEN_V1_CONTRACT_ADDRESS) return [undefined, new Error('SEVENTY_SEVEN_V1_CONTRACT_ADDRESS not found. Please add the SeventySevenV1 contract address to .env file')];

  const rpc_url = process.env.RPC_URL || 'https://lite.chain.opentensor.ai';
  const provider = new JsonRpcProvider(rpc_url);
  const eth_provider = new JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`);

  // --- Obtain a valid votes string (prompt if missing/invalid) ---
  let votes = argv.votes;
  while (true) {
    if (!votes) votes = await prompt('enter votes (poolId,weight;poolId,weight;...): ');

    const err = await validateVotes(votes, eth_provider);
    if (err) {
      console.error(`invalid votes: ${err.message}`);
      votes = undefined;
      continue;
    }

    const items = parseVoteString(votes);
    const sum = items.reduce((acc, { weight }) => acc + weight, 0);

    let finalItems = items;
    if (sum !== 10000) {
      console.log(`weights sum to ${sum}, normalizing to 10000`);
      finalItems = normalizeWeights(items);
    }

    printVotes(finalItems);
    const confirm = await prompt('proceed with these weights? (y/n): ');
    if (confirm.toLowerCase().startsWith('y')) {
      votes = votesToString(finalItems);
      break;
    }
    votes = undefined; // retry input
  }

  // From here votes is finalized and validated
  argv.votes = votes;

  const evmWallet = new Wallet(ETH_SIGN_KEY, provider);
  console.log(`evm address: ${await evmWallet.getAddress()}`);

  const seventySevenV1Abi = loadAbi('SeventySevenV1');
  const seventySevenV1 = new Contract(SEVENTY_SEVEN_V1_CONTRACT_ADDRESS, seventySevenV1Abi, evmWallet);

  const keyring = new Keyring({ type: 'ed25519' });

  const toSeed = (key: string): Uint8Array | null => {
    const hex = key.startsWith('0x') ? key.slice(2) : key;
    if (!/^([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(hex)) return null;
    return Uint8Array.from(Buffer.from(hex.slice(0, 64), 'hex'));
  };

  let btPair;
  try { btPair = keyring.addFromUri(MINER_COLD_PRIVKEY); }
  catch (_err) {
    const seed = toSeed(MINER_COLD_PRIVKEY);
    if (!seed) throw _err;
    btPair = keyring.addFromSeed(seed);
  }
  const btPubHex = u8aToHex(btPair.publicKey);

  

  const msg = votes;
  const hash = keccak256(toUtf8Bytes(msg));
  const sig = u8aToHex(btPair.sign(Uint8Array.from(Buffer.from(hash.slice(2), "hex"))));

  try {
    const tx = await seventySevenV1.updatePositions(msg, sig, btPubHex, { gasLimit: 300000 });
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