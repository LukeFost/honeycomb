// Manual x402 happy-path proof (throwaway). Funder signs EIP-3009 off-chain;
// the facilitator relayer broadcasts transferWithAuthorization. NOT a unit test.
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC!;
const TOKEN = "0x7741897a5cB179c0C44ebc198EeDe70DeB689Cdd" as const; // mUSDCv2
const FUNDER_PK = (process.env.FUNDER_PK!.startsWith("0x") ? process.env.FUNDER_PK! : `0x${process.env.FUNDER_PK!}`) as Hex;
const PAY_TO = "0x06853dcD64c0d6e9C6b9B86AD77218a9545b7f98" as const; // OWNER (custodial Option A target)
const NETWORK = "eip155:11155111";
const VALUE = 50_000_000n; // 50 mUSDC
const FAC = "http://localhost:4021";

const account = privateKeyToAccount(FUNDER_PK);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });

// random bytes32 nonce (EIP-3009 replay field)
const nonce = ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
  .map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;

const now = Math.floor(Date.now() / 1000);
const validAfter = 0n;
const validBefore = BigInt(now + 3600);

const domain = {
  name: "Mock USD Coin",
  version: "2",
  chainId: 11155111,
  verifyingContract: TOKEN,
} as const;

const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const message = {
  from: account.address,
  to: PAY_TO,
  value: VALUE,
  validAfter,
  validBefore,
  nonce,
} as const;

console.log("FUNDER =", account.address);
console.log("payTo  =", PAY_TO);
console.log("value  =", VALUE.toString(), "(50 mUSDC)");
console.log("nonce  =", nonce);

const signature = await account.signTypedData({
  domain, types, primaryType: "TransferWithAuthorization", message,
});
console.log("signature =", signature.slice(0, 20) + "...");

// The PaymentRequirements the resource server "accepted". ExactEvmScheme checks
// the authorization value against requirements.amount (NOT maxAmountRequired),
// and reads extra.{name,version} for the EIP-712 domain.
const paymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: TOKEN,
  payTo: PAY_TO,
  amount: VALUE.toString(),
  maxAmountRequired: VALUE.toString(),
  resource: "https://honeycompute.com/fund/manual-test",
  description: "manual x402 bounty-funding proof",
  mimeType: "application/json",
  maxTimeoutSeconds: 120,
  extra: { name: "Mock USD Coin", version: "2" },
};

// x402 v2 payment payload. The scheme reads payload.accepted (the embedded
// requirements) and payload.payload.{signature,authorization}.
const paymentPayload = {
  x402Version: 2,
  scheme: "exact",
  network: NETWORK,
  accepted: paymentRequirements,
  payload: {
    signature,
    authorization: {
      from: account.address,
      to: PAY_TO,
      value: VALUE.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  },
};

async function call(path: string) {
  const res = await fetch(`${FAC}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  const body = await res.json();
  console.log(`\n${path} -> ${res.status}`, JSON.stringify(body));
  return body;
}

const before = await pub.readContract({ address: TOKEN, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [account.address] });
console.log("\nfunder USDC before:", (before as bigint).toString());

await call("/verify");
await call("/settle");
