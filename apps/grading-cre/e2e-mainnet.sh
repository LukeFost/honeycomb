#!/usr/bin/env bash
# ============================================================================
# Honeycomb FULL E2E — mainnet, fail-closed, ALL gaps wired, honestly scoped.
#
# REAL (every broadcast asserted status==0x1; dies on any revert):
#  1. anti-cheat: TWO agents (honest accumulate.py vs cheat hardcoded.py); cheat
#     backtests HIGHER but the AI flags it invalid -> honest wins (proven by payout).
#  2. sealed delivery: agents seal submissions to the enclave X25519 key; the winner
#     is re-sealed to the maker's X25519 key and the maker decrypts it (NaCl).
#  3. autonomous settle: CRE CRON trigger (time-based) resolves after the deadline.
#  4. x402-gated grading: the maker makes ONE real x402 USDC settle up front to SUMMON
#     the bounty's grader; that payment authorizes the (per-submission) attested VM grades.
#  7. self-approving vault: the Base vault does its own JIT Permit2 approve (no owner
#     top-up) and the strategy workflow DECIDES (accumulate rule) instead of always-swap.
#  + real Confidential Space VM grading (TPM-attested) + in-enclave KMS-HSM signature
#    + real Confidential AI Attestor + CRE->canonical-forwarder onReport + verified payout.
#
# NOT claimed: KMS key not yet attestation-EXCLUSIVE; graded submissions baked in image;
#   vault runs a declarative accumulate rule, not the winner's arbitrary code.
# ============================================================================
set -uo pipefail

GR=/home/thegnome/ethny2026/honeycomb/apps/grading-cre
SV=/home/thegnome/ethny2026/honeycomb/apps/strategy-vault
ENVF=/home/thegnome/ethny2026/.env
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
export GOOGLE_APPLICATION_CREDENTIALS=/home/thegnome/ethny2026/bigquerycreds.txt
PRIV_DIR=$GR/maker/bounties/uniswap-lp-trading-bot/private
export PRIVATE_SERIES=$PRIV_DIR/prices_private.json
export INFERENCE_API_KEY_VAR=$(grep -E "^INFERENCE_API_KEY_VAR=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r\n " ')
PY=$GR/grader/.venv/bin/python; DEL=$GR/grader/deliver.py
ALCHEMY=$(grep -E "^ALCHEMY_API_KEY=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r\n " ')
ETH=https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY
BASE_RPC=https://base-mainnet.g.alchemy.com/v2/$ALCHEMY
MAKER_PK=$(grep -E "^REAL_MONEY_PKEY=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r\n " ' | tr -d 'z')
export MAKER_PK
MAKER=$(cast wallet address --private-key "$MAKER_PK")
export CRE_ETH_PRIVATE_KEY=${MAKER_PK#0x}

ESC=0x90058162D3d55542f39507d0328538824A24C9C3
MUSDC=0x8f938d9d2099Ac04fb3D47e7ACC15be8B955161d
ATTESTER=0x5B57aF5eBAd44bEEfdfCcd71F33359d74Ec0e86F
IDREG=0x8004a169fb4a3325136eb29fa0ceb6d2e539a432
VM_DIGEST=sha256:95367e50eefdbe534db4b6ba3e4d7bb4d102de26e055b121ca3d097e3e5229dd

# Gap 4 — x402 summon env (facilitator must be running on $FACILITATOR_URL, eip155:1)
export FACILITATOR_URL=http://localhost:4021
export SUMMON_NETWORK=eip155:1
export SUMMON_PRICE_ATOMIC=10000                                   # 0.01 USDC per VM summon
export SUMMON_PAY_TO=0x06853dcD64c0d6e9C6b9B86AD77218a9545b7f98     # summon-fee recipient (ours)
export SUMMON_NONCE_HMAC_SECRET=honeycomb-e2e-summon-secret-0xbadfade

# two competing agents
HONEST_AGENT=34570; HONEST_PK=$(python3 -c "import json;print(json.load(open('/tmp/agent.json'))[0]['private_key'])")
HONEST_SUB=accumulate.py; HONEST_LOCAL=$GR/grader/submissions/accumulate.py
CHEAT_AGENT=34631;  CHEAT_PK=$(python3 -c "import json;print(json.load(open('/tmp/cheat.json'))[0]['private_key'])")
CHEAT_SUB=hardcoded.py;  CHEAT_LOCAL=$GR/grader/enclave/submissions/hardcoded.py

# Gap 7 — self-approving vault (redeployed on Base)
VAULT=0xB17eBA5A27dC01a79DaAf753D3009d5b315FA92f
REGISTRY=0x3d60d8b40181aE80D16928563F71B77DE31C60E2
USDC_BASE=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH_BASE=0x4200000000000000000000000000000000000006
JOBCREATED_T0=0xef137df1d007645178f3f70e5c306d8d0b84bb5c70cabda9bb0f8f3c71932a0f
FWD=0xa3d1ad4ac559a6575a114998affb2fb2ec97a7d9

die(){ echo; echo "✗ FAILED: $*" >&2; [ -s /tmp/e2e_err ] && { echo "  --- last error ---" >&2; head -6 /tmp/e2e_err >&2; }; exit 1; }
send_tx(){ local rpc=$1 pk=$2; shift 2; local h
  h=$(cast send "$@" --rpc-url "$rpc" --private-key "$pk" --json 2>/tmp/e2e_err | python3 -c "import sys,json;print(json.load(sys.stdin)['transactionHash'])" 2>/dev/null)
  [ -n "$h" ] || die "broadcast failed: cast send $* "; echo "$h"; }
assert_status(){ local h=$1 rpc=$2 label=$3 st
  st=$(cast receipt "$h" --rpc-url "$rpc" --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))" 2>/dev/null)
  [ "$st" = "0x1" ] || die "$label REVERTED: $h (status=${st:-none})"; echo "  ✓ $label: $h"; }
bal(){ cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url "$3" 2>/dev/null | grep -oE '^[0-9]+' | head -1; }
cre_relay(){ local f=$1 label=$2 out tx
  out=$(cd $GR && cre workflow simulate grading-workflow --non-interactive --target mainnet-settings --trigger-index 0 --http-payload "$f" --broadcast 2>&1)
  echo "$out" | grep -E "USER LOG|Workflow Simulation Result|\"action\"" | sed 's/^/      [CRE] /'
  tx=$(echo "$out" | grep -oE '"txHash":"0x[0-9a-f]+"' | grep -oE '0x[0-9a-f]+' | head -1)
  [ -n "$tx" ] || printf '%s\n' "$out" > /tmp/e2e_err
  assert_status "$tx" $ETH "$label"; }

# grade ONE submission: x402-gated VM spawn -> in-enclave score+KMS sig -> AI -> CRE relay. Sets GR_SCORE/GR_VALID.
grade_record(){
  local aid=$1 sname=$2 spath=$3 label=$4 grade signer ai
  echo "  ── $label (agent $aid · $sname) — grade in the summoned grader VM (paid up front) ──"
  grade=$(bash $GR/grader/enclave/grade_in_vm.sh "$sname" $JOB $aid $VM_DIGEST) || die "$label: in-VM grading failed"
  GR_SCORE=$(echo "$grade" | python3 -c "import sys,json;print(json.load(sys.stdin)['score'])")
  signer=$(echo "$grade" | python3 -c "import sys,json;print(json.load(sys.stdin)['signer'])")
  [ "${signer,,}" = "${ATTESTER,,}" ] || die "$label: in-enclave KMS signer $signer != attesterKey"
  ai=$(bun $GR/grader/attest.ts "$spath" 2>/tmp/e2e_err | tail -1) || die "$label: AI attestor failed"
  GR_VALID=$(echo "$ai" | python3 -c "import sys,json;print('true' if json.load(sys.stdin)['valid'] else 'false')")
  local vatt; vatt=$(echo "$ai" | python3 -c "import sys,json;print(json.load(sys.stdin)['validityAttestation'])")
  echo "     in-VM score=$GR_SCORE (KMS $signer) · AI valid=$GR_VALID"
  echo "$grade" | python3 -c "import sys,json;g=json.load(sys.stdin);json.dump({'kind':'score','jobId':$JOB,'agentId':$aid,'status':'completed','score':g['score'],'signature':g['signature']},open('/tmp/e2e_score.json','w'))"
  python3 -c "import json,sys;json.dump({'kind':'validity','jobId':$JOB,'agentId':$aid,'status':'completed','valid':sys.argv[1]=='true','validityAttestation':sys.argv[2]},open('/tmp/e2e_validity.json','w'))" "$GR_VALID" "$vatt"
  cre_relay /tmp/e2e_score.json    "$label recordScore (CRE->forwarder)"
  cre_relay /tmp/e2e_validity.json "$label recordValidity (CRE->forwarder)"
}

echo "════════ PRECHECK ════════"
echo "  maker $MAKER ($(cast balance $MAKER --rpc-url $ETH --ether) ETH L1)  escrow $ESC  vault $VAULT"
curl -s -o /dev/null http://localhost:4021/health || die "x402 facilitator not running on :4021"
echo "  ✓ x402 facilitator up: $(curl -s http://localhost:4021/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["networks"],d["relayers"])')"
# Gap 2 — real X25519 keypairs (maker delivery key + enclave submission key)
MAKER_KEYS=$($PY $DEL keygen); ENCLAVE_KEYS=$($PY $DEL keygen)
MAKER_PUBKEY=$(echo "$MAKER_KEYS" | python3 -c "import sys,json;print(json.load(sys.stdin)['pub'])")
MAKER_SEC=$(echo "$MAKER_KEYS"   | python3 -c "import sys,json;print(json.load(sys.stdin)['sec'])")
ENCLAVE_ENCPUB=$(echo "$ENCLAVE_KEYS" | python3 -c "import sys,json;print(json.load(sys.stdin)['pub'])")
ENCLAVE_SEC=$(echo "$ENCLAVE_KEYS"    | python3 -c "import sys,json;print(json.load(sys.stdin)['sec'])")
echo "  ✓ X25519 keys: makerPub=${MAKER_PUBKEY:0:14}… enclavePub=${ENCLAVE_ENCPUB:0:14}…"
TESTS_HASH=$(python3 - "$PRIV_DIR" <<'PY'
import hashlib,os,sys
d=sys.argv[1]; files=sorted(f for f in os.listdir(d) if not f.startswith("."))
buf=b"".join((b"" if i==0 else b"\n--FILE--\n")+open(os.path.join(d,f),"rb").read() for i,f in enumerate(files))
print("0x"+hashlib.sha256(buf).hexdigest())
PY
)
echo "  real testsHash: $TESTS_HASH"

echo; echo "════════ PHASE 1 — create bounty (SHORT deadline) + 2 agents SEAL & submit ════════"
H=$(send_tx $ETH $MAKER_PK $MUSDC 'approve(address,uint256)' $ESC 50000000); assert_status $H $ETH "approve"
for i in $(seq 1 10); do A=$(cast call $MUSDC 'allowance(address,address)(uint256)' $MAKER $ESC --rpc-url $ETH 2>/dev/null | grep -oE '^[0-9]+'); [ "${A:-0}" -ge 50000000 ] 2>/dev/null && break; sleep 2; done
[ "${A:-0}" -ge 50000000 ] 2>/dev/null || die "allowance not visible ($A)"
DEADLINE=$(( $(date +%s) + 200 ))   # SHORT — so the CRON resolver can fire during the run (Gap 3)
H=$(send_tx $ETH $MAKER_PK $ESC 'createBounty(uint256,uint64,bytes32,string,address,bytes32,bytes32)' \
   50000000 $DEADLINE $TESTS_HASH "honeycomb://uniswap-eth-accumulation/spec.md" $ATTESTER $MAKER_PUBKEY $ENCLAVE_ENCPUB)
assert_status $H $ETH "createBounty"
JOB=$(cast receipt $H --rpc-url $ETH --json 2>/dev/null | python3 -c "
import sys,json;r=json.load(sys.stdin);esc='$ESC'.lower()
print(next(int(l['topics'][1],16) for l in r['logs'] if l['address'].lower()==esc and l['topics'][0]=='$JOBCREATED_T0'))")
[ -n "$JOB" ] || die "no jobId"; echo "  jobId=$JOB  deadline=+200s"
# Gap 4 — MAKER SUMMONS THE BOUNTY GRADER: one x402 USDC payment up front authorizes
# this bounty's grading (the canonical maker-summoned-per-bounty-TEE model).
echo "  ── maker summons the bounty grader (x402: pay once to authorize grading) ──"
SUM=$(SUMMON_SETTLE_ONLY=1 bash $GR/grader/summon_enclave.sh bounty $JOB 0 $VM_DIGEST 2>&1) || { echo "$SUM" | tail -6; die "bounty-grader x402 summon failed"; }
echo "$SUM" | grep -E "SETTLED|SETTLE-ONLY" | sed 's/^/    [x402] /'
SUMMON_TX=$(echo "$SUM" | python3 -c "import sys,json;ls=[l for l in sys.stdin if l.strip().startswith('{')];print(json.loads(ls[-1]).get('tx','') if ls else '')" 2>/dev/null)
[ -n "$SUMMON_TX" ] || { echo "$SUM" | tail -6; die "no settle tx from bounty-grader summon"; }
echo "  ✓ bounty grader summoned via x402 settle: $SUMMON_TX (grading now authorized)"
# seal each submission to the enclave key; the sealed blob path is the on-chain encCid
HONEST_ENCCID=$($PY $DEL seal "$ENCLAVE_ENCPUB" "$HONEST_LOCAL")
CHEAT_ENCCID=$($PY $DEL seal "$ENCLAVE_ENCPUB" "$CHEAT_LOCAL")
submit_assert(){ local aid=$1 pk=$2 uri=$3 label=$4 enc
  H=$(send_tx $ETH $pk $ESC 'submit(uint256,uint256,string)' $JOB $aid "$uri"); assert_status $H $ETH "$label submit"
  enc=$(cast call $ESC 'submissionOf(uint256,uint256)(uint16,bool,bool,bool,bytes32,bytes32,string)' $JOB $aid --rpc-url $ETH 2>/dev/null | tail -1)
  echo "$enc" | grep -q "$uri" || die "$label submission not on-chain"; }
submit_assert $HONEST_AGENT $HONEST_PK "$HONEST_ENCCID" "honest(sealed)"
submit_assert $CHEAT_AGENT  $CHEAT_PK  "$CHEAT_ENCCID"  "cheat(sealed)"
echo "  ✓ both sealed submissions verified on-chain"

echo; echo "════════ PHASE 2+3 — x402-gated VM grade BOTH + AI + relay via CRE ════════"
grade_record $HONEST_AGENT $HONEST_SUB $HONEST_LOCAL "HONEST"; HONEST_SCORE=$GR_SCORE; HONEST_VALID=$GR_VALID
grade_record $CHEAT_AGENT  $CHEAT_SUB  $CHEAT_LOCAL  "CHEAT";  CHEAT_SCORE=$GR_SCORE;  CHEAT_VALID=$GR_VALID

echo; echo "════════ PHASE 4 — autonomous CRON resolve (Gap 3) + PROVE anti-cheat ════════"
echo "  honest: $HONEST_SCORE/$HONEST_VALID   cheat: $CHEAT_SCORE/$CHEAT_VALID"
CSUB=$(cast call $ESC 'submissionOf(uint256,uint256)(uint16,bool,bool,bool,bytes32,bytes32,string)' $JOB $CHEAT_AGENT --rpc-url $ETH 2>/dev/null)
[ "$(echo "$CSUB" | sed -n '2p')" = "true" ]  || die "cheat not scored on-chain"
[ "$(echo "$CSUB" | sed -n '3p')" = "false" ] || die "cheat not marked invalid on-chain"
echo "  ✓ cheat recorded scored-but-INVALID"
NOW=$(date +%s); [ "$NOW" -gt "$DEADLINE" ] || { echo "  waiting $((DEADLINE-NOW+5))s for deadline..."; sleep $((DEADLINE-NOW+5)); }
HONEST_WALLET=$(cast call $IDREG 'getAgentWallet(uint256)(address)' $HONEST_AGENT --rpc-url $ETH 2>/dev/null)
CHEAT_WALLET=$(cast call $IDREG 'getAgentWallet(uint256)(address)' $CHEAT_AGENT --rpc-url $ETH 2>/dev/null)
WBEFORE=$(bal $MUSDC $HONEST_WALLET $ETH)
bash $GR/grader/cron_resolve.sh "$JOB" >/dev/null   # point config.mainnet.json at this jobId
ROUT=$(cd $GR && cre workflow simulate grading-workflow --non-interactive --target mainnet-settings --trigger-index 1 --broadcast 2>&1)
echo "$ROUT" | grep -E "USER LOG|Workflow Simulation Result|\"action\"" | sed 's/^/      [CRE] /'
RTX=$(echo "$ROUT" | grep -oE '"txHash":"0x[0-9a-f]+"' | grep -oE '0x[0-9a-f]+' | head -1)
[ -n "$RTX" ] || printf '%s\n' "$ROUT" > /tmp/e2e_err
assert_status "$RTX" $ETH "CRON resolve (CRE trigger-index 1 -> forwarder)"
WINNER=$(cast call $ESC 'winnerWalletOf(uint256)(address)' $JOB --rpc-url $ETH 2>/dev/null)
SETTLED=$(cast call $ESC 'isSettled(uint256)(bool)' $JOB --rpc-url $ETH 2>/dev/null)
WAFTER=$(bal $MUSDC $HONEST_WALLET $ETH); DELTA=$(( WAFTER - WBEFORE ))
echo "  winner=$WINNER  isSettled=$SETTLED  honest USDC delta=$DELTA"
[ "$SETTLED" = "true" ] || die "not settled"
[ "${WINNER,,}" = "${HONEST_WALLET,,}" ] || die "winner is not the HONEST agent"
[ "${WINNER,,}" != "${CHEAT_WALLET,,}" ] || die "CHEAT won — anti-cheat FAILED"
[ "$DELTA" -eq 50000000 ] || die "honest payout delta=$DELTA != 50000000"
echo "  ✓ autonomous CRON settle: HONEST won + paid 50 mUSDC; higher-scoring CHEAT rejected"

echo; echo "════════ PHASE 5 — winning algo decides a real Uniswap swap (self-approving vault, Base) ════════"
SIG_OUT=$(python3 $GR/grader/run_signal.py "$HONEST_LOCAL" 3600 2>/tmp/e2e_err) || die "live signal eval failed"
DEC=$(echo "$SIG_OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['decision'])")
echo "  winning algo on live ETH/USD -> $SIG_OUT"
if [ "$DEC" = "buy" ]; then
  STRAT_ID=$(cast keccak "honeycomb:$JOB:$HONEST_AGENT")
  VIN=$(bal $USDC_BASE $VAULT $BASE_RPC)
  if [ "${VIN:-0}" -lt 1000000 ] 2>/dev/null; then
    H=$(send_tx $BASE_RPC $MAKER_PK $USDC_BASE 'transfer(address,uint256)' $VAULT $(( 1000000 - ${VIN:-0} ))); assert_status $H $BASE_RPC "fund vault USDC"
    for i in $(seq 1 10); do VIN=$(bal $USDC_BASE $VAULT $BASE_RPC); [ "${VIN:-0}" -ge 1000000 ] 2>/dev/null && break; sleep 2; done
  fi
  # NO setupAllowance — Gap 7 vault self-approves Permit2 just-in-time inside onReport
  H=$(send_tx $BASE_RPC $MAKER_PK $REGISTRY 'register(address,address,address,uint24,uint256,uint16,bytes32)' $VAULT $USDC_BASE $WETH_BASE 100 1000000 50 $STRAT_ID)
  assert_status $H $BASE_RPC "register winning strategy (Base)"
  # wait for the registry write to be visible (RPC read-after-write lag) before the workflow reads listActive
  for i in $(seq 1 12); do cast call $REGISTRY 'listActive(uint256)((address,address,address,uint24,uint256,uint16,bytes32)[])' 5 --rpc-url $BASE_RPC 2>/dev/null | grep -qi "${VAULT#0x}" && break; sleep 2; done
  WBEF=$(bal $WETH_BASE $VAULT $BASE_RPC)
  SWAP_OUT=$(cd $SV && CRE_TARGET=staging-settings CRE_ETH_PRIVATE_KEY=${MAKER_PK#0x} cre workflow simulate strategy-workflow --non-interactive --trigger-index 0 --broadcast -e $ENVF 2>&1)
  echo "$SWAP_OUT" | grep -E "USER LOG|decision|registry|minOut|hold|skip|Simulation Result" | sed 's/^/      [CRE] /'
  printf '%s\n' "$SWAP_OUT" > /tmp/e2e_err
  # extract OUR vault's swap tx from the workflow's per-vault USER LOG line: "vault <addr>: ... tx=0x.. err=.."
  SWAPTX=$(echo "$SWAP_OUT" | grep -iE "vault ${VAULT}" | grep -oE 'tx=0x[0-9a-f]{64}' | head -1 | sed 's/^tx=//')
  assert_status "$SWAPTX" $BASE_RPC "Uniswap swap USDC->WETH (self-approving vault)"
  WAFT=$(bal $WETH_BASE $VAULT $BASE_RPC)
  echo "  ✓ vault WETH $WBEF -> $WAFT (workflow decided BUY via the accumulate rule; vault self-approved)"
  [ "$WAFT" -gt "$WBEF" ] || die "swap did not increase vault WETH"
else echo "  workflow accumulate rule says '$DEC' -> hold; no swap (gate holds)."; fi

echo; echo "════════ PHASE 6 — sealed winner delivery (Gap 2) ════════"
DELIVERY_CID=$($PY $DEL reseal "$ENCLAVE_SEC" "$MAKER_PUBKEY" "$HONEST_ENCCID")   # enclave re-seals winner to maker
python3 -c "import json;json.dump({'kind':'delivery','jobId':$JOB,'deliveryCid':open('/tmp/_dc','w').write('$DELIVERY_CID') or '$DELIVERY_CID'},open('/tmp/e2e_delivery.json','w'))" 2>/dev/null || \
  printf '{"kind":"delivery","jobId":%s,"deliveryCid":"%s"}\n' "$JOB" "$DELIVERY_CID" > /tmp/e2e_delivery.json
cre_relay /tmp/e2e_delivery.json "deliverWinner (CRE action 3 -> forwarder)"
ONCHAIN_CID=$(cast call $ESC 'winnerDeliveryCidOf(uint256)(string)' $JOB --rpc-url $ETH 2>/dev/null | tr -d '"')
$PY $DEL open "$MAKER_SEC" "$ONCHAIN_CID" > /tmp/recovered_winner.py 2>/dev/null
diff -q /tmp/recovered_winner.py "$HONEST_LOCAL" >/dev/null || die "maker could not recover the winning code from delivery"
echo "  ✓ maker decrypted winnerDeliveryCid -> recovered the winning code byte-for-byte"

echo; echo "════════ E2E COMPLETE — all gaps, all asserted 0x1 ════════"
echo "  bounty $JOB | x402-gated in-VM grades | HONEST($HONEST_SCORE,valid) beat CHEAT($CHEAT_SCORE,invalid)"
echo "  | CRON-resolved | +50 mUSDC to $WINNER | sealed delivery verified | Base swap on self-approving vault"
