# Execution-grading enclave image (Confidential Space, Stage 2).
# Pinned Python for deterministic scoring across enclave runs (HARNESS_SPEC.md:166).
# Pinned by tag here; pushed to Artifact Registry and consumed BY DIGEST (see deploy.sh).
FROM python:3.12-slim-bookworm

# Confidential Space runs the image's entrypoint as the workload. Keep it minimal.
# google-cloud-kms: in-enclave signing via the VM's attested service account.
# eth-keys:         secp256k1 pubkey -> ETH address + ecrecover for the recovery id.
RUN pip install --no-cache-dir \
    google-cloud-kms==2.* \
    eth-keys==0.5.* \
    "eth-hash[pycryptodome]"

WORKDIR /grader

# Trusted grading code + the private series, baked into the image. The series is
# confidential: the image is private in Artifact Registry and (Stage 3) the KMS key
# release is gated on the attested image digest, so only this exact image can grade.
COPY scorer.py worker.py kms_sign.py enclave_grade.py ./
COPY prices_private.json ./prices_private.json
# Sample submissions baked in so the single-shot enclave can grade one by name
# (Confidential Space VMs take container ARGS via metadata, not file uploads).
COPY submissions/ ./submissions/

# scorer.py reads the baked series from here, not the maker/ dev path.
ENV PRIVATE_SERIES=/grader/prices_private.json
ENV PYTHONDONTWRITEBYTECODE=1

# The Confidential Space launcher passes the submission + args. Default ENTRYPOINT runs
# the grade; the launcher's cmd overrides ARGS with the real submission path.
ENTRYPOINT ["python3", "enclave_grade.py"]
