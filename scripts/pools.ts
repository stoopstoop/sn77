import { formatAddress } from '../utils/poolUtils';
import * as fs from 'fs';
import * as readline from 'readline';

const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://77.creativebuilds.io';

interface Voter {
  address: string;
  weight: number;
  alphaBalance: number;
  weightMultiplier: number;
}

interface Pool {
  address: string;
  totalWeight: number;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  voters: Voter[];
}

interface PoolsResponse {
  success: boolean;
  pools: Pool[];
  totalPools: number;
  totalVoters: number;
  totalAlphaTokens: number;
  cached: boolean;
  error?: string;
}

async function fetchPools(): Promise<[PoolsResponse | null, string | null]> {
  try {
    const response = await fetch(`${PRODUCTION_URL}/pools`);
    if (!response.ok) {
      return [null, `HTTP error! status: ${response.status}`];
    }
    
    const data: PoolsResponse = await response.json();
    if (!data.success) {
      return [null, data.error || 'Unknown error from API'];
    }
    
    return [data, null];
  } catch (error) {
    return [null, `Network error: ${error}`];
  }
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function formatAlphaBalance(alphaBalance: number): string {
  return (alphaBalance / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatPercentage(num: number): string {
  return `${(num / 10000 * 100).toFixed(2)}%`;
}

function formatWeightPercentage(weight: number): string {
  const percentage = weight / 10000 * 100;
  if (percentage >= 100) return `${percentage.toFixed(2)}%`;
  if (percentage >= 10) return `${percentage.toFixed(2)}%`;
  if (percentage >= 1) return `${percentage.toFixed(3)}%`;
  return `${percentage.toFixed(4)}%`;
}

function formatFee(fee: number): string {
  return `${(fee / 10000).toFixed(2)}%`;
}

function displayPoolsTable(pools: Pool[], totalAlphaTokens: number): void {
  console.log('\n📊 Pool Information\n');
  
  if (pools.length === 0) {
    console.log('No active pools found.');
    return;
  }

  console.log(`Total Pools: ${pools.length} | Total Alpha Tokens: ${formatAlphaBalance(totalAlphaTokens)}\n`);

  pools.forEach((pool, index) => {
    const poolAddress = formatAddress(pool.address);
    const tokenPair = `${pool.token0Symbol}/${pool.token1Symbol}`;
    const fee = formatFee(pool.fee);
    const totalWeight = formatWeightPercentage(pool.totalWeight);
    const voterCount = pool.voters.length;

    console.log(`🏊 Pool ${index + 1}:`);
    console.log(`   Address: ${poolAddress}`);
    console.log(`   Pair: ${tokenPair}`);
    console.log(`   Fee: ${fee}`);
    console.log(`   Total Weight: ${totalWeight}`);
    console.log(`   Voters: ${voterCount}`);

    if (pool.voters.length > 0) {
      console.log('   Voter Details:');
      pool.voters.forEach((voter, voterIndex) => {
        const voterAddress = formatAddress(voter.address);
        const weight = formatNumber(voter.weight);
        const alphaBalance = formatAlphaBalance(voter.alphaBalance);
        const multiplier = voter.weightMultiplier.toFixed(4);
        
        console.log(`     ${voterIndex + 1}. ${voterAddress}`);
        console.log(`        Weight: ${weight} | Alpha: ${alphaBalance} | Multiplier: ${multiplier}`);
      });
    }
    
    console.log('');
  });
}

function generatePoolCSV(pools: Pool[]): string {
  const headers = ['Pool Address', 'Token Pair', 'Fee (%)', 'Total Weight (%)', 'Voter Count'];
  const rows = pools.map(pool => [
    pool.address,
    `${pool.token0Symbol}/${pool.token1Symbol}`,
    (pool.fee / 10000).toFixed(2),
    formatWeightPercentage(pool.totalWeight).replace('%', ''),
    pool.voters.length.toString()
  ]);
  
  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
}

function savePoolCSV(pools: Pool[]): void {
  const csvContent = generatePoolCSV(pools);
  const filename = `pools_${new Date().toISOString().split('T')[0]}.csv`;
  
  try {
    fs.writeFileSync(filename, csvContent);
    console.log(`✅ Pool data saved to ${filename}`);
  } catch (error) {
    console.error('❌ Error saving CSV file:', error);
  }
}

async function askForCSVSave(pools: Pool[]): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\n💾 Would you like to save pool data to CSV? (y/n): ', (answer) => {
      rl.close();
      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        savePoolCSV(pools);
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  console.log('🔍 Fetching pool information...');
  
  const [poolsData, error] = await fetchPools();
  if (error) {
    console.error('❌ Error fetching pools:', error);
    process.exit(1);
  }

  if (!poolsData) {
    console.error('❌ No data received');
    process.exit(1);
  }

  displayPoolsTable(poolsData.pools, poolsData.totalAlphaTokens);
  
  if (poolsData.cached) {
    console.log('💡 Data served from cache');
  }

  await askForCSVSave(poolsData.pools);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  }); 