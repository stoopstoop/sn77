import { JsonRpcProvider, formatEther } from 'ethers';
import fs from 'fs';
import path from 'path';

async function getEVMBalance(): Promise<[void, Error | null]> {
  try {
    const rpcUrls: Record<string, string> = {
      mainnet: 'https://lite.chain.opentensor.ai',
      testnet: 'https://test.chain.opentensor.ai',
    };

    const network = process.env.NETWORK ?? 'mainnet';
    const rpcUrl = rpcUrls[network];
    if (!rpcUrl) return [undefined, new Error(`Invalid network ${network}`)];

    console.log(`connecting to ${network} at ${rpcUrl}`);

    const provider = new JsonRpcProvider(rpcUrl);
    const keysDir = path.join(process.cwd(), '.keys');
    if (!fs.existsSync(keysDir)) return [undefined, new Error('.keys directory not found')];

    const keyFiles = fs.readdirSync(keysDir).filter(f => f.endsWith('.json'));
    if (!keyFiles.length) {
      console.log('no key files found');
      return [undefined, null];
    }

    console.log(`found ${keyFiles.length} key files`);

    for (const file of keyFiles) {
      const keyPath = path.join(keysDir, file);
      const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { address?: string; ss58Address?: string };
      if (keyData.address?.startsWith('0x')) {
        const balance = await provider.getBalance(keyData.address);
        console.log(`address: ${keyData.address}`);
        console.log(`balance: ${formatEther(balance)} TAO`);
        console.log('-'.repeat(50));
        continue;
      }
      if (keyData.ss58Address) {
        console.log(`SS58 Address: ${keyData.ss58Address}`);
        console.log('convert to H160 to query EVM balance');
        console.log('-'.repeat(50));
      }
    }

    return [undefined, null];
  } catch (err) {
    return [undefined, err as Error];
  }
}

(async () => {
  const [, err] = await getEVMBalance();
  if (err) console.error('error getting balance:', err);
})(); 