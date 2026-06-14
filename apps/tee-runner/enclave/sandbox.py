#!/usr/bin/env python3
# OS confinement for the user-code process (P0-1 metadata block, P0-3 UID-drop, P0-4 egress).
#
# These are the cuts that make "arbitrary code + network" safe to expose. They are
# Linux-and-root operations (setgid/setuid, unshare a network namespace, iptables owner-match)
# and only take effect inside the Confidential Space VM, where the workload runs as root on
# Linux. On a dev laptop (macOS, or non-root Linux) they CANNOT be applied -- and per the
# project's error-handling rule we surface that loudly instead of silently pretending the
# sandbox is on.
#
# Two EGRESS_MODE postures, selected by env (default "block"):
#   "block" (A2): child runs in a fresh EMPTY network namespace -- loopback only, nothing
#                 routable, so 169.254.169.254 and the whole internet are simply unreachable.
#   "proxy" (A3): child stays in the default netns (real network) but the KERNEL firewalls its
#                 uid: iptables OUTPUT owner-match DROPs every packet from the child's uid except
#                 to the egress proxy's localhost port (and loopback). So even if user code
#                 ignores HTTP(S)_PROXY and dials an IP directly, the packet is dropped -- the
#                 proxy is the ONLY way out, and the proxy is default-deny + control-plane-blocked
#                 (egress_proxy.py). This is what severs the metadata/KMS kill-chain with network on.
#
# Confinement is applied in the child via preexec_fn (runs after fork, before exec) for the
# parts that must be per-process (netns unshare, setuid). The iptables rule for "proxy" mode is
# installed ONCE by the trusted parent at startup (install_egress_firewall), keyed on the fixed
# unprivileged uid -- not in preexec, because iptables needs CAP_NET_ADMIN which we drop at setuid.
#
# `confinement_status()` reports what is actually enforceable here so callers/log can be honest.
import ctypes
import ctypes.util
import os
import platform
import pwd
import subprocess
import sys

# CLONE_NEWNET: unshare(2) flag to get a fresh, empty network namespace (loopback only).
CLONE_NEWNET = 0x40000000

UNPRIVILEGED_USER = os.environ.get("SANDBOX_USER", "nobody")

# Egress posture: "block" = empty netns (A2, no network); "proxy" = network on, kernel-forced
# through the egress proxy (A3). The daemon sets "proxy" once the proxy is up; default is the
# safe "block".
EGRESS_MODE = os.environ.get("EGRESS_MODE", "block").lower()

# Where the egress proxy listens (proxy mode). The child's uid may only reach this host:port.
EGRESS_PROXY_HOST = os.environ.get("EGRESS_PROXY_HOST", "127.0.0.1")
EGRESS_PROXY_PORT = int(os.environ.get("EGRESS_PROXY_PORT", "8080"))

# Set SANDBOX_ALLOW_UNSAFE=1 ONLY on a dev box to allow running without confinement (the run
# still works, but with a loud warning). In the enclave this must be unset so a missing
# capability is a hard failure, not a silent hole.
ALLOW_UNSAFE = os.environ.get("SANDBOX_ALLOW_UNSAFE") == "1"


def confinement_status() -> dict:
    """What confinement can actually be applied in this environment, without applying it."""
    is_linux = platform.system() == "Linux"
    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    user_ok = True
    try:
        pwd.getpwnam(UNPRIVILEGED_USER)
    except KeyError:
        user_ok = False
    return {
        "platform": platform.system(),
        "uidDrop": is_linux and is_root and user_ok,
        "metadataBlock": is_linux and is_root,
        "reason": _reason(is_linux, is_root, user_ok),
    }


def _reason(is_linux, is_root, user_ok) -> str:
    if not is_linux:
        return f"not Linux ({platform.system()}): setuid/netns unavailable; enclave-only"
    if not is_root:
        return "not root: cannot setuid or unshare netns"
    if not user_ok:
        return f"user {UNPRIVILEGED_USER!r} not present"
    return "ok: uid-drop + metadata-block enforceable"


def _unshare_netns() -> None:
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    if libc.unshare(CLONE_NEWNET) != 0:
        err = ctypes.get_errno()
        raise OSError(err, f"unshare(CLONE_NEWNET) failed: {os.strerror(err)}")
    # The fresh netns has loopback DOWN and nothing routable. In "block" mode that IS the
    # posture: no network at all, so the metadata server is unreachable. (A "proxy"-mode child
    # does NOT unshare -- it stays in the default netns and the iptables uid rule governs it.)


def install_egress_firewall(uid: int) -> None:
    """A3 "proxy" mode, parent-side, run ONCE at daemon startup. Install iptables OUTPUT rules
    that DROP every packet originating from the user-code `uid` except (a) loopback and (b) the
    egress proxy's host:port. The kernel enforces this regardless of what the user code does:
    ignoring HTTP(S)_PROXY and dialing 169.254.169.254 (or any IP) directly is dropped. iptables
    needs CAP_NET_ADMIN, held by the root parent and lost once the child setuids -- so the parent
    installs it, not the preexec. Idempotent: rules are flushed from a dedicated chain first."""
    if EGRESS_MODE != "proxy":
        return
    status = confinement_status()
    if not status["uidDrop"]:
        if ALLOW_UNSAFE:
            print(
                f"[sandbox] WARNING: egress firewall NOT installed ({status['reason']}). "
                f"proxy-mode egress is UNENFORCED because SANDBOX_ALLOW_UNSAFE=1. Dev only.",
                file=sys.stderr, flush=True,
            )
            return
        raise RuntimeError(
            f"[sandbox] REFUSING proxy-mode egress without a kernel firewall: {status['reason']}."
        )

    chain = "TEE_EGRESS"
    proxy = (EGRESS_PROXY_HOST, str(EGRESS_PROXY_PORT))
    # Build the chain from scratch so re-running the daemon doesn't stack duplicate rules.
    cmds = [
        # (Re)create a dedicated chain and clear it.
        ["iptables", "-N", chain],            # may fail if it exists -> ignored below
        ["iptables", "-F", chain],
        # Jump all OUTPUT from the sandbox uid into our chain.
        ["iptables", "-D", "OUTPUT", "-m", "owner", "--uid-owner", str(uid), "-j", chain],  # de-dup
        ["iptables", "-A", "OUTPUT", "-m", "owner", "--uid-owner", str(uid), "-j", chain],
        # In the chain: allow loopback (the proxy + any 127.0.0.1 the program legitimately uses,
        # though the proxy itself blocks loopback DESTINATIONS at the app layer), allow the proxy
        # host:port, DROP everything else from this uid.
        ["iptables", "-A", chain, "-o", "lo", "-j", "ACCEPT"],
        ["iptables", "-A", chain, "-p", "tcp", "-d", proxy[0], "--dport", proxy[1], "-j", "ACCEPT"],
        # Allow DNS so the proxy env-respecting clients can resolve names they then route via the
        # proxy. (The proxy re-resolves and re-checks itself; this only lets the child's resolver
        # work. UDP/53 + TCP/53.) If you want zero direct DNS, drop these two and run a resolver
        # in the proxy -- out of scope for the hackathon.
        ["iptables", "-A", chain, "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
        ["iptables", "-A", chain, "-p", "tcp", "--dport", "53", "-j", "ACCEPT"],
        ["iptables", "-A", chain, "-j", "DROP"],
    ]
    for c in cmds:
        # -N (create) and the pre-emptive -D (delete-for-dedup) are allowed to fail; the rest
        # must succeed or egress is not actually confined -> raise loudly.
        allow_fail = c[1] in ("-N", "-D")
        res = subprocess.run(c, capture_output=True, text=True)
        if res.returncode != 0 and not allow_fail:
            raise RuntimeError(f"[sandbox] iptables failed: {' '.join(c)} -> {res.stderr.strip()}")
    print(
        f"[sandbox] egress firewall installed: uid {uid} may reach only "
        f"{proxy[0]}:{proxy[1]} (+ DNS); all other egress DROPPED.",
        file=sys.stderr, flush=True,
    )


def child_proxy_env() -> dict:
    """The HTTP(S)_PROXY env the user-code child should inherit in proxy mode so well-behaved
    clients route through the proxy automatically. (Misbehaving clients are still kernel-blocked
    by install_egress_firewall -- this is convenience, not the security boundary.)"""
    if EGRESS_MODE != "proxy":
        return {}
    url = f"http://{EGRESS_PROXY_HOST}:{EGRESS_PROXY_PORT}"
    return {
        "HTTP_PROXY": url, "http_proxy": url,
        "HTTPS_PROXY": url, "https_proxy": url,
        # Never proxy loopback (lets a program talk to 127.0.0.1 directly without looping the
        # proxy); the firewall still blocks any non-allowlisted destination.
        "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
    }


def make_preexec():
    """Return a preexec_fn that confines the child, or None if confinement is impossible and
    SANDBOX_ALLOW_UNSAFE permits running anyway. Raises if confinement is required but absent."""
    status = confinement_status()
    if not (status["uidDrop"] and status["metadataBlock"]):
        if ALLOW_UNSAFE:
            print(
                f"[sandbox] WARNING: confinement NOT applied ({status['reason']}). "
                f"Running UNSANDBOXED because SANDBOX_ALLOW_UNSAFE=1. Dev only -- never in the enclave.",
                file=sys.stderr,
                flush=True,
            )
            return None
        # Loud, hard failure: do not run untrusted code without the cuts the design depends on.
        raise RuntimeError(
            f"[sandbox] REFUSING to run user code unconfined: {status['reason']}. "
            f"Set SANDBOX_ALLOW_UNSAFE=1 on a dev box to override (the enclave must never set it)."
        )

    pw = pwd.getpwnam(UNPRIVILEGED_USER)
    uid, gid = pw.pw_uid, pw.pw_gid

    def preexec():
        # P0-1 metadata block. In "block" mode: unshare an empty netns (no network at all) BEFORE
        # dropping privileges (unshare needs CAP_SYS_ADMIN, lost after setuid). In "proxy" mode we
        # do NOT unshare -- the child must keep the default netns so the parent's iptables uid rule
        # applies; the metadata server is blocked there by that DROP rule, not by namespace removal.
        if EGRESS_MODE != "proxy":
            _unshare_netns()
        # P0-3: drop group then user. Order matters: setgid must precede setuid (after setuid we
        # no longer have the privilege to change gid). initgroups clears supplementary groups.
        os.setgid(gid)
        os.initgroups(UNPRIVILEGED_USER, gid)
        os.setuid(uid)
        # Defense in depth: a new session + umask so the child can't signal the parent group or
        # create group/other-readable files.
        os.setsid()
        os.umask(0o077)

    return preexec


if __name__ == "__main__":
    import json

    print(json.dumps(confinement_status(), indent=2))
