// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {StrategyRegistry} from "../contracts/StrategyRegistry.sol";

contract MockOwned {
    address public owner;
    constructor(address o) { owner = o; }
}

contract StrategyRegistryTest is Test {
    StrategyRegistry reg;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address USDC = makeAddr("USDC");
    address WETH = makeAddr("WETH");

    function setUp() public {
        reg = new StrategyRegistry();
    }

    function _register(address who, address vault) internal {
        vm.prank(who);
        reg.register(vault, USDC, WETH, 100, 1_000_000, 50, keccak256("dca-v1"));
    }

    function test_RegisterAndListActive() public {
        address vaultA = address(new MockOwned(alice));
        address vaultB = address(new MockOwned(bob));
        _register(alice, vaultA);
        _register(bob, vaultB);

        assertEq(reg.vaultCount(), 2);
        StrategyRegistry.Entry[] memory e = reg.listActive(10);
        assertEq(e.length, 2, "two active");
        assertEq(e[0].vault, vaultA);
        assertEq(e[1].vault, vaultB);
        assertEq(e[0].tokenIn, USDC);
        assertEq(e[0].tokenOut, WETH);
        assertEq(e[0].fee, 100);
        assertEq(e[0].amountIn, 1_000_000);
        assertEq(e[0].slippageBps, 50);
    }

    function test_RevertWhen_RegisterVaultYouDontOwn() public {
        address vaultA = address(new MockOwned(alice));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotVaultOwner.selector, vaultA, bob));
        reg.register(vaultA, USDC, WETH, 100, 1_000_000, 50, keccak256("x"));
    }

    function test_SetActiveFiltersList() public {
        address vaultA = address(new MockOwned(alice));
        address vaultB = address(new MockOwned(bob));
        _register(alice, vaultA);
        _register(bob, vaultB);

        vm.prank(alice);
        reg.setActive(vaultA, false);

        StrategyRegistry.Entry[] memory e = reg.listActive(10);
        assertEq(e.length, 1, "one active");
        assertEq(e[0].vault, vaultB);
    }

    function test_UpdateStrategyNoDuplicate() public {
        address vaultA = address(new MockOwned(alice));
        _register(alice, vaultA);
        // re-register with new amount
        vm.prank(alice);
        reg.register(vaultA, USDC, WETH, 500, 2_000_000, 100, keccak256("dca-v2"));

        assertEq(reg.vaultCount(), 1, "no duplicate row");
        StrategyRegistry.Entry[] memory e = reg.listActive(10);
        assertEq(e[0].amountIn, 2_000_000);
        assertEq(e[0].fee, 500);
    }

    function test_RevertWhen_NonRegistrantSetsActive() public {
        address vaultA = address(new MockOwned(alice));
        _register(alice, vaultA);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotRegistrant.selector, vaultA, bob));
        reg.setActive(vaultA, false);
    }

    function test_ListActiveRespectsMaxCount() public {
        for (uint256 i; i < 3; ++i) {
            address v = address(new MockOwned(alice));
            _register(alice, v);
        }
        assertEq(reg.listActive(2).length, 2, "capped at maxCount");
        assertEq(reg.listActive(10).length, 3, "all when under cap");
    }

    function _inList(address vault) internal view returns (bool) {
        StrategyRegistry.Entry[] memory e = reg.listActive(100);
        for (uint256 i; i < e.length; ++i) {
            if (e[i].vault == vault) return true;
        }
        return false;
    }

    function test_RemoveFreesRow() public {
        address vaultA = address(new MockOwned(alice));
        address vaultB = address(new MockOwned(bob));
        _register(alice, vaultA);
        _register(bob, vaultB);

        vm.prank(alice);
        reg.remove(vaultA);

        assertEq(reg.vaultCount(), 1, "row freed (not just deactivated)");
        StrategyRegistry.Entry[] memory e = reg.listActive(10);
        assertEq(e.length, 1);
        assertEq(e[0].vault, vaultB);
    }

    function test_RevertWhen_NonRegistrantRemoves() public {
        address vaultA = address(new MockOwned(alice));
        _register(alice, vaultA);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotRegistrant.selector, vaultA, bob));
        reg.remove(vaultA);
    }

    function test_RevertWhen_RemoveUnregistered() public {
        address ghost = address(new MockOwned(alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotRegistered.selector, ghost));
        reg.remove(ghost);
    }

    function test_RemoveThenReRegister() public {
        address vaultA = address(new MockOwned(alice));
        _register(alice, vaultA);
        vm.prank(alice);
        reg.remove(vaultA);
        assertEq(reg.vaultCount(), 0);
        _register(alice, vaultA); // re-add cleanly
        assertEq(reg.vaultCount(), 1);
        assertTrue(_inList(vaultA));
    }

    function test_RemoveMiddleCompacts() public {
        address vaultA = address(new MockOwned(alice));
        address vaultB = address(new MockOwned(alice));
        address vaultC = address(new MockOwned(alice));
        _register(alice, vaultA);
        _register(alice, vaultB);
        _register(alice, vaultC);

        vm.prank(alice);
        reg.remove(vaultB); // swap-and-pop the middle

        assertEq(reg.vaultCount(), 2, "compacted");
        assertTrue(_inList(vaultA), "A kept");
        assertTrue(_inList(vaultC), "C kept");
        assertFalse(_inList(vaultB), "B gone");
    }
}
