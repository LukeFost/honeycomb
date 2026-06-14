// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {StrategyVault, IERC20} from "../contracts/StrategyVault.sol";

/// @notice De-risk for the REAL Base broadcast: proves our V3 single-hop path executes against
///         Base's real fee-100 USDC/WETH pool, driven through the vault by a (simulated) forwarder,
///         on a fork. Same code/calldata the CRE workflow + a real --broadcast will use.
contract StrategyVaultBaseFork is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base native USDC
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant UR   = 0x6fF5693b99212Da76ad316178A184AB56D299b43; // Base Universal Router
    uint24  constant FEE  = 100;   // the 0.01% V3 pool the Trading API routes USDC->WETH through
    uint8   constant V3_SWAP_EXACT_IN = 0x00;

    address forwarder = makeAddr("forwarder");
    StrategyVault vault;
    uint256 constant FUND = 100e6;     // 100 USDC
    uint256 constant AMOUNT_IN = 1e6;  // swap 1 USDC

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        vault = new StrategyVault(forwarder, address(this));
        address[] memory toks = new address[](2);
        toks[0] = USDC;
        toks[1] = WETH;
        vault.setPolicy(UR, toks, 1000e6, 100, uint64(block.timestamp + 1 days), 10, 1 days);
        deal(USDC, address(vault), FUND);
        assertEq(IERC20(USDC).balanceOf(address(vault)), FUND, "deal failed");
        vault.setupAllowance(USDC, UR, type(uint160).max, uint48(block.timestamp + 1 days));
    }

    function _urCalldata(uint256 amountIn, uint256 urMinOut) internal view returns (bytes memory) {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(USDC, FEE, WETH);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(vault), amountIn, urMinOut, path, true);
        return abi.encodeWithSignature(
            "execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 600
        );
    }

    function _report(uint256 amountIn, uint256 minOut, bytes32 nonce) internal view returns (bytes memory) {
        return abi.encode(
            UR, _urCalldata(amountIn, minOut), uint256(0), minOut, uint64(block.timestamp + 600),
            USDC, WETH, amountIn, nonce, keccak256("strategy-v1")
        );
    }

    function test_BaseSwapSucceeds() public {
        uint256 minOut = 5e14; // 0.0005 WETH floor (expect ~0.00059 for 1 USDC)
        bytes memory report = _report(AMOUNT_IN, minOut, keccak256("base"));

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
}
