# Register a Bittensor public key with an EVM address
register:
  bunx tsx scripts/register.ts

# Submit votes for liquidity pools
vote:
  bunx tsx scripts/vote.ts

# Start the validator to process votes and submit weights
validate:
  bunx tsx validator/index.ts

# Check current pool weights and rankings
pools:
  bun run pools

# Display EVM balances for all keys
balance:
  NETWORK=mainnet bunx tsx scripts/balance.ts

# Generate or import an EVM keypair
create-key:
  bunx tsx scripts/create-key.ts

# Check if a Bittensor key is registered
check-key:
  bunx tsx scripts/check-key.ts

# Calculate and display weight distributions
weights:
  bunx tsx scripts/weights.ts 