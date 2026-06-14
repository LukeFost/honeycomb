// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "forge-std/Test.sol";

interface IERC20 { function approve(address,uint256) external returns(bool); function balanceOf(address) external view returns(uint256); }
interface IWETH9 { function deposit() external payable; }
interface IPermit2 { function approve(address token,address spender,uint160 amount,uint48 expiration) external; }
interface IUR { function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable; }

contract URProbe is Test {
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant UR = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint24 constant FEE = 500;

    function test_swap() external {
        address me = address(this);
        vm.deal(me, 1 ether);
        IWETH9(WETH).deposit{value: 1e15}();
        IERC20(WETH).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(WETH, UR, uint160(1e15), uint48(block.timestamp + 3600));
        bytes memory commands = abi.encodePacked(uint8(0x00));
        bytes memory path = abi.encodePacked(WETH, FEE, USDC);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(me, uint256(1e15), uint256(1), path, true);
        uint256 bef = IERC20(USDC).balanceOf(me);
        IUR(UR).execute(commands, inputs, block.timestamp + 600);
        emit log_named_uint("USDC received", IERC20(USDC).balanceOf(me) - bef);
    }
}
