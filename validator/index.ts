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
import { computePoolWeights } from '../utils/poolWeights';
import { getMiners as getMinersUtil, getMinerAddresses as getMinerAddressesUtil, getMinerLiquidityPositions as getMinerLiquidityPositionsUtil, fetchActivePoolAddresses as fetchActivePoolAddressesUtil } from '../utils/miners';

// ----------------------
//  Logging Configuration
// ----------------------
// Must be set up *before* other imports execute arbitrary logging.
const LOG_CONSOLE = (process.env.LOG || 'false').toLowerCase() === 'true';
const logDir = path.join(__dirname, '..', 'logs');
fs.mkdir(logDir, { recursive: true }).catch(() => {});
const LOG_FILE_PATH = path.join(logDir, `validator-${new Date().toISOString().slice(0, 10)}.log`);

// Preserve originals
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

const appendLog = (level: string, args: any[]): void => {
    const line = `[${new Date().toISOString()}] ${level}: ` + args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    
    // Append the new line
    fs.appendFile(LOG_FILE_PATH, line + '\n').then(async () => {
        // Check if we need to trim the log file
        try {
            const stats = await fs.stat(LOG_FILE_PATH);
            if (stats.size > 0) {
                const content = await fs.readFile(LOG_FILE_PATH, 'utf-8');
                const lines = content.split('\n');
                if (lines.length > 10000) {
                    const trimmedLines = lines.slice(-10000); // Keep last 10000 lines
                    await fs.writeFile(LOG_FILE_PATH, trimmedLines.join('\n'));
                }
            }
        } catch (trimErr) {
            // Silently ignore trim errors to avoid logging loops
        }
    }).catch(() => {});
};

console.log = (...args: any[]): void => {
    appendLog('LOG', args);
    if (LOG_CONSOLE) _origLog(...args);
};

console.warn = (...args: any[]): void => {
    appendLog('WARN', args);
    if (LOG_CONSOLE) _origWarn(...args);
};

console.error = (...args: any[]): void => {
    appendLog('ERROR', args);
    _origError(...args); // always show errors
};

// For messages that should *always* be shown to the user, regardless of LOG flag
function importantLog(...args: any[]): void {
    appendLog('IMPORTANT', args);
    _origLog(...args);
}

function userLog(...args: any[]): void {
    _origLog(`[${new Date().toISOString()}]`, ...args);
}

// Promisify execFile for async/await usage
const execFileAsync = promisify(execFile);

// Load environment variables from .env file
dotenv.config();

// Toggle test mode via env var; when true, weights are not pushed on-chain
const TEST_MODE = (process.env.TEST_MODE || 'false').toLowerCase() === 'true';
if (TEST_MODE) console.log('Running in TEST_MODE: on-chain setWeights will be skipped.');

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
        tick?: string;
        token0Price?: string;
        token1Price?: string;
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
    async function attemptReconnect(wsUrl: string): Promise<void> {
        let delayMs = 1000; // start with 1s
        while (true) {
            try {
                userLog(`Attempting Bittensor WS reconnection...`);
                const newProvider = new WsProvider(wsUrl);
                const newApi = await ApiPromise.create({ provider: newProvider });
                await newApi.isReady;

                btApi = newApi;
                userLog(`Reconnected to Bittensor WS`);
                // re-attach disconnect handler
                newProvider.on('disconnected', () => {
                    userLog('Bittensor WS disconnected');
                    void attemptReconnect(wsUrl);
                });
                break;
            } catch (reErr) {
                console.error('Reconnection attempt failed:', reErr);
                await delay(delayMs);
                delayMs = Math.min(delayMs * 2, 30000); // cap at 30s
            }
        }
    }

    try {
        if (btApi) return null; // already initialized
        const wsUrl = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
        const provider = new WsProvider(wsUrl);
        provider.on('disconnected', () => {
            userLog('Bittensor WS disconnected');
            void attemptReconnect(wsUrl);
        });

        btApi = await ApiPromise.create({ provider });
        await btApi.isReady;

        const hotkeyUri = process.env.VALIDATOR_HOTKEY_URI;
        if (!hotkeyUri) return new Error('VALIDATOR_HOTKEY_URI env var not set');
        
        const keyring = new Keyring({ type: 'sr25519' });
        
        try {
            signer = keyring.addFromUri(hotkeyUri);
        } catch (keyErr) {
            console.error(`Failed to create signer from URI: ${keyErr}`);
            return new Error(`Invalid VALIDATOR_HOTKEY_URI format: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`);
        }

        // Verify neuron registration if storage available
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        if (btApi.query.subtensorModule?.keyToUid) {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const uidCodec = await btApi.query.subtensorModule.keyToUid(NETUID, signer.address);
            const uidNum = (uidCodec as any)?.toNumber ? (uidCodec as any).toNumber() : 0;
            console.log(`Hotkey registration check: UID ${uidNum} on netuid ${NETUID}`);
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
            console.log("Fetching positions from Graph Node (paginated)...");
            const subgraphUrl = process.env.SUBGRAPH_URL;
            if (!subgraphUrl) return [{}, new Error("SUBGRAPH_URL not configured")];

            const PAGE_SIZE = 1000;
            let skip = 0;
            const allPositions: any[] = [];

            while (true) {
                const query = `query {\n              positions(first: ${PAGE_SIZE}, skip: ${skip}, orderBy: id, orderDirection: asc, subgraphError: deny) {\n                id\n                publicKey\n                poolAddress\n                weight\n                timestamp\n              }\n            }`;

                const resp = await fetch(subgraphUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query })
                });

                const text = await resp.text();
                if (!resp.ok) return [{}, new Error(`Graph query failed (${resp.status}): ${text}`)];
                const result = JSON.parse(text);
                if (result.errors) return [{}, new Error(`Graph query errors: ${JSON.stringify(result.errors)}`)];

                const batch: any[] = result.data?.positions ?? [];
                allPositions.push(...batch);
                console.log(`Fetched ${batch.length} positions (skip=${skip}).`);

                if (batch.length < PAGE_SIZE) break; // last page reached
                skip += PAGE_SIZE;
            }

            if (allPositions.length === 0) return [{}, null];

            const positionsMap: Record<string, VotePosition[]> = {};
            for (const pos of allPositions) {
                if (!pos.publicKey) continue;
                let addr: string;
                try { addr = encodeAddress(pos.publicKey); } catch { continue; }
                if (!positionsMap[addr]) positionsMap[addr] = [];
                const w = Number(pos.weight);
                if (isNaN(w)) continue;
                let pool = "";
                try { pool = getAddress(pos.poolAddress); } catch { continue; }
                positionsMap[addr].push({ poolAddress: pool, weight: w });
            }

            return [positionsMap, null];

        } catch (err) {
            const error = err instanceof Error ? err : new Error("Unknown error fetching positions");
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

    const bittensorErr = await initializeBittensor();
    if (bittensorErr) return [null, new Error(`Failed to initialize Bittensor: ${bittensorErr.message}`)];

    // ---------------------------
    //  PERIODIC LOOP W/ EMA LOGIC
    // ---------------------------
    const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 300000); // default 5 minutes
    const SET_INTERVAL_MS = Number(process.env.SET_INTERVAL_MS || 101 * 12 * 1000); // 101 Blocks
    const EMA_ALPHA = Number(process.env.EMA_ALPHA || 0.2);

    let emaWeights: Record<string, number> = {};
    let lastSet = Date.now();
    let iteration = 0;

    const updateEma = (prev: Record<string, number>, curr: Record<string, number>): Record<string, number> => {
        const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
        const next: Record<string, number> = {};
        for (const k of keys) {
            const prevVal = prev[k] ?? 0;
            const currVal = curr[k] ?? 0;
            
            // Safety check for NaN or invalid values
            const safePrev = isFinite(prevVal) ? prevVal : 0;
            const safeCurr = isFinite(currVal) ? currVal : 0;
            
            next[k] = EMA_ALPHA * safeCurr + (1 - EMA_ALPHA) * safePrev;
            
            // Additional safety check on the result
            if (!isFinite(next[k])) {
                console.warn(`EMA calculation resulted in invalid value for key ${k}, setting to 0`);
                next[k] = 0;
            }
        }
        return next;
    };

    // Helper to ensure each loop starts after exactly LOOP_DELAY_MS
    const waitRemaining = async (startTime: number): Promise<Error | null> => {
        let remaining = LOOP_DELAY_MS - (Date.now() - startTime);
        if (remaining <= 0) return null;

        if (!LOG_CONSOLE) {
            // Display dynamic countdown in seconds on the same console line
            while (remaining > 0) {
                const secs = Math.ceil(remaining / 1000);
                process.stdout.write(`\rNext iteration in ${secs}s   `);
                const step = Math.min(1000, remaining);
                await delay(step);
                remaining -= step;
            }
            process.stdout.write('\r\n'); // move to next line after countdown finishes
        } else {
            await delay(remaining);
        }
        return null;
    };

    while (true) {
        iteration++;
        userLog(`Iteration ${iteration} started`);

        const startTime = Date.now();

        const [poolWeightTuple, poolErr] = await computePoolWeights();
        if (poolErr) { console.error(poolErr); await waitRemaining(startTime); continue; }
        const [poolWeights] = poolWeightTuple; // normalized weights from shared logic
        userLog(`Calculated pool weights (shared logic): ${Object.keys(poolWeights).length} pools`);

        const [miners, minersErr] = await getMinersUtil();
        if (minersErr) { console.error(minersErr); await waitRemaining(startTime); continue; }
        userLog(`Fetched miners: ${Object.keys(miners).length}`);

        const [minerAddresses, addrErr] = await getMinerAddressesUtil(miners);
        if (addrErr) { console.error(addrErr); await waitRemaining(startTime); continue; }
        userLog(`Fetched miner addresses: ${Object.keys(minerAddresses).length}`);

        // Fetch active liquidity providers for target pools (informational)
        const [activeOwners, activeErr] = await fetchActivePoolAddressesUtil();
        if (activeErr) {
            console.error(activeErr);
        } else {
            userLog(`Active pool addresses fetched: ${activeOwners.size}`);
        }

        const [minerLiquidityPositions, liqErr] = await getMinerLiquidityPositionsUtil(minerAddresses);
        if (liqErr) { console.error(liqErr); await waitRemaining(startTime); continue; }
        userLog("Fetched miner liquidity positions");

        const [normalizedPositionScores, normPosErr] = await calculateAndNormalizePoolScores(minerLiquidityPositions);
        if (normPosErr) { console.error(normPosErr); await waitRemaining(startTime); continue; }
        userLog("Calculated normalized position scores");

        const [finalMinerWeights, finalWeightsErr] = await calculateFinalMinerWeights(minerLiquidityPositions, normalizedPositionScores, poolWeights);
        if (finalWeightsErr) { console.error(finalWeightsErr); await waitRemaining(startTime); continue; }
        userLog("Calculated final miner weights");

        emaWeights = updateEma(emaWeights, finalMinerWeights);
        userLog('Updated EMA weights');

        const [displayEmaWeights] = await normalizeFinalMinerWeights(emaWeights);
        const top = Object.entries(displayEmaWeights).sort((a, b) => b[1] - a[1]).slice(0, 10);
        importantLog(`--- Loop ${iteration} Top EMA Weights ---`);
        top.forEach(([uid, weight], idx) => {
            const ck = miners[uid] ?? 'N/A';
            const shortCk = ck === 'N/A' ? ck : `${ck.slice(0, 4)}...${ck.slice(-4)}`;
            importantLog(`${idx + 1}. UID ${uid} => ${weight.toFixed(6)} (${shortCk})`);
        });

        if (Date.now() - lastSet >= SET_INTERVAL_MS) {
            userLog(`Settings weights for hotkey: ${signer?.address}`);
            console.log('101 block interval reached, pushing EMA weights on-chain');
            const [normalizedEma, normErr] = await normalizeFinalMinerWeights(emaWeights);
            if (!normErr) {
                const weightsDir = path.join(logDir, 'output');
                await fs.mkdir(weightsDir, { recursive: true });
                await fs.writeFile(path.join(weightsDir, 'latest_weights.json'), JSON.stringify(normalizedEma, null, 2));
                const [_, setErr] = await setWeightsOnNetwork(normalizedEma);
                if (setErr) console.error(setErr); else console.log('Weights successfully set');
            } else {
                console.error(normErr);
            }
            lastSet = Date.now();
        }

        userLog(`Iteration ${iteration} completed in ${((Date.now()-startTime)/1000).toFixed(1)}s`);
        await waitRemaining(startTime);
    }
}

async function normalizeFinalMinerWeights(finalMinerWeights: Record<string, number>): Promise<Result<Record<string, number>>> {
    const normalizedFinalMinerWeights: Record<string, number> = {};
    const totalWeight = Object.values(finalMinerWeights).reduce((sum, weight) => sum + weight, 0);
    
    // Handle case where totalWeight is 0, NaN, or invalid
    if (!totalWeight || totalWeight <= 0 || !isFinite(totalWeight)) {
        const minerIds = Object.keys(finalMinerWeights);
        const uniformWeight = minerIds.length > 0 ? 1 / minerIds.length : 0;
        
        console.warn(`Invalid or zero total weight (${totalWeight}), using uniform distribution: ${uniformWeight.toFixed(6)} per miner`);
        for (const minerId of minerIds) {
            normalizedFinalMinerWeights[minerId] = uniformWeight;
        }
        return [normalizedFinalMinerWeights, null];
    }
    
    for (const [minerId, weight] of Object.entries(finalMinerWeights)) {
        // Additional safety check for individual weights
        if (!isFinite(weight) || weight < 0) {
            console.warn(`Invalid weight ${weight} for miner ${minerId}, setting to 0`);
            normalizedFinalMinerWeights[minerId] = 0;
        } else {
            normalizedFinalMinerWeights[minerId] = weight / totalWeight;
        }
    }
    return [normalizedFinalMinerWeights, null];
}

async function setWeightsOnNetwork(normalizedFinalMinerWeights: Record<string, number>): Promise<Result<Record<string, number>>> {
    if ((process.env.DEBUG_ON_SET_WEIGHTS || 'false').toLowerCase() === 'true') debugger;
    try {
        if (TEST_MODE) {
            // Write the would be weights to a timestamped JSON file for inspection
            try {
                const weightsDir = path.join(logDir, 'weights');
                await fs.mkdir(weightsDir, { recursive: true });
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const filePath = path.join(weightsDir, `${ts}.json`);
                await fs.writeFile(filePath, JSON.stringify(normalizedFinalMinerWeights, null, 2));
                userLog(`[TEST_MODE] Weights saved to ${filePath}`);
            } catch (fileErr) {
                console.error('[TEST_MODE] Failed to write weights file:', fileErr);
            }
            console.log('[TEST_MODE] Skipping setWeightsOnNetwork call. Weights that would be set:', JSON.stringify(normalizedFinalMinerWeights, null, 2));
            return [normalizedFinalMinerWeights, null];
        }

        if (!btApi || !signer) return [{}, new Error('Bittensor API not initialized')];

        let entries = Object.entries(normalizedFinalMinerWeights);

        if (entries.length === 0) {
            console.warn('No miner weight data found – falling back to uniform weights across all registered UIDs.');
            const [uidsFallback, uidErr] = await fetchAllUids();
            if (uidErr) return [{}, uidErr];
            if (uidsFallback.length === 0) return [{}, new Error('Unable to determine UIDs for uniform weight distribution')];

            const uniform = 1 / uidsFallback.length;
            normalizedFinalMinerWeights = Object.fromEntries(uidsFallback.map(uid => [uid.toString(), uniform]));
            entries = Object.entries(normalizedFinalMinerWeights);
            console.log(`Applied uniform weight ${uniform.toFixed(6)} to ${uidsFallback.length} UIDs.`);
        }

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
        console.log('Setting weights on network...');
        console.log('Uids:', uids);
        console.log('Scaled:', scaled);
        console.log('Version key:', versionKey);
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
            if (typeof balance !== 'number' || isNaN(balance) || balance < 0) {
                console.error(`Invalid balance ${balance} for address ${address}`);
                return false;
            } else if (balance === 0) {
                console.warn(`Zero balance found for address ${address}`);
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
    const subgraphUrl = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;

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

    console.log(`Fetching ETH addresses for ${minerIds.length} miners from SeventySevenV1 subgraph...`);

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
    // Adjust query based on your actual SeventySevenV1 subgraph schema.
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

// ---------- The Graph helper ----------

const DEFAULT_TARGET_POOLS = [
    '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    '0x433a00819c771b33fa7223a5b3499b24fbcd1bbc',
];

/**
 * Fetches unique owner addresses that have active liquidity (>1) in the provided pools.
 * Uses the TheGraph endpoint specified via THEGRAPH_API_KEY (Bearer token).
 */
async function fetchActivePoolAddresses(poolIds: string[] = DEFAULT_TARGET_POOLS): Promise<Result<Set<string>>> {
    const apiKey = process.env.THEGRAPH_API_KEY;
    if (!apiKey) return [new Set(), new Error('THEGRAPH_API_KEY not configured')];

    const subgraphId = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
    const subgraphUrl = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;

    const owners = new Set<string>();
    const pageSize = 1000;

    try {
        for (const poolId of poolIds) {
            let skip = 0;
            while (true) {
                const query = `query($poolId: String!, $first: Int!, $skip: Int!) {
                    positions(where:{liquidity_gt:"1", pool_: {id: $poolId}}, first: $first, skip: $skip, orderBy: id, orderDirection: asc, subgraphError: deny) {
                        owner
                    }
                }`;

                const resp = await fetch(subgraphUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({ query, variables: { poolId: poolId.toLowerCase(), first: pageSize, skip } }),
                });

                const text = await resp.text();
                if (!resp.ok) return [new Set(), new Error(`GraphQL error ${resp.status}: ${text}`)];
                const result = JSON.parse(text);
                if (result.errors) return [new Set(), new Error(JSON.stringify(result.errors))];

                const positions = result.data?.positions ?? [];
                positions.forEach((p: { owner: string }) => owners.add(p.owner.toLowerCase()));

                if (positions.length < pageSize) break; // done with this pool
                skip += pageSize;
            }
        }
        return [owners, null];
    } catch (e) {
        return [new Set(), e instanceof Error ? e : new Error(String(e))];
    }
}

async function fetchAllUids(): Promise<Result<number[]>> {
    // Returns [uids, error]. Falls back to empty list on failure.
    try {
        if (!btApi) return [[], new Error('Bittensor API not initialized')];
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore – dynamic storage item lookup
        const totalCodec = await btApi.query.subtensorModule?.subnetworkN(NETUID);
        const total = (totalCodec as any)?.toNumber ? (totalCodec as any).toNumber() : 0;
        if (!total || total <= 0) return [[], new Error(`Invalid subnet size returned: ${total}`)];
        const uids = Array.from({ length: total }, (_, i) => i);
        return [uids, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return [[], error];
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