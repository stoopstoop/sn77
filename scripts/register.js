import hre from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import readline from 'readline';
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import dotenv from 'dotenv';

// --- Configuration & Environment Variable Loading ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.tao') });

// --- Environment Variable Validation ---
const claimVoteAddress = process.env.TAO_CLAIM_VOTE_ADDRESS;
if (!claimVoteAddress) {
    console.error("❌ Configuration Error: TAO_CLAIM_VOTE_ADDRESS not found in .env.tao configuration file.");
    console.error("   Please ensure the .env.tao file exists in the project root and contains the correct contract address.");
    process.exit(1);
}

async function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      const normalizedAnswer = answer.toLowerCase().trim();
      resolve(normalizedAnswer === 'y' || normalizedAnswer === 'yes');
    });
  });
}

// Not to be used for all logging, only logs meant for the developer
const dev = {
    log: process.env.NODE_ENV === 'development' ? console.log : () => {},
    warn: process.env.NODE_ENV === 'development' ? console.warn : () => {},
    error: process.env.NODE_ENV === 'development' ? console.error : () => {},
}

async function main() {
    console.clear();
    const btKeyInput = process.env.BT_PRIVKEY; // Read input once

    if (!btKeyInput && process.env.NODE_ENV !== 'development') {
        console.error("❌ BT_PRIVKEY environment variable is required in production/non-development environments.");
        process.exit(1);
    }

    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'ed25519' });

    let claimVoteKeypair;

    if (btKeyInput === '//Alice') {
        console.warn("⚠️  Using default '//Alice' Bittensor key. This is insecure for production.");
    }

    try {
        // Check if the input looks like a 32-byte hex seed (64 hex chars, optional 0x)
        if (/^(0x)?[0-9a-fA-F]{64}$/.test(btKeyInput)) {
            dev.log("🔑 Interpreting BT_PRIVKEY as a hex seed.");
            const seedBytes = hexToU8a(btKeyInput.startsWith('0x') ? btKeyInput : '0x' + btKeyInput);
            claimVoteKeypair = keyring.addFromSeed(seedBytes, {}, 'ed25519');
        } else {
            dev.log("🔑 Interpreting BT_PRIVKEY as a URI (mnemonic, dev path, etc.).");
            claimVoteKeypair = keyring.addFromUri(btKeyInput);
        }
    } catch (error) {
        console.error(`❌ Failed to load Bittensor key from source: ${btKeyInput}`);
        console.error(`   Error: ${error.message}`);
        console.error(`   Please ensure the BT_PRIVKEY environment variable is set correctly.`);
        console.error(`   You can either use a hex seed, mnemonic, or dev path.`);
        process.exit(1);
    }

    console.log("🚀 Starting the address registration process...");
    console.log("   This will link a miner's coldkey to an Ethereum address.");

    const [signer1] = await hre.ethers.getSigners();
    const ethAddress = signer1.address;

    // const proceed = await askConfirmation(`   You are about to register the following address: ${ethAddress}\n   Are you sure you want to proceed?`);
    const proceed = await askConfirmation(`   ${claimVoteKeypair.address} (Bittensor) - Ensure this is your coldkey\n   ${ethAddress} (Ethereum) - Where you'll deploy liquidity from.\n   Are you sure you want to proceed?`);

    if (!proceed) {
      console.log('❌ Aborting registration process as requested.');
      process.exit(0);
    }

    console.log('✅ Address confirmed. Proceeding with registration...');

    const claimVote = await hre.ethers.getContractAt("ClaimVote", claimVoteAddress);

    
    const claimVoteEd25519PublicKey = hre.ethers.hexlify(claimVoteKeypair.publicKey);

    // Generate necessary signatures
    // 1. Ethereum signature: Sign(ETH_PrivateKey, Hash(BT_PublicKey))
    const ethMessageHash = hre.ethers.keccak256(claimVoteEd25519PublicKey);
    const ethSignature = await signer1.signMessage(hre.ethers.getBytes(ethMessageHash));

    // 2. Bittensor signature: Sign(BT_PrivateKey, Hash(ETH_Address))
    const ed25519MessageHash = hre.ethers.solidityPackedKeccak256(['address'], [signer1.address]);
    const ed25519MessageHashBytes = hre.ethers.getBytes(ed25519MessageHash);
    const ed25519SignatureBytes = claimVoteKeypair.sign(ed25519MessageHashBytes);

    if (ed25519SignatureBytes.length !== 64) {
        // This indicates an internal issue with the crypto library or key generation
        console.error(`❌ Internal Error: Generated Bittensor signature has incorrect length: ${ed25519SignatureBytes.length}. Expected 64 bytes.`);
        throw new Error(`Internal error: Generated Bittensor signature has incorrect length: ${ed25519SignatureBytes.length}. Expected 64 bytes.`);
    }
    const ed25519Signature = hre.ethers.hexlify(ed25519SignatureBytes);

    console.log("\n✍️  Registering your Ethereum address with the Bittensor key...");
    console.log(`   Bittensor Public Key: ${claimVoteEd25519PublicKey}`);
    console.log(`   Ethereum Address:     ${signer1.address}`);

    let registerTxReceipt = null;
    try {
        const registerTx = await claimVote.registerAddress(
            claimVoteEd25519PublicKey,
            signer1.address,
            ethSignature,
            ed25519Signature
        );
        console.log(`⏳ Submitting registration transaction [${registerTx.hash}], please wait for confirmation...`);

        registerTxReceipt = await registerTx.wait();

        if (registerTxReceipt?.status !== 1) {
            console.error(`❌ Registration transaction failed. Transaction Hash: ${registerTxReceipt?.hash}`);
            console.error("   The transaction was included in a block but reverted.");
            throw new Error(`Registration transaction reverted. Transaction Hash: ${registerTxReceipt?.hash}`);
        }
        console.log(`✅ Registration transaction successful! Transaction Hash: ${registerTxReceipt.hash}, Block: ${registerTxReceipt.blockNumber}`);

    } catch (error) {
        console.error("❗ An error occurred during the registration transaction:", error.message);
        if (error.reason) console.error("   Revert Reason:", error.reason);
        if (error.data) console.error("   Error Data:", error.data);
        throw error;
    }

    // Verification step
    console.log("\n🔍 Verifying the registration on the contract...");
    const storedAddress = await claimVote.keyToAddress(claimVoteEd25519PublicKey);
    console.log(`   Contract reports address for key ${claimVoteEd25519PublicKey.substring(0, 10)}... is: ${storedAddress}`);

    if (storedAddress.toLowerCase() !== signer1.address.toLowerCase()) {
        console.error(`❌ Verification Failed! The address stored on the contract (${storedAddress}) does not match your Ethereum address (${signer1.address}).`);
        console.error("   This could indicate an issue with the registration process or the contract state.");
        throw new Error("Address registration verification failed after transaction confirmation.");
    }
    console.log(`✅ Verification Successful! Your Ethereum address (${signer1.address}) is correctly registered.`);

    console.log("\n🎉 Address registration process completed successfully!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n💥 Script execution failed:");
        console.error("   Error:", error.message);
        process.exit(1);
    });
