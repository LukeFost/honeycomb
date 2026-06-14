// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// BountyEscrow — ERC-8183 (Agentic Commerce) job escrow with TEE-graded,
// CRE-resolved settlement, run as a multi-agent contest.
// ============================================================================
//
// ERC-8183 is a 1 client ↔ 1 provider job escrow. A bounty is inherently 1→many
// (one maker, N competing agents), and the provider isn't known until the
// contest is graded. We reconcile the two like this:
//
//   • The CONTEST is the discovery phase (createBounty → agents submit → the two
//     TEEs score/validate each entry → best VALID submission leads).
//   • The ERC-8183 JOB is the settlement record. At resolution we "declare the
//     1:1 job": bind the winner as `provider`, mark the deliverable Submitted,
//     and Complete it — driving the standard Open→Funded→Submitted→Completed
//     lifecycle and emitting every standard event (ProviderSet, JobSubmitted,
//     JobCompleted, PaymentReleased). The final on-chain log IS a valid 8183 job.
//
// The contract `is IERC8183` so the compiler verifies it implements the standard
// interface. A *generic* 8183 job (createJob → setProvider → setBudget → fund →
// submit → complete) is also fully supported with the standard role auth + state
// machine. CONTEST jobs (createBounty) are evaluator-settled: the client-callable
// mutators (setProvider/submit/complete/reject) revert on them — the contest
// outcome, not the client, picks the provider. The standard permits the evaluator
// to complete/reject, which is exactly what the CRE resolver does via onReport.
//
// Lifecycle (contest):
//   1. maker createBounty(...)            → funds USDC escrow, commits testsHash.
//   2. each agent submit(jobId,agentId,encCid) → entry sealed to the enclave key.
//   3. the two TEEs write per-entry, in either order, via the CRE forwarder:
//        • Grader enclave score (ecrecover-verified)  → recordScore
//        • AI Attestor validity verdict               → recordValidity
//      effective = valid ? score : 0; the best valid entry leads.
//   4. CRE CRON resolve(jobId) AFTER expiredAt → declares the winner as provider
//      and Completes the 8183 job (pays the winner's ERC-8004 wallet), or rejects
//      + refunds the maker if there's no valid winner.
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

// ERC-8183 job lifecycle status (file-level so the interface struct and the
// contract storage share one definition). Order is normative.
enum JobStatus {
    Open,
    Funded,
    Submitted,
    Completed,
    Rejected,
    Expired
}

/// @notice ERC-8183 "Agentic Commerce" core interface (non-hooked kernel). A
///         contract that ignores the `hook` field entirely is fully compliant.
interface IERC8183 {
    // The standard Job view. `getJob` returns exactly this shape so generic 8183
    // consumers can decode it. Our rich per-job state lives in getJobFull().
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);
    function setProvider(uint256 jobId, address provider) external;
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;

    function getJob(uint256 jobId) external view returns (Job memory);

    // SHOULD-emit standard events.
    event JobCreated(
        uint256 indexed jobId, address indexed client, address provider, address evaluator, uint256 expiredAt
    );
    event ProviderSet(uint256 indexed jobId, address provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address client, uint256 amount);
}

contract BountyEscrow is IReceiver, IERC8183 {
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

    // Rich internal per-job state (superset of the ERC-8183 Job). Returned by
    // getJobFull(); the standard getJob() projects the 8183 subset out of this.
    // `specCid` is the ERC-8183 `description` (the public spec pointer).
    struct JobData {
        uint256 id;
        address client; // bounty maker (ERC-8183 client)
        address provider; // winner wallet, declared at resolution (ERC-8183 provider)
        address evaluator; // CRE KeystoneForwarder (ERC-8183 evaluator)
        uint256 budget; // reward escrowed (0 once funds leave)
        uint64 expiredAt; // contest deadline (resolution gate)
        JobStatus status;
        address token; // reward token snapshot
        bytes32 testsHash; // commitment to PRIVATE tests + rubric
        string specCid; // PUBLIC spec / tests == ERC-8183 description
        address attesterKey; // execution enclave's signer (ecrecover target for scores)
        bytes32 makerPubKey; // maker's X25519 key — the grader seals the WINNER's code to this
        bytes32 enclaveEncPub; // per-bounty enclave's X25519 key — agents seal SUBMISSIONS to this
        address hook; // ERC-8183 hook (address(0) = non-hooked kernel)
        bool isContest; // true = evaluator-settled bounty (createBounty); false = generic 8183 job
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
    mapping(uint256 => JobData) public jobs;
    mapping(uint256 => mapping(uint256 => Submission)) public submissionOf; // jobId => agentId => state

    /// @notice Grace after expiredAt during which only resolve (not claimRefund)
    ///         is allowed — grading runs after the deadline.
    uint256 public constant SETTLE_GRACE = 1 hours;

    // --- contest-specific events (not part of ERC-8183) -------------------------
    event Submitted(uint256 indexed jobId, uint256 indexed agentId, string encCid);
    event ScoreRecorded(uint256 indexed jobId, uint256 indexed agentId, uint16 score, bytes32 scoreDigest);
    event ValidityRecorded(uint256 indexed jobId, uint256 indexed agentId, bool valid, bytes32 validityAtt);
    event NewLeader(uint256 indexed jobId, uint256 indexed agentId, uint16 score);
    event WinnerDelivered(uint256 indexed jobId, uint256 indexed winnerAgentId, string deliveryCid);
    // Kept for back-compat with the existing indexer/tests (richer than JobCompleted).
    event JobResolved(
        uint256 indexed jobId, uint256 indexed winnerAgentId, address provider, uint16 score, uint256 paidOut
    );

    // --- Dashboard alias events (web bq.ts "bounty-market escrow" schema) ---------
    // Emitted ALONGSIDE the ERC-8183 events so the web Layer-2 decode reads this
    // grading escrow unchanged (jobId == bountyId). Field mapping: rewardWei =
    // budget*1e12 (USDC 6dp → 1e18 so reward_eth shows the USDC amount), title =
    // specCid, response = score/100 (0..100), validator = attesterKey, hash = validityAtt.
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed requester,
        bytes32 category,
        uint256 rewardWei,
        uint64 deadline, // MUST match web bq.ts topic0 (uint64, not uint256)
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

    // ========================================================================
    // CONTEST PATH — the 1→many bounty (createBounty + TEE grading + resolve)
    // ========================================================================

    // --- maker: create + fund a contest -------------------------------------

    function createBounty(
        uint256 budget,
        uint64 expiredAt,
        bytes32 testsHash,
        string calldata specCid,
        address attesterKey,
        bytes32 makerPubKey,
        bytes32 enclaveEncPub
    ) external returns (uint256 jobId) {
        require(budget > 0 && expiredAt > block.timestamp, "bad params");
        require(attesterKey != address(0), "no attester");
        require(makerPubKey != bytes32(0), "no maker key");
        require(enclaveEncPub != bytes32(0), "no enclave key");
        address token = rewardToken;
        jobId = nextJobId++;
        JobData storage j = jobs[jobId];
        j.id = jobId;
        j.client = msg.sender;
        j.evaluator = forwarder;
        j.budget = budget;
        j.expiredAt = expiredAt;
        j.status = JobStatus.Funded; // created + funded atomically
        j.token = token;
        j.testsHash = testsHash;
        j.specCid = specCid;
        j.attesterKey = attesterKey;
        j.makerPubKey = makerPubKey;
        j.enclaveEncPub = enclaveEncPub;
        j.isContest = true; // evaluator-settled: client cannot pick the provider
        require(IERC20(token).transferFrom(msg.sender, address(this), budget), "fund failed");
        // ERC-8183 lifecycle: created (provider TBD via the contest) then funded.
        emit JobCreated(jobId, msg.sender, address(0), forwarder, expiredAt);
        emit JobFunded(jobId, msg.sender, budget);
        // Dashboard alias.
        emit BountyCreated(jobId, msg.sender, bytes32(0), budget * 1e12, expiredAt, specCid);
    }

    // --- agent: submit an encrypted entry -----------------------------------

    /// @notice Register a submission CID (sealed to the grader enclave's key). Only the
    ///         agent's own registered wallet may submit for its agentId. The enclave
    ///         re-fetches this CID at delivery to re-seal the winner to the maker.
    ///         (Overloads the ERC-8183 submit(uint256,bytes32,bytes); distinct selector.)
    function submit(uint256 jobId, uint256 agentId, string calldata encCid) external {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(j.isContest, "not a contest");
        require(j.status == JobStatus.Funded, "not open");
        require(block.timestamp <= j.expiredAt, "submissions closed");
        require(msg.sender == identityRegistry.getAgentWallet(agentId), "not agent wallet");
        submissionOf[jobId][agentId].encCid = encCid;
        emit Submitted(jobId, agentId, encCid);
        emit SubmissionMade(jobId, agentId, encCid);
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
        JobData storage j = jobs[jobId];
        require(j.status == JobStatus.Completed, "not completed");
        j.winnerDeliveryCid = deliveryCid;
        emit WinnerDelivered(jobId, j.bestAgentId, deliveryCid);
    }

    /// @dev Open for grading while Funded and within the grace window.
    function _gradingOpen(JobData storage j) internal view {
        require(j.client != address(0), "no job");
        require(j.isContest, "not a contest");
        require(j.status == JobStatus.Funded, "not open");
        require(block.timestamp <= j.expiredAt + SETTLE_GRACE, "grading closed");
    }

    // --- Gate 1: the Grader enclave's signed score (ecrecover-verified) ----------

    function _recordScore(uint256 jobId, uint256 agentId, uint16 score, uint8 v, bytes32 r, bytes32 s)
        internal
    {
        JobData storage j = jobs[jobId];
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
        JobData storage j = jobs[jobId];
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
        // Need BOTH gates in before a submission counts (in either order).
        if (!(sub.hasScore && sub.hasValidity)) return;
        JobData storage j = jobs[jobId];
        j.gradeCount++;
        // Dashboard alias: the bounty-linked enclave verdict (fires once both gates land,
        // for valid AND invalid submissions so the board shows valid=false too). response
        // is the 0..100 view of the 0..10000 score.
        emit ValidationRecorded(jobId, agentId, j.attesterKey, uint8(sub.score / 100), sub.valid, sub.validityAtt);
        // effective = valid ? score : 0 — only valid grades take the lead.
        if (sub.valid && (j.bestAgentId == 0 || sub.score > j.bestScore)) {
            j.bestAgentId = agentId;
            j.bestScore = sub.score;
            j.bestScoreAtt = sub.scoreDigest;
            j.bestValidityAtt = sub.validityAtt;
            emit NewLeader(jobId, agentId, sub.score);
        }
    }

    /// @dev Resolve a contest: declare the winner as the ERC-8183 provider and
    ///      Complete the job (or Reject + refund the maker if no valid winner).
    ///      This is where the 1→many contest collapses into the 1:1 standard job.
    function _resolve(uint256 jobId) internal {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(j.isContest, "not a contest");
        require(j.status == JobStatus.Funded, "not funded");
        require(block.timestamp > j.expiredAt, "not ended"); // TIME-BASED resolution

        uint256 amount = j.budget;
        j.budget = 0;

        address winnerWallet =
            j.bestAgentId != 0 ? identityRegistry.getAgentWallet(j.bestAgentId) : address(0);

        if (winnerWallet != address(0)) {
            // Declare the 1:1 job at the very end: bind the provider, mark the
            // graded deliverable Submitted, then Complete + release payment.
            j.provider = winnerWallet;
            emit ProviderSet(jobId, winnerWallet);
            emit JobSubmitted(jobId, winnerWallet, j.bestScoreAtt); // deliverable = score commitment
            j.status = JobStatus.Completed;
            if (amount > 0) require(IERC20(j.token).transfer(winnerWallet, amount), "payout failed");
            bytes32 reason = bytes32(uint256(j.bestScore));
            emit JobCompleted(jobId, j.evaluator, reason);
            emit PaymentReleased(jobId, winnerWallet, amount);
            // back-compat + dashboard aliases
            emit JobResolved(jobId, j.bestAgentId, winnerWallet, j.bestScore, amount);
            emit BountySettled(jobId, j.bestAgentId, uint32(j.bestScore), j.bestValidityAtt);
        } else {
            j.status = JobStatus.Rejected;
            if (amount > 0) require(IERC20(j.token).transfer(j.client, amount), "refund failed");
            emit JobRejected(jobId, j.evaluator, "no valid winner");
            emit Refunded(jobId, j.client, amount);
            emit JobResolved(jobId, 0, address(0), 0, 0);
            emit BountySettled(jobId, 0, 0, bytes32(0));
        }
    }

    // ========================================================================
    // ERC-8183 GENERIC PATH — a vanilla 1:1 job (createJob → … → complete)
    // ========================================================================
    // Full standard role auth + state machine. CONTEST jobs reject these client-
    // callable mutators (they're evaluator-settled); use createBounty for those.

    /// @inheritdoc IERC8183
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        require(expiredAt > block.timestamp, "bad deadline");
        require(expiredAt <= type(uint64).max, "deadline overflow");
        jobId = nextJobId++;
        JobData storage j = jobs[jobId];
        j.id = jobId;
        j.client = msg.sender;
        j.provider = provider; // may be address(0) — set later via setProvider
        j.evaluator = evaluator;
        j.expiredAt = uint64(expiredAt);
        j.status = JobStatus.Open;
        j.token = rewardToken;
        j.specCid = description; // ERC-8183 description
        j.hook = hook;
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    /// @inheritdoc IERC8183
    function setProvider(uint256 jobId, address provider) external {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(!j.isContest, "contest: evaluator-settled");
        require(msg.sender == j.client, "only client");
        require(j.status == JobStatus.Open, "not open");
        j.provider = provider;
        emit ProviderSet(jobId, provider);
    }

    /// @inheritdoc IERC8183
    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(!j.isContest, "contest: budget fixed at creation");
        require(msg.sender == j.client || msg.sender == j.provider, "only client/provider");
        require(j.status == JobStatus.Open, "not open");
        j.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    /// @inheritdoc IERC8183
    function fund(uint256 jobId, bytes calldata) external {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(!j.isContest, "contest: funded at creation");
        require(msg.sender == j.client, "only client");
        require(j.status == JobStatus.Open, "not open");
        require(j.provider != address(0), "no provider");
        require(j.budget > 0, "no budget");
        j.status = JobStatus.Funded;
        require(IERC20(j.token).transferFrom(msg.sender, address(this), j.budget), "fund failed");
        emit JobFunded(jobId, msg.sender, j.budget);
    }

    /// @inheritdoc IERC8183
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(!j.isContest, "contest: use submit(jobId,agentId,encCid)");
        require(msg.sender == j.provider, "only provider");
        require(j.status == JobStatus.Funded, "not funded");
        require(block.timestamp <= j.expiredAt, "expired");
        j.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    /// @inheritdoc IERC8183
    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(!j.isContest, "contest: evaluator-settled via resolve");
        require(msg.sender == j.evaluator, "only evaluator");
        require(j.status == JobStatus.Submitted, "not submitted");
        uint256 amount = j.budget;
        j.budget = 0;
        j.status = JobStatus.Completed;
        if (amount > 0) require(IERC20(j.token).transfer(j.provider, amount), "payout failed");
        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, j.provider, amount);
    }

    /// @inheritdoc IERC8183
    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        JobData storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(!j.isContest, "contest: evaluator-settled via resolve");
        bool clientWhenOpen = msg.sender == j.client && j.status == JobStatus.Open;
        bool evaluatorMidFlight =
            msg.sender == j.evaluator && (j.status == JobStatus.Funded || j.status == JobStatus.Submitted);
        require(clientWhenOpen || evaluatorMidFlight, "not authorized");
        uint256 amount = j.budget;
        j.budget = 0;
        j.status = JobStatus.Rejected;
        if (amount > 0) require(IERC20(j.token).transfer(j.client, amount), "refund failed");
        emit JobRejected(jobId, msg.sender, reason);
        if (amount > 0) emit Refunded(jobId, j.client, amount);
    }

    // --- client/anyone: reclaim escrow after expiry (both paths) -------------

    /// @inheritdoc IERC8183
    /// @dev Deliberately not role-gated (anyone may trigger the refund) and not
    ///      hookable. Works for a stuck contest OR a generic job past its deadline.
    function claimRefund(uint256 jobId) external {
        JobData storage j = jobs[jobId];
        require(j.status == JobStatus.Funded || j.status == JobStatus.Submitted, "not refundable");
        require(block.timestamp > j.expiredAt + SETTLE_GRACE, "not expired");
        uint256 amount = j.budget;
        require(amount > 0, "nothing");
        j.budget = 0;
        j.status = JobStatus.Expired;
        require(IERC20(j.token).transfer(j.client, amount), "refund failed");
        emit JobExpired(jobId);
        emit Refunded(jobId, j.client, amount);
    }

    // ========================================================================
    // VIEWS
    // ========================================================================

    /// @inheritdoc IERC8183
    /// @notice The ERC-8183 standard Job projection (specCid is the description,
    ///         expiredAt widened to uint256). Use getJobFull for the rich state.
    function getJob(uint256 jobId) external view returns (IERC8183.Job memory) {
        JobData storage j = jobs[jobId];
        return IERC8183.Job({
            id: j.id,
            client: j.client,
            provider: j.provider,
            evaluator: j.evaluator,
            description: j.specCid,
            budget: j.budget,
            expiredAt: uint256(j.expiredAt),
            status: j.status,
            hook: j.hook
        });
    }

    /// @notice Full internal job state (contest fields + leaderboard + delivery).
    function getJobFull(uint256 jobId) external view returns (JobData memory) {
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
