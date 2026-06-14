// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {StrategyRegistry} from "../contracts/StrategyRegistry.sol";

/// @notice Deploy the StrategyRegistry on Base and register the two existing vaults (multi-user
///         demo). Both vaults are owned by the broadcaster, so registration passes the owner check.
///         BROADCASTS real txs. After running, set the printed registry in config.staging.json.
///
///   DEPLOYER_PK=0x<key> forge script script/DeployRegistry.s.sol --rpc-url https://base-rpc.publicnode.com --broadcast --slow
contract DeployRegistry is Script {
    address constant USDC   = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH   = 0x4200000000000000000000000000000000000006;
    address constant VAULT1 = 0xaeb453fF617Ff76C70FCFeb56D1a4E97e023b64a; // live, funded vault
    address constant VAULT2 = 0x7D3C5aE9BFF49E2940caCc7C6AF387523c1Bbfa3; // 2nd existing vault

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(pk);
        StrategyRegistry reg = new StrategyRegistry();
        // 1 USDC/tick, 0.5% slippage (50 bps), fee-100 pool.
        reg.register(VAULT1, USDC, WETH, 100, 1_000_000, 50, keccak256("dca-v1"));
        reg.register(VAULT2, USDC, WETH, 100, 1_000_000, 50, keccak256("dca-v1"));
        vm.stopBroadcast();

        console2.log("StrategyRegistry :", address(reg));
        console2.log("registered vault1:", VAULT1);
        console2.log("registered vault2:", VAULT2);
        console2.log(">> set registry in strategy-workflow/config.staging.json");
    }
}
