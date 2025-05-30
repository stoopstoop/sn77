# Subnet 77

This project contains the Subnet77 Liquidity Auction and voting system smart contracts.

## Scripts

### Pool Weights Query (`bun run pools`)

Query current pool weights and voting data without running a validator:

```bash
# Set up environment variables
export AUCTION_CONTRACT_ADDRESS=0x...
export CLAIM_VOTE_CONTRACT_ADDRESS=0x...
export RPC_URL=https://lite.chain.opentensor.ai  # optional

# Run the script
bun run pools
```

This script provides:
- List of all active pools in the auction
- Current contract weights for each pool  
- Community voting data aggregated from ClaimVote contract
- Auction status and configuration details

The script is read-only and doesn't require any private keys or wallet setup.

~~This subnet does not currently have a codebase and is being reserved for a later date~~
Subnet's codebase is actively being developed but not currently live.
For latest updates and to watch development checkout the `dev` branch.

(My favorite number is 7 and so I had to get 77)

Updates for this subnet for when the code releases can be found on my twitter/X: [creativebuilds](https://x.com/creativebuilds)

I have two different subnet ideas, so we'll see which wins out for this one when I push the release.