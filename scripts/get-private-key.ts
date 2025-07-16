import { cryptoWaitReady, mnemonicToMiniSecret } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

// --- PASTE YOUR MNEMONIC PHRASE BELOW ---
const MNEMONIC = "XXXX";
// -----------------------------------------

async function getPrivateKey() {
  if (MNEMONIC.includes("mnemonic phrase goes here")) {
    console.error("\n❌ Error: Please replace the placeholder text with your actual mnemonic phrase in the script.");
    process.exit(1);
  }

  console.log("Deriving 32-byte seed from mnemonic...");

  await cryptoWaitReady();

  // Create a 32-byte seed from the mnemonic
  const miniSecret = mnemonicToMiniSecret(MNEMONIC);

  // Convert the 32-byte seed to a hex string
  const seedHex = u8aToHex(miniSecret);

  console.log("\n✅ Success! Here is your 32-byte hotkey seed:");
  console.log(seedHex);
  console.log("\nThis is a 64-character hex string.");
  console.log("Copy this value and set it as MINER_HOTKEY in your .env file.");
}

getPrivateKey().catch(console.error); 