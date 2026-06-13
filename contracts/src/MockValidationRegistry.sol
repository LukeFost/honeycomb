// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockValidationRegistry
/// @notice A minimal stand-in for the ERC-8004 Validation Registry, which has no Ethereum
/// Foundation mainnet deployment yet (see apps/web/src/lib/bq.ts: BQ_VALIDATION_REGISTRY is
/// "pending EF mainnet deployment"). It emits `ValidationResponse` / `ValidationRequest` with
/// the EXACT canonical signatures, so their topic0 hashes match the constants the dashboard
/// filters on in bq.ts. Deploy this on a local Anvil chain to drive the on-chain
/// read-verification harness end to end.
///
/// This is NOT a validator: it grades nothing and runs no enclave. It only emits the event
/// *shape* so we can prove the indexing/serving path reads on-chain data correctly. The
/// indexed-ness of parameters is free to choose (it does not affect topic0) and does not
/// matter to the dashboard, which counts these events by topic0 alone.
contract MockValidationRegistry {
    // canonical sig: ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)
    // topic0:        0xafddf629e874ccc3963b6a888c477bd464a6c8525024fc88759ea3b2326349ae
    event ValidationResponse(
        address indexed validator,
        uint256 indexed agentId,
        bytes32 dataHash,
        uint8 response,
        string uri,
        bytes32 tag,
        string extra
    );

    // canonical sig: ValidationRequest(address,uint256,string,bytes32)
    // topic0:        0x530436c3634a98e1e626b0898be2f1e9980cc1bd2a78c07a0aba52d0a48a5059
    event ValidationRequest(
        address indexed validator,
        uint256 indexed agentId,
        string uri,
        bytes32 dataHash
    );

    function emitResponse(
        address validator,
        uint256 agentId,
        bytes32 dataHash,
        uint8 response,
        string calldata uri,
        bytes32 tag,
        string calldata extra
    ) external {
        emit ValidationResponse(validator, agentId, dataHash, response, uri, tag, extra);
    }

    function emitRequest(address validator, uint256 agentId, string calldata uri, bytes32 dataHash)
        external
    {
        emit ValidationRequest(validator, agentId, uri, dataHash);
    }
}
