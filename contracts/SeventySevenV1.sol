// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./VerifySignature.sol";

contract SeventySevenV1 {
    using VerifySignatureLib for bytes32;
    using VerifySignatureLib for bytes;

    struct Position {
        address poolAddress; // Unique address of the pool in the auction contract
        uint256 weight; // A number out of 10000 representing position weight
    }

    mapping(bytes32 => address) public keyToAddress;
    mapping(address => bytes32) public addressToKey;
    mapping(bytes32 => Position[]) public keyToPositions;

    event AddressRegistered(bytes32 indexed publicKey, address indexed ethAddress);
    event PositionsUpdated(bytes32 indexed publicKey, Position[] positions);

    error InvalidSignature();
    error InvalidMessageFormat();
    error WeightSumMismatch();
    error InvalidPoolLength();

    constructor() {
    }

    /**
     * @dev Updates positions for a given public key after verifying the signature
     * and checking pool validity against the auction contract.
     * @param message The message containing pool IDs and weights (e.g., "poolId1,weight1;poolId2,weight2")
     * @param signature The Ed25519 signature (64 bytes)
     * @param publicKey The Ed25519 public key (32 bytes)
     */
    function updatePositions(
        string calldata message,
        bytes calldata signature,
        bytes32 publicKey
    ) external {
        bytes32 messageHash = keccak256(bytes(message));
        if (signature.length != 64) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);

        if (!VerifySignatureLib.verifyEd25519Signature(messageHash, publicKey, r, s)) {
            revert InvalidSignature();
        }

        Position[] memory positions = parsePositionsMessage(message);

        delete keyToPositions[publicKey];
        for (uint i = 0; i < positions.length; i++) {
            keyToPositions[publicKey].push(positions[i]);
        }

        emit PositionsUpdated(publicKey, positions);
    }

    /**
     * @dev Registers an Ethereum address for a given public key, verifying signatures from both parties.
     * @param publicKey The Ed25519 public key (32 bytes).
     * @param ethAddress The Ethereum address to register.
     * @param ethSignature The signature from the Ethereum address proving ownership (65 bytes), signing keccak256(abi.encodePacked(publicKey)).
     * @param ed25519Signature The Ed25519 signature from the Bittensor key (64 bytes), signing keccak256(abi.encodePacked(ethAddress)).
     */
    function registerAddress(
        bytes32 publicKey,
        address ethAddress,
        bytes calldata ethSignature,
        bytes calldata ed25519Signature
    ) external {
        bytes32 ethMessageHash = keccak256(abi.encodePacked(publicKey));
        bytes32 ethSignedMessageHash = VerifySignatureLib.getEthSignedMessageHash(ethMessageHash);

        if (ethSignature.length != 65) revert InvalidSignature();
        address recoveredAddress = VerifySignatureLib.recoverSigner(ethSignedMessageHash, ethSignature);
        if (recoveredAddress != ethAddress || recoveredAddress == address(0)) {
            revert InvalidSignature();
        }

        bytes32 ed25519MessageHash = keccak256(abi.encodePacked(ethAddress));

        if (ed25519Signature.length != 64) revert InvalidSignature();
        bytes32 r = bytes32(ed25519Signature[0:32]);
        bytes32 s = bytes32(ed25519Signature[32:64]);

        if (!VerifySignatureLib.verifyEd25519Signature(ed25519MessageHash, publicKey, r, s)) {
            revert InvalidSignature();
        }

        // Clear previous association for this public key if it pointed to a different address
        address existingEth = keyToAddress[publicKey];
        if (existingEth != address(0) && existingEth != ethAddress) {
            delete addressToKey[existingEth];
            emit AddressRegistered(publicKey, address(0));
        }

        // Clear previous association for this address if it pointed to a different public key
        bytes32 existingKey = addressToKey[ethAddress];
        if (existingKey != bytes32(0) && existingKey != publicKey) {
            delete keyToAddress[existingKey];
            emit AddressRegistered(existingKey, address(0));
        }

        // Store new one-to-one association
        keyToAddress[publicKey] = ethAddress;
        addressToKey[ethAddress] = publicKey;

        emit AddressRegistered(publicKey, ethAddress);
    }

    /**
     * @dev Parses the positions message.
     * @param message The message string (e.g., "poolId1,weight1;poolId2,weight2")
     */
    function parsePositionsMessage(string calldata message) internal pure returns (Position[] memory) {
        bytes memory data = bytes(message);
        if (data.length == 0) revert InvalidMessageFormat();

        uint256 itemCount = 1;
        for (uint i = 0; i < data.length; i++) {
            if (data[i] == ";") {
                itemCount++;
            }
        }

        Position[] memory positions = new Position[](itemCount);
        uint256 posCount = 0;
        uint256 start = 0;
        uint256 weightSum = 0;

        for (uint i = 0; i < data.length; i++) {
            if (data[i] == ";") {
                if (start == i) revert InvalidMessageFormat();
                Position memory pos = parsePosition(data, start, i);
                positions[posCount++] = pos;
                weightSum += pos.weight;
                start = i + 1;
            }
        }
        if (start < data.length) {
            Position memory pos = parsePosition(data, start, data.length);
            positions[posCount++] = pos;
            weightSum += pos.weight;
        } else if (data[data.length - 1] == ';') {
             revert InvalidMessageFormat();
        }

        if (posCount != itemCount) revert InvalidMessageFormat();
        if (weightSum != 10000) revert WeightSumMismatch();

        return positions;
    }

    /**
     * @dev Parses a single position segment (e.g., "poolId,weight")
     */
    function parsePosition(bytes memory data, uint256 start, uint256 end) internal pure returns (Position memory) {
        uint256 commaPos;
        bool commaFound = false;

        for (uint i = start; i < end; i++) {
            if (data[i] == ",") {
                commaPos = i;
                commaFound = true;
                break;
            }
        }

        if (!commaFound || commaPos == start || commaPos == end - 1) {
             revert InvalidMessageFormat();
        }

        return Position({
            poolAddress: parseAddress(data, start, commaPos),
            weight: parseUint(data, commaPos + 1, end)
        });
    }

    function parseAddress(bytes memory data, uint256 start, uint256 end) internal pure returns (address addr) {
        if (end - start != 42) revert InvalidMessageFormat();
        if (data[start] != '0' || data[start+1] != 'x') revert InvalidMessageFormat();

        uint256 value;
        for (uint i = start + 2; i < end; i++) {
            uint8 charCode = uint8(data[i]);
            uint256 digit;
            if (charCode >= 48 && charCode <= 57) {
                digit = charCode - 48;
            } else if (charCode >= 65 && charCode <= 70) {
                digit = charCode - 55;
            } else if (charCode >= 97 && charCode <= 102) {
                digit = charCode - 87;
            } else {
                revert InvalidMessageFormat();
            }
            if (value > (type(uint160).max - digit) / 16) revert InvalidMessageFormat();
            value = value * 16 + digit;
        }
        addr = address(uint160(value));
    }

    function parseUint(bytes memory data, uint256 start, uint256 end) internal pure returns (uint256 value) {
        if (start >= end) revert InvalidMessageFormat();

        for (uint i = start; i < end; i++) {
            uint8 charCode = uint8(data[i]);
            if (charCode < 48 || charCode > 57) revert InvalidMessageFormat();
            uint256 digit = charCode - 48;
            if (value > (type(uint256).max - digit) / 10) revert InvalidMessageFormat();
            value = value * 10 + digit;
        }
        // No return [value, err] pattern needed, revert handles errors.
        return value;
    }

    /**
     * @dev View function to get all positions for a public key
     */
    function getPositions(bytes32 publicKey) external view returns (Position[] memory) {
        return keyToPositions[publicKey];
    }
}
