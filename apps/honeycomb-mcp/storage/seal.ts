// ============================================================================
// seal.ts — NaCl sealed-box encryption for submissions, via deliver.py.
//
// A submission is sealed to the job's enclaveEncPub (an X25519 pubkey, bytes32
// hex) so ONLY the grading enclave can open it. We deliberately shell out to
// apps/grading-cre/grader/deliver.py `seal` rather than re-implement crypto_box_
// seal in TS: the enclave opens the blob with the SAME deliver.py `open`, so a
// byte-for-byte identical sealed-box framing is guaranteed (no libsodium-vs-
// tweetnacl drift). PyNaCl is already installed in deliver.py's .venv.
//
// Flow (Leg 1 of the two-leg encrypted delivery):
//   agent submission (plaintext) --seal--> enclaveEncPub  => sealed bytes => encCid
// The enclave later opens encCid with its secret, grades, and re-seals the
// winner to the maker (Leg 2, deliver.py `reseal`).
//
// Loud-failure rule: a missing .venv / deliver.py, or a non-zero seal exit,
// THROWS. We never return a half-sealed or empty blob.
// ============================================================================

import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deliver.py + the venv that has PyNaCl, resolved relative to this file
// (apps/honeycomb-mcp/storage -> apps/grading-cre/grader).
const GRADER_DIR = join(import.meta.dir, "..", "..", "grading-cre", "grader");
const DELIVER_PY = join(GRADER_DIR, "deliver.py");
// Prefer the grader's own venv python (has PyNaCl); override with DELIVER_PYTHON.
const VENV_PY = join(GRADER_DIR, ".venv", "bin", "python3");

function pythonBin(): string {
	const override = process.env.DELIVER_PYTHON;
	if (override) return override;
	if (existsSync(VENV_PY)) return VENV_PY;
	// No venv — fall through to a bare python3 and let the import error surface
	// loudly (deliver.py will fail on `import nacl` if PyNaCl isn't present).
	return "python3";
}

/**
 * Seal `plaintext` to an X25519 public key (`pubKeyHex32`, 0x-prefixed bytes32),
 * returning the sealed-box ciphertext bytes. The ciphertext is what gets uploaded
 * to the submissions bucket; its gcs:// URI becomes the on-chain encCid.
 *
 * Implemented by shelling out to `deliver.py seal <pub> <plaintextFile> --out <f>`,
 * which writes the blob to <f> and prints the path. We read the blob back and
 * return its raw bytes.
 */
export async function sealToPub(plaintext: string | Uint8Array, pubKeyHex32: string): Promise<Uint8Array> {
	if (!existsSync(DELIVER_PY)) {
		throw new Error(`deliver.py not found at ${DELIVER_PY} — cannot seal the submission`);
	}
	const pub = pubKeyHex32.trim();
	// deliver.py validates the 32-byte length, but a placeholder all-2222 key (the
	// chain.ts default until a real enclave key is summoned) would seal to a key
	// nobody holds the secret for — catch it here with a clearer message.
	if (!/^0x[0-9a-fA-F]{64}$/.test(pub)) {
		throw new Error(`enclaveEncPub must be 0x-prefixed bytes32 hex, got: ${pub.slice(0, 16)}...`);
	}

	const dir = mkdtempSync(join(tmpdir(), "honeycomb-seal-"));
	const ptFile = join(dir, "plaintext");
	const outFile = join(dir, "sealed.blob");
	try {
		const bytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
		writeFileSync(ptFile, bytes);

		const proc = Bun.spawn([pythonBin(), DELIVER_PY, "seal", pub, ptFile, "--out", outFile], {
			cwd: GRADER_DIR,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) {
			throw new Error(`deliver.py seal failed [exit ${code}]: ${stderr.trim().slice(0, 500)}`);
		}
		if (!existsSync(outFile)) {
			throw new Error(`deliver.py seal reported success but wrote no blob to ${outFile}`);
		}
		return new Uint8Array(readFileSync(outFile));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
