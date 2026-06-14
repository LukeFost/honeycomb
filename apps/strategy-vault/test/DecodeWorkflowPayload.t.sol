// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";

/// @notice Cross-checks the viem(workflow) -> Solidity(vault) ABI boundary.
///         `test/fixtures/encoded_action.hex` is the EXACT report payload the CRE workflow
///         (strategy-workflow/main.ts) emitted in `cre workflow simulate`. This test decodes
///         it with the vault's flat layout and asserts every field round-trips — proving viem's
///         `encodeAbiParameters(parseAbiParameters(...))` is byte-compatible with the vault's
///         `abi.decode(report, (address, bytes, uint256, ...))`. Regenerate the fixture by
///         re-running simulate and copying the `encodedAction` value.
contract DecodeWorkflowPayload is Test {
    function test_DecodeWorkflowAction() public {
        bytes memory report = vm.parseBytes(vm.readFile("test/fixtures/encoded_action.hex"));

        (
            address to,
            bytes memory data,
            uint256 value,
            uint256 minOut,
            uint64 deadline,
            address tokenIn,
            address tokenOut,
            uint256 amountIn,
            bytes32 nonce,
            bytes32 artifactHash
        ) = abi.decode(
            report,
            (address, bytes, uint256, uint256, uint64, address, address, uint256, bytes32, bytes32)
        );

        // Fields must equal config.staging.json + the simulate log output.
        assertEq(to, 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af, "router (to)");
        assertEq(value, 0, "value");
        assertEq(minOut, 0, "minOut");
        assertEq(deadline, 4102444800, "deadline");
        assertEq(tokenIn, 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238, "tokenIn");
        assertEq(tokenOut, 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14, "tokenOut");
        assertEq(amountIn, 1_000_000_000, "amountIn");
        assertEq(nonce, 0x184677fbbfcca27a7163f71f0c6c0cef936a6667cb17d623e6d266b0fe04c771, "nonce");
        assertEq(
            artifactHash,
            0x9798761ddf0c15e9a4e027c33bb59ad83cb193915eccc971667d5f335bcfe0c3,
            "artifactHash"
        );

        // `data` is the Universal Router execute(bytes,bytes[],uint256) calldata.
        assertEq(bytes4(data), bytes4(0x3593564c), "UR execute selector");
        assertGt(data.length, 4, "calldata present");
        emit log_named_uint("decoded UR calldata bytes", data.length);
    }
}
