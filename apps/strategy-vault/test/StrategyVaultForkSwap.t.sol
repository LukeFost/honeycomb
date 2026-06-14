// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {StrategyVault, IERC20, IReceiver, IERC165} from "../contracts/StrategyVault.sol";

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// @notice End-to-end proof of the #1 load-bearing unknown:
///         a forwarder-delivered DON-signed report drives ONE real Uniswap swap through a
///         scoped contract vault, on a mainnet fork. The KeystoneForwarder is simulated with
///         `vm.prank(forwarder)` — we are testing the vault's authority + execution path, not
///         the forwarder's own signature verification (which is Chainlink's, upstream of onReport).
contract StrategyVaultForkSwap is Test {
    // --- canonical mainnet addresses (checksums verified via `cast to-checksum`) ---
    address constant USDC    = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH    = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DAI     = 0x6B175474E89094C44Da98b954EedeAC495271d0F; // a non-allowlisted token
    address constant UR      = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af; // Universal Router (V4-era)
    address constant SROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45; // SwapRouter02 (a non-allowlisted target)
    address constant QUOTER  = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e; // QuoterV2
    uint24  constant FEE     = 500; // USDC/WETH 0.05% pool (deepest)

    uint8   constant V3_SWAP_EXACT_IN = 0x00; // Universal Router command

    address forwarder = makeAddr("forwarder");
    StrategyVault vault;

    uint256 constant FUND      = 10_000e6;  // 10k USDC
    uint256 constant AMOUNT_IN = 1_000e6;   // swap 1k USDC

    function setUp() public {
        // Public default lets this run with no API key; override with MAINNET_RPC_URL=... forge test
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string("https://ethereum-rpc.publicnode.com"));
        vm.createSelectFork(rpc);

        vault = new StrategyVault(forwarder, address(this));

        address[] memory toks = new address[](2);
        toks[0] = USDC;
        toks[1] = WETH;
        vault.setPolicy(
            UR,                       // router
            toks,                     // allowed tokens
            100_000e6,                // spendCapPerEpoch
            100,                      // maxSlippageBps (informational; minOut is the real bound)
            uint64(block.timestamp + 1 days), // expiry
            10,                       // maxSwapsPerEpoch
            1 days                    // epochLength
        );

        deal(USDC, address(vault), FUND);
        assertEq(IERC20(USDC).balanceOf(address(vault)), FUND, "deal failed");

        // one-time approval: USDC -> Permit2 -> Universal Router
        vault.setupAllowance(USDC, UR, type(uint160).max, uint48(block.timestamp + 1 days));
    }

    /* ----------------------------- helpers ----------------------------- */

    function _quoteMinOut(uint256 amountIn, uint256 slippageBps) internal returns (uint256) {
        IQuoterV2.QuoteExactInputSingleParams memory p = IQuoterV2.QuoteExactInputSingleParams({
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            fee: FEE,
            sqrtPriceLimitX96: 0
        });
        (uint256 out, , , ) = IQuoterV2(QUOTER).quoteExactInputSingle(p);
        return (out * (10_000 - slippageBps)) / 10_000;
    }

    /// Universal Router calldata for an exact-in USDC->WETH V3 swap, output to the vault.
    function _urCalldata(uint256 amountIn, uint256 urMinOut) internal view returns (bytes memory) {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(USDC, FEE, WETH);
        bytes[] memory inputs = new bytes[](1);
        // (recipient, amountIn, amountOutMin, path, payerIsUser)
        inputs[0] = abi.encode(address(vault), amountIn, urMinOut, path, true);
        uint256 deadline = block.timestamp + 600;
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, deadline);
    }

    function _report(
        address to,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 reportMinOut,
        uint256 urMinOut,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        StrategyVault.Action memory a = StrategyVault.Action({
            to: to,
            data: _urCalldata(amountIn, urMinOut),
            value: 0,
            minOut: reportMinOut,
            deadline: uint64(block.timestamp + 600),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            nonce: nonce,
            artifactHash: keccak256("strategy-v1")
        });
        // FLAT encoding to match the vault's flat abi.decode AND the TS workflow's
        // encodeAbiParameters(parseAbiParameters(...)).
        return abi.encode(
            a.to, a.data, a.value, a.minOut, a.deadline,
            a.tokenIn, a.tokenOut, a.amountIn, a.nonce, a.artifactHash
        );
    }

    /* ------------------------------ tests ------------------------------ */

    function test_ForwarderSwapSucceeds() public {
        uint256 minOut = _quoteMinOut(AMOUNT_IN, 100); // 1% slippage floor
        bytes memory report = _report(UR, USDC, WETH, AMOUNT_IN, minOut, minOut, keccak256("ok"));

        uint256 usdcBefore = IERC20(USDC).balanceOf(address(vault));
        uint256 wethBefore = IERC20(WETH).balanceOf(address(vault));

        vm.prank(forwarder);
        vault.onReport("", report);

        uint256 received = IERC20(WETH).balanceOf(address(vault)) - wethBefore;
        uint256 spent = usdcBefore - IERC20(USDC).balanceOf(address(vault));

        assertEq(spent, AMOUNT_IN, "spent != amountIn");
        assertGe(received, minOut, "received < minOut");
        emit log_named_decimal_uint("USDC in ", spent, 6);
        emit log_named_decimal_uint("WETH out", received, 18);
    }

    /// Gap 7: the vault self-grants its Permit2 allowance just-in-time inside _execute, so a
    /// freshly-deployed vault that NEVER had setupAllowance called can still swap. Proves the
    /// CRE-driven path is self-sufficient (no external maker top-up needed).
    function test_ForwarderSwapSucceeds_NoPriorSetupAllowance() public {
        // Fresh vault, funded, policy set — but setupAllowance is deliberately NOT called.
        StrategyVault fresh = new StrategyVault(forwarder, address(this));
        address[] memory toks = new address[](2);
        toks[0] = USDC;
        toks[1] = WETH;
        fresh.setPolicy(UR, toks, 100_000e6, 100, uint64(block.timestamp + 1 days), 10, 1 days);
        deal(USDC, address(fresh), FUND);

        uint256 minOut = _quoteMinOut(AMOUNT_IN, 100);
        // _urCalldata/_report reference `vault` for the recipient; point swap output at `fresh`.
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(USDC, FEE, WETH);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(fresh), AMOUNT_IN, minOut, path, true);
        bytes memory urData =
            abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 600);
        bytes memory report = abi.encode(
            UR, urData, uint256(0), minOut, uint64(block.timestamp + 600),
            USDC, WETH, AMOUNT_IN, keccak256("jit"), keccak256("strategy-v1")
        );

        uint256 wethBefore = IERC20(WETH).balanceOf(address(fresh));
        vm.prank(forwarder);
        fresh.onReport("", report);
        assertGt(IERC20(WETH).balanceOf(address(fresh)), wethBefore, "JIT-approved swap produced no WETH");
    }

    function test_RevertWhen_NotForwarder() public {
        bytes memory report = _report(UR, USDC, WETH, AMOUNT_IN, 0, 0, keccak256("x"));
        vm.expectRevert(StrategyVault.NotForwarder.selector);
        vault.onReport("", report); // msg.sender == this (owner), not the forwarder
    }

    /// UR swap succeeds (urMinOut=1) but the report demands an impossible vault minOut,
    /// so the vault's balance-delta post-check rejects it. Isolates the vault guard.
    function test_RevertWhen_VaultMinOutNotMet() public {
        uint256 honest = _quoteMinOut(AMOUNT_IN, 100);
        bytes memory report = _report(UR, USDC, WETH, AMOUNT_IN, honest * 100, 1, keccak256("hi"));
        vm.prank(forwarder);
        vm.expectRevert(StrategyVault.MinOutNotMet.selector);
        vault.onReport("", report);
    }

    function test_RevertWhen_RouterNotAllowed() public {
        bytes memory report = _report(SROUTER, USDC, WETH, AMOUNT_IN, 0, 0, keccak256("r"));
        vm.prank(forwarder);
        vm.expectRevert(StrategyVault.RouterNotAllowed.selector);
        vault.onReport("", report);
    }

    function test_RevertWhen_TokenNotAllowed() public {
        bytes memory report = _report(UR, USDC, DAI, AMOUNT_IN, 0, 0, keccak256("t"));
        vm.prank(forwarder);
        vm.expectRevert(StrategyVault.TokenNotAllowed.selector);
        vault.onReport("", report);
    }

    function test_RevertWhen_NonceReplay() public {
        uint256 minOut = _quoteMinOut(AMOUNT_IN, 100);
        bytes memory report = _report(UR, USDC, WETH, AMOUNT_IN, minOut, minOut, keccak256("dup"));

        vm.prank(forwarder);
        vault.onReport("", report); // first: succeeds

        vm.prank(forwarder);
        vm.expectRevert(StrategyVault.NonceUsed.selector);
        vault.onReport("", report); // replay: rejected
    }

    function test_RevertWhen_Expired() public {
        bytes memory report = _report(UR, USDC, WETH, AMOUNT_IN, 0, 0, keccak256("old"));
        vm.warp(block.timestamp + 1000); // past the action deadline (now+600)
        vm.prank(forwarder);
        vm.expectRevert(StrategyVault.ActionExpired.selector);
        vault.onReport("", report);
    }

    /// The real KeystoneForwarder gates delivery on ERC-165 supportsInterface BEFORE calling
    /// onReport; the vm.prank tests bypass that, so assert the receiver advertises it.
    function test_SupportsInterface() public view {
        assertTrue(vault.supportsInterface(type(IReceiver).interfaceId), "IReceiver not advertised");
        assertTrue(vault.supportsInterface(type(IERC165).interfaceId), "IERC165 not advertised");
        assertFalse(vault.supportsInterface(0xffffffff), "bogus id should be false");
    }
}
