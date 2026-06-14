// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockHoneycombEscrow} from "../src/MockHoneycombEscrow.sol";

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

/// Locks the escrow's event ABI to what apps/web/src/lib/bq.ts decodes (the Layer-2 ESCROW
/// config + decode{Bounties,Submissions,Validations,Settlements}Sql). If these pass, the demo —
/// and mainnet, once BQ_ESCROW_ADDRESS points at the real escrow — decode these logs with the
/// identical production SQL. Each test asserts both topic0 and the precise data-word layout the
/// SUBSTR offset math in bq.ts relies on.
contract MockHoneycombEscrowTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    bytes32 constant BOUNTY_CREATED_TOPIC0 =
        0x7181b860d66cc03cb89eda8049475d4486cf99c9599224e9a07f700ccde35aca;
    bytes32 constant SUBMISSION_MADE_TOPIC0 =
        0xfbc293ba94b87743a04695df6178945fc536676da953723d06353bbd5002b22d;
    bytes32 constant VALIDATION_RECORDED_TOPIC0 =
        0x4c9b4b2b0502a4f8deaf051eea1568760ec7c9d24fc3a69ff8a0905f7a60fd43;
    bytes32 constant BOUNTY_SETTLED_TOPIC0 =
        0xb6f53784b074065f4f949859a7ac4cd18a1ec35eeb4c18d474da7b76e5782d40;

    MockHoneycombEscrow esc;

    function setUp() public {
        esc = new MockHoneycombEscrow();
    }

    /// BountyCreated: category is a fixed bytes32 (word0), rewardWei (word1), deadline (word2),
    /// then the lone trailing `title` string (offset word3 == 0x80; length at byte 128 = word4;
    /// bytes at byte 160 = word5). decodeBountiesSql reads exactly these positions.
    function test_bountyCreatedTopic0AndLayout() public {
        vm.recordLogs();
        esc.createBounty(1, address(0x500), "audit", 5 ether, 1781846400, "Audit an ERC-4626 vault");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "one log");
        require(logs[0].topics[0] == BOUNTY_CREATED_TOPIC0, "BountyCreated topic0 != bq.ts constant");
        require(uint256(logs[0].topics[1]) == 1, "bountyId in topics[1]");
        require(uint256(logs[0].topics[2]) == uint256(uint160(0x500)), "requester in topics[2]");
        bytes memory d = logs[0].data;
        require(_word(d, 0) == uint256(bytes32("audit")), "category bytes32 at word0");
        require(_word(d, 1) == 5 ether, "rewardWei at word1");
        require(_word(d, 2) == 1781846400, "deadline at word2");
        require(_word(d, 3) == 0x80, "title offset (0x80) at word3");
        require(_word(d, 4) == 23, "title length at byte 128 (word4)");
        require(bytes32(_word(d, 5)) == bytes32("Audit an ERC-4626 vault"), "title bytes at byte 160 (word5)");
    }

    /// SubmissionMade: submissionCid is the only non-indexed param — a trailing string at offset
    /// 0x20 (word0 == 0x20; length at word1; bytes at word2), same shape as decodeRegisteredSql.
    function test_submissionMadeTopic0AndLayout() public {
        vm.recordLogs();
        esc.submit(1, 11, "ipfs://s-1-11");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "one log");
        require(logs[0].topics[0] == SUBMISSION_MADE_TOPIC0, "SubmissionMade topic0 != bq.ts constant");
        require(uint256(logs[0].topics[1]) == 1, "bountyId in topics[1]");
        require(uint256(logs[0].topics[2]) == 11, "agentId in topics[2]");
        bytes memory d = logs[0].data;
        require(_word(d, 0) == 0x20, "cid offset (0x20) at word0");
        require(_word(d, 1) == 13, "cid length at word1"); // len("ipfs://s-1-11")
    }

    /// ValidationRecorded: all fixed-width — validator (address, word0), response (uint8, word1),
    /// valid (bool, word2), responseHash (bytes32, word3). decodeValidationsSql reads these.
    function test_validationRecordedTopic0AndLayout() public {
        vm.recordLogs();
        bytes32 rh = keccak256("v-1-11");
        esc.validate(1, 11, address(0x999), 95, true, rh);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "one log");
        require(logs[0].topics[0] == VALIDATION_RECORDED_TOPIC0, "ValidationRecorded topic0 != bq.ts constant");
        require(uint256(logs[0].topics[1]) == 1, "bountyId in topics[1]");
        require(uint256(logs[0].topics[2]) == 11, "agentId in topics[2]");
        bytes memory d = logs[0].data;
        require(_word(d, 0) == uint256(uint160(0x999)), "validator at word0");
        require(_word(d, 1) == 95, "response (uint8) at word1");
        require(_word(d, 2) == 1, "valid (bool=true) at word2");
        require(bytes32(_word(d, 3)) == rh, "responseHash at word3");
    }

    /// BountySettled: winnerScore (uint32, word0), attestationHash (bytes32, word1).
    function test_bountySettledTopic0AndLayout() public {
        vm.recordLogs();
        bytes32 ah = keccak256("a-1");
        esc.settle(1, 11, 95, ah);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "one log");
        require(logs[0].topics[0] == BOUNTY_SETTLED_TOPIC0, "BountySettled topic0 != bq.ts constant");
        require(uint256(logs[0].topics[1]) == 1, "bountyId in topics[1]");
        require(uint256(logs[0].topics[2]) == 11, "winnerAgentId in topics[2]");
        bytes memory d = logs[0].data;
        require(_word(d, 0) == 95, "winnerScore (uint32) at word0");
        require(bytes32(_word(d, 1)) == ah, "attestationHash at word1");
    }

    /// Belt-and-suspenders: the canonical signature strings hash to the same constants.
    function test_signatureKeccakMatches() public pure {
        require(
            keccak256("BountyCreated(uint256,address,bytes32,uint256,uint64,string)") == BOUNTY_CREATED_TOPIC0,
            "BountyCreated sig keccak mismatch"
        );
        require(
            keccak256("SubmissionMade(uint256,uint256,string)") == SUBMISSION_MADE_TOPIC0,
            "SubmissionMade sig keccak mismatch"
        );
        require(
            keccak256("ValidationRecorded(uint256,uint256,address,uint8,bool,bytes32)") == VALIDATION_RECORDED_TOPIC0,
            "ValidationRecorded sig keccak mismatch"
        );
        require(
            keccak256("BountySettled(uint256,uint256,uint32,bytes32)") == BOUNTY_SETTLED_TOPIC0,
            "BountySettled sig keccak mismatch"
        );
    }

    function _word(bytes memory d, uint256 i) internal pure returns (uint256 w) {
        uint256 off = 32 + i * 32;
        assembly {
            w := mload(add(d, off))
        }
    }
}
