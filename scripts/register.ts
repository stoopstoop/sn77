import hre from 'hardhat';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ethers } = hre as any;
import path from 'path';
import readline from 'readline';
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { hexToU8a } from '@polkadot/util';
import dotenv from 'dotenv';

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
  const btKeyInput = process.env.BT_PRIVKEY ?? '';
  if (!btKeyInput && process.env.NODE_ENV !== 'development') {
    return [undefined, new Error('BT_PRIVKEY not set')];
  }

  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'ed25519' });

  let claimVoteKeypair;
  try {
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(btKeyInput)) {
      dev.log('interpreting BT_PRIVKEY as hex seed');
      claimVoteKeypair = keyring.addFromSeed(hexToU8a(btKeyInput.startsWith('0x') ? btKeyInput : '0x' + btKeyInput));
    } else {
      claimVoteKeypair = keyring.addFromUri(btKeyInput);
    }
  } catch (err) {
    return [undefined, err as Error];
  }

  console.log('starting registration...');

  const accounts = await ethers.getSigners();
  console.log(accounts);
  const sender = accounts[0];
  const signer = accounts[1];
  const ethAddress = signer.address;
  const btPubKeyHex = ethers.hexlify(claimVoteKeypair.publicKey);

  const proceed = await ask(`${claimVoteKeypair.address} (Bittensor SS58)\n${btPubKeyHex} (Bittensor PubKey Hex)\n${signer.address} (Ethereum)\n proceed?`);
  if (!proceed) return [undefined, null];

  const seventySevenV1 = await ethers.getContractAt('SeventySevenV1', seventySevenV1ContractAddress);
  const ethMsgHash = ethers.keccak256(btPubKeyHex);
  const ethSig = await signer.signMessage(ethers.getBytes(ethMsgHash));
  const edMsgHashBytes = ethers.getBytes(ethers.solidityPackedKeccak256(['address'], [signer.address]));
  const edSig = ethers.hexlify(claimVoteKeypair.sign(edMsgHashBytes));

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