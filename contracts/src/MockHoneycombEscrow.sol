// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockHoneycombEscrow
/// @notice Mock Honeycomb escrow + enclave validation for the demo's Layer-2 bounty market.
/// Emits the full bounty lifecycle whose byte layout the REAL apps/web/src/lib/bq.ts decode SQL
/// parses (decodeBountiesSql / decodeSubmissionsSql / decodeValidationsSql / decodeSettlementsSql):
/// pointing BQ_ESCROW_ADDRESS at this contract drives honeycomb.{bounties,submissions,validations,
/// settlements} through the same warehouse-native decode→MERGE loop production runs — no off-chain
/// indexer. apps/web reputation.ts reads those tables to build the earned-reputation leaderboard.
/// Not a real escrow — it holds no funds and runs no enclave; it emits the event shapes only so
/// the dashboard can populate from a chain you control. A bounty is "open" until a BountySettled.
///
/// Events are designed SQL-friendly (handoff doc §5): every field is fixed-width except a single
/// trailing `string`, so the decoder never slices two dynamic blobs. `BountyCreated.category` is
/// therefore a bytes32 enum and `title` is the lone trailing string.
contract MockHoneycombEscrow {
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed requester,
        bytes32 category,
        uint256 rewardWei,
        uint64 deadline,
        string title
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
        bytes32 category,
        uint256 rewardWei,
        uint64 deadline,
        string calldata title
    ) external {
        emit BountyCreated(bountyId, requester, category, rewardWei, deadline, title);
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
