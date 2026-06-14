# This is a big picture goal of what we want to create.

> **Vision / origin doc.** This is the north-star product goal, kept for context. The
> _mechanics_ below (e.g. batched grading at the deadline in step 3, agent self-attestation
> in step 5/2) are early framing and have since been superseded. For the resolved
> architecture — two separate TEEs, per-submission scoring, CRE write-callback — see
> [`README.md`](./README.md) and [`diagrams/honeycomb_architecture.png`](./diagrams/). The
> product vision here still holds; the build details live in README/GAPS.

The goal is to create a swarm application where users are able to submit bounties for other user's to work/compete on.

Key point is to incentivize high quality answers and minimize cheating and slop.

Flagship User Flow - Bounty Maker

1. A user creates a bounty for a Uniswap LP Trading Bot using their claude code which is connected to our site via an MCP server or a skill. The bounty takes in information such as a total reward, a description. The agent creates a set of private and public tests(includes private/public dataset) along with a prompt guideliens for finding invalid submissions. This triggers a job deployment following ERC 8183.

2. Agents then submit encrypted responses to the smart contract in the form of a CID (encrypted object storage link). They must also submit an AI attestation verifying that the code is valid and is not hardcoded, the attestation is written to the escrow. An invalid attestation will negatviely affect the agents score.

3. The contest period ends, and the chainlink workflow runs and queries all of the submissions to be run on the TEE. It grades all of the submissions and it then writes to the contract for whicever one scored the highest.

4. The round is then over and the bounty owner, can decrypt the winning submission and they have to pay out the bounty. They can also continue to fund more rounds, and users can base their new submisisons off of the winning one.

5. The user should then be able to run their Uniswap Strategy in a real bot.

Flagship User Flow - Agent

1. A user has to register their agent first accoriding to ERC 8004(?)

2. The user then adds our mcp server/skill to claude. Then the user can launch a loop to monitor using an API which goes to Google Big Query for jobs.

3. The agent then works on the uniswap backtesting problem to create a model to trade the pair and its tested using the public tests/data set.

4. The agent can query other agents which may have unique skills for help or can purchase their help for certain queries.

5. The agent that asks the AI to attest its valid and then it submits the code. Once the code has been attested to, the user can resubmit or wait.

6. When the bounty period is completed, the user is then notified of the result and it can continue to work on more.
