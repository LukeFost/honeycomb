// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {StrategyVault, IERC20} from "../contracts/StrategyVault.sol";

/// @notice Deploy StrategyVault to Base mainnet for the real end-to-end, wired to the CRE Base
///         forwarder, then fund + configure it. BROADCASTS real txs (deploy + transfer + approve).
///         Run ONLY when DEPLOYER_PK is funded on Base with USDC + a little ETH.
///
///   DEPLOYER_PK=0x<key> FUND_USDC=2000000 \
///   forge script script/DeployBase.s.sol --rpc-url https://mainnet.base.org --broadcast
contract DeployBase is Script {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant UR   = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    // The LIVE Base KeystoneForwarder that actually calls onReport (discovered from a --broadcast
    // tx: report(address,bytes,bytes,bytes[]) sent to it). NOT the misleading supported-chains
    // "mock forwarder" 0xF834…, which is not the onReport msg.sender.
    address constant FORWARDER = 0x5E342a8438B4f5d39e72875FCee6f76B39CCE548;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address me = vm.addr(pk);
        uint256 fundUsdc = vm.envOr("FUND_USDC", uint256(2_000_000)); // 2 USDC into the vault

        require(IERC20(USDC).balanceOf(me) >= fundUsdc, "deployer needs USDC on Base");
        console2.log("deployer     :", me);
        console2.log("deployer USDC:", IERC20(USDC).balanceOf(me));

        vm.startBroadcast(pk);
        StrategyVault vault = new StrategyVault(FORWARDER, me);

        address[] memory toks = new address[](2);
        toks[0] = USDC;
        toks[1] = WETH;
        // UR-only, 100 USDC/epoch cap, 1% slippage ceiling, 7-day expiry, 20 swaps/day.
        vault.setPolicy(UR, toks, 100_000_000, 100, uint64(block.timestamp + 7 days), 20, 1 days);

        IERC20(USDC).transfer(address(vault), fundUsdc);
        vault.setupAllowance(USDC, UR, uint160(fundUsdc), uint48(block.timestamp + 7 days));
        vm.stopBroadcast();

        console2.log("StrategyVault:", address(vault));
        console2.log("forwarder    :", FORWARDER);
        console2.log("vault USDC   :", IERC20(USDC).balanceOf(address(vault)));
        console2.log(">> set this vault address in strategy-workflow/config.staging.json before --broadcast");
    }
}
