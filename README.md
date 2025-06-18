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

3. **Query current pool weights**

```bash
bun run pools
```

---

## User Roles & Actions

### 🏦 Token Holders (Voters)

Token holders can vote on which liquidity pools should receive weight in the system.

**What you can do:**
- **Vote on pools**: Submit weighted votes for active liquidity pools
- **Check pool status**: View current pool weights and rankings
- **Monitor your voting power**: Track your influence based on token balance

**Key command:**
```bash
# Submit votes for pools (weights must sum to 10000)
just vote --votes 0xPOOL_A,6000;0xPOOL_B,4000

# Alternatively just run
just vote
# and a prompt will ask you for the pools you wish to vote for
```

**Setup required:**
- `HOLDER_COLDKEY` in `.env` (your Bittensor coldkey for signing votes)
- EVM private key for transaction signing

### ⚡ Validators

Validators read on-chain votes, normalize them by token-holder balance, mix-in Uniswap liquidity, and periodically push **final miner weights** to subnet 77.

**What you can do:**
- **Run weight calculation**: Process votes and compute final miner weights
- **Submit weights to subnet**: Push calculated weights to the Bittensor network
- **Monitor system health**: Track voting patterns and pool performance

**Key commands:**
```bash
# Start the validator (processes votes and submits weights)
just validate

# Run in test mode (compute weights but skip submission)
TEST_MODE=true just validate

# Enable verbose logging
LOG=true just validate
```

**Setup required:**
- `VALIDATOR_HOTKEY_URI` in `.env` (your validator hotkey)
- `THEGRAPH_API_KEY` in `.env` (for Uniswap V3 LP data)
- Funds on associated EVM address for gas

### ⛏️ Miners

Miners provide liquidity to pools and can register their addresses to participate in the system.

**What you can do:**
- **Register your address**: Link your Bittensor public key to an EVM address
- **Provide liquidity**: Add liquidity to pools to earn rewards
- **Monitor earnings**: Track your pool performance and rewards

**Key commands:**
```bash
# Register your Bittensor public key with an EVM address
just register

# Check your registration status
bunx tsx scripts/check-key.ts

# View pool analytics and your position
bun run pools
```

**Setup required:**
- `MINER_HOTKEY` in `.env` (your Bittensor hotkey)
- `ETH_KEY` in `.env` (your Ethereum private key)
- Bittensor wallet with stake on subnet 77

---

## Scripts cheat-sheet

| Script | Purpose | Usage |
|--------|---------|-----------------|
| `create-key.ts` | Generate or import an **EVM keypair** and derive the corresponding **SS58** address. Stores everything in `.keys/` and can update `.env`. | `bunx tsx scripts/create-key.ts` |
| `register.ts` | Link a **Bittensor hotkey** → **EVM address** on-chain via `claimAddress`. Requires `MINER_HOTKEY` and `ETH_KEY` environment variables. | `just register` |
| `vote.ts` | Interactive pool-weight voting. Searches and selects pools, then submits weighted votes that sum to 10000. | `just vote` |
| `pools.ts` | Offline analytics: combines on-chain votes, Taostats balances, and Uniswap-V3 liquidity to print a ranked weight table. | `bun run pools` |

> Run scripts with `LOG=true` to enable verbose logging where available.

---

## Justfile Commands

The project uses `just` as a command runner for common tasks:

| Command | Description |
|---------|-------------|
| `just register` | Register a Bittensor public key with an EVM address |
| `just vote` | Submit votes for liquidity pools |
| `just validate` | Start the validator to process votes and submit weights |

---

## Environment variables

Create a `.env` file in the project root. The most important keys are:

```dotenv
# VALIDATOR ONLY: this can be a private key, URI, or mnemonic
# Used to set weights on chain
VALIDATOR_HOTKEY_URI=

# VALIDATOR ONLY: used to fetch uniswap v3 LP positions for miners
THEGRAPH_API_KEY= 

# VALIDATOR ONLY: set to 'true' to run in test mode (weights saved to files, not submitted to network)
TEST_MODE=false

# VOTER ONLY: hex string starting with 0x
# Used to sign votes in vote.ts script  
HOLDER_COLDKEY=

# MINER ONLY: hex string starting with 0x
# Used for hotkey in register.ts script
MINER_HOTKEY=

# MINER ONLY: ethereum private key hex string
# Used for ethereum wallet in register.ts script
ETH_KEY=
```

*Everything else has sensible defaults or is only required for specific tasks.*

### Obtaining required API keys

• **The Graph**: Log in to [Subgraph Studio](https://thegraph.com/studio/apikeys/) → **API Keys** in the sidebar → *Create API Key* → copy the generated token. See the official guide for details ([docs](https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/)).

---

## Contributing

PRs welcome – especially on optimisation of the weight formula, better docs, or additional scripts.

---

## License

MIT © 2025 creativebuilds