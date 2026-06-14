// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// MockUSDCv2 — 6-decimal test USDC with EIP-3009 (transferWithAuthorization).
//
// Same hand-rolled, dependency-free shape as MockUSDC.sol, PLUS the EIP-3009
// surface x402 needs to settle gas-less signed payments:
//
//   transferWithAuthorization(...)  — relayer broadcasts a buyer-signed transfer
//   receiveWithAuthorization(...)   — same, but pins msg.sender == `to` (front-run safe)
//   cancelAuthorization(...)        — buyer voids an unused authorization
//   authorizationState(from, nonce) — on-chain replay flag x402 /verify reads
//
// The signature scheme is EIP-712 typed data over the EIP-3009 TransferWith-
// Authorization struct, matching Circle's USDC so the @x402/evm ExactEvmScheme
// verifies it unchanged. The constructor pins the EIP-712 domain to:
//
//   name = "Mock USD Coin", version = "2", chainId = block.chainid, this address
//
// DEPLOY + SWAP (no escrow redeploy): deploy this, then call the escrow's
// setRewardToken(newToken) (onlyOwner, BountyEscrow.sol:231). New bounties pull
// the new token; the x402 facilitator points its USDC at this address.
//
// Drop-in for MockUSDC: constructor(uint256 initialMint) and the full ERC-20
// surface are unchanged, so test/BountyEscrow.t.sol's `new MockUSDC(1_000_000e6)`
// pattern works verbatim against this contract.
//
// Open mint() is kept (TEST ONLY) so external funders can self-serve test USDC.
// ============================================================================
contract MockUSDCv2 {
    string public constant name = "Mock USD Coin";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // EIP-3009 replay flag: true once a (authorizer, nonce) pair has been used or
    // cancelled. x402 /verify reads this on-chain to reject replays; /settle relies
    // on it to make each authorization single-use.
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    // EIP-3009 lifecycle events (indexed by authorizer + nonce, per the spec).
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    // --- EIP-712 domain ------------------------------------------------------
    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 private constant _TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 private constant _RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 private constant _CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;

    constructor(uint256 initialMint) {
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
        mint(msg.sender, initialMint);
    }

    // --- EIP-712 plumbing ----------------------------------------------------
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        // Recompute on a forked/replayed chainId so the separator is never stale
        // (the classic chainId-cache guard).
        if (block.chainid == _CACHED_CHAIN_ID) return _CACHED_DOMAIN_SEPARATOR;
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes("2")), // EIP-712 domain version "2" — matches Circle USDC + the x402 web config
                block.chainid,
                address(this)
            )
        );
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    // --- EIP-3009 ------------------------------------------------------------
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(
                _TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        _verifyAndConsume(from, validAfter, validBefore, nonce, structHash, v, r, s);
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // Front-running guard: only the payee may submit, so a relayer can't be
        // racing the real recipient. x402's ExactEvmScheme uses transferWith-
        // Authorization by default; receiveWith is here for spec-completeness.
        require(to == msg.sender, "caller != payee");
        bytes32 structHash = keccak256(
            abi.encode(
                _RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        _verifyAndConsume(from, validAfter, validBefore, nonce, structHash, v, r, s);
        _transfer(from, to, value);
    }

    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(!_authorizationStates[authorizer][nonce], "auth used");
        bytes32 structHash = keccak256(
            abi.encode(_CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_recover(digest, v, r, s) == authorizer, "bad sig");
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _verifyAndConsume(
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes32 structHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        require(block.timestamp > validAfter, "auth not yet valid");
        require(block.timestamp < validBefore, "auth expired");
        require(!_authorizationStates[from][nonce], "auth used");

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_recover(digest, v, r, s) == from, "bad sig");

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    // ecrecover with EIP-2 low-s + zero-address guards (matches USDC's checks).
    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) private pure returns (address) {
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "invalid s"
        );
        require(v == 27 || v == 28, "invalid v");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid signature");
        return signer;
    }

    // --- ERC-20 (unchanged from MockUSDC) ------------------------------------
    /// @notice Open mint — TEST ONLY. Lets external funders self-serve test USDC.
    function mint(address to, uint256 amount) public {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
