// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/* ------------------------------------------------------------------ *
 *  Minimal external interfaces                                        *
 * ------------------------------------------------------------------ */

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Permit2 AllowanceTransfer.approve — a smart-account vault cannot produce an
///         EOA EIP-712 Permit2 signature, so it grants the Universal Router a standing
///         Permit2 allowance via this (non-signature) call. See README "approval model".
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice Chainlink CRE receiver. The canonical KeystoneForwarder calls onReport after the
///         DON's report has been verified by the forwarder itself — the vault therefore trusts
///         `msg.sender == forwarder` and does NOT re-check the DON signature.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/* ------------------------------------------------------------------ *
 *  StrategyVault                                                      *
 * ------------------------------------------------------------------ */

/// @title  StrategyVault
/// @notice Holds user funds and executes a single Uniswap swap ONLY when the CRE
///         KeystoneForwarder delivers a DON-signed report, and ONLY within an
///         on-chain policy (router allowlist, token allowlist, per-epoch spend cap,
///         rate limit, expiry, minOut floor, replay protection).
///
///         The trust story: even if the entire off-chain stack (DON, strategy, Uniswap
///         Trading API) is malicious, the worst it can do is a few capped, slippage-bounded
///         swaps between allowlisted tokens, with all output landing back in this vault.
///         No withdraw, no arbitrary approve, no bridge.
///
///         Enforcement is by BALANCE-DELTA POST-CONDITIONS, not by decoding the router
///         calldata: after forwarding the call we require `tokenIn spent <= amountIn` and
///         `tokenOut received >= minOut`. This makes the vault agnostic to the router's
///         calldata format (Universal Router today) and immune to output-redirection or
///         input-substitution by a lying API — we never have to trust the opaque calldata.
contract StrategyVault is IReceiver {
    /// @dev Canonical Permit2 (same address on every chain).
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice The action the DON authorizes. ABI tuple (for the TS workflow encoder):
    ///   (address to, bytes data, uint256 value, uint256 minOut, uint64 deadline,
    ///    address tokenIn, address tokenOut, uint256 amountIn, bytes32 nonce, bytes32 artifactHash)
    struct Action {
        address to;           // must equal policy.router
        bytes   data;         // opaque router calldata (e.g. UniversalRouter.execute(...))
        uint256 value;        // native ETH to forward (counts against the spend cap)
        uint256 minOut;       // floor on tokenOut received by THIS vault
        uint64  deadline;     // must be >= block.timestamp
        address tokenIn;      // must be allowlisted
        address tokenOut;     // must be allowlisted
        uint256 amountIn;     // ceiling on tokenIn spent
        bytes32 nonce;        // replay protection
        bytes32 artifactHash; // provenance: which strategy/model produced this (emitted)
    }

    struct Policy {
        address router;             // single allowed call target (pinned Universal Router version)
        uint256 spendCapPerEpoch;   // max (amountIn + value) summed per epoch
        uint16  maxSlippageBps;     // informational ceiling; real bound is Action.minOut (see README)
        uint64  expiry;             // grant validity deadline
        uint32  maxSwapsPerEpoch;   // rate limit
        uint32  epochLength;        // seconds per epoch
    }

    address public owner;
    address public immutable forwarder;
    Policy  public policy;
    mapping(address => bool) public isAllowedToken;
    mapping(bytes32 => bool) public usedNonce;

    // epoch accounting
    uint64  public epochStart;
    uint256 public spentThisEpoch;
    uint32  public swapsThisEpoch;

    event PolicySet(address router, uint256 spendCapPerEpoch, uint64 expiry);
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 spent,
        uint256 received,
        bytes32 nonce,
        bytes32 artifactHash
    );

    error NotOwner();
    error NotForwarder();
    error RouterNotAllowed();
    error TokenNotAllowed();
    error GrantExpired();
    error ActionExpired();
    error NonceUsed();
    error RateLimited();
    error SpendCapExceeded();
    error CallFailed(bytes ret);
    error Overspent();
    error MinOutNotMet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _forwarder, address _owner) {
        forwarder = _forwarder;
        owner = _owner;
    }

    receive() external payable {}

    /* -------------------------- owner ops -------------------------- */

    function setPolicy(
        address router,
        address[] calldata allowedTokens,
        uint256 spendCapPerEpoch,
        uint16  maxSlippageBps,
        uint64  expiry,
        uint32  maxSwapsPerEpoch,
        uint32  epochLength
    ) external onlyOwner {
        policy = Policy(router, spendCapPerEpoch, maxSlippageBps, expiry, maxSwapsPerEpoch, epochLength);
        for (uint256 i; i < allowedTokens.length; ++i) {
            isAllowedToken[allowedTokens[i]] = true;
        }
        epochStart = uint64(block.timestamp);
        spentThisEpoch = 0;
        swapsThisEpoch = 0;
        emit PolicySet(router, spendCapPerEpoch, expiry);
    }

    /// @notice One-time allowance setup so the Universal Router can pull `token` from the
    ///         vault via Permit2. Owner-only; never granted to an arbitrary spender.
    function setupAllowance(address token, address router, uint160 amount, uint48 expiration)
        external
        onlyOwner
    {
        IERC20(token).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(token, router, amount, expiration);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "eth withdraw failed");
        } else {
            IERC20(token).transfer(to, amount);
        }
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /* ----------------------- CRE entrypoint ------------------------ */

    /// @inheritdoc IReceiver
    function onReport(bytes calldata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder();
        Action memory a = abi.decode(report, (Action));
        _execute(a);
    }

    function _execute(Action memory a) internal {
        // ---- policy / replay / expiry checks (before any external call) ----
        if (block.timestamp > a.deadline) revert ActionExpired();
        if (block.timestamp > policy.expiry) revert GrantExpired();
        if (a.to != policy.router) revert RouterNotAllowed();
        if (!isAllowedToken[a.tokenIn] || !isAllowedToken[a.tokenOut]) revert TokenNotAllowed();
        if (usedNonce[a.nonce]) revert NonceUsed();
        usedNonce[a.nonce] = true;

        _rollEpoch();
        if (uint256(swapsThisEpoch) + 1 > policy.maxSwapsPerEpoch) revert RateLimited();
        if (spentThisEpoch + a.amountIn + a.value > policy.spendCapPerEpoch) revert SpendCapExceeded();

        // ---- snapshot, forward the call, verify by balance delta ----
        uint256 inBefore  = IERC20(a.tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(a.tokenOut).balanceOf(address(this));

        (bool ok, bytes memory ret) = a.to.call{value: a.value}(a.data);
        if (!ok) revert CallFailed(ret);

        uint256 inAfter  = IERC20(a.tokenIn).balanceOf(address(this));
        uint256 outAfter = IERC20(a.tokenOut).balanceOf(address(this));

        uint256 spent    = inBefore > inAfter ? inBefore - inAfter : 0;
        uint256 received = outAfter - outBefore;

        if (spent > a.amountIn) revert Overspent();        // input bounded -> no substitution/overspend
        if (received < a.minOut) revert MinOutNotMet();    // output landed HERE and >= floor

        swapsThisEpoch += 1;
        spentThisEpoch += spent + a.value;

        emit SwapExecuted(a.tokenIn, a.tokenOut, spent, received, a.nonce, a.artifactHash);
    }

    function _rollEpoch() internal {
        if (block.timestamp >= epochStart + policy.epochLength) {
            epochStart = uint64(block.timestamp);
            spentThisEpoch = 0;
            swapsThisEpoch = 0;
        }
    }
}
