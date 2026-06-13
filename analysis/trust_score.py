"""Trust / sybil-resistance scoring for ERC-8004 agents.

Raw reputation (avg feedback score) is gameable: an owner can mint agents and spray
synthetic feedback. This computes a TRUST score that discounts agents whose feedback
shows sybil patterns, and emits per-agent flags explaining why.

Inputs (from BigQuery):
  erc8004_feedback_raw.csv       - one row per NewFeedback event (agent, client, value, tx, ts)
  erc8004_registrations_raw.csv  - agent_id -> owner, registered_at, reg_tx
  erc8004_directory_resolved.csv - x402 + names (for the final joined output)

Output:
  erc8004_trust.csv  - per-agent: raw_score, trust_score, flags, signal breakdown
"""
import pandas as pd
import numpy as np

fb  = pd.read_csv("erc8004_feedback_raw.csv", parse_dates=["block_timestamp"])
reg = pd.read_csv("erc8004_registrations_raw.csv", parse_dates=["registered_at"])
res = pd.read_csv("erc8004_directory_resolved.csv")

fb["score"] = fb["raw_value"] / np.power(10.0, fb["value_decimals"])
owner_of = reg.set_index("agent_id")["owner"].to_dict()

# ---- transaction-level signals (computed once over all feedback) ----
# how many distinct agents got feedback in the same tx -> scripted batch signal
tx_agent_span = fb.groupby("transaction_hash")["agent_id"].nunique()
fb["tx_agent_span"] = fb["transaction_hash"].map(tx_agent_span)

# client -> set of agents it reviewed (a client reviewing a big sequential cluster is suspect)
client_breadth = fb.groupby("client")["agent_id"].nunique()
fb["client_breadth"] = fb["client"].map(client_breadth)

# ---- per-agent aggregation ----
def agent_signals(g: pd.DataFrame) -> pd.Series:
    aid = g.name
    owner = owner_of.get(aid)
    n = len(g)
    uniq = g["client"].nunique()
    clients = set(g["client"].str.lower())

    # signal 1: self-feedback (owner reviews own agent)
    self_fb = int(owner is not None and str(owner).lower() in clients)

    # signal 2: client concentration (repeat reviewers). 1.0 = all distinct, ->0 = one client spamming
    concentration = uniq / n if n else 1.0

    # signal 3: batch tx -- feedback delivered in txs that also fed many OTHER agents
    batch_share = (g["tx_agent_span"] > 1).mean()

    # signal 4: reviewer ring -- this agent's reviewers also blanket many other agents
    #           (mean breadth of its clients; high = clients are spraying the whole cluster)
    reviewer_ring = g["client_breadth"].mean()

    # signal 5: score uniformity within the agent (zero variance from few clients = templated)
    score_std = g["score"].std(ddof=0)

    return pd.Series({
        "feedback_count": n, "unique_clients": uniq, "avg_score": round(g["score"].mean(), 2),
        "self_feedback": self_fb, "client_concentration": round(concentration, 3),
        "batch_tx_share": round(batch_share, 3), "reviewer_ring": round(reviewer_ring, 2),
        "score_std": round(score_std, 3),
    })

agg = fb.groupby("agent_id").apply(agent_signals, include_groups=False).reset_index()

# ---- trust score ----
# Dominant signal in this data: a single wallet (reviewer_ring/client_breadth ~101) mass-reviews
# almost every agent. An agent whose ONLY reviewers are such ring wallets has no organic
# reputation. So we weight by how many INDEPENDENT (low-breadth) clients an agent has.
RING_BREADTH = 10  # a client reviewing >=10 distinct agents is treated as a sybil/ring wallet

# precompute per-agent count of independent reviewers (clients not in the ring)
ring_wallets = set(client_breadth[client_breadth >= RING_BREADTH].index)
fb["is_ring_client"] = fb["client"].isin(ring_wallets)
indep = fb[~fb["is_ring_client"]].groupby("agent_id")["client"].nunique()
agg["independent_clients"] = agg["agent_id"].map(indep).fillna(0).astype(int)

def trust(row):
    s = row["avg_score"]
    flags = []
    mult = 1.0
    indep_n = row["independent_clients"]

    if row["self_feedback"]:
        mult *= 0.3; flags.append("self-feedback")
    if indep_n == 0:
        # every reviewer is a ring wallet -> no organic reputation
        mult *= 0.1; flags.append("ring-only reviewers")
    elif indep_n < 3:
        mult *= 0.5; flags.append(f"{indep_n} independent client(s)")
    if row["reviewer_ring"] >= RING_BREADTH:
        mult *= 0.5; flags.append(f"reviewed by ring wallet (breadth {int(row['reviewer_ring'])})")
    # confidence bonus: many INDEPENDENT distinct clients is hard to fake
    if indep_n >= 5:
        mult = min(1.0, mult * 1.3); flags.append("broad independent client base")

    return pd.Series({"trust_score": round(s * mult, 2),
                      "trust_mult": round(mult, 3),
                      "flags": "; ".join(flags) if flags else "clean"})

agg = pd.concat([agg, agg.apply(trust, axis=1)], axis=1)

# ---- join names / x402 ----
meta = res[["agent_id", "name", "x402_resolved", "services", "agent_uri"]].copy()
out = agg.merge(meta, on="agent_id", how="left")
out = out.sort_values(["trust_score", "unique_clients"], ascending=False).reset_index(drop=True)
out.to_csv("erc8004_trust.csv", index=False)

# ---- report ----
pd.set_option("display.max_columns", None, "display.width", 200)
print(f"scored {len(out)} agents with feedback\n")
print("=== TOP 10 by TRUST score (sybil-discounted) ===")
cols = ["agent_id","name","avg_score","trust_score","unique_clients","flags"]
print(out[cols].head(10).to_string(index=False))

print("\n=== biggest raw->trust drops (likely sybil) ===")
out["drop"] = out["avg_score"] - out["trust_score"]
worst = out.sort_values("drop", ascending=False).head(8)
print(worst[["agent_id","name","avg_score","trust_score","flags"]].to_string(index=False))

organic = (out["independent_clients"] >= 5).sum()
print(f"\nflag summary: {(out['flags']=='clean').sum()} clean | "
      f"{out['flags'].str.contains('broad independent').sum()} broad-independent | "
      f"{out['flags'].str.contains('ring-only').sum()} ring-only (sybil) | "
      f"{out['flags'].str.contains('reviewed by ring').sum()} touched-by-ring | "
      f"{out['flags'].str.contains('self').sum()} self-feedback")
print(f"\nHEADLINE: of {len(out)} agents with reputation, {organic} have an organic "
      f"(>=5 independent reviewer) client base. The rest are fed by ring wallet(s).")
print("\nwrote erc8004_trust.csv")
