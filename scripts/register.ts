import hre from 'hardhat';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ethers } = hre as any;
import path from 'path';
import readline from 'readline';
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import dotenv from 'dotenv';
import Table from 'cli-table3';

dotenv.config({ path: path.resolve(process.cwd(), process.env.HARDHAT_NETWORK === 'bittensorLocal' ? '.env.local' : '.env'), override: true });

const seventySevenV1ContractAddress = process.env.SEVENTY_SEVEN_V1_CONTRACT_ADDRESS;
if (!seventySevenV1ContractAddress) {
  console.error('SEVENTY_SEVEN_V1_CONTRACT_ADDRESS not set in .env');
  process.exit(1);
}

const ask = (q: string): Promise<boolean> =>
  new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${q} (y/n): `, a => {
      rl.close();
      const v = a.trim().toLowerCase();
      res(v === 'y' || v === 'yes');
    });
  });

const dev = {
  log: process.env.NODE_ENV === 'development' ? console.log : () => {},
  warn: process.env.NODE_ENV === 'development' ? console.warn : () => {},
  error: process.env.NODE_ENV === 'development' ? console.error : () => {},
};

async function main(): Promise<[void, Error | null]> {
  console.clear();
  const btKeyInput = process.env.MINER_COLD_PRIVKEY ?? '';
  if (!btKeyInput && process.env.NODE_ENV !== 'development') {
    return [undefined, new Error('MINER_COLD_PRIVKEY not set')];
  }

  await cryptoWaitReady();

  // derive both sr25519 (matches btcli) and ed25519 (needed for EVM precompile) from the same seed

  const srKeyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
  const srPair = srKeyring.addFromUri(btKeyInput);   // btcli address
  
  const edKeyring = new Keyring({ type: 'ed25519', ss58Format: 42 });
  const edPair = edKeyring.addFromUri(btKeyInput);   // used for signing

  let seventySevenV1Keypair = edPair; // use ed25519 for signature generation

  console.log('You are about to link the following wallets together:');

  const accounts = await ethers.getSigners();
  const sender = accounts[0];
  const signer = accounts[1];
  const btPubKeyHex = ethers.hexlify(seventySevenV1Keypair.publicKey);
  
  // Get Ethereum public key by signing a test message and recovering it
  const testMsg = 'test';
  const testSig = await signer.signMessage(testMsg);
  const ethPubKey = ethers.SigningKey.recoverPublicKey(ethers.hashMessage(testMsg), testSig);

  const truncate = (s: string, lead = 6, tail = 4): string => s.length <= lead + tail + 3 ? s : `${s.slice(0, lead)}...${s.slice(-tail)}`;

  const table = new Table({ colWidths: [22, 30], wordWrap: true });
  table.push(
    ['Miner Cold Key', 'Ethereum Address'],
    // ['Bittensor PubKey Hex', truncate(btPubKeyHex)],
    [truncate(srPair.address, 10, 4), truncate(signer.address, 10, 4)],
    // ['Ethereum PubKey', truncate(ethPubKey)]
  );
  console.log(`\n${table.toString()}\n`);

  const proceed = await ask('Proceed with registration?');
  if (!proceed) return [undefined, null];

  const seventySevenV1 = await ethers.getContractAt('SeventySevenV1', seventySevenV1ContractAddress);
  const ethMsgHash = ethers.keccak256(btPubKeyHex);
  const ethSig = await signer.signMessage(ethers.getBytes(ethMsgHash));
  const edMsgHashBytes = ethers.getBytes(ethers.solidityPackedKeccak256(['address'], [signer.address]));
  const edSig = ethers.hexlify(seventySevenV1Keypair.sign(edMsgHashBytes));

  try {
    const tx = await seventySevenV1.connect(sender).registerAddress(btPubKeyHex, signer.address, ethSig, edSig);
    console.log(`tx ${tx.hash} submitted, waiting...`);
    const receipt = await tx.wait();
    if (receipt?.status !== 1) return [undefined, new Error('transaction reverted')];
  } catch (err) {
    return [undefined, err as Error];
  }

  const stored = await seventySevenV1.connect(sender).keyToAddress(btPubKeyHex);
  if (stored.toLowerCase() !== signer.address.toLowerCase()) return [undefined, new Error('verification failed')];

  console.log('registration successful');
  return [undefined, null];
}

(async () => {
  const [, err] = await main();
  if (err) {
    console.error('error:', err.message);
    process.exit(1);
  }
})(); 