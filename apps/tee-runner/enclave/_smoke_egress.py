#!/usr/bin/env python3
# Egress proxy smoke (offline). The proxy's GATE LOGIC is platform-neutral and fully testable
# on the dev box: default-deny, allowlist suffix match, the always-blocked control-plane hosts,
# and post-resolution IP re-checking (DNS pinning). The iptables/netns wiring that FORCES user
# code through this proxy is Linux-only (sandbox.py A3 hooks) and verified in the CS VM.
#
# We test two layers:
#   1. Pure predicate checks on _host_allowed / _ip_allowed / _resolve_and_check (no sockets).
#   2. Live end-to-end: start the proxy, point a real HTTP client at it, assert an allowlisted
#      host tunnels and a denied host gets 403 -- over the real socket, real CONNECT framing.
import os
import socket
import sys
import threading
import time

# Configure the proxy BEFORE importing it (module reads env at import).
os.environ["EGRESS_PROXY_PORT"] = "0"  # we rebind to an ephemeral port ourselves below
os.environ["EGRESS_ALLOWLIST"] = "example.com, httpbin.org"

import egress_proxy as ep


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {detail}")
    if not ok:
        sys.exit(f"FAILED: {name}")


# ---- Layer 1: pure predicate checks (no network) -------------------------------------------
ep.ALLOWLIST = ["example.com", "httpbin.org"]

# allowlist suffix matching
check("exact host allowed", ep._host_allowed("example.com"))
check("subdomain allowed", ep._host_allowed("api.example.com"))
check("sub-subdomain allowed", ep._host_allowed("a.b.example.com"))
check("unrelated host denied", not ep._host_allowed("evil.com"))
check("suffix-spoof denied", not ep._host_allowed("notexample.com"))  # must not match example.com
check("substring-spoof denied", not ep._host_allowed("example.com.evil.com"))

# control-plane hosts ALWAYS blocked, even when explicitly allowlisted alongside them
ep.ALLOWLIST = ["googleapis.com", "metadata.google.internal", "example.com"]
check("googleapis blocked despite allowlist", not ep._host_allowed("storage.googleapis.com"))
check("metadata host blocked despite allowlist", not ep._host_allowed("metadata.google.internal"))
check("bare metadata blocked", not ep._host_allowed("metadata"))
check("google.internal blocked", not ep._host_allowed("foo.google.internal"))
# wildcard "*" allows any normal host but the control-plane block still wins
ep.ALLOWLIST = ["*"]
check("wildcard allows normal host", ep._host_allowed("example.com"))
check("wildcard still blocks googleapis", not ep._host_allowed("storage.googleapis.com"))
check("wildcard still blocks metadata", not ep._host_allowed("metadata"))
ep.ALLOWLIST = ["example.com", "httpbin.org"]

# IP range blocks (the post-DNS re-check) -- metadata IP, RFC1918, loopback, CGNAT
check("metadata IP blocked", not ep._ip_allowed("169.254.169.254"))
check("link-local blocked", not ep._ip_allowed("169.254.0.1"))
check("loopback blocked", not ep._ip_allowed("127.0.0.1"))
check("rfc1918 10/8 blocked", not ep._ip_allowed("10.1.2.3"))
check("rfc1918 172.16/12 blocked", not ep._ip_allowed("172.16.5.5"))
check("rfc1918 192.168 blocked", not ep._ip_allowed("192.168.1.1"))
check("cgnat blocked", not ep._ip_allowed("100.64.0.1"))
check("public IP allowed", ep._ip_allowed("93.184.216.34"))  # example.com's historic IP

# DNS pinning: a name that resolves only into a blocked range is refused. localhost -> 127.0.0.1.
check("localhost resolves into blocked range -> refused", ep._resolve_and_check("localhost") is None)


# ---- Layer 2: live end-to-end over the real socket -----------------------------------------
# Start the proxy on an ephemeral port. We stub getaddrinfo so the test is hermetic (no real DNS
# / no real outbound): allowlisted host -> a loopback echo server we run; the proxy's own IP
# re-check is exercised separately above. Here we prove the CONNECT framing + 403-on-deny path.

# A trivial upstream "server" the proxy will be allowed to reach. We bypass the IP block for THIS
# test by monkeypatching _ip_allowed to accept our loopback test server (the block itself is
# asserted in layer 1). This isolates the framing/tunnel behavior from the IP policy.
upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
upstream.bind(("127.0.0.1", 0))
upstream.listen(1)
up_host, up_port = upstream.getsockname()


def serve_upstream():
    conn, _ = upstream.accept()
    conn.recv(4096)
    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi")
    conn.close()


# Proxy resolves "allowed.test" -> our loopback server, and we allow that IP for this test only.
_real_resolve = ep._resolve_and_check
ep.ALLOWLIST = ["allowed.test"]
ep._resolve_and_check = lambda host: (socket.AF_INET, up_host) if host == "allowed.test" else None
ep._ip_allowed = lambda ip: True  # framing test only; IP policy asserted in layer 1

# Bind the proxy to an ephemeral port.
ep.LISTEN_PORT = 0
psrv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
psrv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
psrv.bind(("127.0.0.1", 0))
psrv.listen(16)
proxy_host, proxy_port = psrv.getsockname()


def proxy_accept_loop():
    while True:
        try:
            c, _ = psrv.accept()
        except OSError:
            return
        threading.Thread(target=ep._handle, args=(c,), daemon=True).start()


threading.Thread(target=proxy_accept_loop, daemon=True).start()


def connect_via_proxy(target_host, target_port):
    """Send a CONNECT to the proxy; return (status_line, sock) -- sock live if 200."""
    s = socket.create_connection((proxy_host, proxy_port), timeout=5)
    s.sendall(f"CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}\r\n\r\n".encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = s.recv(4096)
        if not chunk:
            break
        resp += chunk
    status = resp.split(b"\r\n", 1)[0].decode(errors="replace")
    return status, s, resp


# 2a. Denied host -> 403 (not in allowlist)
status, s, _ = connect_via_proxy("evil.com", 443)
check("CONNECT to denied host -> 403", "403" in status, status)
s.close()

# 2b. Allowed host -> 200 Connection Established, then the tunnel carries bytes to our upstream
threading.Thread(target=serve_upstream, daemon=True).start()
time.sleep(0.1)
status, s, _ = connect_via_proxy("allowed.test", up_port)
check("CONNECT to allowed host -> 200", "200" in status, status)
if "200" in status:
    s.sendall(b"GET / HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n")
    body = b""
    for _ in range(10):
        chunk = s.recv(4096)
        if not chunk:
            break
        body += chunk
    check("tunnel carries upstream response", b"hi" in body, repr(body[-20:]))
    s.close()

# 2c. Restore and prove a real-DNS denied host still 403s through the resolve path
ep._resolve_and_check = _real_resolve
ep.ALLOWLIST = ["example.com"]
status, s, _ = connect_via_proxy("169.254.169.254", 80)
check("CONNECT to metadata IP-as-host -> denied", "403" in status, status)
s.close()

print("\negress proxy smoke: all checks passed.")
