// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockErc8004
/// @notice Mock ERC-8004 Identity + Reputation registries for the self-contained demo. Emits
/// events whose byte layout the REAL apps/web/src/lib/bq.ts decode SQL parses, so deploying
/// this on a local chain and pointing BQ_IDENTITY_REGISTRY / BQ_REPUTATION_REGISTRY at it
/// drives the live Directory pipeline (raw logs → SQL decode → agent_trust view) from a chain
/// you control. Not a real registry — it emits the event shapes only; it stores nothing.
///
/// - `Registered(uint256,string,address)` → topic0 0xca52… (identical to the EF mainnet
///   contract). agentId + owner indexed; metadataURI is the sole data word-set, so
///   decodeRegisteredSql reads owner from topics[2] and the URI string from data.
/// - `NewFeedback(uint256,address,bytes32,uint256,uint8)` → topic0 0x464064…. agentId + client
///   indexed; data = [tag, value, valueDecimals], so decodeFeedbackSql reads value at the 2nd
///   data word and valueDecimals at the 3rd (score = value / 10^valueDecimals). Set
///   BQ_REPUTATION_TOPIC0 to this event's topic0 for the demo.
contract MockErc8004 {
    event Registered(uint256 indexed agentId, string metadataURI, address indexed owner);
    event NewFeedback(
        uint256 indexed agentId, address indexed client, bytes32 tag, uint256 value, uint8 valueDecimals
    );

    function register(uint256 agentId, string calldata metadataURI, address owner) external {
        emit Registered(agentId, metadataURI, owner);
    }

    function leaveFeedback(uint256 agentId, address client, uint256 value, uint8 valueDecimals) external {
        emit NewFeedback(agentId, client, bytes32(0), value, valueDecimals);
    }
}
