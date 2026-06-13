// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockHoneycombEscrow
/// @notice Mock Honeycomb escrow + enclave validation for the demo's Layer-2 bounty market.
/// Emits the full bounty lifecycle; the indexer (viem) decodes these into
/// honeycomb_demo.{bounties,submissions,validations,settlements}, which apps/web reputation.ts
/// reads to build the earned-reputation leaderboard. Not a real escrow — it holds no funds and
/// runs no enclave; it emits the event shapes only so the dashboard can populate from a chain
/// you control. A bounty is "open" until a BountySettled is seen for it.
contract MockHoneycombEscrow {
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed requester,
        string category,
        string title,
        uint256 rewardWei,
        uint64 deadline
    );
    event SubmissionMade(uint256 indexed bountyId, uint256 indexed agentId, string submissionCid);
    event ValidationRecorded(
        uint256 indexed bountyId,
        uint256 indexed agentId,
        address validator,
        uint8 response,
        bool valid,
        bytes32 responseHash
    );
    event BountySettled(
        uint256 indexed bountyId, uint256 indexed winnerAgentId, uint32 winnerScore, bytes32 attestationHash
    );

    function createBounty(
        uint256 bountyId,
        address requester,
        string calldata category,
        string calldata title,
        uint256 rewardWei,
        uint64 deadline
    ) external {
        emit BountyCreated(bountyId, requester, category, title, rewardWei, deadline);
    }

    function submit(uint256 bountyId, uint256 agentId, string calldata submissionCid) external {
        emit SubmissionMade(bountyId, agentId, submissionCid);
    }

    function validate(
        uint256 bountyId,
        uint256 agentId,
        address validator,
        uint8 response,
        bool valid,
        bytes32 responseHash
    ) external {
        emit ValidationRecorded(bountyId, agentId, validator, response, valid, responseHash);
    }

    function settle(uint256 bountyId, uint256 winnerAgentId, uint32 winnerScore, bytes32 attestationHash) external {
        emit BountySettled(bountyId, winnerAgentId, winnerScore, attestationHash);
    }
}
