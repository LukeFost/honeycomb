// Regenerates the 12 base64 `data:` agent-card URIs seeded in
// contracts/script/DeployAndSeed.s.sol. Each agent registers an ERC-8004 registration-v1 card
// ({type,name,description,image,services,x402}) as fully on-chain metadata (EIP-8004 permits the
// data: scheme), so apps/web/src/lib/bq.ts's agent_trust view decodes a real name/services
// straight from the Registered event — no off-chain fetch in the demo path.
//
// Edit the AGENTS table below, then:  node tools/chain-verify/scripts/gen-agent-cards.mjs
// and paste the printed `string[12] memory cards = [...]` block back into DeployAndSeed.s.sol.
// Keep the names in sync with the golden assertions in scripts/assert-demo.ts (#11 Apiary Prime,
// #3 Vanta Evals).

const TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

// id, name, description, services[], x402
const AGENTS = [
  [1, "Aegis Audit", "Contract security audits.", ["audit"], false],
  [2, "Corpus Labelers", "Human-grade data labeling.", ["data-labeling"], false],
  [3, "Vanta Evals", "LLM evaluation harnesses.", ["evals"], false], // self-dealer (#3)
  [4, "Nimbus Data", "Dataset curation & labeling.", ["data-labeling"], false],
  [5, "Probe Security", "Smart-contract review.", ["audit"], false],
  [6, "Delta Quant", "Quant trading strategies.", ["trading-strategy"], true],
  [7, "Mirage Audit", "Automated audit reports.", ["audit"], false], // cheater (#7)
  [8, "Halo Prover", "ZK proof generation.", ["zk-proof"], true],
  [9, "Tagger Collective", "Crowd data annotation.", ["data-labeling"], false],
  [10, "Sentinel Labs", "Threat & exploit analysis.", ["audit"], false],
  [11, "Apiary Prime", "Audits, strategies & proofs.", ["audit", "trading-strategy", "zk-proof"], true], // organic (#11)
  [12, "Echo Agent", "Model eval & benchmarking.", ["evals"], false],
];

const cards = AGENTS.map(([id, name, description, services, x402]) => {
  const card = {
    type: TYPE,
    name,
    description,
    image: `https://honeycomb.market/a/${id}.png`,
    services: services.map((s) => ({ name: s })),
    x402,
  };
  const json = JSON.stringify(card);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  // round-trip sanity check: the value the view will decode must parse back to this card
  if (JSON.parse(Buffer.from(b64, "base64").toString("utf8")).name !== name) {
    throw new Error(`round-trip failed for ${name}`);
  }
  return { id, name, b64 };
});

console.log("        string[12] memory cards = [");
cards.forEach((c, i) => {
  console.log(`            "${c.b64}"${i < cards.length - 1 ? "," : ""}  // #${c.id} ${c.name}`);
});
console.log("        ];");
