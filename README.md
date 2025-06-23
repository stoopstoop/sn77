# Subnet77 Liquidity Auction & Voting

This project focuses on deploying and managing the [`Subnet77LiquidityAuction.sol`](mdc:contracts/Subnet77LiquidityAuction.sol) and [`ClaimVote.sol`](mdc:contracts/ClaimVote.sol) smart contracts using Hardhat, along with associated helper scripts.

## Core Contracts

*   **Auction Contract:** [`contracts/Subnet77LiquidityAuction.sol`](mdc:contracts/Subnet77LiquidityAuction.sol)
    *   Manages the liquidity pool auction, including bidding, price decay, and pool management.
    *   **Refactored:** Pool storage was changed from a fixed array to a `mapping(uint256 => Pool)` where the key is a unique, non-reusable `poolId`. Active pools are tracked separately.
    *   **Hard Link Note:** This file is a hard link to `/Users/creativebuilds/Projects/v3-bridge/contracts/Subnet77LiquidityAuction.sol`.
*   **Voting Contract:** [`contracts/ClaimVote.sol`](mdc:contracts/ClaimVote.sol)
    *   Allows users (identified by Bittensor public keys) to submit weighted votes for active pools listed in the Auction Contract.
    *   Verifies Ed25519 signatures against submitted vote messages.
    *   Uses the [`VerifySignature.sol`](mdc:contracts/VerifySignature.sol) library for signature verification.
    *   Interacts with the Auction Contract via the [`ISubnet77LiquidityAuction.sol`](mdc:interfaces/ISubnet77LiquidityAuction.sol) interface to check pool validity and activity.
*   **Testing Contract:** [`contracts/simpleAddStake.sol`](mdc:contracts/simpleAddStake.sol)
    *   A minimal contract created to test the Bittensor `addStake` and `removeStake` precompiles directly.

## Validator

The validator (`validator/index.ts`) is responsible for:
- Fetching weights from the central server
- Setting weights on the Bittensor network
- **Version compatibility checking** with automatic updates

### Version Management

The validator includes automatic version checking and update capabilities:

#### Environment Variables
- `AUTO_UPDATE_ENABLED`: Set to `true` to enable automatic updates (default: `false`)
- `TEST_MODE`: Set to `true` to run in test mode (default: `false`)
- `LOG`: Set to `true` to enable console logging (default: `false`)

#### Features
- **Periodic Version Checks**: Every 30 minutes, the validator pings the server to check version compatibility
- **12-Hour Timeout**: If version incompatibility persists for 12 hours, the validator automatically shuts down
- **Auto-Update**: When enabled, automatically pulls latest changes and restarts
- **Persistent Warnings**: Version warnings are saved locally and checked on startup
- **Graceful Degradation**: Version issues don't immediately stop the validator, allowing time for updates

#### Running the Validator
```bash
# Using npm script
bun run validator

# Direct execution
bunx tsx validator/index.ts
```

## Interfaces

*   [`interfaces/ISubnet77LiquidityAuction.sol`](mdc:interfaces/ISubnet77LiquidityAuction.sol): Interface used by `ClaimVote.sol` to interact with `Subnet77LiquidityAuction.sol`.

## Deployment

*   Deployments are managed using the `hardhat-deploy` plugin.
*   The deployment script for the auction contract is [`deploy/01-deploy-auction.js`](mdc:deploy/01-deploy-auction.js).
    *   *Note: Deployment script for `ClaimVote.sol` needs to be created/updated.* This script likely needs to set the auction contract address in the deployed `ClaimVote` contract.
*   Deployments can be run using `npx hardhat deploy`.

## Configuration

*   Hardhat configuration: [`hardhat.config.js`](mdc:hardhat.config.js) (includes `hardhat-deploy`).
*   Node.js dependencies: [`package.json`](mdc:package.json).
*   Environment Variables:
    *   `.env`: Stores EVM `PRIVATE_KEY` for transaction signing, potentially RPC URLs.
    *   `.env.tao`: Stores deployed contract addresses like `CLAIM_VOTE_ADDRESS`.

## Scripts

*   **Key Generation:** [`scripts/create-key.ts`](mdc:scripts/create-key.ts)
    *   Generates or loads EVM wallets (from private key or mnemonic).
    *   Derives the corresponding Bittensor SS58 address using the Frontier HashedAddressMapping (`evm:` prefix + blake2b hash).
    *   Saves keys and addresses to `.env` and a JSON file in `.keys/`.
*   **Voting:** [`scripts/vote.py`](mdc:scripts/vote.py)
    *   Submits votes to the `ClaimVote.sol` contract.
    *   Loads a Bittensor wallet by name (`--wallet.name`) using the `bittensor` Python library.
    *   Signs the vote message using the wallet's **coldkey** (Ed25519).
    *   Sends the transaction using the EVM `PRIVATE_KEY` from `.env`.
    *   Requires Python environment and dependencies (see below).

## Python Environment

*   A Python virtual environment is used for Python scripts: `.venv/`
*   Dependencies include `bittensor`, `web3.py`, `python-dotenv`.
*   Activate using `source .venv/bin/activate`.
*   Install dependencies using `pip install -r requirements.txt` (if a requirements file exists) or `pip install ...`.

## Preferred Runtime: Bun

This project uses Bun as the preferred JavaScript runtime and package manager.

*   Use `bun install` instead of `npm install` or `yarn install`.
*   Use `bun run <script>` instead of `npm run <script>` or `yarn <script>`.
*   Use `bunx` instead of `npx`.

# Subnet 77 – Liquidity

> A complete on-chain liquidity mining system for the Bittensor ecosystem.


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

# Retract all votes (send empty allocation)
just vote --retract
# or
just vote -r
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
| `vote.ts` | Interactive pool-weight voting. Searches and selects pools, then submits weighted votes that sum to 10000. Supports retracting votes with `--retract` flag. | `just vote` |
| `pools.ts` | Display current pool information from the API including pool details, voter information, and alpha token balances. | `just pools` |

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