import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { poolRows } from "../proxy-pool/dist/control-ui/proxy-pool.js";
import { checkProxy, createLocalProxy, createPool, loadOrCreateSecret, openTunnel, parseGrabOutput, PROXY_USER } from "../proxy-pool/pool.js";
import { DEFAULTS, refreshPool, resolveSettings } from "../proxy-pool/settings.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

/** A minimal upstream HTTP proxy that tunnels CONNECT to the asked host:port. */
function fakeUpstream() {
  const server = http.createServer((_req, res) => res.end());
  server.on("connect", (req, client, head) => {
    const [host, port] = req.url.split(":");
    const target = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) target.write(head);
      target.pipe(client);
      client.pipe(target);
    });
    target.on("error", () => client.destroy());
  });
  return server;
}

test("proxy pool: parses proxybroker grab output, without duplicates", () => {
  const text = [
    "<Proxy US 0.00s [] 1.2.3.4:8080>",
    "<Proxy -- 0.00s [] 5.6.7.8:3128>",
    "<Proxy US 0.00s [] 1.2.3.4:8080>",
    "noise",
  ].join("\n");
  assert.deepEqual(parseGrabOutput(text), [
    { host: "1.2.3.4", port: 8080, country: "US" },
    { host: "5.6.7.8", port: 3128, country: "" },
  ]);
});

test("proxy pool: settings fall back to defaults on invalid values", () => {
  assert.deepEqual(resolveSettings({}), DEFAULTS);
  const s = resolveSettings({ port: 80, minPool: 3, checkUrl: "http://plain", excludeCountries: [" ru ", "cn"] });
  assert.equal(s.port, DEFAULTS.port);
  assert.equal(s.minPool, 3);
  assert.equal(s.checkUrl, DEFAULTS.checkUrl);
  assert.deepEqual(s.excludeCountries, ["RU", "CN"]);
  assert.equal(s.requireAuth, false, "the password is off by default");
  assert.equal(resolveSettings({ requireAuth: "yes" }).requireAuth, false);
  assert.equal(resolveSettings({ requireAuth: true }).requireAuth, true);
});

test("proxy pool: a refresh skips excluded countries and keeps the fastest good proxies", async () => {
  const pool = createPool();
  const grab = async () => [
    { host: "1.1.1.1", port: 1, country: "RU" },
    { host: "2.2.2.2", port: 2, country: "US" },
    { host: "3.3.3.3", port: 3, country: "BR" },
    { host: "4.4.4.4", port: 4, country: "PH" },
  ];
  const checked = [];
  const check = async (proxy) => {
    checked.push(proxy.host);
    if (proxy.host === "3.3.3.3") return { ok: false, status: 451, ms: 5, error: "blocked (451)" };
    return { ok: true, status: 404, ms: proxy.host === "2.2.2.2" ? 900 : 100 };
  };
  const result = await refreshPool({ pool, settings: { ...DEFAULTS, maxPool: 5 }, grab, check });
  assert.deepEqual(result, { candidates: 3, good: 2 });
  assert.ok(!checked.includes("1.1.1.1"), "an excluded country is not even checked");
  assert.deepEqual(pool.list().map((entry) => entry.host), ["4.4.4.4", "2.2.2.2"]);
  assert.equal(pool.state().lastError, "");
  await refreshPool({ pool, settings: DEFAULTS, grab: async () => [], check });
  assert.match(pool.state().lastError, /none of 0/);
});

test("proxy pool: a proxy that keeps failing leaves the pool", () => {
  const pool = createPool({ maxFailures: 2 });
  pool.replace([{ host: "a", port: 1, ms: 1 }, { host: "b", port: 2, ms: 2 }]);
  pool.report({ host: "a", port: 1 }, false);
  assert.equal(pool.size(), 2);
  pool.report({ host: "a", port: 1 }, true);
  pool.report({ host: "a", port: 1 }, false);
  assert.equal(pool.size(), 2, "a success resets the count");
  pool.report({ host: "a", port: 1 }, false);
  assert.deepEqual(pool.list().map((entry) => entry.host), ["b"]);
});

test("proxy pool: the local proxy tunnels through the pool and moves past a dead proxy", async () => {
  const target = net.createServer((socket) => socket.pipe(socket)); // echo
  const targetPort = await listen(target);
  const upstream = fakeUpstream();
  const upstreamPort = await listen(upstream);
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await close(dead); // nothing listens there any more

  const pool = createPool({ maxFailures: 1 });
  // The dead proxy is the faster one, so it is picked first.
  pool.replace([{ host: "127.0.0.1", port: deadPort, ms: 1 }, { host: "127.0.0.1", port: upstreamPort, ms: 2 }]);
  const local = createLocalProxy({ pool, timeoutMs: 2000 });
  const localPort = await listen(local);
  try {
    const socket = await openTunnel({ host: "127.0.0.1", port: localPort }, "127.0.0.1", targetPort, 5000);
    const echoed = await new Promise((resolve) => {
      socket.once("data", (chunk) => resolve(chunk.toString()));
      socket.write("ping");
    });
    socket.destroy();
    assert.equal(echoed, "ping");
    assert.deepEqual(pool.list().map((entry) => entry.port), [upstreamPort], "the dead proxy was dropped");

    // With an empty pool the local proxy answers 502 instead of hanging.
    pool.replace([]);
    await assert.rejects(openTunnel({ host: "127.0.0.1", port: localPort }, "127.0.0.1", targetPort, 5000), /502/);
  } finally {
    await close(local);
    await close(upstream);
    await close(target);
  }
});

test("proxy pool: with a password only a client that sends it gets through, and the password stays local", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-pool-"));
  const target = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(target);
  const upstream = fakeUpstream();
  let forwarded = null;
  upstream.on("request", (req) => { forwarded = req.headers; });
  const upstreamPort = await listen(upstream);
  const file = path.join(dir, "proxy-pool.secret");
  const secret = await loadOrCreateSecret(file);
  assert.equal(await loadOrCreateSecret(file), secret, "made once, then reused");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match((await readFile(file, "utf8")).trim(), /^[\w-]{32}$/);

  const pool = createPool();
  pool.replace([{ host: "127.0.0.1", port: upstreamPort, ms: 1 }]);
  const local = createLocalProxy({ pool, timeoutMs: 2000, secret: () => secret });
  const localPort = await listen(local);
  const at = { host: "127.0.0.1", port: localPort };
  try {
    await assert.rejects(openTunnel(at, "127.0.0.1", targetPort, 5000), /407/);
    await assert.rejects(openTunnel({ ...at, auth: `${PROXY_USER}:wrong` }, "127.0.0.1", targetPort, 5000), /407/);
    const socket = await openTunnel({ ...at, auth: `${PROXY_USER}:${secret}` }, "127.0.0.1", targetPort, 5000);
    socket.destroy();

    const get = (headers) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: localPort, path: `http://127.0.0.1:${targetPort}/`, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    assert.equal(await get({}), 407);
    const basic = `Basic ${Buffer.from(`${PROXY_USER}:${secret}`).toString("base64")}`;
    await get({ "Proxy-Authorization": basic });
    assert.ok(forwarded, "the request reached the pool proxy");
    assert.equal(forwarded["proxy-authorization"], undefined, "the free proxy never sees our password");
  } finally {
    local.close();
    upstream.close();
    target.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("proxy pool: a proxy that closes without answering fails the check instead of hanging", async () => {
  const silent = net.createServer((socket) => socket.end());
  const held = [];
  const stalls = net.createServer((socket) => held.push(socket)); // accepts and never answers
  const silentPort = await listen(silent);
  const stallPort = await listen(stalls);
  try {
    const started = Date.now();
    const closed = await checkProxy({ host: "127.0.0.1", port: silentPort }, { url: "https://example.invalid/", timeoutMs: 300 });
    const stalled = await checkProxy({ host: "127.0.0.1", port: stallPort }, { url: "https://example.invalid/", timeoutMs: 300 });
    assert.equal(closed.ok, false);
    assert.match(closed.error, /closed/);
    assert.equal(stalled.ok, false);
    assert.match(stalled.error, /timeout/);
    assert.ok(Date.now() - started < 3000);
  } finally {
    held.forEach((socket) => socket.destroy());
    stalls.close();
    silent.close();
  }
});

test("proxy pool: the page lists proxies with country, answer, time and failures", () => {
  assert.deepEqual(poolRows({ proxies: [{ host: "1.2.3.4", port: 80, country: "", status: 404, ms: 1234, failures: 1 }] }), [
    ["1.2.3.4:80", "—", "404", "1.2 s", "1"],
  ]);
  assert.deepEqual(poolRows(null), []);
});
