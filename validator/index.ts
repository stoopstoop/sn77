/**
 * This is the main validator code for sn77
 * 
 * Determines the weight of each miner and sets weight every interval.
 * 
 * It does this by:
 * Fetching all the votes from a local server.
 * Each Validator runs The Graph as a service which this code queries.
 * The Graph will go back to the start of when the contract was deployed
 * and it will stay up to date with the latest votes.
 * 
 * These votes are just all votes set by anyone who interacts with the contract.
 * So we need to filter out the votes by those who do not have a balance.
 * 
 * This means we need to fetch their balance from something like taostats.
 * 
 * Taostats will provide us a semi-up-to-date list of balances for token holders.
 * 
 * We need to remove the addresses from the votes that do not have a balance.
 * 
 * The votes determine which pool gets the weight. 
 */

import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { promisify } from 'util';
import { getAddress } from 'ethers';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { ISubmittableResult } from '@polkadot/types/types';

// Promisify execFile for async/await usage
const execFileAsync = promisify(execFile);

// Load environment variables from .env file
dotenv.config();

interface VotePosition {
    poolAddress: string;
    weight: number;
}

interface LiquidityPosition {
    id: string;
    owner: string;
    token0: {
        decimals: string;
        id: string;
        name: string;
        symbol: string;
    };
    token1: {
        decimals: string;
        id: string;
        name: string;
        symbol: string;
    };
    liquidity: string;
    tickLower: {
        id: string;
        tickIdx: string;
    };
    tickUpper: {
        id: string;
        tickIdx: string;
    };
    pool?: {
        feeTier: string;
        id: string;
        tick: string;
        token0Price: string;
        token1Price: string;
    };
}

interface Balance {
    address: string;
    balance: number;
}

interface PositionScore {
    gaussianMultiplier: number;
    liquidityAmount: number;
    finalScore: number;
    poolId: string;
    pairKey: string;
}

// Type alias for the standard return pattern [value, error]
type Result<T> = [T, Error | null];

// DEVELOPER NOTE: Consider defining these constants globally or in a config file.
const GAUSSIAN_AMPLITUDE = 10; // 'a' parameter
const FEE_TIER_STD_DEVS: Record<string, number> = {
    "100": 10,    // 0.01% (Stable-Stable)
    "500": 50,    // 0.05% (Stable-Major)
    "3000": 200,  // 0.3% (Standard)
    "10000": 500, // 1% (Volatile)
};
const DEFAULT_STD_DEV = FEE_TIER_STD_DEVS["3000"]; // Default to 0.3%
const LIQUIDITY_NORMALIZATION_FACTOR = 1e9; // Adjust based on typical liquidity scales

// Define TAO conversion constant
const RAO_PER_TAO = 1_000_000_000; // 10^9

// Define type for Taostats balance item
interface TaostatsBalanceItem {
    coldkey: { ss58: string };
    balance_as_tao: string; // API returns it as string
    // Add other fields if needed, like 'balance' (RAO)
}

// Define type for Taostats API Response
interface TaostatsResponse {
    pagination: {
        current_page: number;
        per_page: number;
        total_items: number;
        total_pages: number;
        next_page: number | null;
        prev_page: number | null;
    };
    data: TaostatsBalanceItem[];
}

// Define interface for the structure of position data returned by the subgraph
// Adjust based on the actual Uniswap V3 subgraph schema if needed
interface SubgraphPosition {
    id: string;
    owner: string;      // ETH Address
    liquidity: string;
    tickLower: {        // Updated to object
        id: string;
        tickIdx: string;
    };
    tickUpper: {        // Updated to object
        id: string;
        tickIdx: string;
    };
    token0: {           // Nested token info
        id: string;
        symbol: string;
        name: string;
        decimals: string;
    };
    token1: {           // Nested token info
        id: string;
        symbol: string;
        name: string;
        decimals: string;
    };
    pool?: {            // Nested pool info (make optional if not always present)
        id: string;
        feeTier: string;
        tick?: string;    // Pool tick might be optional depending on subgraph version
        token0Price?: string;
        token1Price?: string;
    };
    // Add other fields if necessary
}

// Utility function for adding delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// global bittensor vars & initializer (placed after RAO_PER_TAO const)
const NETUID = Number(process.env.NETUID || 77);
let btApi: ApiPromise | null = null;
let signer: ReturnType<Keyring['addFromUri']> | null = null;

async function initializeBittensor(): Promise<Error | null> {
    try {
        if (btApi) return null; // already initialized
        const wsUrl = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
        const provider = new WsProvider(wsUrl);
        btApi = await ApiPromise.create({ provider });
        await btApi.isReady;

        const hotkeyUri = process.env.VALIDATOR_HOTKEY_URI;
        if (!hotkeyUri) return new Error('VALIDATOR_HOTKEY_URI env var not set');
        const keyring = new Keyring({ type: 'sr25519' });
        signer = keyring.addFromUri(hotkeyUri);

        // Verify neuron registration if storage available
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        if (btApi.query.subtensorModule?.keyToUid) {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const uidCodec = await btApi.query.subtensorModule.keyToUid(NETUID, signer.address);
            // Some chains return 0 for unregistered hotkeys
            const uidNum = (uidCodec as any)?.toNumber ? (uidCodec as any).toNumber() : 0;
            if (uidNum === 0) return new Error('Hotkey not registered on subnet');
        }
        return null;
    } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
    }
}

async function main() {

    async function fetchVotePositions(): Promise<[Record<string, VotePosition[]>, Error | null]> {
        try {
            console.log('Fetching positions from Graph Node...');
            const subgraphUrl = process.env.SUBGRAPH_URL;
            if (!subgraphUrl) {
                console.error('Error: SUBGRAPH_URL environment variable not set.');
                return [{}, new Error('SUBGRAPH_URL not configured')];
            }

            // Use the environment variable for the fetch URL
            const response = await fetch(subgraphUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: `
                        query {
                            positions(
                                skip: 0
                                first: 100
                                orderBy: id
                                orderDirection: asc
                                subgraphError: deny
                            ) {
                                id
                                publicKey
                                poolAddress
                                weight
                                timestamp
                            }
                        }
                    `
                })
            });

            console.log('Graph Node response status:', response.status);
            const responseText = await response.text();

            if (!response.ok) {
                console.error(`Graph query failed with status ${response.status}: ${responseText}`);
                return [{}, new Error(`Graph query failed: ${response.statusText}`)];
            }

            const result = JSON.parse(responseText);
            if (result.errors) {
                console.error('Graph query errors:', result.errors);
                return [{}, new Error(`Graph query errors: ${JSON.stringify(result.errors)}`)];
            }

            if (!result.data?.positions) { // Use optional chaining
                console.log('No positions data found in response.');
                return [{}, null];
            }

            const positions = result.data.positions as any[]; // Add type assertion for clarity
            if (positions.length === 0) {
                console.log('No positions returned from Graph Node.');
                return [{}, null];
            }

            // Transform the data into the required format
            const positionsMap: Record<string, VotePosition[]> = {};
            positions.forEach((pos) => {
                if (!pos.publicKey) {
                    console.warn('Skipping position with missing publicKey:', pos); // Use warn for skippable issues
                    return;
                }
                
                let address: string;
                try {
                    // DEVELOPER NOTE: Ensure publicKey is a valid hex string or Uint8Array for encodeAddress
                    address = encodeAddress(pos.publicKey);
                } catch (encodeError) {
                    console.error(`Failed to encode publicKey ${pos.publicKey}:`, encodeError);
                    return; // Skip this position if encoding fails
                }

                if (!positionsMap[address]) {
                    positionsMap[address] = [];
                }

                const weight = Number(pos.weight);
                if (isNaN(weight)) {
                    console.warn(`Skipping position with invalid weight for address ${address}:`, pos);
                    return;
                }

                
                positionsMap[address].push({
                    poolAddress: getAddress(pos.poolAddress),
                    weight: weight
                });
            });

            console.log('Processed positions map created.'); // Simplified log
            return [positionsMap, null];

        } catch (err) {
            console.error('Error fetching positions:', err);
            const error = err instanceof Error ? err : new Error('Unknown error fetching positions');
            return [{}, error];
        }
    }

    /**
     * Fetches balances for the given addresses from the Taostats API with pagination and rate limit handling.
     * @param votePositions A map where keys are SS58 addresses of voters.
     * @returns A map of SS58 addresses to their Balance object { address: string, balance: number (in TAO) }.
     */
    async function fetchBalances(votePositions: Record<string, VotePosition[]>): Promise<Result<Record<string, Balance>>> {
        const voterAddresses = Object.keys(votePositions);
        if (voterAddresses.length === 0) {
            console.log("No addresses provided to fetch balances for.");
            return [{}, null];
        }

        const apiKey = process.env.TAOSTATS_API_KEY;
        if (!apiKey) {
            console.error('Error: TAOSTATS_API_KEY environment variable not set.');
            return [{}, new Error('TAOSTATS_API_KEY not configured')];
        }

        const netuid = 77;
        const baseUrl = `https://api.taostats.io/api/dtao/stake_balance/latest/v1`;
        const limit = 200;
        let offset = 0;
        let currentPage = 1; // Start from page 1, mainly for logging
        const allBalancesData: TaostatsBalanceItem[] = []; // Use the specific type
        const maxRetries = 3; 
        const initialRetryDelay = 1000;
        const proactiveDelay = 1000;
        let isLastPage = false; // Flag to control loop termination
        let nextPage: number | null = 1; // Use the API's next_page indicator (initialize as non-null)
        let totalPages = 1; // Initialize totalPages, will be updated by the first API response

        console.log(`Fetching all balances for netuid ${netuid} from Taostats API with pagination...`);

        try {
            // Use a while loop controlled by the API's total_pages indicator
            while (currentPage <= totalPages) {
                let retries = 0;
                let requestSuccessful = false;
                let fetchedDataCount = 0; // Declare here for use within the inner loop and page check

                while (retries <= maxRetries && !requestSuccessful) {
                     // Apply proactive delay only after the first page or on retries
                     if (currentPage > 1 || retries > 0) {
                         await delay(proactiveDelay);
                     }

                    const url = `${baseUrl}?netuid=${netuid}&limit=${limit}&offset=${offset}&order=balance_desc`;
                    console.log(`  Attempting fetch: page ${currentPage}, offset=${offset}, limit=${limit}, retry=${retries}`);

                    let response: Response | null = null;
                    let responseStatus = 0;
                    let responseText = '';

                    try {
                        response = await fetch(url, {
                            method: 'GET',
                            headers: {
                                'Accept': 'application/json',
                                'authorization': apiKey
                            },
                        });
                        responseStatus = response.status;
                        responseText = await response.text(); 

                        if (response.ok) {
                            let currentPageData: TaostatsBalanceItem[] = [];
                            try {
                                const result: TaostatsResponse = JSON.parse(responseText);
                                if (result?.data && Array.isArray(result.data) && result.pagination) {
                                    currentPageData = result.data;
                                    fetchedDataCount = currentPageData.length; // Store count for logging/info
                                    
                                    // Update pagination control based on API response
                                    nextPage = result.pagination.next_page;
                                    totalPages = result.pagination.total_pages; // Update total pages from response
                                    console.log(`    Received ${fetchedDataCount} items. Current Page: ${currentPage}. Next page: ${nextPage}. Total pages: ${totalPages}.`);

                                    if (fetchedDataCount > 0) {
                                        allBalancesData.push(...currentPageData);
                                    }
                                    requestSuccessful = true; 

                                } else {
                                    console.warn(`Unexpected Taostats API response structure (page ${currentPage}):`, result);
                                    throw new Error("Unexpected Taostats API response structure");
                                }
                            } catch (parseError) {
                                console.error(`Failed to parse Taostats API response (page ${currentPage}):`, parseError);
                                throw new Error(`Failed to parse Taostats API response (page ${currentPage})`);
                            }
                        } else if (responseStatus === 429) {
                            retries++;
                            if (retries > maxRetries) {
                                console.error(`Rate limit exceeded after ${maxRetries} retries for page ${currentPage}. Giving up.`);
                                throw new Error(`Rate limit exceeded for page ${currentPage}. Status: ${responseStatus}`);
                            }
                            const retryDelay = initialRetryDelay * Math.pow(2, retries - 1); 
                            console.warn(`Rate limited (429) on page ${currentPage}. Retrying in ${retryDelay}ms (Retry ${retries}/${maxRetries})...`);
                            await delay(retryDelay);
                        } else {
                             console.error(`Taostats API request failed (page ${currentPage}) with status ${responseStatus}: ${responseText}`);
                             throw new Error(`Taostats API request failed: ${response?.statusText || 'Unknown error'} (Status: ${responseStatus})`);
                        }
                    } catch (fetchError) {
                         console.error(`Fetch error for page ${currentPage}:`, fetchError);
                         throw fetchError; 
                    }
                } // End retry while loop

                // Prepare for the next iteration ONLY if there are more pages according to totalPages
                if (currentPage < totalPages) {
                    offset += limit; // Increment offset for the next page
                    currentPage++; // Increment page counter for logging
                } else {
                    // Break the loop explicitly when currentPage reaches totalPages
                    console.log(`  Reached reported total pages (${totalPages}). Stopping fetch loop.`);
                    break; 
                }

            } // End pagination while loop (controlled by totalPages)

            console.log(`Finished fetching. Received ${allBalancesData.length} total balance entries from Taostats.`);

            // Create a map of all balances for efficient lookup (Address -> Balance in TAO)
            const allBalancesMap = new Map<string, number>();
            for (const item of allBalancesData) {
                // Use coldkey.ss58 and balance_as_tao
                if (item.coldkey?.ss58 && typeof item.balance_as_tao === 'string') {
                    const balanceInTao = parseFloat(item.balance_as_tao); // Parse float from string
                    if (!isNaN(balanceInTao)) {
                         allBalancesMap.set(item.coldkey.ss58, balanceInTao);
                    } else {
                         console.warn("Skipping balance entry with invalid balance_as_tao:", item);
                    }
                } else {
                    console.warn("Skipping invalid balance entry (missing coldkey.ss58 or balance_as_tao):", item);
                }
            }

            // Filter balances for the specific voter addresses required
            const relevantBalances: Record<string, Balance> = {};
            for (const address of voterAddresses) {
                const balance = allBalancesMap.get(address) ?? 0; // Default to 0 if not found
                relevantBalances[address] = {
                    address: address,
                    balance: balance
                };
                if (balance === 0 && !allBalancesMap.has(address)) {
                    // console.log(`Voter address ${address} not found in Taostats data (balance set to 0).`);
                }
            }

            console.log(`Filtered balances for ${Object.keys(relevantBalances).length} relevant addresses.`);
            return [relevantBalances, null];

        } catch (err) {
            console.error('Error during paginated fetching or processing balances from Taostats:', err);
            const error = err instanceof Error ? err : new Error('Failed to fetch/process balances');
            return [{}, error];
        }
    }
    const [positions, positionsErr] = await fetchVotePositions();
    if (positionsErr) return [null, new Error(`Failed to fetch positions: ${positionsErr.message}`)];

    const [balances, balancesErr] = await fetchBalances(positions);
    if (balancesErr) return [null, new Error(`Failed to fetch balances: ${balancesErr.message}`)];

    console.log("Calculating pool weights");
    const [poolWeights, poolWeightsErr] = CalculatePoolWeights(positions, balances);
    if (poolWeightsErr) return [null, new Error(`Failed to update pool weights: ${poolWeightsErr.message}`)];

    console.log("Calculated Pool Weights (Vote-Based):", poolWeights);
    
    // --- Miner Liquidity Integration ---
    // The following steps use mock data for demonstration

    // 4. Get Miners
    console.log("Step 4: Fetching miners (mock)...");
    const [miners, minersErr] = await getMiners();
    if (minersErr) return [undefined, new Error(`Failed run: ${minersErr.message}`)];
    // console.log("Step 4: Miners fetched.", miners); // Less verbose log

    // 5. Get Miner ETH Addresses
    // console.log("Step 5: Fetching miner ETH addresses (mock)...");
    const [minerAddresses, minerAddressesErr] = await getMinerAddresses(miners);
    if (minerAddressesErr) return [undefined, new Error(`Failed run: ${minerAddressesErr.message}`)];
    console.log("Step 5: Miner addresses fetched.", minerAddresses); // Less verbose log

    // 6. Get Miner Liquidity Positions
    console.log("Step 6: Fetching miner liquidity positions (mock)...");
    const [minerLiquidityPositions, minerLiquidityPositionsErr] = await getMinerLiquidityPositions(minerAddresses);
    if (minerLiquidityPositionsErr) return [undefined, new Error(`Failed run: ${minerLiquidityPositionsErr.message}`)];
    // console.log("Step 6: Miner liquidity positions generated."); // Less verbose log

    // 7. Calculate Pool-Specific Normalized Position Scores
    console.log("Step 7: Calculating & Normalizing Pool-Specific Position Scores...");
    const [normalizedPositionScores, normScoresErr] = await calculateAndNormalizePoolScores(minerLiquidityPositions);
    if (normScoresErr) return [undefined, new Error(`Failed run: ${normScoresErr.message}`)];
    // console.log("Normalized Position Scores:", normalizedPositionScores); // Can be very verbose

    // 8. Calculate Final Miner Weights (Vote-Weighted Contributions)
    console.log("Step 8: Calculating Final Miner Weights...");
    // Pass poolWeights (checksummed keys) and normalizedPositionScores here
    const [finalMinerWeights, finalWeightsErr] = await calculateFinalMinerWeights(minerLiquidityPositions, normalizedPositionScores, poolWeights); 
    if (finalWeightsErr) return [undefined, new Error(`Failed run: ${finalWeightsErr.message}`)];
    console.log("Final Miner Weights (Before Chain Normalization):", finalMinerWeights);

    // Note: The final weights need to be normalized again (sum to 1) before setting on the chain.
    // The `finalMinerWeights` calculated here represent the relative contribution based on pool votes.
    console.log("Step 9: - Normalize `finalMinerWeights` and set on the network.");

    const [normalizedFinalMinerWeights, normalizedFinalMinerWeightsErr] = await normalizeFinalMinerWeights(finalMinerWeights);
    if (normalizedFinalMinerWeightsErr) return [undefined, new Error(`Failed run: ${normalizedFinalMinerWeightsErr.message}`)];
    console.log("Normalized Final Miner Weights:", normalizedFinalMinerWeights);

    // 9. Set Weights on Network
    console.log("Step 9: Setting weights on the network...");
    const [setWeightsResult, setWeightsErr] = await setWeightsOnNetwork(normalizedFinalMinerWeights);
    if (setWeightsErr) return [undefined, new Error(`Failed run: ${setWeightsErr.message}`)];
    console.log("Weights set on the network:", setWeightsResult);

    console.log("--- Validator Run Completed Successfully (with Mock Data/Placeholders) ---");
    return [undefined, null]; // Success
}

async function normalizeFinalMinerWeights(finalMinerWeights: Record<string, number>): Promise<Result<Record<string, number>>> {
    const normalizedFinalMinerWeights: Record<string, number> = {};
    const totalWeight = Object.values(finalMinerWeights).reduce((sum, weight) => sum + weight, 0);
    for (const [minerId, weight] of Object.entries(finalMinerWeights)) {
        normalizedFinalMinerWeights[minerId] = weight / totalWeight;
    }
    return [normalizedFinalMinerWeights, null];
}

async function setWeightsOnNetwork(normalizedFinalMinerWeights: Record<string, number>): Promise<Result<Record<string, number>>> {
    try {
        if (!btApi || !signer) return [{}, new Error('Bittensor API not initialized')];

        const entries = Object.entries(normalizedFinalMinerWeights);
        if (entries.length === 0) return [normalizedFinalMinerWeights, null];

        const uids = entries.map(([uid]) => Number(uid));
        const floatWeights = entries.map(([_, w]) => w);

        // Scale to u16 (0..65535) and ensure sum == 65535
        let scaled = floatWeights.map(w => Math.round(w * 65535));
        const totalScaled = scaled.reduce((a, b) => a + b, 0);
        if (totalScaled === 0) return [{}, new Error('All scaled weights are zero')];
        if (totalScaled !== 65535) {
            scaled = scaled.map(w => Math.round((w * 65535) / totalScaled));
        }

        const header = await btApi.rpc.chain.getHeader();
        const versionKey = header.number.toNumber();

        // Submit extrinsic
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore – dynamic lookup of pallet in generated types
        const tx = btApi.tx.subtensorModule.setWeights(NETUID, uids, scaled, versionKey);

        await new Promise<void>((resolve, reject) => {
            tx.signAndSend(signer!, { nonce: -1 }, (result: ISubmittableResult) => {
                if (result.status.isFinalized || result.status.isInBlock) {
                    if (result.dispatchError) {
                        let errMsg = result.dispatchError.toString();
                        if (result.dispatchError.isModule) {
                            const decoded = btApi!.registry.findMetaError(result.dispatchError.asModule);
                            errMsg = `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
                        }
                        reject(new Error(errMsg));
                    } else {
                        resolve();
                    }
                } else if (result.isError) {
                    reject(new Error('Transaction error'));
                }
            }).catch(reject);
        });

        return [normalizedFinalMinerWeights, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return [{}, error];
    }
}

/**
 * Calculates the raw score for each liquidity position and normalizes these scores
 * *within each pool* such that the scores for all positions in a single pool sum to 1.
 * @param minerLiquidityPositions Map of miner ID to their liquidity positions.
 * @returns A map where keys are position IDs and values are the position's normalized score within its pool.
 */
async function calculateAndNormalizePoolScores(
    minerLiquidityPositions: Record<string, LiquidityPosition[]>
): Promise<Result<Record<string, number>>> { 
    const poolRawScores: Record<string, Array<{ minerId: string; positionId: string; rawScore: number }>> = {};
    console.log("Calculating raw scores for all positions...");

    try {
        // 1. Calculate Raw Scores and Group by Pool
        for (const [minerId, positions] of Object.entries(minerLiquidityPositions)) {
            for (const pos of positions) {
                const poolId = pos.pool?.id;
                const currentTickStr = pos.pool?.tick;

                if (!poolId || typeof poolId !== 'string') {
                    console.warn(`Skipping position ${pos.id} (Miner ${minerId}): Missing or invalid pool ID.`);
                    continue;
                }
                if (typeof currentTickStr === 'undefined' || currentTickStr === null) {
                    console.warn(`Skipping position ${pos.id} (Miner ${minerId}, Pool ${poolId}): Missing pool tick.`);
                    continue;
                }

                const currentTick = Number(currentTickStr);
                if (isNaN(currentTick)) {
                    console.warn(`Skipping position ${pos.id} (Miner ${minerId}, Pool ${poolId}): Invalid pool tick (${currentTickStr}).`);
                    continue;
                }

                // Calculate the raw score using the existing function (Simpson's rule based)
                const scoreResult = calculatePositionScore(pos, currentTick);
                const rawScore = scoreResult.finalScore;
                const positionId = pos.id;

                if (!poolRawScores[poolId]) {
                    poolRawScores[poolId] = [];
                }
                poolRawScores[poolId].push({ minerId, positionId, rawScore });
                // console.log(`  Raw score for Pos ${positionId} (Miner ${minerId}, Pool ${poolId}): ${rawScore.toFixed(6)}`);
            }
        }

        console.log("Normalizing scores within each pool...");
        const normalizedPositionScores: Record<string, number> = {};

        // 2. Normalize Scores Within Each Pool
        for (const poolId in poolRawScores) {
            const positionsInPool = poolRawScores[poolId];
            const totalRawScoreInPool = positionsInPool.reduce((sum, p) => sum + p.rawScore, 0);

            // console.log(`  Pool ${poolId}: Total Raw Score = ${totalRawScoreInPool.toFixed(6)}, Positions = ${positionsInPool.length}`);

            if (totalRawScoreInPool > 0) {
                for (const p of positionsInPool) {
                    const normalizedScore = p.rawScore / totalRawScoreInPool;
                    normalizedPositionScores[p.positionId] = normalizedScore;
                    // console.log(`    Pos ${p.positionId} (Miner ${p.minerId}): Normalized Score = ${normalizedScore.toFixed(6)}`);
                }
            } else {
                // If total score is 0, assign 0 to all positions in that pool
                for (const p of positionsInPool) {
                    normalizedPositionScores[p.positionId] = 0;
                    // console.log(`    Pos ${p.positionId} (Miner ${p.minerId}): Normalized Score = 0.000000 (Total Pool Score was 0)`);
                }
            }
        }

        console.log("Finished calculating and normalizing pool-specific scores.");
        return [normalizedPositionScores, null];

    } catch (err) {
        console.error(`Error calculating/normalizing pool scores: ${err}`);
        const error = err instanceof Error ? err : new Error("Failed to calculate/normalize pool scores");
        return [{}, error];
    }
}

/**
 * Calculates the final weight for each miner based on their normalized position scores
 * and the global vote weights assigned to each pool.
 * @param minerLiquidityPositions Map of miner ID to their liquidity positions.
 * @param normalizedPositionScores Map of position ID to its normalized score within its pool.
 * @param poolWeights Map of (checksummed) pool ID to its global vote weight.
 * @returns A map of miner ID to their final calculated weight.
 */
async function calculateFinalMinerWeights(
    minerLiquidityPositions: Record<string, LiquidityPosition[]>,
    normalizedPositionScores: Record<string, number>,
    poolWeights: Record<string, number> // Expects checksummed keys
): Promise<Result<Record<string, number>>> {
    const finalMinerWeights: Record<string, number> = {};
    console.log("Calculating final miner weights based on normalized position scores and pool vote weights...");

    try {
        // Initialize all known miners with 0 weight
        for (const minerId of Object.keys(minerLiquidityPositions)) {
            finalMinerWeights[minerId] = 0;
        }

        // Aggregate contributions from each position
        for (const [minerId, positions] of Object.entries(minerLiquidityPositions)) {
            let minerTotalContribution = 0;
            for (const pos of positions) {
                const positionId = pos.id;
                const poolId = pos.pool?.id;

                if (!poolId || typeof poolId !== 'string') {
                    // Already warned in previous step, skip silently or add minimal log
                    // console.warn(`Skipping weight contribution for Pos ${positionId} (Miner ${minerId}): Missing pool ID.`);
                    continue;
                }

                const normalizedScore = normalizedPositionScores[positionId] ?? 0;
                let voteWeight = 0;
                try {
                    // Pool weights keys are checksummed from CalculatePoolWeights
                    const checksummedPoolId = getAddress(poolId);
                    voteWeight = poolWeights[checksummedPoolId] || 0;
                } catch (e) {
                    // Handle cases where poolId might not be a valid address format
                    // console.warn(`Could not get vote weight for pool ${poolId} (Pos ${positionId}): Invalid address format?`);
                    voteWeight = 0;
                }

                const contribution = normalizedScore * voteWeight;
                minerTotalContribution += contribution;

                // Optional detailed log per position
                // console.log(`  Pos ${positionId} (Miner ${minerId}, Pool ${checksummedPoolId}): NormScore=${normalizedScore.toFixed(6)}, VoteWeight=${voteWeight.toFixed(6)}, Contribution=${contribution.toFixed(6)}`);
            }
            finalMinerWeights[minerId] = minerTotalContribution;
            // console.log(`--- Miner ${minerId} Total Weight Contribution: ${minerTotalContribution.toFixed(6)} ---`);
        }
        
        console.log("Raw Final Miner Weights:", finalMinerWeights);

        // Zero out very small weights
        const threshold = 1e-8;
        let totalWeight = 0;
        for (const minerId in finalMinerWeights) {
            if (finalMinerWeights[minerId] <= threshold) {
                 console.log(`  Zeroing out weight for miner ${minerId} (${finalMinerWeights[minerId]} <= ${threshold})`);
                 finalMinerWeights[minerId] = 0;
            }
            totalWeight += finalMinerWeights[minerId];
        }
        
        console.log("Total weight after zeroing small values:", totalWeight);

        // Normalize weights if totalWeight > 0
        if (totalWeight > 0) {
            console.log("Normalizing final miner weights...");
            for (const minerId in finalMinerWeights) {
                finalMinerWeights[minerId] /= totalWeight;
            }
        } else {
             console.log("Total weight is 0, skipping normalization. All miner weights are 0.");
        }

        console.log("Finished calculating and normalizing final miner weights.");
        // The weights are now normalized (sum to 1) or all zero.
        return [finalMinerWeights, null];

    } catch (err) {
        console.error(`Error calculating final miner weights: ${err}`);
        const error = err instanceof Error ? err : new Error("Failed to calculate final miner weights");
        return [{}, error];
    }
}

/**
 * Calculates the weight of each pool based on the votes and balances of the addresses that have voted.
 * 
 * This is done by:
 * 1. Filtering out any addresses that do not have a balance or a position.
 * 2. Calculating the total weight of the positions for each address.
 * 3. Normalizing the weights so they sum to 1.
 * 
 * @param positions 
 * @param balances 
 * @returns A map of pool addresses to their weight
 */
function CalculatePoolWeights(positions: Record<string, VotePosition[]>, balances:Record<string, Balance>): [Record<string, number>, Error | null] {

    function filterPositions(positions: Record<string, VotePosition[]>, balances: Record<string, Balance>): Record<string, number> {
        const pairWeights: Record<string, number> = {};
        
        // First, find all valid addresses that have both positions and balances
        const validAddresses = Object.keys(positions).filter(address => {
            console.log("Checking address:", address);
            
            // Validate balances object
            if (!balances) {
                console.error("Balances object is undefined");
                return false;
            }
            
            // Validate specific address in balances
            if (!balances[address]) {
                console.error(`No balance found for address ${address}`);
                return false;
            }
            
            // Validate balance value
            const balance = balances[address].balance;
            if (typeof balance !== 'number' || isNaN(balance) || balance <= 0) {
                console.error(`Invalid balance ${balance} for address ${address}`);
                return false;
            }
            
            // Validate positions
            if (!positions[address] || !Array.isArray(positions[address]) || positions[address].length === 0) {
                console.error(`No valid positions found for address ${address}`);
                return false;
            }
            
            console.log(`Address ${address} has valid balance ${balance} and ${positions[address].length} positions`);
            return true;
        });

        console.log("Valid addresses with both positions and balances:", validAddresses);

        if (validAddresses.length === 0) {
            console.log("No valid addresses found with both positions and balances");
            return {};
        }

        // Process each valid address
        for (const address of validAddresses) {
            const userBalance = balances[address].balance;
            if (isNaN(userBalance) || userBalance <= 0) {
                console.error(`Invalid balance ${userBalance} for address ${address}`);
                continue;
            }

            const userPositions = positions[address];
            const totalWeight = userPositions.reduce((sum, pos) => {
                if (isNaN(pos.weight) || pos.weight < 0) {
                    console.error(`Invalid weight ${pos.weight} for position ${pos.poolAddress}`);
                    return sum;
                }
                return sum + pos.weight;
            }, 0);

            if (totalWeight <= 0) {
                console.error(`Invalid total weight ${totalWeight} for address ${address}`);
                continue;
            }

            // Initialize pair weights for this user's positions
            userPositions.forEach(position => {
                if (!position.poolAddress) {
                    console.error(`Invalid pool address for position:`, position);
                    return;
                }
                const pairKey = position.poolAddress;
                if (!pairWeights[pairKey]) pairWeights[pairKey] = 0;
            });

            // Calculate weight contributions
            for (const position of userPositions) {
                const pairKey = position.poolAddress;
                
                const weightContribution = (position.weight / totalWeight) * userBalance;
                pairWeights[pairKey] += weightContribution;
                console.log(`Added weight ${weightContribution} to pair ${pairKey}`);
            }
        }

        console.log("Final pair weights before normalization:", pairWeights);
        return pairWeights;
    }

    function normalizePairWeights(pairWeights: Record<string, number>): Record<string, number> {
        const totalWeight = Object.values(pairWeights).reduce((sum, weight) => sum + weight, 0);
        if (totalWeight === 0) {
            console.log("Total weight is 0, cannot normalize");
            return {};
        }
        
        const normalized = Object.fromEntries(
            Object.entries(pairWeights).map(([pair, weight]) => [pair, weight / totalWeight])
        );
        console.log("Normalized weights:", normalized);
        return normalized;
    }

    const pairWeights = filterPositions(positions, balances);
    const normalizedPairWeights = normalizePairWeights(pairWeights);

    return [normalizedPairWeights, null];
}

/**
 * Calculates a Gaussian score based on distance. Used for liquidity scoring.
 * @param distance - The distance value (e.g., tick distance).
 * @param a - Amplitude (max score).
 * @param c - Standard deviation (controls the spread).
 * @returns The Gaussian score.
 */
function gaussianScore(distance: number, a: number = GAUSSIAN_AMPLITUDE, c: number = DEFAULT_STD_DEV): number {
    if (c <= 0) { // Avoid division by zero or non-positive std dev
        console.warn(`Invalid standard deviation (c=${c}) in gaussianScore, returning 0.`);
        return 0;
    }
    // Standard Gaussian formula: a * exp(- (x - mu)^2 / (2 * c^2) )
    // Here, mu (mean) is 0 as distance is relative, x is the distance.
    return a * Math.exp(-(distance ** 2) / (2 * (c ** 2)));
}

/**
 * Calculates a score for a single Uniswap V3 liquidity position based on its
 * proximity to the current pool tick and the amount of liquidity.
 * Positions covering the current tick receive the maximum proximity multiplier.
 * Positions not covering the current tick receive a score based on distance to the nearest edge.
 * @param position - The liquidity position details.
 * @param currentTick - The current tick of the pool.
 * @returns An object containing the Gaussian multiplier, liquidity amount, and final score.
 */
function calculatePositionScore(position: LiquidityPosition, currentTick: number): PositionScore {
    // Validate essential data presence
    // Check for missing essential data individually for clearer warnings
    if (!position.pool) {
        console.warn(`Cannot calculate score for position ${position.id}: missing pool data.`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }
    // Updated check for tickLower and its nested tickIdx
    if (typeof position.tickLower?.tickIdx === 'undefined' || position.tickLower.tickIdx === null) { 
        console.warn(`Cannot calculate score for position ${position.id}: missing tickLower.tickIdx.`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }
     // Updated check for tickUpper and its nested tickIdx
    if (typeof position.tickUpper?.tickIdx === 'undefined' || position.tickUpper.tickIdx === null) { 
        console.warn(`Cannot calculate score for position ${position.id}: missing tickUpper.tickIdx.`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }
    if (typeof position.liquidity === 'undefined' || position.liquidity === null) { // Check for undefined or null
        console.warn(`Cannot calculate score for position ${position.id}: missing liquidity.`);
         return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }

    // Convert string numbers (including nested ticks) to actual numbers and validate
    const tickLower = Number(position.tickLower.tickIdx); // Access nested tickIdx
    const tickUpper = Number(position.tickUpper.tickIdx); // Access nested tickIdx
    const liquidityRaw = Number(position.liquidity);
    const poolId = position.pool.id;
    const pairKey = position.token0.id < position.token1.id ? `${position.token0.id}-${position.token1.id}` : `${position.token1.id}-${position.token0.id}`;

    if (isNaN(tickLower) || isNaN(tickUpper) || isNaN(liquidityRaw) || isNaN(currentTick)) {
         console.warn(`Cannot calculate score for position ${position.id}: invalid numeric data (tickLower=${position.tickLower.tickIdx}, tickUpper=${position.tickUpper.tickIdx}, liquidity=${position.liquidity}, or currentTick=${currentTick}).`);
         return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: poolId, pairKey: pairKey };
    }

     // Ensure tickLower is actually lower than tickUpper
    if (tickLower >= tickUpper) {
        console.warn(`Cannot calculate score for position ${position.id}: tickLower (${tickLower}) must be less than tickUpper (${tickUpper}).`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: poolId, pairKey: pairKey };
    }

    // Determine if the current tick is within the position's active range
    const isInRange = currentTick >= tickLower && currentTick <= tickUpper;

    let distanceForGaussian: number;

    if (isInRange) {
        // If the tick is within the range, the position is active. Use distance 0 for max Gaussian score.
        distanceForGaussian = 0;
    } else {
        // If the tick is outside the range, calculate the distance to the *nearest* edge.
        const distanceToLower = Math.abs(currentTick - tickLower);
        const distanceToUpper = Math.abs(currentTick - tickUpper);
        distanceForGaussian = Math.min(distanceToLower, distanceToUpper);
    }

    // Get fee tier specific std dev, default if not found
    const feeTier = position.pool.feeTier;
    const stdDev = FEE_TIER_STD_DEVS[feeTier] ?? DEFAULT_STD_DEV;

    // --- Simpson's Rule Approximation for Average Gaussian Multiplier --- 
    const midPoint = (tickLower + tickUpper) / 2;

    const distanceLower = Math.abs(currentTick - tickLower);
    const distanceUpper = Math.abs(currentTick - tickUpper);
    const distanceMid = Math.abs(currentTick - midPoint);

    const scoreLower = gaussianScore(distanceLower, GAUSSIAN_AMPLITUDE, stdDev);
    const scoreUpper = gaussianScore(distanceUpper, GAUSSIAN_AMPLITUDE, stdDev);
    const scoreMid = gaussianScore(distanceMid, GAUSSIAN_AMPLITUDE, stdDev);

    // Weighted average using Simpson's rule (weights: 1, 4, 1)
    const averageGaussianMultiplier = (scoreLower + 4 * scoreMid + scoreUpper) / 6;
    // --------------------------------------------------------------------

    // Normalize liquidity amount
    const liquidityAmount = liquidityRaw / LIQUIDITY_NORMALIZATION_FACTOR;

    // Final score combines proximity (Average Gaussian) and magnitude (Liquidity)
    const finalScore = averageGaussianMultiplier * liquidityAmount;


    // --- Detailed Logging --- 
    console.log(`  Detailed Score Calculation for Pos ${position.id} (Pool: ${poolId}):`);
    console.log(`    - Ticks: Lower=${tickLower}, Upper=${tickUpper}, Mid=${midPoint.toFixed(1)}, Current=${currentTick}`);
    console.log(`    - Liquidity: Raw=${liquidityRaw}, Normalized=${liquidityAmount.toFixed(4)}`);
    // Removed Range Check log as it's no longer directly used
    console.log(`    - Distances: Lower=${distanceLower.toFixed(1)}, Mid=${distanceMid.toFixed(1)}, Upper=${distanceUpper.toFixed(1)}`);
    console.log(`    - Gaussian Params: Amplitude=${GAUSSIAN_AMPLITUDE}, StdDev=${stdDev} (FeeTier: ${feeTier})`);
    console.log(`    - Scores: Lower=${scoreLower.toFixed(4)}, Mid=${scoreMid.toFixed(4)}, Upper=${scoreUpper.toFixed(4)}`);
    console.log(`    - Average Gaussian Multiplier (Simpson): ${averageGaussianMultiplier.toFixed(4)}`);
    console.log(`    - Final Raw Score: ${finalScore.toFixed(4)}`);
    // --- End Detailed Logging ---

    return {
        gaussianMultiplier: averageGaussianMultiplier, // Return the average multiplier
        liquidityAmount,
        finalScore,
        poolId: poolId,
        pairKey: pairKey
    };
}

async function getMinerLiquidityPositions(minerAddresses: Record<string, string>): Promise<Result<Record<string, LiquidityPosition[]>>> {
    const ethAddresses = Object.values(minerAddresses);
    const numMiners = ethAddresses.length;
    if (numMiners === 0) {
        console.log("No miner addresses provided to fetch liquidity positions for.");
        return [{}, null];
    }

    const apiKey = process.env.THEGRAPH_API_KEY;
    if (!apiKey) {
        console.error('Error: THEGRAPH_API_KEY environment variable not set.');
        return [{}, new Error('THEGRAPH_API_KEY not configured')];
    }

    const subgraphId = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";
    const subgraphUrl = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;

    console.log(`Fetching liquidity positions for ${numMiners} miners from The Graph: ${subgraphUrl}`);

    // Create a reverse map: ETH Address -> UID
    const addressToUidMap = new Map<string, string>();
    for (const [uid, address] of Object.entries(minerAddresses)) {
        addressToUidMap.set(address.toLowerCase(), uid); // Use lowercase for consistent matching
    }

    const minerLiquidityPositions: Record<string, LiquidityPosition[]> = {};
    const batchSize = 100; // Number of owners per query
    const queryLimit = 1000; // Max positions per owner batch

    try {
        for (let i = 0; i < numMiners; i += batchSize) {
            const addressBatch = ethAddresses.slice(i, i + batchSize).map(addr => addr.toLowerCase());
            console.log(`  Querying batch ${i / batchSize + 1}: ${addressBatch.length} addresses...`);

            // Construct the GraphQL query for the batch
            // Fetches first 1000 positions per batch of owners
            const query = `
                query GetMinerPositions($owners: [String!]!, $limit: Int!) {
                    positions(first: $limit, where: { owner_in: $owners, liquidity_gt: "1" }) {
                        id
                        owner
                        liquidity
                        tickLower {
                            id
                            tickIdx
                        }
                        tickUpper {
                            id
                            tickIdx
                        }
                        token0 {
                            id
                            symbol
                            name
                            decimals
                        }
                        token1 {
                            id
                            symbol
                            name
                            decimals
                        }
                        pool {
                            id
                            feeTier
                            tick
                            token0Price
                            token1Price
                        }
                    }
                }
            `;

            const response = await fetch(subgraphUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}` // Use Bearer token header
                },
                body: JSON.stringify({
                    query: query,
                    variables: { owners: addressBatch, limit: queryLimit }
                })
            });

            const responseText = await response.text();
            if (!response.ok) {
                console.error(`Subgraph query for positions failed (Batch ${i / batchSize + 1}) with status ${response.status}: ${responseText}`);
                // Continue to next batch or throw? For now, log and continue.
                 console.warn(`Continuing to next batch despite error in batch ${i / batchSize + 1}.`);
                 continue;
                // Or: throw new Error(`Subgraph query failed: ${response.statusText}`);
            }

            const result = JSON.parse(responseText);
            if (result.errors) {
                console.error(`Subgraph query errors for positions (Batch ${i / batchSize + 1}):`, result.errors);
                 // Continue to next batch or throw?
                 console.warn(`Continuing to next batch despite errors in batch ${i / batchSize + 1}.`);
                 continue;
                 // Or: throw new Error(`Subgraph query errors: ${JSON.stringify(result.errors)}`);
            }

            const positionsData = result.data?.positions as SubgraphPosition[] || [];
            console.log(`    Received ${positionsData.length} positions for this batch.`);

            // Process the received positions and map them back to UIDs
            for (const pos of positionsData) {
                const ownerAddress = pos.owner.toLowerCase();
                const uid = addressToUidMap.get(ownerAddress);
                if (uid) {
                    if (!minerLiquidityPositions[uid]) {
                        minerLiquidityPositions[uid] = [];
                    }
                    // Ensure the structure matches LiquidityPosition interface
                    // The types mostly align, but pool might be optional/null
                    minerLiquidityPositions[uid].push(pos as LiquidityPosition);
                } else {
                    console.warn(`Position ${pos.id} owner ${pos.owner} not found in miner address map.`);
                }
            }
        } // End of batch loop

         // Initialize empty arrays for miners with no positions found
        for (const uid of Object.keys(minerAddresses)) {
            if (!minerLiquidityPositions[uid]) {
                minerLiquidityPositions[uid] = [];
            }
        }

        console.log(`Finished fetching positions. Found data for ${Object.keys(minerLiquidityPositions).length} miners.`);
        return [minerLiquidityPositions, null];

    } catch (err) {
        console.error("Error fetching or processing miner liquidity positions from subgraph:", err);
        const error = err instanceof Error ? err : new Error("Failed to fetch miner liquidity positions");
        return [{}, error];
    }
}

/**
 * Executes the get-miners.py script to fetch miner data.
 * @param netuid The netuid to query.
 * @param network The network to query.
 * @returns Promise<void> Resolves when the script completes successfully, rejects on error.
 */
async function runGetMinersScript(netuid: number, network: string): Promise<void> {
    const scriptPath = path.join(__dirname, '..', 'utils', 'get-miners.py'); // Assumes validator/ is one level down
    const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python'; // Allow specifying python path via env

    console.log(`Executing ${pythonExecutable} ${scriptPath} ${netuid} --network ${network}...`);

    try {
        const { stdout, stderr } = await execFileAsync(pythonExecutable, [
            scriptPath,
            netuid.toString(),
            '--network',
            network
        ]);

        if (stderr) {
            console.error(`get-miners.py stderr: ${stderr}`);
            // Decide if stderr always means failure, or could be warnings
            // For now, let's treat non-empty stderr as an error cause.
            throw new Error(`Python script execution failed with stderr: ${stderr}`);
        }

        console.log(`get-miners.py stdout: ${stdout}`); // Log success message from script
        console.log("Python script executed successfully.");

    } catch (error) {
        console.error(`Error executing Python script: ${error}`);
        throw new Error(`Failed to execute get-miners.py: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Fetches miner data by running the get-miners.py script and parsing its CSV output.
 * Returns a map of miner UID to their SS58 Coldkey.
 */
async function getMiners(): Promise<Result<Record<string, string>>> {
    const netuid = 77; // TODO: Make configurable?
    const network = process.env.BITTENSOR_NETWORK || 'finney'; // Use env var or default
    const csvPath = path.join(__dirname, '..', 'output', 'miners.csv');

    try {
        // Step 1: Run the script to ensure the CSV is up-to-date
        await runGetMinersScript(netuid, network);

        // Step 2: Read the CSV file
        console.log(`Reading miner data from ${csvPath}...`);
        const csvData = await fs.readFile(csvPath, 'utf-8');

        // Step 3: Parse the CSV data
        const records: Array<{ uid: string; coldkey: string; hotkey: string }> = parse(csvData, {
            columns: true, // Treat the first row as headers
            skip_empty_lines: true,
        });

        // Step 4: Transform into the required map format (UID -> Coldkey)
        const minerMap: Record<string, string> = {};
        for (const record of records) {
            if (record.uid && record.coldkey) {
                 // The key is the UID (string), the value is the Coldkey (SS58 Address string)
                minerMap[record.uid] = record.coldkey;
            } else {
                console.warn("Skipping record due to missing uid or coldkey:", record);
            }
        }

        if (Object.keys(minerMap).length === 0) {
             console.warn("No valid miner records found in CSV or CSV was empty.");
             // Return empty map, but not necessarily an error unless the script failed (handled above)
             return [{}, null];
        }


        console.log(`Successfully fetched and parsed ${Object.keys(minerMap).length} miners.`);
        return [minerMap, null];

    } catch (err) {
        console.error("Error in getMiners process:", err);
        const error = err instanceof Error ? err : new Error("Failed to get miner data");
        return [{}, error]; // Return empty map and the error
    }
}

async function getMinerAddresses(miners: Record<string, string>): Promise<Result<Record<string, string>>> {
    const minerIds = Object.keys(miners);
    if (minerIds.length === 0) {
        console.log("No miners provided to fetch addresses for.");
        return [{}, null];
    }

    console.log(`Fetching ETH addresses for ${minerIds.length} miners from ClaimVote subgraph...`);

    const subgraphUrl = process.env.SUBGRAPH_URL;
    if (!subgraphUrl) {
        console.error('Error: SUBGRAPH_URL environment variable not set.');
        return [{}, new Error('SUBGRAPH_URL not configured')];
    }

    const publicKeyToUidMap = new Map<string, string>();
    const publicKeysHex: string[] = [];

    // Convert SS58 to hex public keys and map back to UID
    for (const [uid, ss58Address] of Object.entries(miners)) {
        try {
            const publicKeyBytes = decodeAddress(ss58Address);
            const publicKeyHex = u8aToHex(publicKeyBytes); // Get 0x prefixed hex string
            publicKeysHex.push(publicKeyHex);
            publicKeyToUidMap.set(publicKeyHex, uid);
            // console.log(`  Mapping SS58 ${ss58Address} to PubKey ${publicKeyHex} for UID ${uid}`);
        } catch (err) {
            console.warn(`Failed to decode SS58 address ${ss58Address} for UID ${uid}:`, err);
            // Skip this miner if address is invalid
        }
    }

    if (publicKeysHex.length === 0) {
        console.log("No valid public keys derived from miner SS58 addresses.");
        return [{}, null];
    }

    // Construct the GraphQL query
    // IMPORTANT: Assumes subgraph entity is `addressRegistration` and fields are `id` (publicKey) and `ethAddress`.
    // Adjust query based on your actual ClaimVote subgraph schema.
    const query = `
        query GetRegisteredAddresses($publicKeys: [Bytes!]!) {
            addressRegistrations(where: { id_in: $publicKeys }) {
                id        # This should be the bytes32 public key (as hex string)
                ethAddress # This should be the registered Ethereum address
            }
        }
    `;

    try {
        const response = await fetch(subgraphUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: query,
                variables: { publicKeys: publicKeysHex }
            })
        });

        const responseText = await response.text();
        if (!response.ok) {
            console.error(`Subgraph query for addresses failed with status ${response.status}: ${responseText}`);
            return [{}, new Error(`Subgraph query failed: ${response.statusText}`)];
        }

        const result = JSON.parse(responseText);
        if (result.errors) {
            console.error('Subgraph query errors for addresses:', result.errors);
            return [{}, new Error(`Subgraph query errors: ${JSON.stringify(result.errors)}`)];
        }

        // Process the results
        const minerAddresses: Record<string, string> = {};
        const registrations = result.data?.addressRegistrations as Array<{ id: string; ethAddress: string }> || [];

        console.log(`Received ${registrations.length} address registrations from subgraph.`);

        const foundPublicKeys = new Set<string>();
        for (const reg of registrations) {
            if (reg.id && reg.ethAddress) {
                const publicKeyHex = reg.id; // Assuming id is the hex public key
                const uid = publicKeyToUidMap.get(publicKeyHex);
                if (uid) {
                    minerAddresses[uid] = reg.ethAddress;
                    foundPublicKeys.add(publicKeyHex);
                    // console.log(`  Found registration: UID ${uid} -> ETH ${reg.ethAddress}`);
                } else {
                     console.warn(`Subgraph returned registration for unknown public key: ${publicKeyHex}`);
                }
            } else {
                console.warn("Skipping registration with missing id or ethAddress:", reg);
            }
        }

        // Log miners who didn't have a registration
        for (const publicKeyHex of publicKeysHex) {
            if (!foundPublicKeys.has(publicKeyHex)) {
                 const uid = publicKeyToUidMap.get(publicKeyHex);
                 console.warn(`No address registration found in subgraph for UID ${uid} (PubKey: ${publicKeyHex})`);
            }
        }

        console.log(`Successfully fetched ETH addresses for ${Object.keys(minerAddresses).length} miners.`);
        return [minerAddresses, null];

    } catch (err) {
        console.error("Error fetching or processing miner addresses from subgraph:", err);
        const error = err instanceof Error ? err : new Error("Failed to fetch miner addresses");
        return [{}, error];
    }
}

main().then((result) => {
    if (result && result[1]) {
        console.error('Error:', result[1]);
    } else if (result) {
        console.log('Result:', result[0]);
    }
}).catch((err) => {
    console.error('Unhandled error:', err);
});