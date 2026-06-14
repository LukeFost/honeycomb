// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "forge-std/Test.sol";
import {StrategyVault, IERC20} from "../contracts/StrategyVault.sol";

interface IWETH9 { function deposit() external payable; }

contract VaultSwapProbe is Test {
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant UR = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;
    uint24 constant FEE = 500;
    uint8 constant V3_SWAP_EXACT_IN = 0x00;

    function _urCalldata(address recipient, uint256 amountIn, uint256 minOut) internal view returns (bytes memory) {
        bytes memory commands = abi.encodePacked(V3_SWAP_EXACT_IN);
        bytes memory path = abi.encodePacked(WETH, FEE, USDC);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountIn, minOut, path, true);
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 600);
    }

    function test_vault_swap() external {
        address me = address(this);
        uint256 amountIn = 1e15;
        uint256 minOut = 15026002;
        vm.deal(me, 1 ether);
        IWETH9(WETH).deposit{value: amountIn}();

        StrategyVault vault = new StrategyVault(me, me);
        address[] memory toks = new address[](2);
        toks[0] = WETH; toks[1] = USDC;
        vault.setPolicy(UR, toks, amountIn, 100, uint64(block.timestamp + 1 hours), 1, 1 hours);
        IERC20(WETH).transfer(address(vault), amountIn);
        vault.setupAllowance(WETH, UR, uint160(amountIn), uint48(block.timestamp + 1 hours));

        bytes memory urData = _urCalldata(address(vault), amountIn, minOut);
        // FLAT 10-tuple — must match onReport's abi.decode, NOT abi.encode(struct).
        bytes memory report = abi.encode(
            UR, urData, uint256(0), minOut, uint64(block.timestamp + 600),
            WETH, USDC, amountIn, keccak256("probe-1"), keccak256("strategy-v1")
        );
        vault.onReport("", report);
        uint256 got = IERC20(USDC).balanceOf(address(vault));
        emit log_named_uint("vault USDC", got);
        assertGe(got, minOut, "vault did not receive USDC");
    }
}
