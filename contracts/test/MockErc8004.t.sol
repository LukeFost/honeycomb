// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockErc8004} from "../src/MockErc8004.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// Asserts the mock's events match what apps/web/src/lib/bq.ts filters/decodes on:
/// - Registered topic0 == the canonical EF identity topic0 (0xca52…).
/// - NewFeedback topic0 == keccak("NewFeedback(uint256,address,bytes32,uint256,uint8)")
///   (the value the demo sets BQ_REPUTATION_TOPIC0 to).
/// - NewFeedback data layout: value at the 2nd data word, valueDecimals at the 3rd — exactly
///   where decodeFeedbackSql reads them (SUBSTR(data,67,64) and SUBSTR(data,131,64)).
contract MockErc8004Test {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    bytes32 constant REGISTERED_TOPIC0 =
        0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a;
    bytes32 constant NEWFEEDBACK_TOPIC0 =
        0x464064d02dd8555dc4a1d0316f1fecfc0f9f549816f9231af2f1d24dc78be894;

    MockErc8004 reg;

    function setUp() public {
        reg = new MockErc8004();
    }

    function test_registeredTopic0() public {
        vm.recordLogs();
        reg.register(42, "ipfs://agent-42", address(0xABCD));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "one log");
        require(logs[0].topics[0] == REGISTERED_TOPIC0, "Registered topic0 != 0xca52 (EF identity)");
        require(uint256(logs[0].topics[1]) == 42, "agentId in topics[1]");
    }

    function test_newFeedbackTopic0AndLayout() public {
        vm.recordLogs();
        reg.leaveFeedback(7, address(0xBEEF), 950, 1); // score 95.0
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "one log");
        require(logs[0].topics[0] == NEWFEEDBACK_TOPIC0, "NewFeedback topic0 != configured");
        require(uint256(logs[0].topics[1]) == 7, "agentId in topics[1]");
        // data = [tag(word0)][value(word1)][valueDecimals(word2)]; decodeFeedbackSql reads
        // value at the 2nd word and decimals at the 3rd.
        bytes memory d = logs[0].data;
        require(d.length == 96, "three data words");
        uint256 value = _word(d, 1);
        uint256 decimals = _word(d, 2);
        require(value == 950, "value at 2nd data word");
        require(decimals == 1, "valueDecimals at 3rd data word");
    }

    function _word(bytes memory d, uint256 i) internal pure returns (uint256 w) {
        uint256 off = 32 + i * 32;
        assembly {
            w := mload(add(d, off))
        }
    }
}
