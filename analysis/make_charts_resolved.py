"""Charts built from the RESOLVED directory (off-chain x402 fetched). No BQ cost.
Produces: chart_4_x402.png (overwrite, now truthful), chart_2_leaderboard.png (overwrite, with names),
chart_5_services.png (new), and refreshes erc8004_snapshot.md leaderboard with names."""
import pandas as pd, numpy as np
import matplotlib.pyplot as plt

plt.rcParams.update({
    "figure.dpi": 160, "savefig.dpi": 160, "font.size": 12,
    "axes.titleweight": "bold", "axes.titlesize": 15,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.alpha": 0.25, "figure.autolayout": True,
})
INK="#0F172A"; ACCENT="#6366F1"; ACCENT2="#F59E0B"; GREEN="#10B981"; RED="#EF4444"; SLATE="#94A3B8"
WINDOW = "May 14 – Jun 12, 2026 (30d)"
def footer(fig):
    fig.text(0.99, 0.01, f"Source: BigQuery Ethereum mainnet + off-chain metadata fetch · ERC-8004 · {WINDOW}",
             ha="right", va="bottom", fontsize=8, color=SLATE)

d = pd.read_csv("erc8004_directory_resolved.csv")

def disp_name(r):
    if isinstance(r["name"], str) and r["name"].strip():
        return r["name"][:26]
    u = str(r["agent_uri"])
    return ("onchain agent" if u.startswith("data:") else u.replace("https://","")[:26])
d["disp"] = d.apply(disp_name, axis=1)

# ---- Chart 4 (truthful): x402 payability after off-chain resolution ----
def bucket(v):
    if v is True or v=="True": return "Payable (x402 ✓)"
    if v is False or v=="False": return "Not payable"
    return "Unresolved"
d["x402b"] = d["x402_resolved"].map(bucket)
order = ["Payable (x402 ✓)","Not payable","Unresolved"]
col = {"Payable (x402 ✓)":GREEN,"Not payable":RED,"Unresolved":SLATE}
xc = d["x402b"].value_counts().reindex([o for o in order if o in d["x402b"].values])
fig, ax = plt.subplots(figsize=(9, 3.8))
bars = ax.barh(xc.index, xc.values, color=[col[i] for i in xc.index])
for b in bars:
    ax.text(b.get_width()+0.5, b.get_y()+b.get_height()/2, f"{int(b.get_width())}", va="center", fontweight="bold")
ax.set_xlabel("Reputable agents (n=%d)" % len(d))
ax.set_title("x402 payability — resolved via off-chain metadata fetch")
ax.set_xlim(0, max(xc.values)*1.15); ax.invert_yaxis()
footer(fig); fig.savefig("chart_4_x402.png", bbox_inches="tight"); plt.close(fig)

# ---- Chart 2 (improved): leaderboard with names + x402 badge color ----
lb = d.dropna(subset=["avg_score"]).sort_values(["avg_score","unique_clients"], ascending=False).head(12).iloc[::-1]
barcol = [GREEN if (v is True or v=="True") else ACCENT for v in lb["x402_resolved"]]
fig, ax = plt.subplots(figsize=(11, 6))
bars = ax.barh(lb["disp"], lb["avg_score"], color=barcol)
ax.set_xlabel("Average reputation score"); ax.set_title("Top ERC-8004 agents by reputation  (green = x402-payable)")
ax.set_xlim(0, lb["avg_score"].max()*1.22)
for bar, c in zip(bars, lb["unique_clients"]):
    ax.text(bar.get_width()+lb["avg_score"].max()*0.01, bar.get_y()+bar.get_height()/2,
            f"{bar.get_width():.0f} · {int(c)} client{'s' if c!=1 else ''}", va="center", fontsize=9, color=INK)
footer(fig); fig.savefig("chart_2_leaderboard.png", bbox_inches="tight"); plt.close(fig)

# ---- Chart 5 (new): services / interaction protocols offered ----
svc = d["services"].dropna().str.split(",").explode().str.strip()
svc = svc[svc!=""].value_counts()
fig, ax = plt.subplots(figsize=(8, 4))
bars = ax.bar(svc.index, svc.values, color=[ACCENT, ACCENT2, GREEN, SLATE][:len(svc)])
for b in bars: ax.text(b.get_x()+b.get_width()/2, b.get_height()+0.5, int(b.get_height()), ha="center", fontweight="bold")
ax.set_ylabel("Agents offering"); ax.set_title("Interaction protocols advertised by ERC-8004 agents")
ax.set_ylim(0, svc.max()*1.18)
footer(fig); fig.savefig("chart_5_services.png", bbox_inches="tight"); plt.close(fig)

print("wrote chart_4_x402.png (truthful), chart_2_leaderboard.png (named), chart_5_services.png")

# ---- refresh snapshot leaderboard table with names + resolved x402 ----
lines = ["## ERC-8004 Agent Economy — Snapshot (resolved)",
         f"_Window: {WINDOW} · Source: BigQuery + off-chain metadata fetch_\n",
         "### Key metrics", "| Metric | Value |", "|---|---:|"]
payable = (d["x402_resolved"]==True).sum() if d["x402_resolved"].dtype!=object else (d["x402_resolved"].astype(str)=="True").sum()
lines += [f"| Agents with reputation | {len(d)} |",
          f"| x402-payable (resolved) | {int(payable)} |",
          f"| Not payable | {int((d['x402b']=='Not payable').sum())} |",
          f"| Unresolved metadata | {int((d['x402b']=='Unresolved').sum())} |",
          f"| Top reputation score | {d['avg_score'].max():.0f} |", ""]
lines += ["### Reputation leaderboard (top 15, resolved)",
          "| Rank | Agent | ID | Score | Clients | x402 | Services |",
          "|---:|:--|---:|---:|---:|:--:|:--|"]
top = d.sort_values(["avg_score","unique_clients"], ascending=False).head(15).reset_index(drop=True)
for i, r in top.iterrows():
    x = "✅" if str(r["x402_resolved"])=="True" else ("❌" if str(r["x402_resolved"])=="False" else "—")
    nm = (r["disp"] or "")[:24]
    svcs = r["services"] if isinstance(r["services"], str) else ""
    lines.append(f"| {i+1} | {nm} | {int(r['agent_id'])} | {r['avg_score']:.0f} | {int(r['unique_clients'])} | {x} | {svcs} |")
open("erc8004_snapshot.md","w").write("\n".join(lines))
print("refreshed erc8004_snapshot.md")
print("\n".join(lines))
