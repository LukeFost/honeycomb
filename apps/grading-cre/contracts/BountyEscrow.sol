// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// BountyEscrow — ERC-8183 job escrow with TEE-graded, CRE-resolved settlement
// ============================================================================
//
// Lifecycle:
//   1. maker createBounty(...)            → Funds USDC escrow, commits testsHash.
//   2. grader recordGrade(...) per entry  → BOTH TEE outputs land on-chain:
//        • execution score + scoreAttestationHash  (Confidential Space scorer)
//        • AI validity     + validityAttestationHash (Confidential AI Attester)
//      Only VALID grades can win (effective = valid ? score : 0). The contract
//      tracks the best valid submission as the live leaderboard top.
//   3. CRE CRON resolve(jobId) AFTER expiredAt → pays the best valid agent's
//      wallet (ERC-8004 Identity), or refunds the maker if none.
//
// Both recordGrade and resolve arrive through the CRE KeystoneForwarder's single
// onReport entrypoint, multiplexed by an action discriminator. The forwarder is
// the evaluator; the report is DON-signed.
//
// ERC-8004 Identity (Sepolia): 0x8004A818BFB912233c491871b3d84c89A494BD9e.
// Forwarder (Sepolia): Mock 0x15fC6ae953E024d975e77382eEeC56A9101f9F88 (sim),
// 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 (prod).
// ============================================================================

interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IIdentityRegistry {
    function getAgentWallet(uint256 agentId) external view returns (address);
}

contract BountyEscrow is IReceiver {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    // onReport action discriminator.
    uint8 internal constant ACTION_RECORD_GRADE = 0;
    uint8 internal constant ACTION_RESOLVE = 1;

    struct Job {
        uint256 id;
        address client; // bounty maker
        address provider; // winner wallet, set at resolution
        address evaluator; // CRE KeystoneForwarder
        uint256 budget; // reward escrowed (0 once funds leave)
        uint64 expiredAt; // contest deadline (resolution gate)
        JobStatus status;
        address token; // reward token snapshot
        bytes32 testsHash; // commitment to PRIVATE tests + rubric
        string specCid; // PUBLIC spec / tests
        // --- live leaderboard: best VALID grade so far ---
        uint256 bestAgentId; // ERC-8004 agentId of current leader (0 = none)
        uint16 bestScore; // execution score 0..10000
        bytes32 bestScoreAtt; // execution-enclave attestation digest
        bytes32 bestValidityAtt; // Confidential AI Attester attestation digest
        uint64 gradeCount; // submissions graded
    }

    address public rewardToken; // default token for new bounties (settable)
    IIdentityRegistry public immutable identityRegistry;
    address public immutable forwarder;
    address public owner;

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    /// @notice Grace after expiredAt during which only resolve (not claimRefund)
    ///         is allowed — grading runs after the deadline.
    uint256 public constant SETTLE_GRACE = 1 hours;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address token,
        uint256 budget,
        uint64 expiredAt,
        bytes32 testsHash,
        string specCid
    );
    event GradeRecorded(
        uint256 indexed jobId,
        uint256 indexed agentId,
        uint16 score,
        bool valid,
        bytes32 scoreAttestationHash,
        bytes32 validityAttestationHash,
        bool newLeader
    );
    event JobResolved(
        uint256 indexed jobId,
        uint256 indexed winnerAgentId,
        address provider,
        uint16 score,
        uint256 paidOut
    );
    event JobExpired(uint256 indexed jobId, uint256 refunded);
    event RewardTokenSet(address indexed token);

    error UnauthorizedForwarder(address caller);
    error NotOwner(address caller);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(address forwarder_, address rewardToken_, address identityRegistry_) {
        forwarder = forwarder_;
        rewardToken = rewardToken_;
        identityRegistry = IIdentityRegistry(identityRegistry_);
        owner = msg.sender;
    }

    function setRewardToken(address token) external onlyOwner {
        rewardToken = token;
        emit RewardTokenSet(token);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // --- client: create + fund ----------------------------------------------

    function createBounty(
        uint256 budget,
        uint64 expiredAt,
        bytes32 testsHash,
        string calldata specCid
    ) external returns (uint256 jobId) {
        require(budget > 0 && expiredAt > block.timestamp, "bad params");
        address token = rewardToken;
        jobId = nextJobId++;
        Job storage j = jobs[jobId];
        j.id = jobId;
        j.client = msg.sender;
        j.evaluator = forwarder;
        j.budget = budget;
        j.expiredAt = expiredAt;
        j.status = JobStatus.Funded;
        j.token = token;
        j.testsHash = testsHash;
        j.specCid = specCid;
        require(IERC20(token).transferFrom(msg.sender, address(this), budget), "fund failed");
        emit JobCreated(jobId, msg.sender, token, budget, expiredAt, testsHash, specCid);
    }

    // --- evaluator (CRE via forwarder): record grades + resolve -------------

    /// @inheritdoc IReceiver
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender);
        (uint8 action, bytes memory data) = abi.decode(report, (uint8, bytes));

        if (action == ACTION_RECORD_GRADE) {
            (
                uint256 jobId,
                uint256 agentId,
                uint16 score,
                bool valid,
                bytes32 scoreAtt,
                bytes32 validityAtt
            ) = abi.decode(data, (uint256, uint256, uint16, bool, bytes32, bytes32));
            _recordGrade(jobId, agentId, score, valid, scoreAtt, validityAtt);
        } else if (action == ACTION_RESOLVE) {
            uint256 jobId = abi.decode(data, (uint256));
            _resolve(jobId);
        } else {
            revert("bad action");
        }
    }

    function _recordGrade(
        uint256 jobId,
        uint256 agentId,
        uint16 score,
        bool valid,
        bytes32 scoreAtt,
        bytes32 validityAtt
    ) internal {
        Job storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(j.status == JobStatus.Funded, "not open");
        // Grading window = contest + SETTLE_GRACE (covers grading latency). Stops
        // grades being inserted arbitrarily late to snipe a result post-contest.
        require(block.timestamp <= j.expiredAt + SETTLE_GRACE, "grading closed");
        j.gradeCount += 1;

        // effective = valid ? score : 0  → only valid grades can take the lead.
        bool newLeader = valid && agentId != 0 && (j.bestAgentId == 0 || score > j.bestScore);
        if (newLeader) {
            j.bestAgentId = agentId;
            j.bestScore = score;
            j.bestScoreAtt = scoreAtt;
            j.bestValidityAtt = validityAtt;
        }
        emit GradeRecorded(jobId, agentId, score, valid, scoreAtt, validityAtt, newLeader);
    }

    function _resolve(uint256 jobId) internal {
        Job storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(j.status == JobStatus.Funded, "not funded");
        require(block.timestamp > j.expiredAt, "not ended"); // TIME-BASED resolution

        uint256 amount = j.budget;
        j.budget = 0;

        address winnerWallet =
            j.bestAgentId != 0 ? identityRegistry.getAgentWallet(j.bestAgentId) : address(0);

        if (winnerWallet != address(0)) {
            j.provider = winnerWallet;
            j.status = JobStatus.Completed;
            if (amount > 0) require(IERC20(j.token).transfer(winnerWallet, amount), "payout failed");
            emit JobResolved(jobId, j.bestAgentId, winnerWallet, j.bestScore, amount);
        } else {
            j.status = JobStatus.Rejected;
            if (amount > 0) require(IERC20(j.token).transfer(j.client, amount), "refund failed");
            emit JobResolved(jobId, 0, address(0), 0, 0);
        }
    }

    // --- client: reclaim if never resolved ----------------------------------

    function claimRefund(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == JobStatus.Funded, "not refundable");
        require(block.timestamp > j.expiredAt + SETTLE_GRACE, "not expired");
        uint256 amount = j.budget;
        require(amount > 0, "nothing");
        j.budget = 0;
        j.status = JobStatus.Expired;
        require(IERC20(j.token).transfer(j.client, amount), "refund failed");
        emit JobExpired(jobId, amount);
    }

    // --- views ---------------------------------------------------------------

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function winnerWalletOf(uint256 jobId) external view returns (address) {
        return jobs[jobId].provider;
    }

    function isSettled(uint256 jobId) external view returns (bool) {
        JobStatus s = jobs[jobId].status;
        return s == JobStatus.Completed || s == JobStatus.Rejected || s == JobStatus.Expired;
    }
}
