/**
 * Subnet77 Pool Weights Query Script
 * 
 * This script allows anyone to query the current weights of all active pools
 * in the Subnet77 Liquidity Auction without needing to run a validator.
 * 
 * Usage: bun run pools
 * 
 * Required Environment Variables:
 * - SUBGRAPH_URL: Graph endpoint for the SeventySevenV1 subgraph
 * - TAOSTATS_API_KEY: API key for Taostats balance endpoint
 * - THEGRAPH_API_KEY: API key for The Graph network (for Uniswap V3 data)
 * 
 * Optional Environment Variables:
 * - LOG=true               # Enable verbose logging from utils/poolWeights
 * 
 * The script will:
 * 1. Fetch vote positions via The Graph (SeventySevenV1 subgraph)
 * 2. Fetch token-holder balances from Taostats
 * 3. Compute normalized weights for every pool and display them
 * 4. Fetch miner liquidity positions from Uniswap V3
 * 5. Aggregate and display total token amounts per pool
 */

import { parseUnits } from 'ethers';
import { computePoolWeights } from '../utils/poolWeights';
import { getMiners, getMinerAddresses, getMinerLiquidityPositions, type LiquidityPosition } from '../utils/miners';


interface PoolLiquidityData {
  totalToken0: bigint;
  totalToken1: bigint;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  positionCount: number;
  feeTier: number;
}

function formatPercentage(value: number): string {
  return (value * 100).toFixed(2) + '%';
}

function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTokenAmount(amount: bigint, decimals: number, symbol: string): string {
  if (decimals === 0) return `${amount.toString()} ${symbol}`;

  // Compute divisor as 10^decimals using BigInt exponentiation
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = amount / divisor;
  const fractional = amount % divisor;

  const wholeDigits = whole.toString().length;
  const decimalsToShow = Math.max(2, Math.min(6, 6 - (wholeDigits - 1)));

  const fractionalStr = fractional
    .toString()
    .padStart(decimals, '0')
    .slice(0, decimalsToShow)
    .replace(/0+$/, ''); // trim trailing zeros

  const fractionalDisplay = fractionalStr.length ? `.${fractionalStr}` : '';
  return `${whole.toString()}${fractionalDisplay} ${symbol}`;
}

function aggregateLiquidityByPool(positions: Record<string, LiquidityPosition[]>): Record<string, PoolLiquidityData> {
  const poolData: Record<string, PoolLiquidityData> = {};

  for (const minerPositions of Object.values(positions)) {
    for (const position of minerPositions) {
      if (!position.pool?.id) continue;
      
      const poolId = position.pool.id.toLowerCase();
      
      if (!poolData[poolId]) {
        poolData[poolId] = {
          totalToken0: BigInt(0),
          totalToken1: BigInt(0),
          token0Symbol: position.token0.symbol,
          token1Symbol: position.token1.symbol,
          token0Decimals: parseInt(position.token0.decimals),
          token1Decimals: parseInt(position.token1.decimals),
          positionCount: 0,
          feeTier: Number.isFinite(parseInt(position.pool.feeTier)) ? parseInt(position.pool.feeTier) : NaN
        };
      }
      
      poolData[poolId].totalToken0 += parseUnits(position.depositedToken0, poolData[poolId].token0Decimals);
      poolData[poolId].totalToken1 += parseUnits(position.depositedToken1, poolData[poolId].token1Decimals);
      poolData[poolId].positionCount++;
    }
  }

  return poolData;
}

interface PoolMetadata {
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  feeTier: number;
}

async function fetchPoolMetadata(poolIds: string[]): Promise<Record<string, PoolMetadata>> {
  const apiKey = process.env.THEGRAPH_API_KEY;
  if (!apiKey || poolIds.length === 0) return {};

  const subgraphId = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
  const url = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;

  const out: Record<string, PoolMetadata> = {};
  const batchSize = 50;

  for (let i = 0; i < poolIds.length; i += batchSize) {
    const ids = poolIds.slice(i, i + batchSize).map(id => id.toLowerCase());
    const query = `query($ids:[String!]!){pools(where:{id_in:$ids}){id feeTier token0{symbol decimals} token1{symbol decimals}}}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, variables: { ids } }),
      });
      const text = await res.text();
      if (!res.ok) continue;
      const json = JSON.parse(text);
      const pools = json.data?.pools ?? [];
      for (const p of pools) {
        out[p.id.toLowerCase()] = {
          token0Symbol: p.token0.symbol,
          token1Symbol: p.token1.symbol,
          token0Decimals: parseInt(p.token0.decimals),
          token1Decimals: parseInt(p.token1.decimals),
          feeTier: Number.isFinite(parseInt(p.feeTier)) ? parseInt(p.feeTier) : NaN,
        };
      }
    } catch {}
  }
  return out;
}

async function main(): Promise<void> {
  // Lazy import ESM/CJS modules to maintain CommonJS compatibility
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: dynamic import
  const chalk = (await import('chalk')).default as typeof import('chalk').default;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: dynamic import
  const Table = (await import('cli-table3')).default as typeof import('cli-table3');

  console.log(chalk.cyan('🔍 Computing Subnet77 pool weights (off-chain)...\n'));

  // Compute pool weights
  const [[normalized, raw], err] = await computePoolWeights();
  if (err) {
    console.error('❌ Failed to compute pool weights:', err.message);
    process.exit(1);
  }

  const rankedWeights = Object.entries(normalized).sort((a, b) => b[1] - a[1]);

  if (rankedWeights.length === 0) {
    console.log('No pool weights found. Ensure votes exist on the SeventySevenV1 contract and SUBGRAPH_URL is correct.');
    return;
  }

  // Get pool addresses for liquidity queries
  const poolAddresses = rankedWeights.map(([address]) => address);

  
  const [miners, minersErr] = await getMiners();
  if (minersErr) {
    console.warn('⚠️  Failed to fetch miners:', minersErr.message);
  }

  const [minerAddresses, addressesErr] = await getMinerAddresses(miners);
  if (addressesErr) {
    console.warn('⚠️  Failed to fetch miner addresses:', addressesErr.message);
  }

  const [liquidityPositions, positionsErr] = await getMinerLiquidityPositions(minerAddresses, poolAddresses);
  if (positionsErr) {
    console.warn('⚠️  Failed to fetch liquidity positions:', positionsErr.message);
  }

  const poolLiquidityData = aggregateLiquidityByPool(liquidityPositions);

  // Fetch metadata for pools lacking liquidity info
  const missingPools = rankedWeights
    .map(([addr]) => addr.toLowerCase())
    .filter(addr => !poolLiquidityData[addr]);

  const metadataMap = await fetchPoolMetadata(missingPools);

  // Display results
  console.log('Current Pool Weights:\n');

  const table = new Table({
    head: [
      chalk.bold.blue('Rank'),
      chalk.bold.blue('Address (Pair)'),
      chalk.bold.blue('Weight'),
      chalk.bold.blue('Token0'),
      chalk.bold.blue('Token1')
    ],
    style: { head: [], border: [] }
  });

  rankedWeights.forEach(([address, weight], idx) => {
    const lowerAddr = address.toLowerCase();
    const liquidityData = poolLiquidityData[lowerAddr];
    const meta = metadataMap[lowerAddr];

    const token0Symbol = liquidityData?.token0Symbol ?? meta?.token0Symbol ?? '';
    const token1Symbol = liquidityData?.token1Symbol ?? meta?.token1Symbol ?? '';

    const feeTierValue = liquidityData?.feeTier ?? meta?.feeTier;
    const feeLabel = feeTierValue !== undefined && !Number.isNaN(feeTierValue) ? `${parseFloat((feeTierValue / 10000).toFixed(2))}%` : '';

    const pairLabel = token0Symbol && token1Symbol ? `(${token0Symbol}/${token1Symbol}${feeLabel ? ' ' + feeLabel : ''})` : '';

    const addrDisplay = `${truncateAddress(address)} ${pairLabel}`.trim();

    const token0Str = liquidityData
      ? formatTokenAmount(
          liquidityData.totalToken0,
          liquidityData.token0Decimals,
          liquidityData.token0Symbol
        )
      : token0Symbol
      ? `0 ${token0Symbol}`
      : '-';

    const token1Str = liquidityData
      ? formatTokenAmount(
          liquidityData.totalToken1,
          liquidityData.token1Decimals,
          liquidityData.token1Symbol
        )
      : token1Symbol
      ? `0 ${token1Symbol}`
      : '-';

    table.push([
      chalk.yellowBright(`${idx + 1}`),
      chalk.green(addrDisplay),
      chalk.magenta(formatPercentage(weight)),
      chalk.cyan(token0Str),
      chalk.cyan(token1Str)
    ]);
  });

  console.log(table.toString());
  console.log(chalk.gray(`\nTotal Pools: ${rankedWeights.length}`));
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main().catch(console.error);
}
