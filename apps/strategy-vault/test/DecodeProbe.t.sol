// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "forge-std/Test.sol";
import {StrategyVault} from "../contracts/StrategyVault.sol";

contract DecodeProbe is Test {
    // Does abi.encode(structInstance) == abi.encode(flat fields)?  And does the flat decode read it?
    function test_struct_encode_equals_flat() external {
        StrategyVault.Action memory a = StrategyVault.Action({
            to: address(0xAAAA), data: hex"deadbeef", value: 0, minOut: 123, deadline: 999,
            tokenIn: address(0xBBBB), tokenOut: address(0xCCCC), amountIn: 456,
            nonce: keccak256("n"), artifactHash: keccak256("h")
        });
        bytes memory encStruct = abi.encode(a);
        bytes memory encFlat = abi.encode(
            address(0xAAAA), bytes(hex"deadbeef"), uint256(0), uint256(123), uint64(999),
            address(0xBBBB), address(0xCCCC), uint256(456), keccak256("n"), keccak256("h")
        );
        emit log_named_uint("encStruct len", encStruct.length);
        emit log_named_uint("encFlat len", encFlat.length);
        assertEq(keccak256(encStruct), keccak256(encFlat), "struct vs flat encoding DIFFERS");
        // now decode the STRUCT encoding with the FLAT tuple decoder (what onReport does)
        (address to,,,,,address tokenIn,,uint256 amountIn,,) =
          abi.decode(encStruct, (address,bytes,uint256,uint256,uint64,address,address,uint256,bytes32,bytes32));
        assertEq(to, address(0xAAAA));
        assertEq(amountIn, 456);
        emit log("struct->flat decode OK, encodings identical");
    }
}
