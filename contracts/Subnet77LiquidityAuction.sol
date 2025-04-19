// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Interface for staking precompile - only addStake, no stake movement
interface IStakingPrecompile {
    function addStake(bytes32 hotkey) external payable;
}

contract Subnet77LiquidityAuction {
    // ---- Contract Parameters ----
    // Key values here, mutable for owner updates
    uint256 public decayPeriod = 216_000; // 2.5 days for linear decay, adjustable
    uint256 public immunityPeriod = 604_800; // 7 days for pool immunity, tweakable
    uint256 public maxPools = 10; // Max active pool slots, can’t exceed INITIAL_MAX_POOLS
    uint256 public basePrice = 10 ether; // 10 TAO base price, 1e19 wei (18 decimals)
    address constant STAKING_PRECOMPILE = 0x0000000000000000000000000000000000000801; // Staking precompile, fixed
    bytes32 public hotkey = 0x8f66718929f8b8d8ea0df6d6e0fd0f1324df6720a0eb401a7d835d0f5666f0f6; // Subnet 77 hotkey, mutable for validator swaps
    uint256 constant INITIAL_MAX_POOLS = 10; // Hard limit for pools array size

    // Callflag mapping: index = callflag (uint16), value = chain name
    string[] public callflagToChain; // Array for callflag -> chain name, index is callflag

    // ---- State Variables ----
    address public owner; // My address for contract control
    address public trustedAddress; // Team’s address for weights, will go multisig
    uint256 public currentPrice; // Current bid price, linear decay
    uint256 public auctionStartTime; // Decay start time
    bool public auctionActive; // Auction toggle for emergencies

    // Pool struct - added callflag for chain ID
    struct Pool {
        address poolAddress; // Uniswap pool contract
        uint16 callflag; // Chain identifier (uint16)
        uint256 weight; // Off-chain vote weight
        uint256 immunityStart; // Immunity start
        bool active; // Slot status
    }

    Pool[INITIAL_MAX_POOLS] public pools; // Fixed array, maxPools limits active slots
    bool private locked; // Reentrancy guard

    // ---- Events ----
    // Logging for debugging and community tracking
    event PoolAdded(uint256 indexed slot, address indexed poolAddress, uint16 callflag, uint256 pricePaid, uint256 newStartPrice);
    event PoolRemoved(uint256 indexed slot, address indexed poolAddress);
    event PoolWeightsUpdated(uint256 indexed slot, uint256 weight);
    event AuctionReset(uint256 newStartPrice, uint256 startTime);
    event StakedToHotkey(bytes32 indexed hotkey, uint256 amount);
    event TrustedAddressUpdated(address indexed newTrustedAddress);
    event HotkeyUpdated(bytes32 indexed newHotkey);
    event ParametersUpdated(uint256 decayPeriod, uint256 immunityPeriod, uint256 maxPools, uint256 basePrice);
    event CallflagUpdated(uint16 indexed callflag, string chainName);

    // ---- Constructor ----
    // Set up initial state, initialize callflags
    constructor(address _trustedAddress) {
        owner = msg.sender; // I’m the owner, secure this key
        trustedAddress = _trustedAddress; // Team’s address, verify before deploy
        currentPrice = basePrice; // Start at 10 TAO
        auctionStartTime = block.timestamp; // Decay starts now
        auctionActive = true; // Live for 4/20 launch

        callflagToChain.push("ethereum"); // callflag 0 = ethereum
        emit CallflagUpdated(1, "ethereum");
    }

    // ---- Modifiers ----
    // Guard against reentrancy for TAO transfers
    modifier nonReentrant() {
        require(!locked, "Reentrancy risk");
        locked = true;
        _;
        locked = false;
    }

    // Owner-only for sensitive ops
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // Trusted address for weight updates
    modifier onlyTrusted() {
        require(msg.sender == trustedAddress, "Not trusted");
        _;
    }

    // ---- Price Logic ----
    // Linear decay: 25% drop at 1.25 days, 50% at 2.5 days
    function getCurrentPrice() public view returns (uint256) {
        if (!auctionActive) return basePrice;

        uint256 elapsed = block.timestamp - auctionStartTime;
        uint256 periods = elapsed / decayPeriod;
        uint256 remainingTime = elapsed % decayPeriod;

        // Halve price for each full period
        uint256 periodPrice = currentPrice;
        for (uint256 i = 0; i < periods; i++) {
            periodPrice = periodPrice / 2;
        }

        // Linear decay in current period
        uint256 decayAmount = (periodPrice * remainingTime) / (2 * decayPeriod);
        uint256 decayedPrice = periodPrice - decayAmount;

        return decayedPrice >= basePrice ? decayedPrice : basePrice;
    }

    // ---- Pool Management ----
    // Find least-weighted pool for replacement
    function findLeastWeightedPool() public view returns (uint256 slot, bool found) {
        uint256 minWeight = type(uint256).max;
        uint256 minSlot = 0;
        bool eligible = false;

        for (uint256 i = 0; i < maxPools; i++) {
            if (pools[i].active && block.timestamp >= pools[i].immunityStart + immunityPeriod) {
                if (pools[i].weight < minWeight) {
                    minWeight = pools[i].weight;
                    minSlot = i;
                    eligible = true;
                }
            }
        }
        return (minSlot, eligible);
    }

    // Bid to add/replace a Uniswap pool with callflag
    function bid(address poolAddress, uint16 callflag) external payable nonReentrant {
        require(auctionActive, "Auction paused");
        require(poolAddress != address(0), "Invalid pool address");
        require(callflag < callflagToChain.length, "Invalid callflag"); // Must be defined

        // Check bid price
        uint256 price = getCurrentPrice();
        require(msg.value >= price, "Not enough TAO");

        // Refund excess
        if (msg.value > price) {
            uint256 refund = msg.value - price;
            payable(msg.sender).transfer(refund); // Safe with nonReentrant
        }

        // Stake TAO to hotkey
        IStakingPrecompile staking = IStakingPrecompile(STAKING_PRECOMPILE);
        try staking.addStake{value: price}(hotkey) {
            emit StakedToHotkey(hotkey, price);
        } catch {
            revert("Staking failed");
        }

        // Find empty slot or replace least-weighted pool
        uint256 slot = INITIAL_MAX_POOLS;
        for (uint256 i = 0; i < maxPools; i++) {
            if (!pools[i].active) {
                slot = i;
                break;
            }
        }

        if (slot == INITIAL_MAX_POOLS) {
            (uint256 leastWeightedSlot, bool found) = findLeastWeightedPool();
            require(found, "No replaceable pool");
            slot = leastWeightedSlot;
            emit PoolRemoved(slot, pools[slot].poolAddress);
        }

        // Add new pool
        pools[slot] = Pool({
            poolAddress: poolAddress,
            callflag: callflag,
            weight: 0,
            immunityStart: block.timestamp,
            active: true
        });

        // Double price, reset decay
        uint256 newStartPrice = price * 2;
        currentPrice = newStartPrice;
        auctionStartTime = block.timestamp;

        emit PoolAdded(slot, poolAddress, callflag, price, newStartPrice);
        emit AuctionReset(newStartPrice, block.timestamp);
    }

    // ---- Callflag Management ----
    // Add new callflag (chain name)
    function addCallflag(string calldata chainName) external onlyOwner returns (uint16) {
        require(bytes(chainName).length > 0, "Empty chain name");
        callflagToChain.push(chainName);
        uint16 newCallflag = uint16(callflagToChain.length - 1);
        emit CallflagUpdated(newCallflag, chainName);
        return newCallflag; // Return new callflag for front-end
    }

    // Update existing callflag
    function updateCallflag(uint16 callflag, string calldata chainName) external onlyOwner {
        require(callflag < callflagToChain.length, "Invalid callflag");
        require(bytes(chainName).length > 0, "Empty chain name");
        callflagToChain[callflag] = chainName;
        emit CallflagUpdated(callflag, chainName);
    }

    // Get chain name for a callflag
    function getChainName(uint16 callflag) external view returns (string memory) {
        require(callflag < callflagToChain.length, "Invalid callflag");
        return callflagToChain[callflag];
    }

    // Get all callflags and chain names
    function getAllCallflags() external view returns (string[] memory) {
        return callflagToChain;
    }

    // ---- Weight Updates ----
    // Trusted address sets weights
    function setPoolWeights(uint256[] calldata slots, uint256[] calldata weights) external onlyTrusted {
        require(slots.length == weights.length, "Array mismatch");
        require(slots.length <= maxPools, "Too many slots");

        for (uint256 i = 0; i < slots.length; i++) {
            uint256 slot = slots[i];
            require(slot < maxPools && pools[slot].active, "Invalid slot");
            pools[slot].weight = weights[i];
            emit PoolWeightsUpdated(slot, weights[i]);
        }
    }

    // ---- Admin Functions ----
    // Update parameters
    function updateParameters(
        uint256 _decayPeriod,
        uint256 _immunityPeriod,
        uint256 _maxPools,
        uint256 _basePrice
    ) external onlyOwner {
        require(_decayPeriod > 3600, "Decay too short"); // Min 1 hour
        require(_immunityPeriod > 86400, "Immunity too short"); // Min 1 day
        require(_maxPools > 0 && _maxPools <= INITIAL_MAX_POOLS, "Invalid max pools");
        require(_basePrice > 0, "Base price zero");

        // Check active pools for maxPools reduction
        uint256 activePools = 0;
        for (uint256 i = 0; i < maxPools; i++) {
            if (pools[i].active) activePools++;
        }
        require(_maxPools >= activePools, "Max pools too low");

        decayPeriod = _decayPeriod;
        immunityPeriod = _immunityPeriod;
        maxPools = _maxPools;
        basePrice = _basePrice;

        emit ParametersUpdated(_decayPeriod, _immunityPeriod, _maxPools, _basePrice);
    }

    // Change hotkey for future stakes
    function updateHotkey(bytes32 newHotkey) external onlyOwner {
        require(newHotkey != bytes32(0), "Invalid hotkey");
        hotkey = newHotkey;
        emit HotkeyUpdated(newHotkey);
    }

    // Update trusted address for multisig
    function updateTrustedAddress(address newTrustedAddress) external onlyOwner {
        require(newTrustedAddress != address(0), "Invalid address");
        trustedAddress = newTrustedAddress;
        emit TrustedAddressUpdated(newTrustedAddress);
    }

    // Emergency pause
    function stopAuction() external onlyOwner {
        auctionActive = false;
    }

    // Restart auction
    function restartAuction(uint256 newStartPrice) external onlyOwner {
        require(!auctionActive, "Auction active");
        require(newStartPrice >= basePrice, "Price too low");
        currentPrice = newStartPrice;
        auctionStartTime = block.timestamp;
        auctionActive = true;
        emit AuctionReset(newStartPrice, block.timestamp);
    }

    // ---- Fallback ----
    // Block accidental TAO
    receive() external payable {
        revert("Use bid()");
    }
}