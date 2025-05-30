/**
 * Subnet77 Pool Weights Query Script
 * 
 * This script allows anyone to query the current weights of all active pools
 * in the Subnet77 Liquidity Auction without needing to run a validator.
 * 
 * Usage: bun run pools
 * 
 * Required Environment Variables:
 * - SUBGRAPH_URL: Graph endpoint for the ClaimVote subgraph
 * - TAOSTATS_API_KEY: API key for Taostats balance endpoint
 * 
 * Optional Environment Variables:
 * - LOG=true               # Enable verbose logging from utils/poolWeights
 * 
 * The script will:
 * 1. Fetch vote positions via The Graph (ClaimVote subgraph)
 * 2. Fetch token-holder balances from Taostats
 * 3. Compute normalized weights for every pool and display them
 */

import * as dotenv from 'dotenv';
import { computePoolWeights } from '../utils/poolWeights';

dotenv.config();

function formatPercentage(value: number): string {
  return (value * 100).toFixed(4) + '%';
}

async function main(): Promise<void> {
  console.log('🔍 Computing Subnet77 pool weights (off-chain)...\n');

  const [[normalized, raw], err] = await computePoolWeights();
  if (err) {
    console.error('❌ Failed to compute pool weights:', err.message);
    process.exit(1);
  }

  const ranked = Object.entries(normalized).sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    console.log('No pool weights found. Ensure votes exist on the ClaimVote contract and SUBGRAPH_URL is correct.');
    return;
  }

  console.log('📈 Current Pool Weights (normalized):\n');
  console.log('Rank'.padEnd(6) + 'Pool Address'.padEnd(44) + 'Weight');
  console.log('-'.repeat(80));

  ranked.forEach(([address, weight], idx) => {
    console.log(`${idx + 1}`.padEnd(6) + address.padEnd(44) + formatPercentage(weight));
  });

  console.log('-'.repeat(80));
  console.log(`Total Pools: ${ranked.length}`);
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main().catch(console.error);
}
