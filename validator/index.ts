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

import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { getAddress } from 'ethers';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { ISubmittableResult } from '@polkadot/types/types';
import { computePoolWeights } from '../utils/poolWeights';
import { getMiners as getMinersUtil, getMinerAddresses as getMinerAddressesUtil, getMinerLiquidityPositions as getMinerLiquidityPositionsUtil } from '../utils/miners';
import { GraphQLClient } from 'graphql-request';

// ----------------------
//  Logging Configuration
// ----------------------
// Must be set up *before* other imports execute arbitrary logging.
const TEST_MODE = (process.env.TEST_MODE || 'false').toLowerCase() === 'true';
const LOG_CONSOLE = (process.env.LOG || 'false').toLowerCase() === 'true' || TEST_MODE;
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

// Load environment variables from .env file
dotenv.config();

// Toggle test mode via env var; when true, weights are not pushed on-chain
// Default to false unless explicitly set to true
if (TEST_MODE) {
    console.log('Running in TEST_MODE: weights will be saved to JSON files instead of being pushed on-chain');
    console.log('Console logging is automatically enabled in TEST_MODE');
    // Ensure weights directory exists
    const weightsDir = path.join(logDir, 'weights');
    fs.mkdir(weightsDir, { recursive: true }).catch(err => {
        console.error('Failed to create weights directory:', err);
    });
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
    token0Balance: string;
    token1Balance: string;
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

interface PositionScore {
    gaussianMultiplier: number;
    liquidityAmount: number;
    finalScore: number;
    poolId: string;
    pairKey: string;
}

interface Vote {
  ss58Address: string;
  pools: Array<{ address: string; weight: number }>;
  total_weight: number;
  block_number: number;
  alphaBalance: number;
  weightMultiplier: number;
}

interface VotesResponse {
  success: boolean;
  votes: Vote[];
  totalAlphaTokens: number;
  cached: boolean;
  error?: string;
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


// Utility function for adding delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// global bittensor vars & initializer (placed after RAO_PER_TAO const)
const NETUID = 77
let btApi: ApiPromise | null = null;
let signer: ReturnType<Keyring['addFromUri']> | null = null;

// Cache for votes data
interface CachedVotes {
  data: VotesResponse;
  timestamp: number;
}

let cachedVotes: CachedVotes | null = null;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

// Constants for Uniswap V3 subgraph
const UNISWAP_V3_SUBGRAPH_URL = 'https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const UNISWAP_V3_CLIENT = new GraphQLClient(UNISWAP_V3_SUBGRAPH_URL, {
  headers: {
    'Authorization': `Bearer ${process.env.THEGRAPH_API_KEY || ''}`
  }
});

// Query to get positions for a specific owner
const POSITIONS_QUERY = `
  query GetPositions($owner: String!, $poolIds: [String!]!) {
    positions(where: { owner: $owner, pool_in: $poolIds, liquidity_gt:"1", token0Balance_gt: "0", token1Balance_gt: "0" }) {
      id
      owner
      pool {
        id
        feeTier
        token0 {
          id
          symbol
          decimals
          name
        }
        token1 {
          id
          symbol
          decimals
          name
        }
        tick
      }
      tickLower {
        id
        tickIdx
      }
      tickUpper {
        id
        tickIdx
      }
      liquidity
      token0Balance
      token1Balance
    }
  }
`;

interface UniswapPosition {
  id: string;
  owner: string;
  pool: {
    id: string;
    feeTier: string;
    token0: {
      id: string;
      symbol: string;
      decimals: string;
      name: string;
    };
    token1: {
      id: string;
      symbol: string;
      decimals: string;
      name: string;
    };
    tick: string;
  };
  tickLower: {
    id: string;
    tickIdx: string;
  };
  tickUpper: {
    id: string;
    tickIdx: string;
  };
  liquidity: string;
  token0Balance: string;
  token1Balance: string;
}

interface UniswapResponse {
  positions: UniswapPosition[];
}

interface RegistryMapResponse {
  success: boolean;
  miners: Array<{ hotkeyAddress: string, ethereumAddress: string | null }>;
  totalMiners: number;
  linkedMiners: number;
  error?: string;
}

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
        const wsUrl = 'wss://entrypoint-finney.opentensor.ai:443';
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

async function main(): Promise<void> {
    const bittensorErr = await initializeBittensor();
    if (bittensorErr) {
        console.error('Failed to initialize Bittensor:', bittensorErr);
        process.exit(1);
        return;
    }

    // ---------------------------
    //  PERIODIC LOOP W/ EMA LOGIC
    // ---------------------------
    const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 300000); // default 5 minutes
    const SET_INTERVAL_MS = Number(process.env.SET_INTERVAL_MS || 101 * 12 * 1000); // 101 Blocks
    const EMA_ALPHA = Number(process.env.EMA_ALPHA || 0.2);
    const MAX_CONSECUTIVE_ERRORS = 5;

    let emaWeights: Record<string, number> = {};
    let lastSet = 0;
    let iteration = 0;
    let consecutiveErrors = 0;

    // Note: We determine the list of valid UIDs from the registry map data rather than fetchAllUids()
    // to ensure consistency between the UIDs we process and the miners data available from the API

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
        try {
            const startTime = Date.now();
            userLog(`\nIteration ${++iteration} starting...`);

            // Fetch votes from central server
            const [votesData, votesErr] = await fetchVotesFromServer();
            if (votesErr) {
                console.error('Error fetching votes:', votesErr);
                consecutiveErrors++;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                    process.exit(1);
                    return;
                }
                await waitRemaining(startTime);
                continue;
            }

            if (!votesData) {
                console.error('No votes data received');
                consecutiveErrors++;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                    process.exit(1);
                    return;
                }
                await waitRemaining(startTime);
                continue;
            }

            // Debug log the votes data structure
            console.log('DEBUG: Votes data structure:', JSON.stringify(votesData, null, 2));

            // Reset error counter on successful iteration
            consecutiveErrors = 0;

            // Log vote information
            userLog(`Total Alpha Tokens: ${votesData.totalAlphaTokens}`);
            userLog(`Number of voters: ${Array.isArray(votesData.votes) ? votesData.votes.length : 'invalid'}`);
            userLog(`Cache status: ${votesData.cached ? 'Using cached data' : 'Fresh data'}`);

            // Ensure votesData.votes is an array before processing
            if (!Array.isArray(votesData.votes)) {
                console.error('votesData.votes is not an array:', typeof votesData.votes, votesData.votes);
                console.error('Full votesData structure:', JSON.stringify(votesData, null, 2));
                
                // Try to find votes in different possible locations
                let foundVotes: any[] | null = null;
                const votesDataAny = votesData as any;
                if (votesDataAny.data && Array.isArray(votesDataAny.data.votes)) {
                    foundVotes = votesDataAny.data.votes;
                    console.log('Found votes in votesData.data.votes');
                } else if (votesDataAny.result && Array.isArray(votesDataAny.result.votes)) {
                    foundVotes = votesDataAny.result.votes;
                    console.log('Found votes in votesData.result.votes');
                } else if (Array.isArray(votesDataAny)) {
                    foundVotes = votesDataAny;
                    console.log('Found votes as direct array in votesData');
                }
                
                if (foundVotes) {
                    console.log('Using fallback votes data');
                    (votesData as any).votes = foundVotes;
                } else {
                    await waitRemaining(startTime);
                    continue;
                }
            }

            // Process votes and calculate pool weights
            const poolWeights: Record<string, number> = {};
            const votedPoolIds = new Set<string>();

            votesData.votes.forEach(vote => {
                vote.pools.forEach(pool => {
                    const poolAddress = getAddress(pool.address);
                    const weightedVote = pool.weight * vote.weightMultiplier;
                    poolWeights[poolAddress] = (poolWeights[poolAddress] || 0) + weightedVote;
                    votedPoolIds.add(poolAddress.toLowerCase());
                });
            });

            if (Object.keys(poolWeights).length === 0) {
                console.error('No pool weights calculated from votes');
                await waitRemaining(startTime);
                continue;
            }

            userLog(`Pool weights calculated from ${votesData.votes.length} votes`);
            userLog(`Number of unique pools voted for: ${votedPoolIds.size}`);

            // Fetch registry map (includes miners and their ethereum addresses)
            const [registryMap, registryErr] = await fetchRegistryMap();
            if (registryErr) {
                console.error('Error fetching registry map:', registryErr);
                await waitRemaining(startTime);
                continue;
            }

            if (!registryMap || !registryMap.miners) {
                console.error('No registry map data received');
                await waitRemaining(startTime);
                continue;
            }

            if (registryMap.miners.length === 0) {
                console.error('Registry map contains no miners');
                await waitRemaining(startTime);
                continue;
            }

            // Create mappings from registry data
            const uidToHotkey: Record<string, string> = {};
            const hotkeyToEth: Record<string, string> = {};
            const ethereumAddresses: string[] = [];
            const validUIDs: number[] = []; // Track UIDs that exist in registry map

            console.log('DEBUG: First few miners from registry map:', registryMap.miners.slice(0, 3));
            for (let i = 0; i < registryMap.miners.length; i++) {
                const entry = registryMap.miners[i];
                uidToHotkey[i.toString()] = entry.hotkeyAddress;
                validUIDs.push(i); // Add UID to valid list
                
                if (entry.ethereumAddress) {
                    hotkeyToEth[entry.hotkeyAddress] = entry.ethereumAddress.toLowerCase();
                    ethereumAddresses.push(entry.ethereumAddress.toLowerCase());
                }
            }

            userLog(`Registry map contains ${registryMap.miners.length} miners, using UIDs 0-${registryMap.miners.length - 1}`);
            userLog(`Found ${ethereumAddresses.length} linked Ethereum addresses`);

            // Fetch liquidity positions for voted pools
            const [liquidityPositions, liqErr] = await fetchLiquidityPositions(
                ethereumAddresses,
                Array.from(votedPoolIds)
            );

            if (liqErr) {
                console.error('Error fetching liquidity positions:', liqErr);
                await waitRemaining(startTime);
                continue;
            }

            // Log liquidity position information
            const minersWithLiquidity = Object.entries(liquidityPositions)
                .filter(([_, positions]) => positions.length > 0);
            
            userLog(`Found ${minersWithLiquidity.length} miners with liquidity positions in voted pools`);
            minersWithLiquidity.forEach(([address, positions]) => {
                userLog(`Address ${address} has ${positions.length} liquidity positions`);
            });

            if (minersWithLiquidity.length === 0) {
                console.error('No miners have liquidity positions in voted pools');
                await waitRemaining(startTime);
                continue;
            }

            // Normalize pool weights
            const totalWeight = Object.values(poolWeights).reduce((sum, weight) => sum + weight, 0);
            if (totalWeight === 0) {
                console.error('Total pool weight is zero, skipping weight update');
                await waitRemaining(startTime);
                continue;
            }

            Object.keys(poolWeights).forEach(pool => {
                poolWeights[pool] = (poolWeights[pool] / totalWeight) * 10000;
            });

            // Build uid -> positions map using only valid UIDs from registry map
            const uidPositions: Record<string, LiquidityPosition[]> = {};
            for (const uid of validUIDs) {
                const uidStr = uid.toString();
                const hotkey = uidToHotkey[uidStr];
                if (!hotkey) {
                    console.error(`DEBUG: UID ${uidStr} has no hotkey mapping - this should not happen`);
                    uidPositions[uidStr] = [];
                    continue;
                }
                const ethAddress = hotkeyToEth[hotkey];
                const positions = ethAddress ? (liquidityPositions[ethAddress] || []) : [];
                if (!ethAddress) console.log(`DEBUG: UID ${uidStr} (hotkey ${hotkey}) has no Ethereum address mapping`);
                if (!positions.length) console.log(`DEBUG: UID ${uidStr} has no liquidity positions in voted pools`);
                uidPositions[uidStr] = positions;
            }

            // Calculate position scores and final miner weights (by uid)
            const [normalizedPositionScores, normPosErr] = await calculateAndNormalizePoolScores(uidPositions);
            if (normPosErr) {
                console.error('Error calculating position scores:', normPosErr);
                await waitRemaining(startTime);
                continue;
            }

            const [finalMinerWeights, finalWeightsErr] = await calculateFinalMinerWeights(
                uidPositions,
                normalizedPositionScores,
                poolWeights
            );
            if (finalWeightsErr) {
                console.error('Error calculating final miner weights:', finalWeightsErr);
                await waitRemaining(startTime);
                continue;
            }

            // Log final weights for debugging
            console.log('DEBUG: Final miner weights before EMA:');
            Object.entries(finalMinerWeights).forEach(([uid, weight]) => {
                console.log(`  UID ${uid}: ${weight}`);
            });

            // Update EMA weights (by uid)
            emaWeights = updateEma(emaWeights, finalMinerWeights);

            // Check if it's time to set weights
            const timeSinceLastSet = Date.now() - lastSet;
            if (timeSinceLastSet >= SET_INTERVAL_MS) {
                if (!TEST_MODE) {
                    const [setResult, setErr] = await setWeightsOnNetwork(finalMinerWeights);
                    if (setErr) {
                        console.error('Error setting weights:', setErr);
                        consecutiveErrors++;
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                            process.exit(1);
                            return;
                        }
                    } else {
                        userLog('Successfully set weights on network');
                        lastSet = Date.now();
                        consecutiveErrors = 0;
                    }
                } else {
                    userLog('TEST_MODE: Skipping weight setting');
                    lastSet = Date.now();
                    consecutiveErrors = 0;
                }
            }

            await waitRemaining(startTime);
        } catch (err) {
            console.error('Error in main loop:', err);
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                process.exit(1);
                return;
            }
            await delay(LOOP_DELAY_MS);
        }
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
    try {
        // Always save weights to a timestamped JSON file for inspection
        try {
            const weightsDir = path.join(logDir, 'weights');
            await fs.mkdir(weightsDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const filePath = path.join(weightsDir, `${ts}.json`);
            await fs.writeFile(filePath, JSON.stringify({
                weights: normalizedFinalMinerWeights,
                timestamp: new Date().toISOString(),
                testMode: TEST_MODE
            }, null, 2));
            userLog(`Weights saved to ${filePath}`);
        } catch (fileErr) {
            console.error('Failed to write weights file:', fileErr);
        }

        if (TEST_MODE) {
            console.log('[TEST_MODE] Skipping setWeightsOnNetwork call. Weights that would be set:', JSON.stringify(normalizedFinalMinerWeights, null, 2));
            return [normalizedFinalMinerWeights, null];
        }

        if (!btApi || !signer) {
            const error = new Error('Bittensor API not initialized');
            console.error(error);
            return [{}, error];
        }

        // Verify API connection is still active
        try {
            await btApi.rpc.chain.getHeader();
        } catch (apiErr) {
            const error = new Error(`Bittensor API connection lost: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`);
            console.error(error);
            return [{}, error];
        }

        let entries = Object.entries(normalizedFinalMinerWeights);

        if (entries.length === 0) {
            console.warn('No miner weight data found – falling back to uniform weights across all registered UIDs.');
            const [uidsFallback, uidErr] = await fetchAllUids();
            if (uidErr) {
                console.error('Failed to fetch UIDs for fallback:', uidErr);
                return [{}, uidErr];
            }
            if (uidsFallback.length === 0) {
                const error = new Error('Unable to determine UIDs for uniform weight distribution');
                console.error(error);
                return [{}, error];
            }

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
        if (totalScaled === 0) {
            const error = new Error('All scaled weights are zero');
            console.error(error);
            return [{}, error];
        }
        if (totalScaled !== 65535) {
            scaled = scaled.map(w => Math.round((w * 65535) / totalScaled));
        }

        const header = await btApi.rpc.chain.getHeader();
        const versionKey = header.number.toNumber();
        console.log('Setting weights on network...');
        console.log('Uids:', uids);
        console.log('Scaled:', scaled);
        console.log('Version key:', versionKey);

        // Submit extrinsic with timeout
        const txPromise = new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Transaction timeout after 5 minutes'));
            }, 300000); // 5 minute timeout

            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore – dynamic lookup of pallet in generated types
            const tx = btApi.tx.subtensorModule.setWeights(NETUID, uids, scaled, versionKey);

            tx.signAndSend(signer!, { nonce: -1 }, (result: ISubmittableResult) => {
                if (result.status.isFinalized || result.status.isInBlock) {
                    clearTimeout(timeoutId);
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
                    clearTimeout(timeoutId);
                    reject(new Error('Transaction error'));
                }
            }).catch(err => {
                clearTimeout(timeoutId);
                reject(err);
            });
        });

        await txPromise;
        return [normalizedFinalMinerWeights, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Error in setWeightsOnNetwork:', error);
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

                if (!poolId || typeof poolId !== 'string') continue;

                const normalizedScore = normalizedPositionScores[positionId] ?? 0;
                let voteWeight = 0;
                try {
                    const checksummedPoolId = getAddress(poolId);
                    voteWeight = poolWeights[checksummedPoolId] || 0;
                } catch (e) {
                    voteWeight = 0;
                }

                const contribution = normalizedScore * voteWeight;
                minerTotalContribution += contribution;
            }
            finalMinerWeights[minerId] = minerTotalContribution;
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

        // Normalize weights to sum to 1
        if (totalWeight > 0) {
            console.log("Normalizing final miner weights...");
            for (const minerId in finalMinerWeights) {
                finalMinerWeights[minerId] = finalMinerWeights[minerId] / totalWeight;
            }
        } else {
            console.log("Total weight is 0, skipping normalization. All miner weights are 0.");
        }

        console.log("Finished calculating and normalizing final miner weights.");
        return [finalMinerWeights, null];

    } catch (err) {
        console.error(`Error calculating final miner weights: ${err}`);
        const error = err instanceof Error ? err : new Error("Failed to calculate final miner weights");
        return [{}, error];
    }
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

    // Check for one-sided positions by validating token balances
    const token0Balance = Number(position.token0Balance || "0");
    const token1Balance = Number(position.token1Balance || "0");
    const minTokenThreshold = 1e-6; // Minimum threshold for considering a token balance valid
    
    if (token0Balance <= minTokenThreshold || token1Balance <= minTokenThreshold) {
        console.warn(`Cannot calculate score for position ${position.id}: one-sided position detected (token0Balance=${token0Balance}, token1Balance=${token1Balance})`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: position.pool.id || "", pairKey: "" };
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
    console.log(`    - Token Balances: token0=${token0Balance.toFixed(6)}, token1=${token1Balance.toFixed(6)}`);
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

async function fetchVotesFromServer(): Promise<[VotesResponse | null, Error | null]> {
    const now = Date.now();
    
    // Return cached data if it exists and is not expired
    if (cachedVotes && (now - cachedVotes.timestamp) < CACHE_DURATION_MS) {
        userLog('Using cached votes data');
        return [cachedVotes.data, null];
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            userLog(`Fetching fresh votes data from server (attempt ${attempt}/${maxRetries})`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

            const response = await fetch('https://77.creativebuilds.io/allVotes', {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Server responded with status ${response.status}: ${response.statusText}`);
            }

            // Debug: Log response headers
            console.log('DEBUG: Response headers:', Object.fromEntries(response.headers.entries()));
            console.log('DEBUG: Content-Type:', response.headers.get('content-type'));

            const data = await response.json() as VotesResponse;
            
            // Debug: Log the raw response structure
            console.log('DEBUG: Raw response from server:', JSON.stringify(data, null, 2));
            console.log('DEBUG: votes property type:', typeof data.votes);
            console.log('DEBUG: votes property value:', data.votes);
            
            if (!data.success) {
                throw new Error(data.error || 'Failed to fetch votes');
            }
            
            // Update cache
            cachedVotes = {
                data,
                timestamp: now
            };
            
            return [data, null];
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (err instanceof Error && err.name === 'AbortError') {
                console.error('Request timed out');
            } else {
                console.error(`Attempt ${attempt} failed:`, lastError);
            }
            
            if (attempt < maxRetries) {
                const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                await delay(delayMs);
            }
        }
    }

    // If we have cached data but it's expired, use it as fallback
    if (cachedVotes) {
        console.warn('Using expired cached data due to fetch failures');
        return [cachedVotes.data, null];
    }

    return [null, lastError];
}

async function fetchLiquidityPositions(
  ethereumAddresses: string[],
  votedPoolIds: string[]
): Promise<[Record<string, LiquidityPosition[]>, Error | null]> {
  const positions: Record<string, LiquidityPosition[]> = {};
  
  try {
    for (const address of ethereumAddresses) {
      const variables = {
        owner: address.toLowerCase(),
        poolIds: votedPoolIds
      };

      const data = await UNISWAP_V3_CLIENT.request<UniswapResponse>(POSITIONS_QUERY, variables);
      if (data.positions && data.positions.length > 0) {
        positions[address] = data.positions.map(pos => ({
          id: pos.id,
          owner: pos.owner,
          token0: {
            id: pos.pool.token0.id,
            symbol: pos.pool.token0.symbol,
            decimals: pos.pool.token0.decimals,
            name: pos.pool.token0.name || pos.pool.token0.symbol
          },
          token1: {
            id: pos.pool.token1.id,
            symbol: pos.pool.token1.symbol,
            decimals: pos.pool.token1.decimals,
            name: pos.pool.token1.name || pos.pool.token1.symbol
          },
          liquidity: pos.liquidity,
          token0Balance: pos.token0Balance,
          token1Balance: pos.token1Balance,
          tickLower: {
            id: pos.tickLower.id,
            tickIdx: pos.tickLower.tickIdx
          },
          tickUpper: {
            id: pos.tickUpper.id,
            tickIdx: pos.tickUpper.tickIdx
          },
          pool: {
            feeTier: pos.pool.feeTier,
            id: pos.pool.id,
            tick: pos.pool.tick
          }
        }));
      }
    }
    return [positions, null];
  } catch (err) {
    return [{}, err instanceof Error ? err : new Error(String(err))];
  }
}

async function fetchRegistryMap(): Promise<[RegistryMapResponse | null, Error | null]> {
  try {
    const response = await fetch('https://77.creativebuilds.io/allMiners');
    const data = await response.json() as RegistryMapResponse;
    
    if (!data.success) return [null, new Error(data.error || 'Failed to fetch miners')];
    return [data, null];
  } catch (err) {
    return [null, err instanceof Error ? err : new Error(String(err))];
  }
}

main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
});