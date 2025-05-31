# Subnet 77 – Liquidity

> A complete on-chain liquidity mining system for the Bittensor ecosystem.

This repository contains:

1. `Subnet77LiquidityAuction.sol` – a liquidity pool auction that issues rewards based on community voting.
2. `SeventySevenV1` – a helper contract that lets **Token Holders** vote on which pools should receive weight.
3. Off-chain tooling (TypeScript + Python) for voters, validators, and data aggregation.
4. A ready-to-run local Graph Node stack (Postgres + IPFS) for ultra-fast subgraph indexing.

---

## ✨ Quick start

1. **Install dependencies** (Bun is the primary runtime)

```bash
bun install
```

2. **Copy & edit the environment template**

```bash
cp .env.example .env
# then fill in the blanks – see the Environment section below
```

3. **Spin-up The Graph locally**

```bash
just start # boots docker + deploys the subgraph
```

4. **Query current pool weights**

```bash
bun run pools
```

---

## Scripts cheat-sheet

| Script | Purpose | Usage |
|--------|---------|-----------------|
| `create-key.ts` | Generate or import an **EVM keypair** and derive the corresponding **SS58** address. Stores everything in `.keys/` and can update `.env`. | `bunx tsx scripts/create-key.ts` |
| `register.ts` | Link a **Bittensor public-key** → **EVM address** on-chain via `registerAddress`. Requires the `BT_PRIVKEY` that owns the public key *and* two funded EVM signers. | `bunx tsx scripts/register.ts` |
| `vote.ts` | Submit pool-weight votes. Accepts a string such as `0xPOOL_A,6000;0xPOOL_B,4000` that must sum to `10000`. | `bunx tsx scripts/vote.ts --votes 0x..,7000;0x..,3000` |
| `pools.ts` | Offline analytics: combines on-chain votes, Taostats balances, and Uniswap-V3 liquidity to print a ranked weight table. | `bun run pools` |
| `balance.ts` | Display EVM balances for every key inside `.keys/`. | `NETWORK=mainnet bunx tsx scripts/balance.ts` |

> Run scripts with `LOG=true` to enable verbose logging where available.

---

## Running a Validator

Validators read on-chain votes, normalise them by token-holder balance, mix-in Uniswap liquidity, and periodically push **final miner weights** to subnet 77.

### 1. Prerequisites

• Bun
• Docker (only needed for the local Graph Node)  
• A registered **validator hotkey** with stake on subnet 77
• Funds (≈ 0.02 TAO) on the associated **EVM address** for gas  
• Environment variables (see next section)  

### 2. Boot a local Graph Node

Local indexing keeps the validator independent from external gateways.

```bash
just start         # boots Postgres, IPFS, Graph-Node, deploys the subgraph
# …wait until "Graph Node is ready!"
```

Under the hood `just start` runs these tasks:

1. `docker-start` – compose stack with the `graph` profile  
2. `wait-for-graph-node` – loop until `/health` endpoint reports OK  
3. `deploy-subgraph` – `npm i && graph codegen && graph build && graph deploy`  

Stop everything with:

```bash
just down          # or `just docker-clean` to wipe volumes
```

> The subgraph is exposed at `http://localhost:8050/subgraphs/name/seventy-seven`.

### 3. Start the validator

```bash
bunx tsx validator/index.ts
```

Optional flags (via env):

* `TEST_MODE=true` – compute weights but **skip** on-chain submission
* `LOG=true` – stream logs to stdout in addition to `./logs/`

Weights are recalculated every few minutes and submitted with `setWeights` (unless `TEST_MODE` is enabled).

---

## Environment variables

Create a `.env` file in the project root. The most important keys are:

```dotenv
# Bittensor / Subnet
NETUID=77
BITTENSOR_WS_URL=wss://entrypoint-finney.opentensor.ai:443  # or your own
VALIDATOR_HOTKEY_URI="//Alice"                               # sr25519 URI

# Keys
BT_PRIVKEY=                                             # Ed25519 cold-key seed for voting
ETH_PRIVKEY=                                            # EVM key with TAO for gas

# Contracts
SEVENTY_SEVEN_V1_CONTRACT_ADDRESS=0x...                 # SeventySevenV1
AUCTION_CONTRACT_ADDRESS=0x...

# Indexing / Analytics
SUBGRAPH_URL=http://localhost:8050/subgraphs/name/seventy-seven
TAOSTATS_API_KEY=...                                    # Get one at https://taostats.io
THEGRAPH_API_KEY=...                                    # Free key at https://thegraph.com
INFURA_API_KEY=...                                      # Needed for main-net contract checks

# Misc
RPC_URL=https://lite.chain.opentensor.ai                # Public archive RPC
HARDHAT_NETWORK=bittensorLocal                          # optional
```

*Everything else has sensible defaults or is only required for specific tasks.*

---

## justfile reference

| Target | Description |
|--------|-------------|
| `just start` | Bring up Graph Node stack **and** deploy the subgraph |
| `just down` | Graceful shutdown (containers stay cached) |
| `docker-clean` | Tear-down **and** remove volumes |
| `deploy-subgraph` | Re-deploy only (expects Graph Node to be up) |

See the [justfile](./justfile) for the full command definitions.

---

## Contributing

PRs welcome – especially on optimisation of the weight formula, better docs, or additional scripts.

---

## License

MIT © 2025 creativebuilds