import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

async function getEVMBalance() {
  try {
    // Define RPC URLs for different networks
    const rpcUrls = {
      mainnet: 'https://lite.chain.opentensor.ai',
      testnet: 'https://test.chain.opentensor.ai',
      // Add localnet if needed
      // localnet: 'http://localhost:9944',
    };

    // Chain IDs
    const chainIds = {
      mainnet: 964, // UTF-8 encoded TAO symbol
      testnet: 945, // UTF-8 encoded alpha character
    };

    // Default to mainnet
    const network = process.env.NETWORK || 'mainnet';
    const rpcUrl = rpcUrls[network];
    
    if (!rpcUrl) {
      throw new Error(`Invalid network: ${network}. Valid options are: ${Object.keys(rpcUrls).join(', ')}`);
    }

    console.log(`Connecting to ${network} at ${rpcUrl}`);
    
    // Create provider
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Check if .keys directory exists
    const keysDir = path.join(process.cwd(), '.keys');
    if (!fs.existsSync(keysDir)) {
      throw new Error('.keys directory not found');
    }
    
    // Read all key files
    const keyFiles = fs.readdirSync(keysDir).filter(file => file.endsWith('.json'));
    
    if (keyFiles.length === 0) {
      console.log('No key files found in .keys directory');
      return;
    }
    
    console.log(`Found ${keyFiles.length} key files`);
    
    // Process each key file
    for (const keyFile of keyFiles) {
      const keyPath = path.join(keysDir, keyFile);
      const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      
      // Check if the key file contains an Ethereum address
      if (keyData.address && keyData.address.startsWith('0x')) {
        const address = keyData.address;
        const balance = await provider.getBalance(address);
        
        // 1 TAO = 1e18 on subtensor EVM
        const balanceInTAO = ethers.formatEther(balance);
        
        console.log(`Address: ${address}`);
        console.log(`Balance: ${balanceInTAO} TAO`);
        console.log('-'.repeat(50));
      } else if (keyData.ss58Address) {
        // If the key contains an SS58 address, we need to find its EVM equivalent
        console.log(`SS58 Address: ${keyData.ss58Address}`);
        console.log('SS58 addresses need to be converted to H160 format for EVM balance checks.');
        console.log('Consider using the withdraw-address.js script from evm-bittensor to find the Ethereum mirror address.');
        console.log('-'.repeat(50));
      }
    }
  } catch (error) {
    console.error('Error getting EVM balance:', error);
  }
}

// Execute the function
getEVMBalance();
