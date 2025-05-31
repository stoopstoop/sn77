import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { promisify } from 'util';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

// Standard [value, err] result type
export type Result<T> = [T, Error | null];

// Promisified execFile for async/await usage
const execFileAsync = promisify(execFile);

/**
 * Executes the get-miners.py script to fetch miner data.
 * @param netuid The netuid to query.
 * @param network The network to query.
 * @returns Promise<void> Resolves when the script completes successfully, rejects on error.
 */
export async function runGetMinersScript(netuid: number, network: string): Promise<void> {
    // The Python helper lives in the same directory as this file
    const scriptPath = path.join(__dirname, 'get-miners.py');
    const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python';

    try {
        const { stderr } = await execFileAsync(pythonExecutable, [
            scriptPath,
            netuid.toString(),
            '--network',
            network
        ]);

        if (stderr) throw new Error(`Python script execution failed with stderr: ${stderr}`);
    } catch (error) {
        throw new Error(`Failed to execute get-miners.py: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Fetches miner data by running the get-miners.py script and parsing its CSV output.
 * Returns a map of miner UID to their SS58 Coldkey.
 */
export async function getMiners(): Promise<Result<Record<string, string>>> {
    const netuid = 77; // TODO: Make configurable if needed
    const network = process.env.BITTENSOR_NETWORK || 'finney';

    // CSV is written by the Python helper to the project root /output folder
    const csvPath = path.join(__dirname, '..', 'output', 'miners.csv');

    try {
        // Ensure the CSV is up-to-date
        await runGetMinersScript(netuid, network);

        // Read and parse CSV
        const csvData = await fs.readFile(csvPath, 'utf-8');
        const records: Array<{ uid: string; coldkey: string; hotkey: string }> = parse(csvData, {
            columns: true,
            skip_empty_lines: true,
        });

        // Transform to UID -> Coldkey map
        const minerMap: Record<string, string> = {};
        for (const record of records) {
            if (record.uid && record.coldkey) minerMap[record.uid] = record.coldkey;
        }

        if (Object.keys(minerMap).length === 0) return [{}, null];
        return [minerMap, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error('Failed to get miner data');
        return [{}, error];
    }
}

// Duplicate interface declarations to keep utils self-contained
export interface LiquidityPosition {
    id: string;
    owner: string;
    token0: { id: string; symbol: string; name: string; decimals: string };
    token1: { id: string; symbol: string; name: string; decimals: string };
    liquidity: string;
    depositedToken0: string;
    depositedToken1: string;
    tickLower: { id: string; tickIdx: string };
    tickUpper: { id: string; tickIdx: string };
    pool?: { id: string; feeTier: string; tick?: string; token0Price?: string; token1Price?: string };
}

interface SubgraphPosition extends LiquidityPosition {} // identical shape for casting

/**
 * Fetch ETH addresses that miners registered via SeventySevenV1 contract.
 */
export async function getMinerAddresses(miners: Record<string, string>): Promise<Result<Record<string, string>>> {
    const minerIds = Object.keys(miners);
    if (minerIds.length === 0) return [{}, null];

    const subgraphUrl = process.env.SUBGRAPH_URL;
    if (!subgraphUrl) return [{}, new Error('SUBGRAPH_URL not configured')];

    const publicKeyToUid = new Map<string, string>();
    const publicKeys: string[] = [];
    for (const [uid, ss58] of Object.entries(miners)) {
        try {
            const hex = u8aToHex(decodeAddress(ss58));
            publicKeys.push(hex);
            publicKeyToUid.set(hex, uid);
        } catch {}
    }
    if (publicKeys.length === 0) return [{}, null];

    const query = `query($publicKeys: [Bytes!]!) { addressRegistrations(where:{ id_in:$publicKeys}){id ethAddress} }`;
    const resp = await fetch(subgraphUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { publicKeys } })
    });
    const text = await resp.text();
    if (!resp.ok) return [{}, new Error(`Subgraph error ${resp.status}: ${text}`)];
    const result = JSON.parse(text);
    if (result.errors) return [{}, new Error(JSON.stringify(result.errors))];
    const map: Record<string, string> = {};
    for (const reg of (result.data?.addressRegistrations ?? [])) {
        const uid = publicKeyToUid.get(reg.id);
        if (uid) map[uid] = reg.ethAddress;
    }
    return [map, null];
}

const DEFAULT_POOLS = [
    '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    '0x433a00819c771b33fa7223a5b3499b24fbcd1bbc',
].filter(p => p.toLowerCase());

/**
 * Fetch liquidity positions for the given miners from the Uniswap-V3 subgraph.
 */
export async function getMinerLiquidityPositions(minerAddresses: Record<string, string>, pools: string[] = DEFAULT_POOLS): Promise<Result<Record<string, LiquidityPosition[]>>> {
    const ethAddresses = Object.values(minerAddresses);
    if (ethAddresses.length === 0) return [{}, null];

    const apiKey = process.env.THEGRAPH_API_KEY;
    if (!apiKey) return [{}, new Error('THEGRAPH_API_KEY not configured')];

    const subgraphId = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
    const url = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;

    // Ensure pool IDs are lowercase to match how The Graph stores addresses
    const poolIds = pools.map(p => p.toLowerCase());

    const addrToUid = new Map<string, string>();
    for (const [uid, addr] of Object.entries(minerAddresses)) addrToUid.set(addr.toLowerCase(), uid);

    const out: Record<string, LiquidityPosition[]> = {};
    const batchSize = 100;
    const limit = 1000;

    for (let i = 0; i < ethAddresses.length; i += batchSize) {
        const owners = ethAddresses.slice(i, i + batchSize).map(a => a.toLowerCase());
        const query = `query($owners:[String!]!,$pools:[String!]!,$limit:Int!){positions(first:$limit,where:{owner_in:$owners,liquidity_gt:"1",pool_:{id_in:$pools}}){id owner liquidity depositedToken0 depositedToken1 tickLower{id tickIdx} tickUpper{id tickIdx} token0{id symbol name decimals} token1{id symbol name decimals} pool{id feeTier tick token0Price token1Price}}}`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ query, variables: { owners, pools: poolIds, limit } })
        });
        const txt = await r.text();
        if (!r.ok) continue;
        const data = JSON.parse(txt);
        if (data.errors) continue;
        const positions: SubgraphPosition[] = data.data?.positions ?? [];
        for (const p of positions) {
            const uid = addrToUid.get(p.owner.toLowerCase());
            if (!uid) continue;
            if (!out[uid]) out[uid] = [];
            out[uid].push(p as LiquidityPosition);
        }
    }

    // ensure every miner key exists
    for (const uid of Object.keys(minerAddresses)) if (!out[uid]) out[uid] = [];
    return [out, null];
}

/** Fetch unique owner addresses that currently have liquidity in the given pools. */
export async function fetchActivePoolAddresses(poolIds: string[] = DEFAULT_POOLS): Promise<Result<Set<string>>> {
    const apiKey = process.env.THEGRAPH_API_KEY;
    if (!apiKey) return [new Set(), new Error('THEGRAPH_API_KEY not configured')];
    const subgraphId = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
    const url = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;

    const owners = new Set<string>();
    const pageSize = 1000;

    for (const poolId of poolIds) {
        let skip = 0;
        while (true) {
            const query = `query($poolId:String!,$first:Int!,$skip:Int!){positions(where:{liquidity_gt:"1",pool_:{id:$poolId}},first:$first,skip:$skip){owner}}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ query, variables: { poolId: poolId.toLowerCase(), first: pageSize, skip } })
            });
            const txt = await res.text();
            if (!res.ok) break;
            const json = JSON.parse(txt);
            if (json.errors) break;
            const pos = json.data?.positions ?? [];
            pos.forEach((p: { owner: string }) => owners.add(p.owner.toLowerCase()));
            if (pos.length < pageSize) break;
            skip += pageSize;
        }
    }
    return [owners, null];
} 