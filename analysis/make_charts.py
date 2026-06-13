"""Generate shareable PNG charts + markdown tables from the exported ERC-8004 CSVs. No BQ cost."""
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.ticker import MaxNLocator
import numpy as np

plt.rcParams.update({
    "figure.dpi": 160, "savefig.dpi": 160, "font.size": 12,
    "axes.titleweight": "bold", "axes.titlesize": 15,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.alpha": 0.25, "figure.autolayout": True,
})
INK = "#0F172A"; ACCENT = "#6366F1"; ACCENT2 = "#F59E0B"; GREEN = "#10B981"; SLATE = "#94A3B8"
WINDOW = "May 14 – Jun 12, 2026 (30d)"

adoption = pd.read_csv("erc8004_adoption.csv", parse_dates=["day"])
directory = pd.read_csv("erc8004_directory.csv")

def footer(fig):
    fig.text(0.99, 0.01, f"Source: BigQuery goog_blockchain_ethereum_mainnet · ERC-8004 · {WINDOW}",
             ha="right", va="bottom", fontsize=8, color=SLATE)

# ---- Chart 1: Adoption (daily bars + cumulative line) ----
fig, ax1 = plt.subplots(figsize=(11, 5.5))
ax1.bar(adoption["day"], adoption["new_agents"], color=ACCENT, alpha=0.85, width=0.8)
ax1.set_ylabel("New agents / day", color=ACCENT)
ax1.tick_params(axis="y", labelcolor=ACCENT)
ax2 = ax1.twinx()
ax2.plot(adoption["day"], adoption["cumulative"], color=INK, lw=2.5, marker="o", ms=3)
ax2.set_ylabel("Cumulative agents", color=INK)
ax2.grid(False)
ax1.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
ax1.xaxis.set_major_locator(mdates.DayLocator(interval=4))
total = int(adoption["new_agents"].sum())
ax1.set_title(f"ERC-8004 agent registrations · {total:,} new agents in 30 days")
fig.autofmt_xdate()
footer(fig)
fig.savefig("chart_1_adoption.png", bbox_inches="tight")
plt.close(fig)

# ---- Chart 2: Reputation leaderboard (top agents by score) ----
lb = directory.dropna(subset=["avg_score"]).copy()
lb["label"] = lb["agent_uri"].str.replace(r"^https?://", "", regex=True).str.replace(r"^ipfs://", "ipfs:", regex=True)
lb["label"] = lb["label"].str.slice(0, 38)
lb = lb.sort_values(["avg_score", "unique_clients"], ascending=False).head(12).iloc[::-1]
fig, ax = plt.subplots(figsize=(11, 6))
colors = plt.cm.viridis(np.linspace(0.15, 0.85, len(lb)))
bars = ax.barh(lb["label"], lb["avg_score"], color=colors)
ax.set_xlabel("Average reputation score (value / 10^decimals)")
ax.set_title("Top ERC-8004 agents by reputation")
ax.set_xlim(0, max(lb["avg_score"]) * 1.18)
for bar, c in zip(bars, lb["unique_clients"]):
    ax.text(bar.get_width() + max(lb["avg_score"])*0.01, bar.get_y() + bar.get_height()/2,
            f"{bar.get_width():.0f}  ·  {int(c)} clients", va="center", fontsize=9, color=INK)
footer(fig)
fig.savefig("chart_2_leaderboard.png", bbox_inches="tight")
plt.close(fig)

# ---- Chart 3: URI storage mix (donut) ----
# reconstruct full registration mix from directory's fully_onchain + uri scheme
all_uris = directory.copy()
def kind(u, onchain):
    if onchain: return "On-chain (base64)"
    if isinstance(u,str) and u.startswith("ipfs://"): return "IPFS"
    if isinstance(u,str) and u.startswith("http"): return "HTTPS"
    return "Other/empty"
# directory only has agents WITH reputation; use it to show the reputable-agent mix
all_uris["kind"] = [kind(u,o) for u,o in zip(all_uris["agent_uri"], all_uris["fully_onchain"])]
mix = all_uris["kind"].value_counts()
fig, ax = plt.subplots(figsize=(7.5, 7.5))
cmap = {"HTTPS": ACCENT, "IPFS": ACCENT2, "On-chain (base64)": GREEN, "Other/empty": SLATE}
w, *_ = ax.pie(mix, labels=mix.index, autopct=lambda p: f"{p:.0f}%\n({int(round(p*mix.sum()/100))})",
               colors=[cmap[k] for k in mix.index], startangle=90, pctdistance=0.78,
               wedgeprops=dict(width=0.42, edgecolor="w", linewidth=2))
ax.set_title(f"Where reputable agents store metadata  (n={mix.sum()})")
footer(fig)
fig.savefig("chart_3_uri_mix.png", bbox_inches="tight")
plt.close(fig)

# ---- Chart 4: x402 payability status ----
x = directory.copy()
x["x402_label"] = x["x402"].map({"true":"Payable (on-chain ✓)","false":"Not payable"}).fillna("Unknown (off-chain)")
xc = x["x402_label"].value_counts()
fig, ax = plt.subplots(figsize=(9, 4.2))
order = ["Payable (on-chain ✓)","Not payable","Unknown (off-chain)"]
xc = xc.reindex([o for o in order if o in xc.index])
barcol = {"Payable (on-chain ✓)":GREEN,"Not payable":"#EF4444","Unknown (off-chain)":SLATE}
bars = ax.barh(xc.index, xc.values, color=[barcol[i] for i in xc.index])
for b in bars:
    ax.text(b.get_width()+0.5, b.get_y()+b.get_height()/2, f"{int(b.get_width())}", va="center", fontweight="bold")
ax.set_xlabel("Reputable agents")
ax.set_title("x402 payability — only on-chain metadata is verifiable via SQL")
ax.set_xlim(0, xc.max()*1.15)
ax.invert_yaxis()
footer(fig)
fig.savefig("chart_4_x402.png", bbox_inches="tight")
plt.close(fig)

print("wrote chart_1_adoption.png chart_2_leaderboard.png chart_3_uri_mix.png chart_4_x402.png")

# ================= TABLES (markdown) =================
lines = []
lines.append("## ERC-8004 Agent Economy — Snapshot")
lines.append(f"_Window: {WINDOW} · Source: BigQuery Ethereum mainnet public dataset_\n")

# Headline metrics
n_payable = (directory["x402"]=="true").sum()
lines.append("### Key metrics")
lines.append("| Metric | Value |")
lines.append("|---|---:|")
lines.append(f"| New agents registered (30d) | {int(adoption['new_agents'].sum()):,} |")
lines.append(f"| Agents with reputation (≥1 feedback) | {len(directory):,} |")
lines.append(f"| Fully on-chain metadata | {int(directory['fully_onchain'].sum())} |")
lines.append(f"| Confirmed x402-payable (on-chain) | {int(n_payable)} |")
lines.append(f"| x402 unknown (off-chain, needs fetch) | {int((directory['x402']=='unknown').sum())} |")
lines.append(f"| Top reputation score | {directory['avg_score'].max():.0f} |")
lines.append("")

# Leaderboard table
lines.append("### Reputation leaderboard (top 15)")
lines.append("| Rank | Agent ID | Score | Unique clients | x402 | Metadata URI |")
lines.append("|---:|---:|---:|---:|:--:|:--|")
top = directory.sort_values(["avg_score","unique_clients"], ascending=False).head(15).reset_index(drop=True)
for i, r in top.iterrows():
    uri = str(r["agent_uri"])
    uri = (uri[:46] + "…") if len(uri) > 47 else uri
    x402 = "✅" if r["x402"]=="true" else ("❌" if r["x402"]=="false" else "—")
    lines.append(f"| {i+1} | {int(r['agent_id'])} | {r['avg_score']:.0f} | {int(r['unique_clients'])} | {x402} | `{uri}` |")
lines.append("")

# Metadata mix table
lines.append("### Metadata storage mix (reputable agents)")
lines.append("| Storage | Count | Share |")
lines.append("|:--|---:|---:|")
for k, v in mix.items():
    lines.append(f"| {k} | {int(v)} | {v/mix.sum()*100:.0f}% |")

open("erc8004_snapshot.md","w").write("\n".join(lines))
print("wrote erc8004_snapshot.md")
print("\n".join(lines))
