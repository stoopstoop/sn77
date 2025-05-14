// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Interface for the Ed25519 verification precompile
interface IEd25519Verify {
    /**
     * @dev Verifies Ed25519 signature using provided message and public key.
     * 
     * @param message The 32-byte signature payload message.
     * @param publicKey 32-byte public key matching to private key used to sign the message.
     * @param r The Ed25519 signature commitment (first 32 bytes).
     * @param s The Ed25519 signature response (second 32 bytes).
     * @return bool Returns true if the signature is valid for the given message and public key, false otherwise.
     */
    function verify(bytes32 message, bytes32 publicKey, bytes32 r, bytes32 s) external pure returns (bool);
}

library VerifySignatureLib {
    // Address of the Ed25519 verification precompile
    address constant IED25519VERIFY_ADDRESS = 0x0000000000000000000000000000000000000402;
    
    /**
     * @dev Returns the keccak256 hash of a message prefixed with \x19Ethereum Signed Message:\n32.
     * @param _messageHash The hash of the message.
     * @return The hash of the signed message.
     */
    function getEthSignedMessageHash(bytes32 _messageHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _messageHash));
    }

    /**
     * @dev Recovers the signer address from an Ethereum signature.
     * @param _ethSignedMessageHash The hash of the signed message (prefixed).
     * @param _signature The signature bytes (65 bytes).
     * @return The address of the signer, or address(0) if recovery fails.
     */
    function recoverSigner(bytes32 _ethSignedMessageHash, bytes memory _signature) internal pure returns (address) {
        // Developer Comment: Consider adding specific error messages instead of returning address(0) for different failure modes (e.g., invalid signature length, invalid v value).
        if (_signature.length != 65) return address(0); // Early return for invalid length

        bytes32 r;
        bytes32 s;
        uint8 v;

        // Extract r, s, v from signature
        assembly {
            r := mload(add(_signature, 32))
            s := mload(add(_signature, 64))
            v := byte(0, mload(add(_signature, 96)))
        }

        // EIP-155 support, also handles v = 0/1 case
        if (v < 27) v += 27;

        // Check if v is valid (27 or 28)
        if (v != 27 && v != 28) return address(0); // Early return for invalid v value

        return ecrecover(_ethSignedMessageHash, v, r, s);
    }
    
    /**
     * @dev Verifies an Ed25519 signature using the precompile.
     * @param message The 32-byte message hash.
     * @param publicKey The 32-byte Ed25519 public key.
     * @param r The Ed25519 signature commitment (first 32 bytes).
     * @param s The Ed25519 signature response (second 32 bytes).
     * @return bool Returns true if the signature is valid, false otherwise.
     */
    function verifyEd25519Signature(
        bytes32 message,
        bytes32 publicKey,
        bytes32 r,
        bytes32 s
    ) internal pure returns (bool) {
        IEd25519Verify verifier = IEd25519Verify(IED25519VERIFY_ADDRESS);
        return verifier.verify(message, publicKey, r, s);
        // Developer Comment: The return structure [value, err] is not standard practice in Solidity. Functions typically return values directly or revert on error. Returning a boolean indicating success/failure is common.
    }
}

