# "Summon a TEE" warm runner image (Confidential Space). A long-lived HTTP daemon that runs the
# buyer's arbitrary Python in a hardened child and returns the run output bundled with the proof
# it ran in this exact image inside a real TEE (attestation JWT + KMS signature).
#
# Differs from the single-shot grading enclave: no baked private data, the entrypoint is the warm
# daemon (enclave_server.py) not a one-shot grade, and the image carries the P0 confinement +
# proof code (sandbox / signer sidecar / egress proxy / attestation / proof).
FROM python:3.12-slim-bookworm

# iptables: the egress firewall (P0-4 proxy mode) is installed by the daemon at startup via the
# iptables CLI. procps/iproute2 are handy for in-VM debugging during bring-up. Kept minimal.
RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables iproute2 procps \
    && rm -rf /var/lib/apt/lists/*

# Runtime deps:
#   google-cloud-kms: in-enclave signing via the VM's attested service account (sidecar only).
#   eth-keys:         secp256k1 pubkey -> ETH address + recovery id for the bundle signature.
#   eth-hash:         keccak256 for the proof digest preimage.
RUN pip install --no-cache-dir \
    google-cloud-kms==2.* \
    eth-keys==0.5.* \
    "eth-hash[pycryptodome]"

WORKDIR /enclave

# Trusted parent + the confinement/proof modules. NO private data is baked in (the old enclave's
# prices_private.json was both irrelevant here and the original leak). The image is the proof
# subject: the buyer checks the attested image digest, so the contents must be exactly this.
COPY runner.py code_worker.py sandbox.py egress_proxy.py \
     signer_sidecar.py kms_sign.py attestation.py proof.py enclave_server.py ./

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# Network ON behind the default-deny egress proxy (A3). The daemon brings the proxy + firewall up
# at startup. Override to "block" to run fully network-isolated.
ENV EGRESS_MODE=proxy
ENV ENCLAVE_PORT=8000

# Confidential Space forbids the operator from overriding CMD via tee-cmd unless the image opts
# in. The daemon takes no per-run args (requests arrive over HTTP), but we keep the label so the
# operator can pass daemon-level flags (e.g. EGRESS_MODE) via tee-cmd/tee-env without rebuilding.
LABEL "tee.launch_policy.allow_cmd_override"="true"

# The warm daemon is the entrypoint. It blocks serving until the trust boundary is up (sidecar,
# proxy, firewall) and refuses to serve unconfined in the enclave.
ENTRYPOINT ["python3", "enclave_server.py"]
