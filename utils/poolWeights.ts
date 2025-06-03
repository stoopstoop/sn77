import { encodeAddress } from '@polkadot/util-crypto';
import { getAddress } from 'ethers';
import dotenv from 'dotenv';    

const NO_ENV = process.env.NO_ENV === 'true';

if (NO_ENV) {
  let _env: Record<string, string> = {};
  Object.keys(process.env).forEach(key => {
      _env[key] = process.env[key] ?? '';
      delete process.env[key];
    });

  dotenv.config();

  let _env2: Record<string, string> = {};
  Object.keys(process.env).forEach(key => {
      _env2[key] = process.env[key] ?? '';
      delete process.env[key];
    });

  process.env = {..._env2, PYTHONPATH: _env.PYTHONPATH, PATH: _env.PATH};
} else {
  dotenv.config();
}

// Standard [value, err] tuple type
export type Result<T> = [T, Error | null];

export interface VotePosition { poolAddress: string; weight: number; }
export interface Balance { address: string; balance: number; }

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/**
 * Fetch vote positions from SeventySevenV1 subgraph.
 */
export async function fetchVotePositions(): Promise<Result<Record<string, VotePosition[]>>> {
    try {
        const subgraphUrl = process.env.SUBGRAPH_URL;
        if (!subgraphUrl) return [{}, new Error('SUBGRAPH_URL not configured')];

        const PAGE_SIZE = 1000;
        let skip = 0;
        const all: any[] = [];

        while (true) {
            const query = `query{positions(first:${PAGE_SIZE},skip:${skip},orderBy:id,orderDirection:asc,subgraphError:deny){id publicKey poolAddress weight timestamp}}`;
            const resp = await fetch(subgraphUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            const txt = await resp.text();
            if (!resp.ok) return [{}, new Error(`Graph query failed (${resp.status}): ${txt}`)];
            const js = JSON.parse(txt);
            if (js.errors) return [{}, new Error(`Graph query errors: ${JSON.stringify(js.errors)}`)];
            const batch = js.data?.positions ?? [];
            all.push(...batch);
            if (batch.length < PAGE_SIZE) break;
            skip += PAGE_SIZE;
        }

        const map: Record<string, VotePosition[]> = {};
        for (const p of all) {
            if (!p.publicKey) continue;
            let ss58: string;
            try { ss58 = encodeAddress(p.publicKey, 42); } catch { continue; }
            if (!map[ss58]) map[ss58] = [];
            const w = Number(p.weight);
            if (isNaN(w)) continue;
            let pool: string;
            try { pool = getAddress(p.poolAddress); } catch { continue; }
            map[ss58].push({ poolAddress: pool, weight: w });
        }
        return [map, null];
    } catch (err) {
        return [{}, err instanceof Error ? err : new Error(String(err))];
    }
}

/**
 * Fetch balances for addresses from Taostats API.
 */
export async function fetchBalances(votePositions: Record<string, VotePosition[]>): Promise<Result<Record<string, Balance>>> {
    const addresses = Object.keys(votePositions);
    if (!addresses.length) return [{}, null];

    const apiKey = process.env.TAOSTATS_API_KEY;
    if (!apiKey) return [{}, new Error('TAOSTATS_API_KEY not configured')];

    const baseUrl = 'https://api.taostats.io/api/dtao/stake_balance/latest/v1';
    const limit = 200;
    let offset = 0, page = 1, totalPages = 1;
    const all: any[] = [];
    const initDelay = 1000, proactiveDelay = 1000, maxBackoff = 60000;

    while (page <= totalPages) {
        let done = false, backoff = initDelay;
        while (!done) {
            if (page > 1 || backoff > initDelay) await delay(proactiveDelay);

            const url = `${baseUrl}?netuid=77&limit=${limit}&offset=${offset}&order=balance_desc`;
            let resp: Response | undefined; let text = '';
            try {
                resp = await fetch(url, { headers: { accept: 'application/json', authorization: apiKey } });
                text = await resp.text();
            } catch (e) { resp = undefined; text = String(e); }

            if (resp?.ok) {
                try {
                    const j = JSON.parse(text);
                    totalPages = j.pagination.total_pages;
                    all.push(...j.data);
                    done = true;
                } catch { return [{}, new Error('Failed to parse Taostats response')]; }
                continue;
            }

            if (resp?.status === 429) {
                await delay(backoff);
                backoff = Math.min(backoff * 2, maxBackoff);
                continue;
            }

            return [{}, new Error(`Taostats request failed: ${resp?.status} ${text}`)];
        }
        page++; offset += limit;
    }

    const mapAll = new Map<string, number>();
    for (const item of all) {
        if (!item.coldkey?.ss58) continue;
        const bal = parseFloat(item.balance_as_tao);
        if (!isNaN(bal)) mapAll.set(item.coldkey.ss58, bal);
    }

    const relevant: Record<string, Balance> = {};
    for (const a of addresses) relevant[a] = { address: a, balance: mapAll.get(a) ?? 0 };

    return [relevant, null];
}

/**
 * Calculate pool weights (normalized) and also return raw weights.
 */
export function calculatePoolWeights(
    positions: Record<string, VotePosition[]>,
    balances: Record<string, Balance>
): [Record<string, number>, Record<string, number>] {
    const raw: Record<string, number> = {};
    for (const addr in positions) {
        const bal = balances?.[addr]?.balance ?? 0;
        if (!isFinite(bal) || bal <= 0) continue;
        const userPositions = positions[addr] ?? [];
        if (!userPositions.length) continue;
        const total = userPositions.reduce((s, p) => {
            const weight = isFinite(p.weight) ? p.weight : 0;
            return s + weight;
        }, 0);
        if (!isFinite(total) || total <= 0) continue;
        for (const p of userPositions) {
            if (!isFinite(p.weight) || p.weight < 0) continue;
            let key: string;
            try { key = getAddress(p.poolAddress); } catch { continue; }
            if (!raw[key]) raw[key] = 0;
            const contribution = (p.weight / total) * bal;
            if (isFinite(contribution)) raw[key] += contribution;
        }
    }
    const sum = Object.values(raw).reduce((s, v) => s + v, 0);
    const normalized: Record<string, number> = {};
    if (isFinite(sum) && sum > 0) {
        for (const k in raw) {
            const normalizedWeight = raw[k] / sum;
            if (isFinite(normalizedWeight)) normalized[k] = normalizedWeight;
        }
    }
    return [normalized, raw];
}

/**
 * High level helper returning [normalized, raw, error]
 */
export async function computePoolWeights(): Promise<[[Record<string, number>, Record<string, number>], Error | null]> {
    const [positions, posErr] = await fetchVotePositions();
    console.log('positions:', positions);
    if (posErr) return [[{}, {}], posErr];
    const [balances, balErr] = await fetchBalances(positions);
    console.log('balances:', balances);
    if (balErr) return [[{}, {}], balErr];
    return [calculatePoolWeights(positions, balances), null];
} 