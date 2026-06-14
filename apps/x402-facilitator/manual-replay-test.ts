// Replay-protection proof: re-sign + re-settle the SAME nonce. The token's
// authorizationState already flags it used, so /verify must reject and /settle
// must fail. Run right after manual-fund-test.ts with the SAME nonce.
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TOKEN = "0x7741897a5cB179c0C44ebc198EeDe70DeB689Cdd" as const;
const FUNDER_PK = (process.env.FUNDER_PK!.startsWith("0x") ? process.env.FUNDER_PK! : `0x${process.env.FUNDER_PK!}`) as Hex;
const PAY_TO = "0x06853dcD64c0d6e9C6b9B86AD77218a9545b7f98" as const;
const NETWORK = "eip155:11155111";
const VALUE = 50_000_000n;
const FAC = "http://localhost:4021";
const NONCE = process.env.REPLAY_NONCE as Hex; // the nonce that was already settled

const account = privateKeyToAccount(FUNDER_PK);
const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

const domain = { name: "Mock USD Coin", version: "2", chainId: 11155111, verifyingContract: TOKEN } as const;
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;
const message = { from: account.address, to: PAY_TO, value: VALUE, validAfter, validBefore, nonce: NONCE } as const;

const signature = await account.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });

const paymentRequirements = {
  scheme: "exact", network: NETWORK, asset: TOKEN, payTo: PAY_TO,
  amount: VALUE.toString(), maxAmountRequired: VALUE.toString(),
  resource: "https://honeycompute.com/fund/manual-test",
  description: "replay attempt", mimeType: "application/json",
  maxTimeoutSeconds: 120, extra: { name: "Mock USD Coin", version: "2" },
};
const paymentPayload = {
  x402Version: 2, scheme: "exact", network: NETWORK, accepted: paymentRequirements,
  payload: {
    signature,
    authorization: {
      from: account.address, to: PAY_TO, value: VALUE.toString(),
      validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce: NONCE,
    },
  },
};

async function call(path: string) {
  const res = await fetch(`${FAC}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  console.log(`${path} -> ${res.status}`, JSON.stringify(await res.json()));
}

console.log("REPLAY with already-used nonce:", NONCE);
await call("/verify");
await call("/settle");
