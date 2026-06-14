// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IOwned {
    function owner() external view returns (address);
}

/// @title  StrategyRegistry
/// @notice Multi-user directory of strategy vaults. Each user registers THEIR own StrategyVault
///         plus the per-vault strategy params; the CRE workflow reads `listActive(...)` once per
///         tick and fans out — quoting + reporting to each registered vault. Registration is
///         gated on `IOwned(vault).owner() == msg.sender`, so nobody can register a vault they
///         don't control, and each user's funds stay isolated in their own policy-bounded vault.
contract StrategyRegistry {
    struct Strategy {
        address tokenIn;
        address tokenOut;
        uint24  fee;          // Uniswap V3 fee tier of the execution pool
        uint256 amountIn;     // raw tokenIn units to swap per tick
        uint16  slippageBps;  // slippage tolerance sent to the quote API
        bytes32 strategyId;   // provenance / kind (e.g. keccak256("dca-v1"))
        bool    active;
    }

    /// @notice Flat row the workflow consumes (vault + its strategy params).
    struct Entry {
        address vault;
        address tokenIn;
        address tokenOut;
        uint24  fee;
        uint256 amountIn;
        uint16  slippageBps;
        bytes32 strategyId;
    }

    address[] public vaults;                       // enumeration
    mapping(address => uint256) private idxPlus1;  // vault -> index+1 (0 = absent)
    mapping(address => Strategy) public strategyOf;
    mapping(address => address) public registrantOf; // who registered the vault

    event Registered(address indexed vault, address indexed registrant);
    event ActiveSet(address indexed vault, bool active);
    event Removed(address indexed vault);

    error NotVaultOwner(address vault, address caller);
    error NotRegistrant(address vault, address caller);
    error NotRegistered(address vault);

    /// @notice Register or update the strategy for a vault you own.
    function register(
        address vault,
        address tokenIn,
        address tokenOut,
        uint24  fee,
        uint256 amountIn,
        uint16  slippageBps,
        bytes32 strategyId
    ) external {
        if (IOwned(vault).owner() != msg.sender) revert NotVaultOwner(vault, msg.sender);

        if (idxPlus1[vault] == 0) {
            vaults.push(vault);
            idxPlus1[vault] = vaults.length;
            registrantOf[vault] = msg.sender;
        } else if (registrantOf[vault] != msg.sender) {
            revert NotRegistrant(vault, msg.sender);
        }
        strategyOf[vault] = Strategy(tokenIn, tokenOut, fee, amountIn, slippageBps, strategyId, true);
        emit Registered(vault, msg.sender);
    }

    /// @notice Pause/resume a vault's strategy without losing its config (soft remove).
    function setActive(address vault, bool active) external {
        if (registrantOf[vault] != msg.sender) revert NotRegistrant(vault, msg.sender);
        strategyOf[vault].active = active;
        emit ActiveSet(vault, active);
    }

    /// @notice Fully remove a vault's strategy you registered — frees the row (O(1) swap-and-pop),
    ///         so the registry doesn't accumulate dead entries. Re-register later to re-add.
    function remove(address vault) external {
        uint256 i1 = idxPlus1[vault];
        if (i1 == 0) revert NotRegistered(vault);
        if (registrantOf[vault] != msg.sender) revert NotRegistrant(vault, msg.sender);

        uint256 i = i1 - 1;
        uint256 lastIdx = vaults.length - 1;
        if (i != lastIdx) {
            address moved = vaults[lastIdx];
            vaults[i] = moved;
            idxPlus1[moved] = i1; // `moved` now lives at index i (i1 == i + 1)
        }
        vaults.pop();
        delete idxPlus1[vault];
        delete strategyOf[vault];
        delete registrantOf[vault];
        emit Removed(vault);
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice Up to `maxCount` ACTIVE entries for the CRE workflow to fan out over in one tick.
    ///         A single read returns everything the workflow needs (no per-vault round-trips).
    function listActive(uint256 maxCount) external view returns (Entry[] memory out) {
        uint256 n = vaults.length;
        uint256 c;
        for (uint256 i; i < n && c < maxCount; ++i) {
            if (strategyOf[vaults[i]].active) c++;
        }
        out = new Entry[](c);
        uint256 k;
        for (uint256 i; i < n && k < c; ++i) {
            address v = vaults[i];
            Strategy storage s = strategyOf[v];
            if (s.active) {
                out[k++] = Entry(v, s.tokenIn, s.tokenOut, s.fee, s.amountIn, s.slippageBps, s.strategyId);
            }
        }
    }
}
