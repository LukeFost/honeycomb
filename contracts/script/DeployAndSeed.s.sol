// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockErc8004} from "../src/MockErc8004.sol";
import {MockHoneycombEscrow} from "../src/MockHoneycombEscrow.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Deploys the demo's mock ERC-8004 registries + Honeycomb escrow on a fresh local chain and
/// emits a scenario designed to exercise the dashboard's whole thesis:
///   - a sybil RING: one client reviews 10 agents (breadth 10 → ring wallet) → those agents are
///     flagged sybil (ring-only reviewers, near-zero trust despite high raw scores).
///   - an ORGANIC agent (#11): reviewed by 6 distinct independent clients; wins two bounties from
///     two independent requesters → tops the earned-reputation leaderboard.
///   - a SELF-DEALER (#3): funds its own bounty and "wins" it at enclave score 97 → earns ~0.
///   - a CHEATER (#7): submits, fails attestation, never wins → flagged.
/// On a fresh Anvil (acct0 nonce 0/1) the addresses are deterministic: registry 0x5FbDB…aa3,
/// escrow 0xe7f1…512. Run: forge script script/DeployAndSeed.s.sol:DeployAndSeed --broadcast.
contract DeployAndSeed {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    // Each agent's metadataURI is a base64 `data:` URI carrying a real ERC-8004 registration-v1
    // card ({type,name,description,image,services,x402}). EIP-8004 explicitly permits the data:
    // scheme for fully on-chain metadata, so the agent_trust view decodes a real name/services
    // straight from the Registered event — no off-chain fetch. The prefix is concatenated at
    // register time to avoid repeating it 12×; regenerate the payloads with
    // tools/chain-verify/scripts/gen-agent-cards.mjs.
    string constant CARD_URI_PREFIX = "data:application/json;base64,";

    function run() external {
        vm.startBroadcast();

        MockErc8004 reg = new MockErc8004();
        MockHoneycombEscrow esc = new MockHoneycombEscrow();

        // --- Layer 1: identity + reputation -----------------------------------------------
        // 12 agents, each registered with a distinct on-chain agent card (name + services live in
        // the base64 data: URI). Names: #1 Aegis Audit … #3 Vanta Evals (self-dealer) … #7 Mirage
        // Audit (cheater) … #11 Apiary Prime (organic, tops the board) … #12 Echo Agent.
        string[12] memory cards = [
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJBZWdpcyBBdWRpdCIsImRlc2NyaXB0aW9uIjoiQ29udHJhY3Qgc2VjdXJpdHkgYXVkaXRzLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvMS5wbmciLCJzZXJ2aWNlcyI6W3sibmFtZSI6ImF1ZGl0In1dLCJ4NDAyIjpmYWxzZX0=",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJDb3JwdXMgTGFiZWxlcnMiLCJkZXNjcmlwdGlvbiI6Ikh1bWFuLWdyYWRlIGRhdGEgbGFiZWxpbmcuIiwiaW1hZ2UiOiJodHRwczovL2hvbmV5Y29tYi5tYXJrZXQvYS8yLnBuZyIsInNlcnZpY2VzIjpbeyJuYW1lIjoiZGF0YS1sYWJlbGluZyJ9XSwieDQwMiI6ZmFsc2V9",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJWYW50YSBFdmFscyIsImRlc2NyaXB0aW9uIjoiTExNIGV2YWx1YXRpb24gaGFybmVzc2VzLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvMy5wbmciLCJzZXJ2aWNlcyI6W3sibmFtZSI6ImV2YWxzIn1dLCJ4NDAyIjpmYWxzZX0=",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJOaW1idXMgRGF0YSIsImRlc2NyaXB0aW9uIjoiRGF0YXNldCBjdXJhdGlvbiAmIGxhYmVsaW5nLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvNC5wbmciLCJzZXJ2aWNlcyI6W3sibmFtZSI6ImRhdGEtbGFiZWxpbmcifV0sIng0MDIiOmZhbHNlfQ==",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJQcm9iZSBTZWN1cml0eSIsImRlc2NyaXB0aW9uIjoiU21hcnQtY29udHJhY3QgcmV2aWV3LiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvNS5wbmciLCJzZXJ2aWNlcyI6W3sibmFtZSI6ImF1ZGl0In1dLCJ4NDAyIjpmYWxzZX0=",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJEZWx0YSBRdWFudCIsImRlc2NyaXB0aW9uIjoiUXVhbnQgdHJhZGluZyBzdHJhdGVnaWVzLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvNi5wbmciLCJzZXJ2aWNlcyI6W3sibmFtZSI6InRyYWRpbmctc3RyYXRlZ3kifV0sIng0MDIiOnRydWV9",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJNaXJhZ2UgQXVkaXQiLCJkZXNjcmlwdGlvbiI6IkF1dG9tYXRlZCBhdWRpdCByZXBvcnRzLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvNy5wbmciLCJzZXJ2aWNlcyI6W3sibmFtZSI6ImF1ZGl0In1dLCJ4NDAyIjpmYWxzZX0=",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJIYWxvIFByb3ZlciIsImRlc2NyaXB0aW9uIjoiWksgcHJvb2YgZ2VuZXJhdGlvbi4iLCJpbWFnZSI6Imh0dHBzOi8vaG9uZXljb21iLm1hcmtldC9hLzgucG5nIiwic2VydmljZXMiOlt7Im5hbWUiOiJ6ay1wcm9vZiJ9XSwieDQwMiI6dHJ1ZX0=",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJUYWdnZXIgQ29sbGVjdGl2ZSIsImRlc2NyaXB0aW9uIjoiQ3Jvd2QgZGF0YSBhbm5vdGF0aW9uLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvOS5wbmciLCJzZXJ2aWNlcyI6W3sibmFtZSI6ImRhdGEtbGFiZWxpbmcifV0sIng0MDIiOmZhbHNlfQ==",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJTZW50aW5lbCBMYWJzIiwiZGVzY3JpcHRpb24iOiJUaHJlYXQgJiBleHBsb2l0IGFuYWx5c2lzLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvMTAucG5nIiwic2VydmljZXMiOlt7Im5hbWUiOiJhdWRpdCJ9XSwieDQwMiI6ZmFsc2V9",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJBcGlhcnkgUHJpbWUiLCJkZXNjcmlwdGlvbiI6IkF1ZGl0cywgc3RyYXRlZ2llcyAmIHByb29mcy4iLCJpbWFnZSI6Imh0dHBzOi8vaG9uZXljb21iLm1hcmtldC9hLzExLnBuZyIsInNlcnZpY2VzIjpbeyJuYW1lIjoiYXVkaXQifSx7Im5hbWUiOiJ0cmFkaW5nLXN0cmF0ZWd5In0seyJuYW1lIjoiemstcHJvb2YifV0sIng0MDIiOnRydWV9",
            "eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJFY2hvIEFnZW50IiwiZGVzY3JpcHRpb24iOiJNb2RlbCBldmFsICYgYmVuY2htYXJraW5nLiIsImltYWdlIjoiaHR0cHM6Ly9ob25leWNvbWIubWFya2V0L2EvMTIucG5nIiwic2VydmljZXMiOlt7Im5hbWUiOiJldmFscyJ9XSwieDQwMiI6ZmFsc2V9"
        ];
        for (uint256 i = 1; i <= 12; i++) {
            reg.register(i, string.concat(CARD_URI_PREFIX, cards[i - 1]), owner(i));
        }

        // sybil ring: one client reviews agents 1..10 → breadth 10 (ring wallet)
        address ring = addr(900);
        for (uint256 i = 1; i <= 10; i++) {
            reg.leaveFeedback(i, ring, 900 + i, 1); // raw ~90.x, but ring-only → discounted to ~0
        }
        // organic: agent 11 reviewed by 6 distinct independent clients (each breadth 1)
        for (uint256 j = 1; j <= 6; j++) {
            reg.leaveFeedback(11, addr(700 + j), 870 + j * 3, 1);
        }
        // self-feedback: agent 12's owner reviews itself, plus one independent reviewer
        reg.leaveFeedback(12, owner(12), 990, 1);
        reg.leaveFeedback(12, addr(800), 850, 1);

        // --- Layer 2: the bounty market ---------------------------------------------------
        address reqA = addr(500);
        address reqB = addr(501);
        address reqC = addr(502);
        address reqD = addr(503);
        address enclave = addr(999);
        uint64 deadline = uint64(block.timestamp + 7 days);

        // createBounty(bountyId, requester, bytes32 category, rewardWei, deadline, string title)
        esc.createBounty(1, reqA, "audit", 5 ether, deadline, "Audit an ERC-4626 vault");
        esc.createBounty(2, reqB, "trading-strategy", 8 ether, deadline, "Backtest a funding-rate arb");
        esc.createBounty(3, reqC, "zk-proof", 3 ether, deadline, "Prove Merkle inclusion in Halo2");
        esc.createBounty(4, reqD, "data-labeling", 2 ether, deadline, "Label 10k toxicity samples");
        esc.createBounty(5, owner(3), "evals", 4 ether, deadline, "Eval harness for a 7B model"); // self-dealt

        esc.submit(1, 11, "ipfs://s-1-11");
        esc.submit(1, 5, "ipfs://s-1-5");
        esc.submit(1, 7, "ipfs://s-1-7");
        esc.submit(2, 11, "ipfs://s-2-11");
        esc.submit(2, 6, "ipfs://s-2-6");
        esc.submit(3, 11, "ipfs://s-3-11");
        esc.submit(3, 8, "ipfs://s-3-8");
        esc.submit(4, 2, "ipfs://s-4-2");
        esc.submit(4, 9, "ipfs://s-4-9");
        esc.submit(5, 3, "ipfs://s-5-3");

        // enclave verdicts (ValidationRecorded): #7 fails attestation; self-dealer #3 scores 97
        esc.validate(1, 11, enclave, 95, true, h("v-1-11"));
        esc.validate(1, 5, enclave, 60, true, h("v-1-5"));
        esc.validate(1, 7, enclave, 40, false, h("v-1-7"));
        esc.validate(2, 11, enclave, 92, true, h("v-2-11"));
        esc.validate(2, 6, enclave, 70, true, h("v-2-6"));
        esc.validate(3, 11, enclave, 85, true, h("v-3-11")); // generalist; below Halo on a pure-zk bounty
        esc.validate(3, 8, enclave, 88, true, h("v-3-8")); // zk specialist → top valid grade, wins bounty 3
        esc.validate(5, 3, enclave, 97, true, h("v-5-3"));

        // settlements: #11 wins 1 & 2 (two independent requesters), #8 wins 3, #3 self-wins 5.
        // Bounty 4 stays open.
        esc.settle(1, 11, 95, h("a-1"));
        esc.settle(2, 11, 92, h("a-2"));
        esc.settle(3, 8, 88, h("a-3"));
        esc.settle(5, 3, 97, h("a-5"));

        vm.stopBroadcast();
    }

    function owner(uint256 i) internal pure returns (address) {
        return addr(1000 + i);
    }

    function addr(uint256 n) internal pure returns (address) {
        return address(uint160(n));
    }

    function h(string memory s) internal pure returns (bytes32) {
        return keccak256(bytes(s));
    }
}
