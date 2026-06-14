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

interface IWETH9 {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
}

/// @notice REAL-MONEY smoke test of the FULL StrategyVault path on Sepolia, with the forwarder
///         slot set to the caller EOA as a stand-in for the KeystoneForwarder (the only deviation
///         from production). Wraps a little ETH -> WETH, deploys the vault, funds it with that
///         WETH, sets approvals, and drives ONE real swap (WETH -> USDC) via `onReport`.
///
///         WHY WETH->USDC (opposite of mainnet RealSwap.s.sol): the Sepolia "USDC" at the address
///         below is Circle's real FiatToken — mint() is minter-gated, no public faucet. The deployer
///         holds Sepolia ETH, so we wrap ETH->WETH (free) and swap WETH->USDC through the deep 0.05%
///         pool. Output USDC lands back in the vault and is checked by the vault's balance-delta floor.
///
///         SAFETY: this BROADCASTS real transactions and spends real (testnet) funds. It is NOT run
///         by any test. `REAL_MONEY_PKEY` must be supplied at runtime (the Bun wrapper pulls it from
///         the macOS Keychain; the value never touches disk or the repo). To run:
///           REAL_MONEY_PKEY=0x... SEPOLIA_RPC_URL=<rpc> \
///             forge script script/SepoliaSwap.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
///         Defaults to swapping 0.001 WETH. Override: AMOUNT_IN=<18dp wei> forge script ...
contract SepoliaSwap is Script {
    // --- Sepolia Uniswap V3 infra (all verified on-chain, see memory sepolia-uniswap-v3-infra) ---
    address constant WETH   = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14; // WETH9
    address constant USDC   = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238; // Circle FiatToken (6dp)
    address constant UR     = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b; // Universal Router (v2.0; verified: executes V3_SWAP_EXACT_IN on Sepolia)
    address constant QUOTER = 0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3; // QuoterV2
    uint24  constant FEE    = 500;  // 0.05% pool 0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1 (deepest)
    uint8   constant V3_SWAP_EXACT_IN = 0x00;

    function run() external {
        uint256 pk = vm.envUint("REAL_MONEY_PKEY"); // reverts here if not supplied
        address me = vm.addr(pk);
        uint256 amountIn = vm.envOr("AMOUNT_IN", uint256(1e15)); // 0.001 WETH default

        // Quote OUTSIDE broadcast (simulation only, sends nothing).
        IQuoterV2.QuoteExactInputSingleParams memory qp = IQuoterV2.QuoteExactInputSingleParams({
            tokenIn: WETH, tokenOut: USDC, amountIn: amountIn, fee: FEE, sqrtPriceLimitX96: 0
        });
        (uint256 expectedOut, , , ) = IQuoterV2(QUOTER).quoteExactInputSingle(qp);
        uint256 minOut = (expectedOut * 99) / 100; // 1% slippage floor

        console2.log("swapper EOA:", me);
        console2.log("amountIn (WETH wei):", amountIn);
        console2.log("expected USDC out (6dp):", expectedOut);
        console2.log("minOut (6dp):", minOut);

        vm.startBroadcast(pk);

        // Acquire WETH to spend: wrap ETH if the EOA doesn't already hold enough.
        if (IWETH9(WETH).balanceOf(me) < amountIn) {
            IWETH9(WETH).deposit{value: amountIn}();
        }

        StrategyVault vault = new StrategyVault(me, me); // forwarder = me (stand-in), owner = me

        address[] memory toks = new address[](2);
        toks[0] = WETH; toks[1] = USDC;
        // setPolicy(router, allowedTokens, spendCapPerEpoch, maxSlippageBps, expiry, maxSwapsPerEpoch, epochLength)
        vault.setPolicy(UR, toks, amountIn, 100, uint64(block.timestamp + 1 hours), 1, 1 hours);

        IERC20(WETH).transfer(address(vault), amountIn);                  // fund the vault with WETH
        vault.setupAllowance(WETH, UR, uint160(amountIn), uint48(block.timestamp + 1 hours));

        // Build the same Action the CRE workflow would emit, then drive it through onReport.
        // NOTE: onReport decodes a FLAT 10-tuple (NOT abi.encode(struct), which would prepend an
        // outer tuple offset and shift every field). Encode the fields flat — identical to the
        // workflow's encodeAbiParameters(parseAbiParameters(...)).
        bytes memory urData = _urCalldata(address(vault), amountIn, minOut);
        bytes memory report = abi.encode(
            UR,                            // to
            urData,                        // data
            uint256(0),                    // value
            minOut,                        // minOut
            uint64(block.timestamp + 600), // deadline
            WETH,                          // tokenIn
            USDC,                          // tokenOut
            amountIn,                      // amountIn
            keccak256("sepolia-1"),        // nonce
            keccak256("strategy-v1")       // artifactHash
        );
        vault.onReport("", report); // me == forwarder stand-in

        vm.stopBroadcast();

        console2.log("vault:", address(vault));
        console2.log("vault USDC after (6dp):", IERC20(USDC).balanceOf(address(vault)));
        console2.log("vault WETH after (wei):", IERC20(WETH).balanceOf(address(vault)));
    }

    /// @dev Universal Router v1.2 ABI: execute(commands, inputs, deadline). One command,
    ///      V3_SWAP_EXACT_IN. path = packed(tokenIn, fee, tokenOut). payerIsUser=true so the UR
    ///      pulls tokenIn from the caller (the vault) via Permit2; recipient = vault so output
    ///      returns to the vault.
    function _urCalldata(address recipient, uint256 amountIn, uint256 urMinOut)
        internal
        view
        returns (bytes memory)
    {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(WETH, FEE, USDC);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountIn, urMinOut, path, true);
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 600);
    }
}
