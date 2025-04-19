const { network } = require("hardhat");
// const { verify } = require("../utils/verify"); // Assuming a verify utility exists - Commented out as it's not used currently

module.exports = async ({ getNamedAccounts, deployments }) => {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts(); // Get the deployer address

  log("----------------------------------------------------");
  log("Deploying Subnet77LiquidityAuction and waiting for confirmations...");

  // The constructor requires a 'trustedAddress'. Using the deployer for local testing.
  // Update this address for mainnet/testnet deployments.
  const trustedAddress = deployer; 

  const args = [trustedAddress]; // Arguments for the constructor

  const subnetAuction = await deploy("Subnet77LiquidityAuction", {
    from: deployer,
    args: args,
    log: true,
    // waitConfirmations: network.config.blockConfirmations || 1, // Optional: wait for blocks
  });

  log(`Subnet77LiquidityAuction deployed at ${subnetAuction.address}`);

  // Verification logic (optional, depends on your setup and network)
  // if (!network.name.includes("localhost") && process.env.ETHERSCAN_API_KEY) {
  //   await verify(subnetAuction.address, args);
  // }
  log("----------------------------------------------------");
};

module.exports.tags = ["all", "auction"]; // Tags for running specific deployments 