# feedback — uniswap trading api

notes from integrating the trading api into a contract vault. quotes are good; the friction is in
the contract / onchain-execution path.

- `slippageTolerance` is percent, not bps.
- `x-permit2-disabled` only skips the eip-712 signature, not permit2 onchain — a contract still
  needs the permit2 allowance.
- min-out field isn't named `minOut`; had to read the exact field from a quote response.
- `/swap` calldata is opaque — unusable for a contract + DON consensus, so we rebuild the universal
  router calldata from route + min-out, potentially using a more structured option?
- testnet often returns "no quotes available"; did everything on mainnet/forks.
