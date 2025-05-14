import bittensor as bt
import argparse
import sys
import csv
import os

def get_miners(netuid: int, network: str = "finney"):
    """
    Retrieves and prints the UID, hotkey, and coldkey of all miners in a given subnet.

    Args:
        netuid: The unique identifier of the subnet.
        network: The Bittensor network to connect to (e.g., "finney", "local").

    Returns:
        A tuple containing a list of miner info dictionaries and an error string,
        or (None, error_string) if an error occurs.
    """
    try:
        # Connect to the Bittensor network
        sub = bt.subtensor(network=network)
        if not sub:
            return None, f"Failed to connect to Bittensor network: {network}"

        # Get the metagraph for the specified subnet
        metagraph = sub.metagraph(netuid=netuid)
        if not metagraph:
            return None, f"Failed to retrieve metagraph for netuid: {netuid}"

        miners_info = []
        # Iterate through all neurons in the metagraph
        for neuron in metagraph.neurons:
            # Simple check: assume non-zero stake or incentive might indicate a miner
            # More sophisticated filtering might be needed depending on the exact definition of "miner"
            # For now, we'll list all neurons.
            miner_data = {
                "uid": neuron.uid,
                "hotkey": neuron.hotkey,
                "coldkey": neuron.coldkey,
                "stake": metagraph.S[neuron.uid].item(), # Get stake for this UID
                "incentive": metagraph.I[neuron.uid].item() # Get incentive for this UID
            }
            miners_info.append(miner_data)
            # print(f"UID: {neuron.uid}, Hotkey: {neuron.hotkey}, Coldkey: {neuron.coldkey}, Stake: {miner_data['stake']}, Incentive: {miner_data['incentive']}")


        if not miners_info:
            return [], "No neurons found in the metagraph for this subnet."

        return miners_info, None

    except Exception as e:
        return None, f"An error occurred: {e}"

def main():
    parser = argparse.ArgumentParser(description="Get miner hotkeys and coldkeys for a specific Bittensor subnet.")
    parser.add_argument("netuid", type=int, help="The NetUID of the subnet to query.")
    parser.add_argument("--network", type=str, default="finney", help="The Bittensor network (e.g., 'finney', 'local'). Default: 'finney'")
    args = parser.parse_args()

    miners, err = get_miners(args.netuid, args.network)

    if err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)

    if not miners:
        print(f"No miners found for netuid {args.netuid} on network {args.network}.")
        return

    output_dir = "./output"
    output_file = os.path.join(output_dir, "miners.csv")

    try:
        # Ensure output directory exists
        os.makedirs(output_dir, exist_ok=True)

        # Write to CSV
        with open(output_file, 'w', newline='') as csvfile:
            fieldnames = ['uid', 'coldkey', 'hotkey'] # Define CSV header
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)

            writer.writeheader()
            for miner in miners:
                # Write only the required fields
                writer.writerow({'uid': miner['uid'], 'coldkey': miner['coldkey'], 'hotkey': miner['hotkey']})

        print(f"Successfully wrote miner data to {output_file}")

    except IOError as e:
        print(f"Error writing to file {output_file}: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred during file writing: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
