// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockValidationRegistry} from "../src/MockValidationRegistry.sol";

/// Minimal inline Foundry cheatcode interface so this builds with no forge-std dependency.
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// Proves the mock emits events whose topic0 matches the constants the dashboard filters on
/// (apps/web/src/lib/bq.ts → VALIDATION_REGISTRY.events.{response,request}.topic0). If these
/// pass, an indexer copying this contract's logs into the BigQuery fixture table will be
/// counted by the live `countSql` path exactly as a real EF deployment would be.
contract MockValidationRegistryTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    bytes32 constant RESPONSE_TOPIC0 =
        0xafddf629e874ccc3963b6a888c477bd464a6c8525024fc88759ea3b2326349ae;
    bytes32 constant REQUEST_TOPIC0 =
        0x530436c3634a98e1e626b0898be2f1e9980cc1bd2a78c07a0aba52d0a48a5059;

    MockValidationRegistry reg;

    function setUp() public {
        reg = new MockValidationRegistry();
    }

    /// The compiled `ValidationResponse` event's topic0 must equal the dashboard constant.
    function test_responseTopic0MatchesDashboardConstant() public {
        vm.recordLogs();
        reg.emitResponse(address(0xBEEF), 7, bytes32(uint256(0xABC)), 88, "ipfs://verdict", bytes32(0), "ok");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "expected exactly one log");
        require(logs[0].topics[0] == RESPONSE_TOPIC0, "ValidationResponse topic0 != bq.ts constant");
    }

    /// Same for `ValidationRequest`.
    function test_requestTopic0MatchesDashboardConstant() public {
        vm.recordLogs();
        reg.emitRequest(address(0xBEEF), 7, "ipfs://req", bytes32(uint256(0x1)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "expected exactly one log");
        require(logs[0].topics[0] == REQUEST_TOPIC0, "ValidationRequest topic0 != bq.ts constant");
    }

    /// Belt-and-suspenders: the canonical signature strings hash to the same constants.
    function test_signatureKeccakMatches() public pure {
        require(
            keccak256("ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)")
                == RESPONSE_TOPIC0,
            "response sig keccak mismatch"
        );
        require(
            keccak256("ValidationRequest(address,uint256,string,bytes32)") == REQUEST_TOPIC0,
            "request sig keccak mismatch"
        );
    }
}
