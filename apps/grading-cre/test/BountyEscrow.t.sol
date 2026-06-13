// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BountyEscrow} from "../contracts/BountyEscrow.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";

contract MockIdentity {
    function getAgentWallet(uint256) external pure returns (address) { return address(0xBEEF); }
}

contract BountyEscrowTest {
    function _setup() internal returns (BountyEscrow esc, MockUSDC usdc) {
        usdc = new MockUSDC(1_000_000e6);
        BountyEscrow e = new BountyEscrow(address(0x15FC), address(usdc), address(new MockIdentity()));
        usdc.approve(address(e), 50e6);
        esc = e;
    }

    // exact Sepolia inputs: long specCid (42 chars), real testsHash, real-ish deadline
    function testLongSpec() external {
        (BountyEscrow esc,) = _setup();
        esc.createBounty(
            50000000,
            1781385396,
            0xc6affbccf99689cc5bec6b820620ce730dffb446e47daeb6c455b10970b64661,
            "honeycomb://uniswap-lp-trading-bot/spec.md"
        );
    }
}
