// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// BountyEscrow — ERC-8183 Agentic Commerce job escrow (Honeycomb contest profile)
// ============================================================================
//
// One ERC-8183 Job per bounty. Roles:
//   • client    = the bounty maker (funds the job)
//   • provider  = the winning agent's wallet (set at completion)
//   • evaluator = the CRE KeystoneForwarder (settles via onReport)
//
// The winner is an ERC-8004 agent: settlement carries the winner's `agentId`,
// and the reward is paid to `IdentityRegistry.getAgentWallet(agentId)`.
//
// Reward token: an owner-settable DEFAULT (`rewardToken`) — start with MockUSDC,
// switch to real USDC later via setRewardToken(). Each bounty SNAPSHOTS the token
// at creation (Job.token), so changing the default never breaks already-funded
// escrows.
//
// CONTEST-PROFILE deviations from vanilla ERC-8183 (documented on purpose):
//   1. `provider` is resolved at completion (not set by the client up front).
//   2. The evaluator completes/rejects directly from `Funded` (no provider
//      `submit` step); contest entries are tracked off-chain.
//   3. create + fund are collapsed into `createBounty`.
//
// ERC-8004 (Sepolia): Identity Registry 0x8004A818BFB912233c491871b3d84c89A494BD9e.
// Forwarder (Sepolia): simulation Mock 0x15fC6ae953E024d975e77382eEeC56A9101f9F88,
// production 0xF8344CFd5c43616a4366C34E3EEE75af79a74482.
// The onReport settlement tuple MUST match the CRE workflow's encodeAbiParameters.
// ============================================================================

interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Minimal slice of the ERC-8004 Identity Registry we depend on.
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

    struct Job {
        // --- ERC-8183 fields ---
        uint256 id;
        address client; // bounty maker
        address provider; // winner wallet, set at completion
        address evaluator; // CRE KeystoneForwarder
        string description;
        uint256 budget; // reward escrowed (set to 0 once funds leave)
        uint64 expiredAt; // contest deadline
        JobStatus status;
        address hook; // unused (0) in this profile
        // --- Honeycomb extension fields ---
        address token; // reward token snapshot for this bounty
        bytes32 testsHash; // commitment to PRIVATE tests + rubric
        string specCid; // PUBLIC spec / tests (IPFS)
        uint256 winnerAgentId; // ERC-8004 agentId of the winner
        uint8 score; // winning score, 0..100
        bytes32 reason; // attestation / validation responseHash
    }

    address public rewardToken; // DEFAULT reward token for new bounties (settable)
    IIdentityRegistry public immutable identityRegistry; // ERC-8004
    address public immutable forwarder; // == evaluator for CRE-settled jobs
    address public owner;

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    /// @notice Grace window after `expiredAt` during which only settlement (onReport)
    ///         is allowed — the grader runs after the deadline, so claimRefund must
    ///         not snipe a refund before settlement can land.
    uint256 public constant SETTLE_GRACE = 1 hours;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed evaluator,
        address token,
        uint256 budget,
        uint64 expiredAt,
        bytes32 testsHash,
        string specCid
    );
    event JobCompleted(
        uint256 indexed jobId,
        uint256 indexed winnerAgentId,
        address provider,
        uint8 score,
        bytes32 reason,
        uint256 paidOut
    );
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason, uint256 refunded);
    event JobExpired(uint256 indexed jobId, uint256 refunded);
    event RewardTokenSet(address indexed token);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

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

    // --- owner: configuration ------------------------------------------------

    /// @notice Set the DEFAULT reward token for FUTURE bounties (e.g. switch
    ///         MockUSDC -> real USDC). Existing bounties keep their snapshotted token.
    function setRewardToken(address token) external onlyOwner {
        rewardToken = token;
        emit RewardTokenSet(token);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // --- client: create + fund (Open -> Funded) ------------------------------

    function createBounty(
        uint256 budget,
        uint64 expiredAt,
        bytes32 testsHash,
        string calldata specCid
    ) external returns (uint256 jobId) {
        require(budget > 0 && expiredAt > block.timestamp, "bad params");
        address token = rewardToken; // snapshot
        jobId = nextJobId++;
        jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: address(0),
            evaluator: forwarder,
            description: specCid,
            budget: budget,
            expiredAt: expiredAt,
            status: JobStatus.Funded,
            hook: address(0),
            token: token,
            testsHash: testsHash,
            specCid: specCid,
            winnerAgentId: 0,
            score: 0,
            reason: bytes32(0)
        });
        require(IERC20(token).transferFrom(msg.sender, address(this), budget), "fund failed");
        emit JobCreated(jobId, msg.sender, forwarder, token, budget, expiredAt, testsHash, specCid);
    }

    // --- evaluator (CRE via forwarder): settle (Funded -> Completed/Rejected) -

    /// @inheritdoc IReceiver
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender);

        (uint256 jobId, uint256 winnerAgentId, bool valid, uint8 score, bytes32 reason) =
            abi.decode(report, (uint256, uint256, bool, uint8, bytes32));

        Job storage j = jobs[jobId];
        require(j.client != address(0), "no job");
        require(j.status == JobStatus.Funded, "not funded");

        uint256 amount = j.budget;
        j.budget = 0;
        j.winnerAgentId = winnerAgentId;
        j.score = score;
        j.reason = reason;

        // Resolve the winner's wallet from the ERC-8004 Identity Registry.
        address winnerWallet =
            (valid && winnerAgentId != 0) ? identityRegistry.getAgentWallet(winnerAgentId) : address(0);

        // Funds ALWAYS move: pay a valid, resolvable winner; otherwise refund the client.
        if (winnerWallet != address(0)) {
            j.provider = winnerWallet;
            j.status = JobStatus.Completed;
            if (amount > 0) require(IERC20(j.token).transfer(winnerWallet, amount), "payout failed");
            emit JobCompleted(jobId, winnerAgentId, winnerWallet, score, reason, amount);
        } else {
            j.status = JobStatus.Rejected;
            if (amount > 0) require(IERC20(j.token).transfer(j.client, amount), "refund failed");
            emit JobRejected(jobId, forwarder, reason, amount);
        }
    }

    // --- client: reclaim after expiry if never settled (Funded -> Expired) ----

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

    /// @notice The winning agent's wallet (zero until completed).
    function winnerWalletOf(uint256 jobId) external view returns (address) {
        return jobs[jobId].provider;
    }

    function isSettled(uint256 jobId) external view returns (bool) {
        JobStatus s = jobs[jobId].status;
        return s == JobStatus.Completed || s == JobStatus.Rejected || s == JobStatus.Expired;
    }
}
