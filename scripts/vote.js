// scripts/vote.ts
import { ethers, Contract, Wallet, JsonRpcProvider } from 'ethers';
import * as dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Keyring } from '@polkadot/keyring';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import * as path from 'path';
import * as fs from 'fs';

// --- Configuration ---

// Load environment variables from .env (for keys)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
// Load environment variables from .env.tao (for contract addresses)
dotenv.config({ path: path.resolve(process.cwd(), '.env.tao'), override: true });

const {
    ETH_PRIVKEY, // EVM private key for sending tx
    BT_PRIVKEY, // Bittensor Ed25519 private key (hex string, 0x prefix) for signing the vote message
    CLAIM_VOTE_ADDRESS,
    // Add RPC_URL to your .env or pass via --rpc-url if not using default localhost
    RPC_URL = 'http://127.0.0.1:9944/' // LOCAL BITTENSOR NODE
} = process.env;

// --- Argument Parsing ---
const argv = yargs(hideBin(process.argv))
    .option('votes', {
        alias: 'v',
        type: 'string',
        description: 'Vote message string, format: "poolId1,weight1;poolId2,weight2;..."',
        demandOption: true,
    })
    .option('rpc-url', {
        type: 'string',
        description: 'RPC URL for the network',
        default: RPC_URL,
    })
    .help()
    .alias('help', 'h')
    .parseSync();

// --- Helper Functions ---
function loadContractAbi(contractName) {
    // Adjust the path according to your Hardhat setup
    const abiPath = path.resolve(
        process.cwd(),
        `artifacts/contracts/${contractName}.sol/${contractName}.json`
    );
    if (!fs.existsSync(abiPath)) {
        throw new Error(`ABI file not found for ${contractName} at ${abiPath}. Did you compile?`);
    }
    const contractJson = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return contractJson.abi;
}


// --- Main Execution ---
async function main() {
    console.log("--- Starting Vote Script ---");

    // --- Input Validation ---
    if (!ETH_PRIVKEY) {
        throw new Error("Missing EVM PRIVATE_KEY in .env file");
    }
    if (!BT_PRIVKEY) {
        console.warn("-----------------------------------------------------------------");
        console.warn("WARNING: Missing BT_PRIVKEY (Bittensor Ed25519 private key) in .env file.");
        console.warn("This key is needed to sign the vote message itself.");
        console.warn("Please add BT_PRIVKEY=<your_ed25519_hex_private_key> to .env");
        console.warn("-----------------------------------------------------------------");
        throw new Error("Missing BT_PRIVKEY in .env file");
    }
    if (!CLAIM_VOTE_ADDRESS) {
        throw new Error("Missing CLAIM_VOTE_ADDRESS in .env.tao file");
    }
    if (!argv.votes) {
        // Should be caught by yargs demandOption, but double-check
        throw new Error("Missing --votes argument");
    }
    console.log(`Using RPC URL: ${argv['rpc-url']}`);
    console.log(`ClaimVote Contract Address: ${CLAIM_VOTE_ADDRESS}`);
    console.log(`Vote Message: "${argv.votes}"`);

    // --- Setup Provider and Signer ---
    const provider = new JsonRpcProvider(argv['rpc-url']);
    const evmWallet = new Wallet(ETH_PRIVKEY, provider);
    console.log(`Using EVM Wallet Address: ${await evmWallet.getAddress()}`);

    // --- Load Contract ---
    const claimVoteAbi = loadContractAbi('ClaimVote');
    const claimVoteContract = new Contract(CLAIM_VOTE_ADDRESS, claimVoteAbi, evmWallet);
    console.log("ClaimVote contract instance created.");

    // --- Prepare Ed25519 Signature ---
    const keyring = new Keyring({ type: 'ed25519' });
    const ed25519Pair = keyring.addFromUri(BT_PRIVKEY); // Assumes BT_PRIVKEY is a hex seed or phrase
    
    // Important: The publicKey for the contract needs to be the raw 32 bytes
    const ed25519PublicKeyBytes = ed25519Pair.publicKey;
    const ed25519PublicKeyHex = u8aToHex(ed25519PublicKeyBytes); // For contract call (bytes32)

    console.log(`Using Ed25519 Public Key (SS58): ${ed25519Pair.address}`);
    console.log(`Using Ed25519 Public Key (Hex for contract): ${ed25519PublicKeyHex}`);

    const voteMessageBytes = stringToU8a(argv.votes);
    const signatureBytes = ed25519Pair.sign(voteMessageBytes);
    const signatureHex = u8aToHex(signatureBytes); // For contract call (bytes)

    console.log(`Ed25519 Signature (Hex): ${signatureHex}`);


    // --- Send Transaction ---
    console.log("Sending updatePositions transaction...");
    try {
        const tx = await claimVoteContract.updatePositions(
            argv.votes,         // string message
            signatureHex,       // bytes signature
            ed25519PublicKeyHex // bytes32 publicKey
        );

        console.log(`Transaction sent: ${tx.hash}`);
        console.log("Waiting for transaction confirmation...");

        const receipt = await tx.wait(); // Wait for 1 confirmation

        if (receipt?.status === 1) {
            console.log("✅ Vote successfully submitted!");
            console.log(`Block Number: ${receipt.blockNumber}`);
        } else {
            console.error("❌ Transaction failed!");
            console.error(`Receipt:`, receipt);
        }
    } catch (error) {
        console.error("❌ Error sending transaction:", error.message);
        // Log more details if available (e.g., revert reason)
        if (error.reason) console.error("Revert Reason:", error.reason);
        if (error.data) console.error("Error Data:", error.data);
        process.exit(1); // Exit with error
    }

    console.log("--- Vote Script Finished ---");
}

main().catch((error) => {
    console.error("Unhandled error in main function:", error);
    process.exit(1);
});
