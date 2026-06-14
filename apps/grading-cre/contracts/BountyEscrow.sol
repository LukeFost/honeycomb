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

    // onReport action discriminator. Architecture A: the two TEEs write independently.
    uint8 internal constant ACTION_RECORD_SCORE = 0; // from the Grader enclave's CRE callback
    uint8 internal constant ACTION_RECORD_VALIDITY = 1; // from the AI Attestor's CRE callback
    uint8 internal constant ACTION_RESOLVE = 2; // from the CRON resolver
    uint8 internal constant ACTION_DELIVER = 3; // from the Grader enclave (post-resolve, winner re-sealed to maker)

    // Per-(jobId, agentId) submission state. The two gates arrive in EITHER order via
    // separate TEE callbacks; a submission can only lead once BOTH are in and valid.
    struct Submission {
        uint16 score; // execution score 0..10000
        bool hasScore; // grader enclave wrote a (sig-verified) score
        bool valid; // AI attestor verdict
        bool hasValidity; // AI attestor wrote a verdict
        bytes32 scoreDigest; // keccak256(jobId,agentId,score) — the ecrecover'd digest
        bytes32 validityAtt; // AI attestor response digest (record)
        string encCid; // the agent's submission, sealed to the grader enclave's key
    }

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
        address attesterKey; // execution enclave's signer (ecrecover target for scores)
        bytes32 makerPubKey; // maker's X25519 key — the grader seals the WINNER's code to this
        // --- live leaderboard: best VALID grade so far ---
        uint256 bestAgentId; // ERC-8004 agentId of current leader (0 = none)
        uint16 bestScore; // execution score 0..10000
        bytes32 bestScoreAtt; // execution-enclave attestation digest
        bytes32 bestValidityAtt; // Confidential AI Attester attestation digest
        uint64 gradeCount; // submissions graded
        string winnerDeliveryCid; // winning code re-sealed to makerPubKey (set on delivery)
    }

    address public rewardToken; // default token for new bounties (settable)
    IIdentityRegistry public immutable identityRegistry;
    address public immutable forwarder;
    address public owner;

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => mapping(uint256 => Submission)) public submissionOf; // jobId => agentId => state

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
    event Submitted(uint256 indexed jobId, uint256 indexed agentId, string encCid);
    event ScoreRecorded(uint256 indexed jobId, uint256 indexed agentId, uint16 score, bytes32 scoreDigest);
    event ValidityRecorded(uint256 indexed jobId, uint256 indexed agentId, bool valid, bytes32 validityAtt);
    event NewLeader(uint256 indexed jobId, uint256 indexed agentId, uint16 score);
    event WinnerDelivered(uint256 indexed jobId, uint256 indexed winnerAgentId, string deliveryCid);
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
        string calldata specCid,
        address attesterKey,
        bytes32 makerPubKey
    ) external returns (uint256 jobId) {
        require(budget > 0 && expiredAt > block.timestamp, "bad params");
        require(attesterKey != address(0), "no attester");
        require(makerPubKey != bytes32(0), "no maker key");
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
        j.attesterKey = attesterKey;
        j.makerPubKey = makerPubKey;
        require(IERC20(token).transferFrom(msg.sender, address(this), budget), "fund failed");
        emit JobCreated(jobId, msg.sender, token, budget, expiredAt, testsHash, specCid);
    }

    // --- agent: submit an encrypted entry -----------------------------------

    /// @notice Register a submission CID (sealed to the grader enclave's key). Only the
    ///         agent's own registered wallet may submit for its agentId. The enclave
    ///         re-fetches this CID at delivery to re-seal the winner to the maker.
    function submit(uint256 jobId, uint256 agentId, string calldata encCid) external {
        Job storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(j.status == JobStatus.Funded, "not open");
        require(block.timestamp <= j.expiredAt, "submissions closed");
        require(msg.sender == identityRegistry.getAgentWallet(agentId), "not agent wallet");
        submissionOf[jobId][agentId].encCid = encCid;
        emit Submitted(jobId, agentId, encCid);
    }

    // --- evaluator (CRE via forwarder): record grades + resolve + deliver ----

    /// @inheritdoc IReceiver
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender);
        (uint8 action, bytes memory data) = abi.decode(report, (uint8, bytes));

        if (action == ACTION_RECORD_SCORE) {
            (uint256 jobId, uint256 agentId, uint16 score, uint8 v, bytes32 r, bytes32 s) =
                abi.decode(data, (uint256, uint256, uint16, uint8, bytes32, bytes32));
            _recordScore(jobId, agentId, score, v, r, s);
        } else if (action == ACTION_RECORD_VALIDITY) {
            (uint256 jobId, uint256 agentId, bool valid, bytes32 validityAtt) =
                abi.decode(data, (uint256, uint256, bool, bytes32));
            _recordValidity(jobId, agentId, valid, validityAtt);
        } else if (action == ACTION_RESOLVE) {
            uint256 jobId = abi.decode(data, (uint256));
            _resolve(jobId);
        } else if (action == ACTION_DELIVER) {
            (uint256 jobId, string memory deliveryCid) = abi.decode(data, (uint256, string));
            _deliverWinner(jobId, deliveryCid);
        } else {
            revert("bad action");
        }
    }

    /// @dev Grader enclave posts the winning code re-sealed to the maker's key.
    function _deliverWinner(uint256 jobId, string memory deliveryCid) internal {
        Job storage j = jobs[jobId];
        require(j.status == JobStatus.Completed, "not completed");
        j.winnerDeliveryCid = deliveryCid;
        emit WinnerDelivered(jobId, j.bestAgentId, deliveryCid);
    }

    /// @dev Open for grading while Funded and within the grace window.
    function _gradingOpen(Job storage j) internal view {
        require(j.client != address(0), "no job");
        require(j.status == JobStatus.Funded, "not open");
        require(block.timestamp <= j.expiredAt + SETTLE_GRACE, "grading closed");
    }

    // --- Gate 1: the Grader enclave's signed score (ecrecover-verified) ----------

    function _recordScore(uint256 jobId, uint256 agentId, uint16 score, uint8 v, bytes32 r, bytes32 s)
        internal
    {
        Job storage j = jobs[jobId];
        _gradingOpen(j);
        // The score must be SIGNED by this bounty's execution enclave. The signed digest
        // binds (jobId, agentId, score) → can't be lied about, replayed, or forged.
        bytes32 scoreDigest = keccak256(abi.encode(jobId, agentId, uint256(score)));
        require(ecrecover(scoreDigest, v, r, s) == j.attesterKey, "bad enclave score sig");

        Submission storage sub = submissionOf[jobId][agentId];
        sub.score = score;
        sub.hasScore = true;
        sub.scoreDigest = scoreDigest;
        emit ScoreRecorded(jobId, agentId, score, scoreDigest);
        _maybePromote(jobId, agentId);
    }

    // --- Gate 2: the AI Attestor's validity verdict (delivered via its CRE callback) -

    function _recordValidity(uint256 jobId, uint256 agentId, bool valid, bytes32 validityAtt) internal {
        Job storage j = jobs[jobId];
        _gradingOpen(j);
        Submission storage sub = submissionOf[jobId][agentId];
        sub.valid = valid;
        sub.hasValidity = true;
        sub.validityAtt = validityAtt;
        emit ValidityRecorded(jobId, agentId, valid, validityAtt);
        _maybePromote(jobId, agentId);
    }

    // --- Combine: a submission leads only with BOTH gates in and valid -----------

    function _maybePromote(uint256 jobId, uint256 agentId) internal {
        if (agentId == 0) return;
        Submission storage sub = submissionOf[jobId][agentId];
        // effective = valid ? score : 0 ; needs an enclave-signed score AND a valid verdict.
        if (!(sub.hasScore && sub.hasValidity && sub.valid)) return;
        Job storage j = jobs[jobId];
        if (j.bestAgentId == 0 || sub.score > j.bestScore) {
            j.bestAgentId = agentId;
            j.bestScore = sub.score;
            j.bestScoreAtt = sub.scoreDigest;
            j.bestValidityAtt = sub.validityAtt;
            emit NewLeader(jobId, agentId, sub.score);
        }
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

    /// @notice The winning code, re-sealed to the maker's key (maker decrypts with their secret).
    function winnerDeliveryCidOf(uint256 jobId) external view returns (string memory) {
        return jobs[jobId].winnerDeliveryCid;
    }

    function isSettled(uint256 jobId) external view returns (bool) {
        JobStatus s = jobs[jobId].status;
        return s == JobStatus.Completed || s == JobStatus.Rejected || s == JobStatus.Expired;
    }
}
