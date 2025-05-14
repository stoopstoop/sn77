import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { blake2AsU8a, encodeAddress } from '@polkadot/util-crypto';
import { hexToU8a, stringToU8a } from '@polkadot/util';

// Define command-line arguments
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
  .parseSync();

/**
 * Prompts the user with a question and returns their answer.
 * @param {string} question - The question to ask the user.
 * @returns {Promise<string>} A promise that resolves with the user's answer.
 */
async function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  // Load current environment variables
  dotenv.config();

  // Check if PRIVATE_KEY already exists in .env
  const existingKey = process.env.PRIVATE_KEY;

  if (existingKey) {
    console.warn("WARNING: A private key already exists in your .env file.");
    const answer = await promptUser("Do you want to overwrite it? (y/n): ");

    if (answer.toLowerCase() !== 'y') {
      console.log("Operation cancelled. Your existing key was not modified.");
      return;
    }
  }

  // Generate or load wallet based on arguments
  let wallet;
  let derivedMnemonic = null;

  try {
    if (argv['private-key']) {
      console.log("Loading wallet from provided private key...");
      wallet = new ethers.Wallet(argv['private-key']);
    } else if (argv.mnemonic) {
      console.log("Loading wallet from provided mnemonic...");
      wallet = ethers.Wallet.fromPhrase(argv.mnemonic);
      derivedMnemonic = argv.mnemonic;
    } else {
      console.log("Generating new random wallet...");
      wallet = ethers.Wallet.createRandom();
      // Check if the created wallet object has a mnemonic property (HD wallets do)
      if (wallet.mnemonic && wallet.mnemonic.phrase) {
          derivedMnemonic = wallet.mnemonic.phrase;
      }
    }
  } catch (error) {
    console.error("Error creating/loading wallet:", error.message);
    process.exit(1);
  }

  const privateKey = wallet.privateKey;
  const address = wallet.address;

  // Derive SS58 address using Frontier HashedAddressMapping logic
  let ss58Address = '';
  try {
    const prefixBytes = stringToU8a("evm:");
    // Ensure address has 0x prefix for hexToU8a
    const addressBytes = hexToU8a(address.startsWith("0x") ? address : `0x${address}`);
    const combined = new Uint8Array(prefixBytes.length + addressBytes.length);

    combined.set(prefixBytes);
    combined.set(addressBytes, prefixBytes.length);

    // Hash the combined bytes to get the Substrate AccountId (public key)
    const substrateAccountIdBytes = blake2AsU8a(combined);

    // console.log(substrateAccountIdBytes); // Developer comment: Consider removing this log in production

    // Encode the AccountId into SS58 format (using prefix 42 for Bittensor)
    ss58Address = encodeAddress(substrateAccountIdBytes, 42);

  } catch (error) {
    console.error(`Error deriving SS58 address for ${address}:`, error.message);
    // Decide if this should be fatal or just a warning
    // For now, let's continue but log the error
  }

  console.log(`Wallet EVM Address: ${address}`);
  if (ss58Address) {
      console.log(`Corresponding SS58 Address: ${ss58Address}`);
  }

  // Ensure .keys directory exists
  const keysDir = path.join(process.cwd(), '.keys');
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  // Save full key details to .keys/key-{address}.json
  const keyData = {
    address: address,
    privateKey: privateKey,
    mnemonic: derivedMnemonic,
    ss58Address: ss58Address || null // Save derived SS58 address or null if derivation failed
  };

  const keyFilePath = path.join(keysDir, `key-${address}.json`);
  fs.writeFileSync(keyFilePath, JSON.stringify(keyData, null, 2));
  console.log(`Full key details saved to: ${keyFilePath}`);

  // Update or create .env file with the private key and address
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';

  // Developer comment: Consider using a more robust .env file management library
  // like 'dotenv-expand' or custom parsing to handle comments and formatting better.
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');

    // Replace existing PRIVATE_KEY or add new one
    if (envContent.includes('PRIVATE_KEY=')) {
      envContent = envContent.replace(/PRIVATE_KEY=.*(\r?\n|$)/g, `PRIVATE_KEY=${privateKey}$1`);
    } else {
      envContent += `\nPRIVATE_KEY=${privateKey}\n`;
    }

    // Replace existing ADDRESS or add new one
    if (envContent.includes('ADDRESS=')) {
      envContent = envContent.replace(/ADDRESS=.*(\r?\n|$)/g, `ADDRESS=${address}$1`);
    } else {
      envContent += `ADDRESS=${address}\n`;
    }

    // Replace existing SS58_ADDRESS or add new one
    if (ss58Address) { // Only add/update if derivation was successful
        if (envContent.includes('SS58_ADDRESS=')) {
            envContent = envContent.replace(/SS58_ADDRESS=.*(\r?\n|$)/g, `SS58_ADDRESS=${ss58Address}$1`);
        } else {
            envContent += `SS58_ADDRESS=${ss58Address}\n`;
        }
    }
  } else {
    // Developer comment: Ensure consistent newline handling if the file is created.
    // Adding SS58_ADDRESS here as well if it exists.
    envContent = `PRIVATE_KEY=${privateKey}\nADDRESS=${address}\n`;
    if (ss58Address) {
        envContent += `SS58_ADDRESS=${ss58Address}\n`;
    }
  }

  fs.writeFileSync(envPath, envContent.trim() + '\n'); // Trim potential leading/trailing whitespace and ensure trailing newline
  console.log(`Private key, address, and SS58 address (if available) saved to .env file`);
  console.log(`Your new wallet address: ${address}`);
  if (derivedMnemonic) {
      console.log(`Your mnemonic phrase: ${derivedMnemonic}`);
  }
  console.log(`IMPORTANT: Keep your private key and mnemonic secure! Do not share them.`);
}

main().catch((error) => {
  console.error("Error creating key:", error);
  process.exit(1);
});
