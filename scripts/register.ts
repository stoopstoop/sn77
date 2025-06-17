import { Wallet } from 'ethers';
import {
  sr25519PairFromSeed,
  sr25519Sign,
  encodeAddress,
  cryptoWaitReady,
} from '@polkadot/util-crypto';
import { u8aToHex, hexToU8a } from '@polkadot/util';
import { fetchCurrentBittensorBlock, closeBittensorConnection } from '../utils/bittensorUtils';

const PRODUCTION_URL = 'https://77.creativebuilds.io';

async function claimAddress() {
  await cryptoWaitReady();

  const privateKeyHex = process.env.MINER_HOTKEY;
  if (!privateKeyHex) {
    console.error('Error: MINER_HOTKEY environment variable is required');
    process.exit(1);
  }

  if (!privateKeyHex.startsWith('0x')) {
    console.error('Error: MINER_HOTKEY must be a hex string starting with 0x');
    process.exit(1);
  }

  const [currentBlock, blockErr] = await fetchCurrentBittensorBlock();
  if (blockErr) {
    console.error('Error: Failed to fetch current block:', blockErr);
    process.exit(1);
  }

  const ethKeyHex = process.env.ETH_KEY;
  if (!ethKeyHex) {
    console.error('Error: ETH_KEY environment variable is required');
    process.exit(1);
  }

  const ethWallet = new Wallet(ethKeyHex);
  const ethAddress = await ethWallet.getAddress();

  const seed = hexToU8a(privateKeyHex);
  const hotkeyPair = sr25519PairFromSeed(seed);
  const hotkeyAddress = encodeAddress(hotkeyPair.publicKey, 42);

  console.log('Generating claim request...');
  console.log('Hotkey Address:', hotkeyAddress);
  console.log('Ethereum Address:', ethAddress);
  console.log('Current Block:', currentBlock);

  const ethMessageToSign = `${ethAddress}|${hotkeyAddress}|${currentBlock}`;
  const ethSignature = await ethWallet.signMessage(ethMessageToSign);

  const outerMessageContent = `${ethSignature}|${ethAddress}|${hotkeyAddress}|${currentBlock}|${ethAddress}`;

  const hotkeySignatureBytes = sr25519Sign(outerMessageContent, hotkeyPair);
  const hotkeySignatureHex = u8aToHex(hotkeySignatureBytes);

  try {
    const response = await fetch(`${PRODUCTION_URL}/claimAddress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: hotkeyAddress,
        message: outerMessageContent,
        signature: hotkeySignatureHex
      })
    });

    const result = await response.json();
    console.log('\nResponse:', result);

    if (!result.success) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    console.log('\nSuccessfully claimed address!');
  } catch (error) {
    console.error('Error making request:', error);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args.length > 0) {
  console.error('Error: This script does not accept arguments');
  console.error('Usage: MINER_HOTKEY=0x... ETH_KEY=0x... bun run claimAddress');
  process.exit(1);
}

claimAddress()
  .then(async () => {
    await closeBittensorConnection();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Error:', error);
    await closeBittensorConnection();
    process.exit(1);
  }); 