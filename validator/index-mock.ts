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

import { encodeAddress } from '@polkadot/util-crypto';
import dotenv from 'dotenv';

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
    tickLower: string;
    tickUpper: string;
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
                    poolAddress: pos.poolAddress,
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

    // DEV: Not currently used but can be used to test
    function _getTestData(): Record<string, VotePosition[]> {
        // Using example SS58 addresses and mock Token Addresses
        return {
            "5FsXmaa5wK2nS5bQgeoNcG4gBDSMcPZw3LmsphThduPpaD7K": [
                {
                    poolAddress: "0xTokenA",
                    weight: 1
                },
                {
                    poolAddress: "0xTokenB", // Same address can vote on multiple pairs
                    weight: 10
                }
            ],
            "5FeuK7vBUVywnNxwWbpNw86qpZp9aUJFAQEUz51Kmj3hMT9Z": [
                {
                    poolAddress: "0xTokenB", // Ensure canonical order doesn't matter here
                    weight: 1
                }
            ],
            "5Do8jG4GWWkR7v5SphLh4AzB5D34AzgDcH3ELoMiAHmAofxD": [
                {
                    poolAddress: "0xTokenC",
                    weight: 3
                }
            ]
        };
    }

    /**
     * 
     * @param votePositions 
     * @returns Mocked balances for each address that has voted on a pool
     */
    async function fetchBalances(votePositions: Record<string, VotePosition[]>): Promise<[Record<string, Balance>, Error | null]> {
        const addresses = Object.keys(votePositions);
        if (addresses.length === 0) {
            console.log("No addresses provided to fetch balances for.");
            return [{}, null]; // No addresses, return empty map
        }

        try {
            // TODO: Get real balances from taostats API (e.g., https://taostats.io/api/balances?netuid=77)
            // MOCKED implementation:
            console.log('Fetching (mock) balances for addresses:', addresses);
            const mockBalances: Record<string, Balance> = {};
            for (const address of addresses) {
                mockBalances[address] = {
                    address: address,
                    balance: Math.floor(Math.random() * 9000) + 1000 // Random balance 1000-9999
                };
            }
            console.log('Created mock balances.'); // Simplified log
            return [mockBalances, null];

        } catch (err) {
            console.error('Error fetching/creating mock balances:', err);
            const error = err instanceof Error ? err : new Error('Failed to fetch/create balances');
            return [{}, error];
        }
    }
    // const [positions, positionsErr] = await fetchVotePositions();
    // if (positionsErr) return [null, new Error(`Failed to fetch positions: ${positionsErr.message}`)];

    const positions = _getTestData();

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
    console.log("Step 5: Fetching miner ETH addresses (mock)...");
    const [minerAddresses, minerAddressesErr] = await getMinerAddresses(miners);
    if (minerAddressesErr) return [undefined, new Error(`Failed run: ${minerAddressesErr.message}`)];
    // console.log("Step 5: Miner addresses fetched.", minerAddresses); // Less verbose log

    // 6. Get Miner Liquidity Positions
    console.log("Step 6: Fetching miner liquidity positions (mock)...");
    const [minerLiquidityPositions, minerLiquidityPositionsErr] = await getMinerLiquidityPositions(minerAddresses);
    if (minerLiquidityPositionsErr) return [undefined, new Error(`Failed run: ${minerLiquidityPositionsErr.message}`)];
    // console.log("Step 6: Miner liquidity positions generated."); // Less verbose log

    // 7. Calculate Miner Scores (Weighted by Pool Votes)
    console.log("Step 7: Calculating miner scores (weighted by pool votes)...");
    // Pass poolWeights here
    const [minerScores, minerScoresErr] = await getMinerScores(minerLiquidityPositions, poolWeights); 
    if (minerScoresErr) return [undefined, new Error(`Failed run: ${minerScoresErr.message}`)];
    console.log("Miner Scores (Vote-Weighted Total per Miner):", minerScores);

    // 8. Normalize Miner Scores to get Final Weights
    console.log("Step 8: Normalizing miner scores to get final weights...");
    const finalMinerWeights = normalizeScores(minerScores);
    console.log("Final Normalized Miner Weights:", finalMinerWeights);

    // 9. TODO: Set Weights on Network
    console.log("Step 9: TODO - Set calculated final weights (`finalMinerWeights`) on the network.");

    console.log("--- Validator Run Completed Successfully (with Mock Data/Placeholders) ---");
    return [undefined, null]; // Success
}

/**
 * Normalizes a record of scores (minerId -> score) so they sum to 1.
 */
function normalizeScores(scores: Record<string, number>): Record<string, number> {
    const totalScore = Object.values(scores).reduce((acc, score) => acc + score, 0);
    if (totalScore === 0) {
        console.warn("Total weighted score is 0, cannot normalize. Assigning equal weights (or 0 if no miners).");
        const numMiners = Object.keys(scores).length;
        if (numMiners === 0) return {};
        // Return equal weights if total is 0 but miners exist
        return Object.fromEntries(Object.keys(scores).map(key => [key, 1 / numMiners])); 
    }
    return Object.fromEntries(Object.entries(scores).map(([key, score]) => [key, score / totalScore]));
}

/**
 * Calculates the total *vote-weighted* final score for each miner based on their liquidity positions
 * and the vote weights assigned to each pool/pair.
 * @param minerLiquidityPositions Map of miner ID to their liquidity positions.
 * @param poolWeights Map of canonical pair key to its normalized vote weight (0-1).
 */
async function getMinerScores(
    minerLiquidityPositions: Record<string, LiquidityPosition[]>,
    poolWeights: Record<string, number> // Added poolWeights parameter
): Promise<Result<Record<string, number>>> { 
    // REMOVED: No longer using a single illustrative tick here.
    // const currentTick = 14485; 
    const minerTotalWeightedScores: Record<string, number> = {}; // Renamed for clarity
    try {
        console.log("Calculating vote-weighted miner scores using pool-specific ticks...");
        console.log("Using Pool Weights:", poolWeights);
        for (const [minerId, minerPositions] of Object.entries(minerLiquidityPositions)) {
            if (!minerPositions || minerPositions.length === 0) {
                minerTotalWeightedScores[minerId] = 0; // Assign 0 score if no positions
                console.log(`  Miner ${minerId}: 0 score (no positions)`);
                continue;
            }

            let totalWeightedScore = 0;
            console.log(`--- Calculating scores for Miner ${minerId} ---`);
            for (const pos of minerPositions) {
                // --- Use the tick specific to this position's pool ---
                if (!pos.pool?.tick) {
                    console.warn(`Skipping position ${pos.id} for miner ${minerId}: Missing pool tick information.`);
                    continue; // Skip if tick info is missing
                }
                const poolCurrentTick = Number(pos.pool.tick);
                if (isNaN(poolCurrentTick)) {
                    console.warn(`Skipping position ${pos.id} for miner ${minerId}: Invalid pool tick (${pos.pool.tick}).`);
                    continue; // Skip if tick is not a valid number
                }
                // -----------------------------------------------------

                const rawScore = calculatePositionScore(pos, poolCurrentTick); // Use pool's tick
                const pairKey = rawScore.pairKey; // Get pairKey from the score object
                const voteWeight = poolWeights[pairKey] || 0; // Get vote weight, default to 0

                // Calculate vote-weighted score for this position
                const weightedScore = rawScore.finalScore * voteWeight;
                totalWeightedScore += weightedScore;

                console.log(`  Pos ${pos.id} (${pairKey}) using Tick ${poolCurrentTick}: Raw Score=${rawScore.finalScore.toFixed(4)}, Vote Weight=${voteWeight.toFixed(4)}, Weighted Score=${weightedScore.toFixed(4)}`);
            }
            minerTotalWeightedScores[minerId] = totalWeightedScore;
            console.log(`--- Miner ${minerId} Total Weighted Score: ${totalWeightedScore.toFixed(4)} ---`);
        }
        return [minerTotalWeightedScores, null];
    } catch (err) {
        console.error(`Error calculating miner scores: ${err}`);
        const error = err instanceof Error ? err : new Error("Failed to calculate miner scores");
        return [{}, error];
    }
}

async function getMinerLiquidityPositions(minerAddresses: Record<string, string>): Promise<Result<Record<string, LiquidityPosition[]>>> {
     const minerIds = Object.keys(minerAddresses);
     if (minerIds.length === 0) {
        console.log("No miner addresses provided to fetch liquidity positions for.");
        return [{}, null];
    }
    try {
        console.log("Fetching (mock) miner liquidity positions...");
        const minerLiquidityPositions: Record<string, LiquidityPosition[]> = {};

        // Mock Token Definitions (replace with actual addresses if needed)
        const tokenA = { decimals: "18", id: "0xTokenA", name: "Token A", symbol: "TKA" };
        const tokenB = { decimals: "18", id: "0xTokenB", name: "Token B", symbol: "TKB" };
        const tokenC = { decimals: "6", id: "0xTokenC", name: "Token C", symbol: "TKC" }; // Example different decimals

        // Mock Pool IDs (derived from tokens)
        const poolAB = `pool-${[tokenA.id, tokenB.id].sort().join('-')}`;
        const poolAC = `pool-${[tokenA.id, tokenC.id].sort().join('-')}`;

        // Example current ticks for mock pools (can be adjusted)
        const poolABTick = "15000"; // Example tick
        const poolACTick = "-5000"; // Example tick

        for (const [minerId, minerAddress] of Object.entries(minerAddresses)) {
             // DEVELOPER NOTE: Replace with actual query to a Uniswap V3 compatible subgraph
             // using the minerAddress (ETH address) to filter positions by owner.
            
             // --- Generate Unique Mock Positions Per Miner ---
             let mockPositions: LiquidityPosition[] = [];
             const minerNum = parseInt(minerId); // Use minerId to vary positions

             // Miner 1: Concentrated in A/B, smaller position in A/C
             if (minerNum === 1) {
                 mockPositions = [
                    // Position in A/B (Only Miner 1 has this)
                     {
                         id: `mockPos1-miner${minerId}`,
                         liquidity: "250000000000", 
                         owner: minerAddress,
                         pool: { feeTier: "3000", id: poolAB, tick: poolABTick, token0Price: "1.01", token1Price: "0.99" }, 
                         tickLower: "14800", tickUpper: "15200", 
                         token0: tokenA, token1: tokenB, 
                     },
                     // Position in A/C
                     {
                         id: `mockPos2-miner${minerId}`,
                         liquidity: "50000000000", 
                         owner: minerAddress,
                         pool: { feeTier: "10000", id: poolAC, tick: poolACTick, token0Price: "50.5", token1Price: "0.0198" },
                         tickLower: "-6000", tickUpper: "-4000", 
                         token0: tokenA, token1: tokenC, 
                     },
                 ];
             }
             // Miner 2: Only A/C position
             else if (minerNum === 2) {
                 mockPositions = [
                     // Removed A/B position
                     // Add a different A/C position for variety
                     {
                         id: `mockPos1-miner${minerId}`,
                         liquidity: "100000000000", // Example liquidity 
                         owner: minerAddress,
                         pool: { feeTier: "10000", id: poolAC, tick: poolACTick, token0Price: "50.5", token1Price: "0.0198" },
                         tickLower: "-7000", tickUpper: "-3000", // Wider range
                         token0: tokenA, token1: tokenC,
                     },
                 ];
             }
             // Miner 3: Only A/C position
             else if (minerNum === 3) {
                 mockPositions = [
                     // Removed A/B position
                     // Keep existing A/C position
                     {
                         id: `mockPos2-miner${minerId}`,
                         liquidity: "150000000000",
                         owner: minerAddress,
                         pool: { feeTier: "10000", id: poolAC, tick: poolACTick, token0Price: "50.5", token1Price: "0.0198" },
                         tickLower: "-5500", tickUpper: "-4500", 
                         token0: tokenA, token1: tokenC,
                     },
                 ];
             }
             // Default for any other miners: No A/B position
             else {
                 mockPositions = [
                     // Default position (e.g., in A/C or another pool, but not A/B)
                     {
                         id: `mockPos1-miner${minerId}`,
                         liquidity: "10000000000", // Low liquidity
                         owner: minerAddress,
                         pool: { feeTier: "10000", id: poolAC, tick: poolACTick, token0Price: "50.5", token1Price: "0.0198" },
                         tickLower: "-10000", tickUpper: "0", // Very wide range
                         token0: tokenA, token1: tokenC,
                     }
                 ];
             }

            // --- Calculate Scores for Mock Positions ---
            // Use a fixed, illustrative tick for scoring demonstration.
            const illustrativeCurrentTick = 14485; // Using a positive tick example now

            console.log(`--- Scores for Miner ${minerId} (ETH: ${minerAddress}, Illustrative Tick: ${illustrativeCurrentTick}) ---`);
            mockPositions.forEach(pos => {
                if (!pos.pool || typeof pos.tickLower === 'undefined' || typeof pos.tickUpper === 'undefined' || typeof pos.liquidity === 'undefined') {
                    console.warn(`Skipping scoring for position ${pos.id} due to missing data.`);
                    return;
                }
                 try {
                    const score = calculatePositionScore(pos, illustrativeCurrentTick);
                    console.log(`  Pos ${pos.id} (${pos.token0.symbol}/${pos.token1.symbol}) [${pos.tickLower}-${pos.tickUpper}] Score: ${score.finalScore.toFixed(4)} (Gaussian: ${score.gaussianMultiplier.toFixed(4)})`);
                } catch (scoreError) {
                     console.error(`Error calculating score for position ${pos.id}:`, scoreError);
                }
            });
             console.log(`--- End Scores for Miner ${minerId} ---`);
            // ------------------------------------------

            minerLiquidityPositions[minerId] = mockPositions;
        }

        console.log("Generated distinct (mock) miner liquidity positions.");
        return [minerLiquidityPositions, null];
    } catch (err) {
        console.error("Error generating/fetching miner liquidity positions:", err);
        const error = err instanceof Error ? err : new Error("Failed to generate/fetch miner liquidity positions");
        return [{}, error];
    }
}


async function getMinerAddresses(miners: Record<string, string>): Promise<Result<Record<string, string>>> {
    const minerIds = Object.keys(miners);
     if (minerIds.length === 0) {
        console.log("No miners provided to fetch addresses for.");
        return [{}, null];
    }
    try {
        console.log("Fetching (mock) miner Ethereum addresses...");
        // Mock data: Map Miner ID -> ETH Address
        const minerAddresses: Record<string, string> = {};
        let counter = 1; // Simple counter for unique mock addresses
        for (const minerId of minerIds) {
             const ss58Address = miners[minerId];
             // DEVELOPER NOTE: Replace this with actual logic to look up the registered ETH address
             // corresponding to the ss58Address (e.g., query database or API).
             // Example using a simple, unique mock ETH address:
             const mockEthAddress = `0x${'0'.repeat(38)}${counter.toString(16).padStart(2, '0')}`; // Creates 0x00...00, 0x00...01, etc.
             minerAddresses[minerId] = mockEthAddress;
             console.log(`  Mock mapping: Miner ${minerId} (SS58: ${ss58Address}) -> Mock ETH: ${mockEthAddress}`);
             counter++;
        }

        console.log("Fetched (mock) miner addresses.");
        return [minerAddresses, null];
    } catch (err) {
        console.error("Error fetching miner addresses:", err);
        const error = err instanceof Error ? err : new Error("Failed to fetch miner addresses");
        return [{}, error];
    }
}

async function getMiners(): Promise<[Record<string, string>, Error | null]> {
    try {
        // TODO: Implement actual miner fetching logic
        // Mock data for demonstration
        const minerMap: Record<string, string> = {
            "1": encodeAddress("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"),
            "2": encodeAddress("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"),
            "3": encodeAddress("5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y")
        };
        
        console.log("Fetched miners:", minerMap);
        return [minerMap, null];
    } catch (err) {
        console.error("Error fetching miners:", err);
        return [{}, err instanceof Error ? err : new Error("Failed to fetch miners")];
    }
}

// --- Calculation Functions ---

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
    if (!position.pool || typeof position.tickLower === 'undefined' || typeof position.tickUpper === 'undefined' || typeof position.liquidity === 'undefined') {
        console.warn(`Cannot calculate score for position ${position.id}: missing essential data (pool, tickLower, tickUpper, or liquidity).`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }

    // Convert string numbers to actual numbers and validate
    const tickLower = Number(position.tickLower);
    const tickUpper = Number(position.tickUpper);
    const liquidityRaw = Number(position.liquidity);
    const poolId = position.pool.id;
    const pairKey = position.token0.id < position.token1.id ? `${position.token0.id}-${position.token1.id}` : `${position.token1.id}-${position.token0.id}`;

    if (isNaN(tickLower) || isNaN(tickUpper) || isNaN(liquidityRaw) || isNaN(currentTick)) {
         console.warn(`Cannot calculate score for position ${position.id}: invalid numeric data (tickLower=${position.tickLower}, tickUpper=${position.tickUpper}, liquidity=${position.liquidity}, or currentTick=${currentTick}).`);
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


    // Calculate Gaussian score based on the determined distance (0 if in range, distance to edge if out).
    const gaussianMultiplier = gaussianScore(distanceForGaussian, GAUSSIAN_AMPLITUDE, stdDev);


    // Normalize liquidity amount
    const liquidityAmount = liquidityRaw / LIQUIDITY_NORMALIZATION_FACTOR;


    // Final score combines proximity (Gaussian) and magnitude (Liquidity)
    const finalScore = gaussianMultiplier * liquidityAmount;


    // DEVELOPER NOTE: Add logging here if needed for debugging scores
    // console.log(`Score for Pos ${position.id}: InRange=${isInRange}, Dist=${distanceForGaussian}, Gaussian=${gaussianMultiplier.toFixed(4)}, Liq=${liquidityAmount.toFixed(4)}, Final=${finalScore.toFixed(4)}`);
    // Removed temporary log: console.log("poolId", position);

    return {
        gaussianMultiplier,
        liquidityAmount,
        finalScore,
        poolId: poolId,
        pairKey: pairKey
    };
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