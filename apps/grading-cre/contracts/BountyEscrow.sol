// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// BountyEscrow — create / fund / settle a graded bounty (Honeycomb)
// ============================================================================
//
// Maker side:
//   createBounty(bountyId, reward, deadline, testsHash, specCid)
//     • pulls `reward` USDC into escrow (maker must approve() first)
//     • commits `testsHash` = hash of the PRIVATE tests + rubric (hidden; the
//       grading enclave later verifies it graded against this exact commitment)
//     • `specCid` points at the PUBLIC spec/tests (IPFS)
//
// Settlement side (decided off-chain from two attested TEE jobs):
//   • execution grading — run code against the datasets → score (+ attestation)
//   • AI attestation    — LLM judges valid / not hardcoded → valid (+ attestation)
//   The grader POSTs the result to a CRE workflow's HTTP trigger; the workflow
//   ABI-encodes it and writes here via the KeystoneForwarder:
//
//     CRE workflow --(report)--> KeystoneForwarder --(onReport)--> BountyEscrow
//
//   onReport records the settlement and, if the winner is valid, AUTO-PAYS the
//   USDC reward to the winner.
//
// Forwarder (Ethereum Sepolia): simulation Mock 0x15fC6ae953E024d975e77382eEeC56A9101f9F88,
// production 0xF8344CFd5c43616a4366C34E3EEE75af79a74482. The decoded settlement
// tuple MUST match the workflow's encodeAbiParameters call.
// ============================================================================

interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BountyEscrow is IReceiver {
    struct Bounty {
        address maker;
        uint256 reward; // USDC (6 decimals) locked in escrow
        uint64 deadline; // contest end (drives the CRON trigger)
        bytes32 testsHash; // commitment to PRIVATE tests + rubric
        string specCid; // PUBLIC spec / tests (IPFS)
        bool settled;
    }

    struct Settlement {
        address winner;
        uint256 score; // execution score (scaled integer)
        bool valid; // AI attestor verdict: valid and not hardcoded
        bytes32 scoreAttestationHash; // execution-enclave attestation digest
        bytes32 validityAttestationHash; // Confidential AI Attester attestation digest
        uint256 paidOut; // USDC released to the winner
        uint256 timestamp;
    }

    address public immutable forwarder;
    IERC20 public immutable rewardToken; // e.g. Sepolia USDC

    mapping(bytes32 => Bounty) public bountyById;
    mapping(bytes32 => Settlement) public settlementByBounty;

    event BountyCreated(
        bytes32 indexed bountyId,
        address indexed maker,
        uint256 reward,
        uint64 deadline,
        bytes32 testsHash,
        string specCid
    );
    event BountySettled(
        bytes32 indexed bountyId, address indexed winner, uint256 score, bool valid, uint256 paidOut
    );
    event BountyReclaimed(bytes32 indexed bountyId, address indexed maker, uint256 amount);

    error UnauthorizedForwarder(address caller);

    modifier onlyForwarder() {
        if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender);
        _;
    }

    constructor(address forwarder_, address rewardToken_) {
        forwarder = forwarder_;
        rewardToken = IERC20(rewardToken_);
    }

    // --- Maker: create + fund ------------------------------------------------

    function createBounty(
        bytes32 bountyId,
        uint256 reward,
        uint64 deadline,
        bytes32 testsHash,
        string calldata specCid
    ) external {
        require(bountyById[bountyId].maker == address(0), "exists");
        require(reward > 0 && deadline > block.timestamp, "bad params");

        bountyById[bountyId] = Bounty({
            maker: msg.sender,
            reward: reward,
            deadline: deadline,
            testsHash: testsHash,
            specCid: specCid,
            settled: false
        });

        require(rewardToken.transferFrom(msg.sender, address(this), reward), "fund failed");
        emit BountyCreated(bountyId, msg.sender, reward, deadline, testsHash, specCid);
    }

    // --- Settlement: record winner + auto-payout -----------------------------

    /// @inheritdoc IReceiver
    function onReport(bytes calldata, bytes calldata report) external onlyForwarder {
        (
            bytes32 bountyId,
            address winner,
            uint256 score,
            bool valid,
            bytes32 scoreAttestationHash,
            bytes32 validityAttestationHash
        ) = abi.decode(report, (bytes32, address, uint256, bool, bytes32, bytes32));

        Bounty storage b = bountyById[bountyId];
        require(b.maker != address(0), "no bounty");
        require(!b.settled, "settled");
        b.settled = true;

        // Funds ALWAYS move on settlement: pay a VALID, non-zero winner; otherwise
        // refund the maker. Settled bounties are not reclaimable, so without this
        // branch a no-valid-winner settlement would strand the reward forever.
        uint256 paidOut = 0;
        uint256 amount = b.reward;
        if (amount > 0) {
            b.reward = 0;
            if (valid && winner != address(0)) {
                paidOut = amount;
                require(rewardToken.transfer(winner, amount), "payout failed");
            } else {
                require(rewardToken.transfer(b.maker, amount), "refund failed");
            }
        }

        settlementByBounty[bountyId] = Settlement({
            winner: winner,
            score: score,
            valid: valid,
            scoreAttestationHash: scoreAttestationHash,
            validityAttestationHash: validityAttestationHash,
            paidOut: paidOut,
            timestamp: block.timestamp
        });

        emit BountySettled(bountyId, winner, score, valid, paidOut);
    }

    // --- Maker: reclaim if never settled -------------------------------------

    /// @notice After the deadline, an unsettled bounty's reward returns to the maker.
    function reclaim(bytes32 bountyId) external {
        Bounty storage b = bountyById[bountyId];
        require(msg.sender == b.maker, "not maker");
        require(!b.settled && block.timestamp > b.deadline, "not reclaimable");

        uint256 amount = b.reward;
        require(amount > 0, "nothing");
        b.reward = 0;
        b.settled = true;

        require(rewardToken.transfer(b.maker, amount), "refund failed");
        emit BountyReclaimed(bountyId, b.maker, amount);
    }

    // --- Views ---------------------------------------------------------------

    function winnerOf(bytes32 bountyId) external view returns (address) {
        return settlementByBounty[bountyId].winner;
    }

    function isSettled(bytes32 bountyId) external view returns (bool) {
        return bountyById[bountyId].settled;
    }
}
