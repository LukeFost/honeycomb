// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BountyEscrow, IERC8183, JobStatus} from "../contracts/BountyEscrow.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";

contract MockIdentity {
    function getAgentWallet(uint256) external pure returns (address) { return address(0xBEEF); }
}

contract BountyEscrowTest {
    function _setup() internal returns (BountyEscrow esc, MockUSDC usdc) {
        usdc = new MockUSDC(1_000_000e6);
        BountyEscrow e = new BountyEscrow(address(0x15FC), address(usdc), address(new MockIdentity()));
        usdc.approve(address(e), 1_000_000e6);
        esc = e;
    }

    function _eq(uint256 a, uint256 b, string memory m) internal pure {
        require(a == b, m);
    }

    // exact Sepolia inputs: long specCid (42 chars), real testsHash, real-ish deadline
    function testLongSpec() external {
        (BountyEscrow esc,) = _setup();
        uint256 jobId = esc.createBounty(
            50000000,
            1781385396,
            0xc6affbccf99689cc5bec6b820620ce730dffb446e47daeb6c455b10970b64661,
            "honeycomb://uniswap-lp-trading-bot/spec.md",
            address(0x5B57aF5eBAd44bEEfdfCcd71F33359d74Ec0e86F),
            bytes32(uint256(0xBEEF)), // maker X25519 pubkey (test)
            bytes32(uint256(0xC0DE)) // enclave X25519 submission key (test)
        );
        _eq(jobId, 1, "first jobId == 1");
    }

    // ERC-8183 standard getJob projection: a contest job reads back as a valid
    // 1:1 job (provider TBD = 0, status Funded, description == specCid).
    function testStandardGetJobShape() external {
        (BountyEscrow esc,) = _setup();
        uint256 jobId = esc.createBounty(
            50000000,
            1781385396,
            bytes32(uint256(1)),
            "honeycomb://spec.md",
            address(0x5B57aF5eBAd44bEEfdfCcd71F33359d74Ec0e86F),
            bytes32(uint256(0xBEEF)),
            bytes32(uint256(0xC0DE))
        );
        IERC8183.Job memory j = esc.getJob(jobId);
        _eq(j.id, jobId, "id");
        require(j.client == address(this), "client == maker");
        require(j.provider == address(0), "provider TBD until resolution");
        _eq(uint256(j.status), uint256(JobStatus.Funded), "status Funded");
        require(j.hook == address(0), "non-hooked kernel");
        _eq(j.budget, 50000000, "budget");
        require(
            keccak256(bytes(j.description)) == keccak256(bytes("honeycomb://spec.md")),
            "description == specCid"
        );
    }

    // Full generic ERC-8183 lifecycle WITHOUT the contest:
    // createJob(Open) -> setProvider -> setBudget -> fund(Funded) -> submit(Submitted)
    // -> complete(Completed) -> provider paid. (this == client == provider == evaluator
    // so we can drive every role without time warps / cheatcodes.)
    function testGenericLifecycle() external {
        (BountyEscrow esc, MockUSDC usdc) = _setup();
        uint256 jobId = esc.createJob(
            address(0), // provider TBD
            address(this), // evaluator
            type(uint64).max, // far-future deadline
            "do the thing",
            address(0) // no hook
        );
        IERC8183.Job memory j = esc.getJob(jobId);
        _eq(uint256(j.status), uint256(JobStatus.Open), "Open after createJob");

        esc.setProvider(jobId, address(this));
        esc.setBudget(jobId, 40e6, "");
        esc.fund(jobId, "");
        _eq(uint256(esc.getJob(jobId).status), uint256(JobStatus.Funded), "Funded after fund");

        uint256 balBefore = usdc.balanceOf(address(this));
        esc.submit(jobId, keccak256("deliverable"), "");
        _eq(uint256(esc.getJob(jobId).status), uint256(JobStatus.Submitted), "Submitted");

        esc.complete(jobId, bytes32(uint256(1)), "");
        _eq(uint256(esc.getJob(jobId).status), uint256(JobStatus.Completed), "Completed");
        // funds went out of escrow and back to the provider (== this)
        _eq(usdc.balanceOf(address(this)), balBefore + 40e6, "provider paid 40");
        require(esc.isSettled(jobId), "settled");
    }

    // CONTEST jobs are evaluator-settled: the client-callable standard mutators
    // must revert on them (the contest, not the client, picks the provider).
    function testContestBlocksClientMutators() external {
        (BountyEscrow esc,) = _setup();
        uint256 jobId = esc.createBounty(
            50000000,
            1781385396,
            bytes32(uint256(1)),
            "honeycomb://spec.md",
            address(0x5B57aF5eBAd44bEEfdfCcd71F33359d74Ec0e86F),
            bytes32(uint256(0xBEEF)),
            bytes32(uint256(0xC0DE))
        );
        (bool a,) = address(esc).call(
            abi.encodeWithSignature("setProvider(uint256,address)", jobId, address(this))
        );
        require(!a, "setProvider must revert on contest");
        (bool b,) = address(esc).call(abi.encodeWithSignature("fund(uint256,bytes)", jobId, ""));
        require(!b, "fund must revert on contest");
        (bool c,) = address(esc).call(
            abi.encodeWithSignature("complete(uint256,bytes32,bytes)", jobId, bytes32(0), "")
        );
        require(!c, "complete must revert on contest");
        (bool d,) =
            address(esc).call(abi.encodeWithSignature("submit(uint256,bytes32,bytes)", jobId, bytes32(0), ""));
        require(!d, "standard submit must revert on contest");
    }

    // A generic job cannot use the contest agent-submit path, and vice-versa.
    function testPathIsolation() external {
        (BountyEscrow esc,) = _setup();
        uint256 jobId = esc.createJob(address(this), address(this), type(uint64).max, "x", address(0));
        // contest agent submit on a generic job must revert ("not a contest")
        (bool ok,) = address(esc).call(
            abi.encodeWithSignature("submit(uint256,uint256,string)", jobId, uint256(7), "cid")
        );
        require(!ok, "agent submit must revert on generic job");
    }
}
