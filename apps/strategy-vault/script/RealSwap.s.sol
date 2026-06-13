// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {StrategyVault, IERC20} from "../contracts/StrategyVault.sol";

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

/// @notice REAL-MONEY smoke test of the FULL vault path on a live network, with the forwarder
///         slot set to the caller EOA as a stand-in for the KeystoneForwarder (the only deviation
///         from production). Deploys the vault, funds it with a small USDC amount, sets approvals,
///         and drives ONE real swap via `onReport`.
///
///         SAFETY: this BROADCASTS real transactions and spends real funds. It is NOT run by any
///         test. `REAL_MONEY_PKEY` in the repo-root .env is intentionally corrupted (invalid hex)
///         so `vm.envUint` reverts before anything happens. To actually run it:
///           1. Replace REAL_MONEY_PKEY with a valid 0x-prefixed 32-byte key.
///           2. Fund that address with a little USDC (>= AMOUNT_IN) and ETH for gas.
///           3. export MAINNET_RPC_URL=<your rpc>   (and source the .env)
///           4. forge script script/RealSwap.s.sol --rpc-url $MAINNET_RPC_URL --broadcast
///         Defaults to 5 USDC. Override: AMOUNT_IN=<6dp> forge script ...
contract RealSwap is Script {
    address constant USDC   = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH   = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant UR     = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
    address constant QUOTER = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;
    uint24  constant FEE    = 500;
    uint8   constant V3_SWAP_EXACT_IN = 0x00;

    function run() external {
        uint256 pk = vm.envUint("REAL_MONEY_PKEY"); // reverts here if the key is the corrupted placeholder
        address me = vm.addr(pk);
        uint256 amountIn = vm.envOr("AMOUNT_IN", uint256(5e6)); // 5 USDC default

        // Quote OUTSIDE broadcast (simulation only, sends nothing).
        IQuoterV2.QuoteExactInputSingleParams memory qp = IQuoterV2.QuoteExactInputSingleParams({
            tokenIn: USDC, tokenOut: WETH, amountIn: amountIn, fee: FEE, sqrtPriceLimitX96: 0
        });
        (uint256 expectedOut, , , ) = IQuoterV2(QUOTER).quoteExactInputSingle(qp);
        uint256 minOut = (expectedOut * 99) / 100; // 1% slippage

        require(IERC20(USDC).balanceOf(me) >= amountIn, "fund the EOA with USDC first");
        console2.log("swapper EOA:", me);
        console2.log("amountIn (USDC 6dp):", amountIn);
        console2.log("expected WETH out (wei):", expectedOut);

        vm.startBroadcast(pk);

        StrategyVault vault = new StrategyVault(me, me); // forwarder = me (stand-in), owner = me

        address[] memory toks = new address[](2);
        toks[0] = USDC; toks[1] = WETH;
        vault.setPolicy(UR, toks, amountIn, 100, uint64(block.timestamp + 1 hours), 1, 1 hours);

        IERC20(USDC).transfer(address(vault), amountIn);                  // fund the vault
        vault.setupAllowance(USDC, UR, uint160(amountIn), uint48(block.timestamp + 1 hours));

        // Build the same Action the CRE workflow would emit, then drive it through onReport.
        bytes memory urData = _urCalldata(address(vault), amountIn, minOut);
        StrategyVault.Action memory a = StrategyVault.Action({
            to: UR, data: urData, value: 0, minOut: minOut, deadline: uint64(block.timestamp + 600),
            tokenIn: USDC, tokenOut: WETH, amountIn: amountIn, nonce: keccak256("real-1"),
            artifactHash: keccak256("strategy-v1")
        });
        vault.onReport("", abi.encode(a)); // me == forwarder stand-in

        vm.stopBroadcast();

        console2.log("vault:", address(vault));
        console2.log("vault WETH after (wei):", IERC20(WETH).balanceOf(address(vault)));
    }

    function _urCalldata(address recipient, uint256 amountIn, uint256 urMinOut)
        internal
        view
        returns (bytes memory)
    {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(USDC, FEE, WETH);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountIn, urMinOut, path, true);
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 600);
    }
}
