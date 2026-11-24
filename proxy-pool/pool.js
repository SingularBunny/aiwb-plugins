// Proxy pool core: the proxybroker2 list, the tunnel check, the pool and the local proxy.
// No OpenClaw imports here, so the tests run it with plain node.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

/** `proxybroker grab` lines (`<Proxy US 0.00s [] 1.2.3.4:8080>`) → [{host, port, country}]. */
export function parseGrabOutput(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split("\n")) {
    const match = /^<Proxy\s+(\S+)\s.*?\s(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})>\s*$/.exec(line.trim());
    if (!match) continue;
    const key = `${match[2]}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: match[2], port: Number(match[3]), country: match[1] === "--" ? "" : match[1].toUpperCase() });
  }
  return out;
}

/** Raw candidates from proxybroker2 (`python -m proxybroker grab`); the check is ours. */
export function grabProxies({ python, cwd, limit = 400, timeoutMs = 240_000, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/_proxy$/i.test(key)) delete env[key];
    const child = spawn(python, ["-m", "proxybroker", "grab", "--limit", String(limit)], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("stopped"));
      const list = parseGrabOutput(stdout);
      if (list.length || code === 0) resolve(list);
      else reject(new Error(`proxybroker grab exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
    });
  });
}

/** Opens a CONNECT tunnel to host:port through the proxy (`auth`: optional `user:password`); resolves the socket. */
export function openTunnel(proxy, host, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const fail = (error) => { socket.destroy(); reject(error); };
    socket.setTimeout(timeoutMs, () => fail(new Error("timeout")));
    socket.once("error", fail);
    // A proxy that closes without answering would otherwise leave the promise pending for ever.
    const closed = () => fail(new Error("closed by the proxy"));
    socket.once("close", closed);
    socket.once("connect", () => {
      const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192) fail(new Error("bad proxy reply"));
        return;
      }
      socket.off("data", onData);
      socket.off("close", closed);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"))?.[1]);
      if (status !== 200) return fail(new Error(`proxy answered ${status || "garbage"}`));
      socket.setTimeout(0);
      socket.off("error", fail);
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

/**
 * Checks one proxy against an HTTPS URL: a CONNECT tunnel, TLS with certificate verification, and a
 * HEAD request. Good when the answer's status is not one of `blocked` (451 is a block by country).
 */
export async function checkProxy(proxy, { url, blocked = [451], timeoutMs = 10_000, signal }) {
  const target = new URL(url);
  const started = Date.now();
  let socket;
  let secure;
  // A hard limit on the whole check: some free proxies accept and then trickle or stall.
  let deadline;
  let onAbort;
  const expired = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("timeout")), timeoutMs * 2.5);
    onAbort = () => reject(new Error("stopped"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([expired, (async () => {
    socket = await openTunnel(proxy, target.hostname, Number(target.port) || 443, timeoutMs);
    const status = await new Promise((resolve, reject) => {
      secure = tls.connect({ socket, servername: target.hostname });
      secure.setTimeout(timeoutMs, () => { secure.destroy(); reject(new Error("timeout")); });
      secure.once("error", reject);
      secure.once("close", () => reject(new Error("closed before an answer")));
      secure.once("secureConnect", () => {
        secure.write(`HEAD ${target.pathname || "/"} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: aiwb-proxy-pool\r\nConnection: close\r\n\r\n`);
      });
      let head = "";
      secure.on("data", (chunk) => {
        head += chunk.toString("latin1");
        const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
        if (match) { resolve(Number(match[1])); secure.destroy(); }
        else if (head.length > 8192) { reject(new Error("bad reply")); secure.destroy(); }
      });
    });
    const ms = Date.now() - started;
    return blocked.includes(status) ? { ok: false, status, ms, error: `blocked (${status})` } : { ok: true, status, ms };
    })()]);
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message || error) };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    secure?.destroy();
    socket?.destroy();
  }
}

/** Runs `work` over `items` with at most `limit` at once; results in input order. */
export async function mapLimit(items, limit, work, signal) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

/**
 * The pool of checked proxies. A proxy leaves it after `maxFailures` failed connections in a row
 * (own threshold, set before any run: one failure is too often a free proxy's hiccup, three keep a
 * dead one too long). Picks rotate over the fastest half.
 */
export function createPool({ file, maxFailures = 2, now = Date.now } = {}) {
  let entries = [];
  let cursor = 0;
  const state = { refreshedAt: 0, lastError: "" };
  const key = (proxy) => `${proxy.host}:${proxy.port}`;
  const save = async () => {
    if (!file) return;
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...state, entries }, null, 1));
    await rename(tmp, file);
  };
  return {
    async load() {
      if (!file) return;
      try {
        const data = JSON.parse(await readFile(file, "utf8"));
        entries = Array.isArray(data.entries) ? data.entries.filter((entry) => entry?.host && entry?.port) : [];
        state.refreshedAt = Number(data.refreshedAt) || 0;
        state.lastError = String(data.lastError || "");
      } catch { /* first start */ }
    },
    save,
    list: () => entries.map((entry) => ({ ...entry })),
    size: () => entries.length,
    state: () => ({ ...state }),
    /** Replaces the pool with freshly checked proxies, fastest first. */
    replace(checked, { error = "" } = {}) {
      entries = checked.map((entry) => ({ ...entry, failures: 0 })).sort((a, b) => a.ms - b.ms);
      cursor = 0;
      state.refreshedAt = now();
      state.lastError = error;
    },
    note(error) { state.lastError = error; },
    /** The next proxy to use, skipping `exclude` (keys tried in this connection). */
    pick(exclude = new Set()) {
      const usable = entries.filter((entry) => !exclude.has(key(entry)));
      if (!usable.length) return null;
      const best = usable.slice(0, Math.max(1, Math.ceil(usable.length / 2)));
      const choice = best[cursor++ % best.length];
      return choice;
    },
    /** Records a connection's outcome; a proxy that failed `maxFailures` times in a row is dropped. */
    report(proxy, ok) {
      const entry = entries.find((candidate) => key(candidate) === key(proxy));
      if (!entry) return;
      if (ok) {
        entry.failures = 0;
        entry.usedAt = now();
        return;
      }
      entry.failures = (entry.failures || 0) + 1;
      if (entry.failures >= maxFailures) entries = entries.filter((candidate) => candidate !== entry);
    },
    key,
  };
}

/** The user name of the local proxy's password (Basic auth); the password is the secret file's content. */
export const PROXY_USER = "aiwb";

/** The local proxy's password from `file`, written (mode 600) with a random one when missing. */
export async function loadOrCreateSecret(file) {
  try {
    const secret = (await readFile(file, "utf8")).trim();
    if (secret) return secret;
  } catch { /* first use */ }
  const secret = randomBytes(24).toString("base64url");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${secret}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  return secret;
}

/** Whether a `Proxy-Authorization` header carries `PROXY_USER`:`secret` (no secret: anyone may connect). */
export function proxyAuthorized(header, secret) {
  if (!secret) return true;
  const match = /^Basic\s+(\S+)$/i.exec(String(header ?? "").trim());
  if (!match) return false;
  const given = Buffer.from(match[1], "base64");
  const expected = Buffer.from(`${PROXY_USER}:${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const AUTH_REALM = 'Basic realm="aiwb-proxy-pool"';

/**
 * The local proxy: CONNECT (HTTPS) and plain HTTP requests go through a pool proxy; a proxy that
 * cannot open the tunnel is reported and the next one is tried, up to `attempts`. With `secret()`
 * returning a password, a request without it gets 407 (off by default: the plugin's `requireAuth`).
 */
export function createLocalProxy({ pool, attempts = 3, timeoutMs = 10_000, logger, secret = () => "" }) {
  const server = http.createServer((req, res) => {
    if (!proxyAuthorized(req.headers["proxy-authorization"], secret())) {
      res.writeHead(407, { "Proxy-Authenticate": AUTH_REALM, "Content-Type": "text/plain" });
      res.end("proxy password required\n");
      return;
    }
    // Our password is for us only; the free proxy never sees it.
    delete req.headers["proxy-authorization"];
    // Plain HTTP through an upstream HTTP proxy: the absolute URI is passed on as is.
    const proxy = pool.pick();
    if (!proxy || !/^http:\/\//i.test(req.url ?? "")) {
      res.writeHead(proxy ? 400 : 502, { "Content-Type": "text/plain" });
      res.end(proxy ? "only absolute http:// URLs or CONNECT\n" : "proxy pool is empty\n");
      return;
    }
    const upstream = http.request({ host: proxy.host, port: proxy.port, method: req.method, path: req.url, headers: req.headers, timeout: timeoutMs });
    upstream.on("response", (answer) => {
      pool.report(proxy, true);
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      pool.report(proxy, false);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream proxy failed\n");
    });
    req.pipe(upstream);
  });
  // Open client sockets and their tunnels, so that close() ends them instead of waiting: the Gateway
  // stops the service on a plugin reload and gives it only a short time.
  const open = new Set();
  server.on("connection", (socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    close(callback);
    for (const socket of open) socket.destroy();
    server.closeAllConnections?.();
    return server;
  };
  server.on("connect", async (req, client, head) => {
    const [host, portText] = String(req.url ?? "").split(/:(?=\d+$)/);
    const port = Number(portText) || 443;
    const tried = new Set();
    client.on("error", () => {});
    if (!proxyAuthorized(req.headers["proxy-authorization"], secret())) {
      client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${AUTH_REALM}\r\n\r\n`);
      return;
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const proxy = pool.pick(tried);
      if (!proxy) break;
      tried.add(pool.key(proxy));
      try {
        const upstream = await openTunnel(proxy, host, port, timeoutMs);
        pool.report(proxy, true);
        if (client.destroyed) { upstream.destroy(); return; }
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        upstream.pipe(client);
        client.pipe(upstream);
        return;
      } catch (error) {
        pool.report(proxy, false);
        logger?.debug?.(`aiwb-proxy-pool: ${pool.key(proxy)} failed for ${host}: ${error?.message || error}`);
      }
    }
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  return server;
}
