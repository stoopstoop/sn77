require("@nomicfoundation/hardhat-toolbox");
require("hardhat-deploy");
require("dotenv").config();

// Retrieve private key from environment variable
const ETH_PRIVKEY = process.env.ETH_PRIVKEY || "";
if (ETH_PRIVKEY === "") {
  throw new Error("ETH_PRIVKEY is not set");
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  networks: {
    hardhat: {
      // Default Hardhat network config
    },
    bittensorLocal: {
      url: "http://localhost:9944",
      accounts: ETH_PRIVKEY !== "" ? [ETH_PRIVKEY] : [],
      chainId: 6969,
    },
    bittensorMainnet: {
      url: "https://lite.chain.opentensor.ai",
      accounts: ETH_PRIVKEY !== "" ? [ETH_PRIVKEY] : [],
      chainId: 964,
    },
    // You can add other networks like testnet here if needed
    // bittensorTestnet: {
    //   url: "https://test.chain.opentensor.ai",
    //   accounts: PRIVATE_KEY !== "" ? [PRIVATE_KEY] : [],
    //   chainId: 945,
    // },
  },
};
