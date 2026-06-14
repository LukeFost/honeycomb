#!/usr/bin/env python3
# Default-deny egress proxy (P0-4). The user-code process gets network access ONLY through
# this proxy; everything else is firewalled off (Linux: iptables owner-match on the user-code
# uid drops all direct egress except to this proxy's port -- see sandbox.py's A3 hooks).
#
# The proxy is the single chokepoint that decides what the internet-facing user code may reach.
# It is default-DENY: a host must match the allowlist or the request is refused. It blocks the
# kill-chain endpoints explicitly even if somehow allowlisted:
#   - 169.254.169.254 and the whole link-local 169.254.0.0/16 (GCP/AWS metadata server),
#   - *.googleapis.com / *.google.internal (the SA-token + KMS control plane),
#   - RFC1918 + loopback + CGNAT internal ranges (no lateral movement to enclave-internal svcs).
# Allowed hosts are resolved and the resolved IP is re-checked against the deny ranges (DNS
# rebinding / pinning): an allowlisted name that resolves into a blocked range is refused.
#
# Supports both:
#   - HTTP forward proxy (plain GET/POST with absolute-form request line), and
#   - HTTPS via CONNECT tunneling (we never see plaintext; we gate on the CONNECT host:port).
# So `HTTPS_PROXY=http://127.0.0.1:8080 curl https://example.com` works and is gated by host.
import ipaddress
import os
import re
import select
import socket
import sys
import threading

LISTEN_HOST = os.environ.get("EGRESS_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("EGRESS_PROXY_PORT", "8080"))

# Allowlist: comma-separated host suffixes the user code may reach. A host matches if it equals
# an entry or ends with "." + entry (so "api.example.com" matches "example.com"). Empty default
# = deny everything; the daemon sets EGRESS_ALLOWLIST per the product's needs. "*" allows any
# host EXCEPT the always-blocked ranges below (use only when the product wants open egress).
ALLOWLIST = [h.strip().lower() for h in os.environ.get("EGRESS_ALLOWLIST", "").split(",") if h.strip()]

# Always-blocked IP ranges -- checked AFTER DNS resolution so a name can't smuggle past them.
_BLOCKED_NETS = [
    ipaddress.ip_network("169.254.0.0/16"),   # link-local: cloud metadata server
    ipaddress.ip_network("127.0.0.0/8"),      # loopback: enclave-internal services (sidecar)
    ipaddress.ip_network("10.0.0.0/8"),       # RFC1918
    ipaddress.ip_network("172.16.0.0/12"),    # RFC1918
    ipaddress.ip_network("192.168.0.0/16"),   # RFC1918
    ipaddress.ip_network("100.64.0.0/10"),    # CGNAT
    ipaddress.ip_network("::1/128"),          # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),         # IPv6 ULA
    ipaddress.ip_network("fe80::/10"),        # IPv6 link-local
]

# Hostnames always blocked regardless of allowlist (the control plane that issues SA tokens / KMS).
_BLOCKED_HOST_SUFFIXES = ("googleapis.com", "google.internal", "metadata.google.internal", "metadata")


def _host_allowed(host: str) -> bool:
    h = host.lower().rstrip(".")
    if any(h == s or h.endswith("." + s) or h == "metadata" for s in _BLOCKED_HOST_SUFFIXES):
        return False
    if ALLOWLIST == ["*"]:
        return True
    return any(h == a or h.endswith("." + a) for a in ALLOWLIST)


def _ip_allowed(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return not any(ip in net for net in _BLOCKED_NETS)


def _resolve_and_check(host: str):
    """Resolve host, return a safe (family, sockaddr) whose IP is NOT in a blocked range, or
    None if the name doesn't resolve or every resolved IP is blocked (DNS-pinning defense)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return None
    for family, _type, _proto, _canon, sockaddr in infos:
        if _ip_allowed(sockaddr[0]):
            return family, sockaddr[0]
    return None


def _refuse(conn, code, msg):
    conn.sendall(f"HTTP/1.1 {code} {msg}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
    conn.close()


def _pump(a, b):
    """Bidirectional byte pump until either side closes (for CONNECT tunnels)."""
    socks = [a, b]
    try:
        while True:
            r, _, _ = select.select(socks, [], [], 60)
            if not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        return
    finally:
        for s in (a, b):
            try:
                s.close()
            except OSError:
                pass


_CONNECT_RE = re.compile(rb"^CONNECT\s+([^\s:]+):(\d+)\s+HTTP/1\.[01]", re.I)
_ABSFORM_RE = re.compile(rb"^(GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS)\s+http://([^/\s:]+)(:(\d+))?(/[^\s]*)?\s+HTTP/1\.[01]", re.I)


def _handle(conn):
    conn.settimeout(30)
    try:
        head = b""
        while b"\r\n" not in head and len(head) < 8192:
            chunk = conn.recv(4096)
            if not chunk:
                conn.close()
                return
            head += chunk

        m = _CONNECT_RE.match(head)
        if m:  # HTTPS tunnel: gate on host:port, then blind-pipe TLS
            host = m.group(1).decode()
            port = int(m.group(2))
            if not _host_allowed(host):
                return _refuse(conn, 403, "Egress Denied (host)")
            checked = _resolve_and_check(host)
            if not checked:
                return _refuse(conn, 403, "Egress Denied (resolved-ip)")
            family, ip = checked
            try:
                upstream = socket.create_connection((ip, port), timeout=15)
            except OSError:
                return _refuse(conn, 502, "Upstream Unreachable")
            conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            _pump(conn, upstream)
            return

        m = _ABSFORM_RE.match(head)
        if m:  # plain HTTP forward proxy
            host = m.group(2).decode()
            port = int(m.group(4)) if m.group(4) else 80
            if not _host_allowed(host):
                return _refuse(conn, 403, "Egress Denied (host)")
            checked = _resolve_and_check(host)
            if not checked:
                return _refuse(conn, 403, "Egress Denied (resolved-ip)")
            family, ip = checked
            try:
                upstream = socket.create_connection((ip, port), timeout=15)
            except OSError:
                return _refuse(conn, 502, "Upstream Unreachable")
            # Rewrite absolute-form to origin-form is unnecessary for most servers; forward as-is.
            upstream.sendall(head)
            _pump(conn, upstream)
            return

        return _refuse(conn, 400, "Bad Proxy Request")
    except (OSError, socket.timeout):
        try:
            conn.close()
        except OSError:
            pass


def serve():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(64)
    print(
        f"[egress_proxy] listening {LISTEN_HOST}:{LISTEN_PORT}  allowlist={ALLOWLIST or 'DENY-ALL'}",
        file=sys.stderr, flush=True,
    )
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    serve()
