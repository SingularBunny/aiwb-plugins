import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  BACKENDS, ROUTES, CHECK_MAX_HOSTS, DEFAULT_CHECK_HOSTS, checkHosts, checkList, classifyError, composeRules,
  createTransport, editableRules, hintFor, managedProxy, proxyAddress, routeFor, routesState,
} from "../fork-settings/proxy.js";
import { METHODS, registerForkSettings } from "../fork-settings/register.js";
import { normalizeHost as uiNormalizeHost, previewValue } from "../fork-settings/dist/control-ui/proxy.js";

const SECRET = "s3cret-pass";
const PROXY = `http://user:${SECRET}@127.0.0.1:3128/`;
const OTHER = `http://other:${SECRET}@10.0.0.5:8080`;

/** A fake Gateway plugin api: methods by name, config in memory, files in a map. */
function fakeApi({ config = {}, env = {}, files = {}, makeTransport } = {}) {
  const methods = {};
  const writes = [];
  const descriptors = [];
  const state = { config: structuredClone(config) };
  const api = {
    runtime: { config: {
      current: () => state.config,
      mutateConfigFile: async ({ mutate }) => {
        const draft = structuredClone(state.config);
        mutate(draft);
        writes.push(draft);
        state.config = draft;
      },
    } },
    registerGatewayMethod: (name, handler, opts) => { methods[name] = { handler, scope: opts?.scope }; },
    session: { controls: { registerControlUiDescriptor: (d) => { descriptors.push(d); } } },
  };
  registerForkSettings(api, {
    env, home: "/home/test",
    exists: (f) => f in files,
    read: (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; },
    makeTransport,
  });
  const call = (name, params = {}) => new Promise((resolve) => {
    methods[name].handler({ params, respond: (ok, payload, error) => resolve({ ok, payload, error }) });
  });
  return { methods, writes, call, state, descriptor: () => descriptors[0], descriptors };
}

test("proxy page: address is scheme://host:port only, never credentials or path", () => {
  assert.equal(proxyAddress(PROXY), "http://127.0.0.1:3128");
  assert.equal(proxyAddress("https://u:p@proxy.example.com/x?y=1"), "https://proxy.example.com:443");
  assert.equal(proxyAddress("http://[::1]"), "http://[::1]:80");
  assert.equal(proxyAddress("socks5://h:1"), null);
  const m = managedProxy({ proxy: { proxyUrl: PROXY } }, { OPENCLAW_PROXY_ACTIVE: "1" });
  assert.deepEqual(m.info, { configured: true, enabled: true, active: true, address: "http://127.0.0.1:3128",
    source: "proxy.proxyUrl", loopbackMode: "gateway-only", customCa: false });
  assert.ok(!JSON.stringify(m.info).includes(SECRET));
  assert.equal(managedProxy({ proxy: { proxyUrl: PROXY, enabled: false } }, {}).info.enabled, false);
  assert.equal(managedProxy({}, { OPENCLAW_PROXY_URL: PROXY }).info.source, "OPENCLAW_PROXY_URL");
  assert.equal(managedProxy({}, {}).info.configured, false);
});

test("proxy page: routes state follows the fork (unset, invalid with reason, URL other than proxy.proxyUrl, active)", () => {
  assert.deepEqual(routesState("", PROXY), { state: "unset" });
  assert.equal(routesState("example.com=maybe", PROXY).state, "invalid");
  assert.match(routesState(`example.com=${OTHER};*=direct`, PROXY).reason, /other than proxy.proxyUrl/);
  assert.equal(routesState(`example.com=${PROXY};*=direct`, PROXY).state, "active");
  const { rules } = routesState("example.com,example.net=proxy;console.example.com=direct;*=direct", PROXY);
  assert.equal(routeFor(rules, "api.example.com"), "proxy");
  assert.equal(routeFor(rules, "console.example.com"), "direct");
  assert.equal(routeFor(rules, "example.org"), "direct");
  assert.equal(routeFor([], "example.org"), "proxy");
  assert.equal(routeFor(routesState("a.com=direct", PROXY).rules, "b.com"), "proxy");
});

test("proxy page: route editing round-trip keeps URL targets server side and validates hosts", () => {
  const raw = `example.com,example.net=proxy;intranet.example.com=direct;other.example.com=${PROXY};*=direct`;
  const ed = editableRules("routes", raw);
  assert.deepEqual(ed.entries, [{ key: "example.com", target: "proxy" }, { key: "example.net", target: "proxy" },
    { key: "intranet.example.com", target: "direct" }, { key: "other.example.com", target: "url:0" }]);
  assert.equal(ed.fallback, "direct");
  assert.deepEqual(ed.urls, [PROXY]);
  assert.equal(composeRules("routes", ed, ed.urls).raw, raw);
  const edited = { entries: [...ed.entries.filter((e) => e.key !== "example.net"), { key: "*.Models.Example.io.", target: "proxy" }], fallback: "direct" };
  assert.equal(composeRules("routes", edited, ed.urls).raw,
    `example.com,models.example.io=proxy;intranet.example.com=direct;other.example.com=${PROXY};*=direct`);
  assert.match(composeRules("routes", { entries: [{ key: "bad host", target: "proxy" }] }).error, /not a host name/);
  assert.match(composeRules("routes", { entries: [{ key: "a.com", target: "proxy" }, { key: "A.com", target: "direct" }] }).error, /listed twice/);
  assert.match(composeRules("routes", { entries: [{ key: "a.com", target: "url:3" }] }, ed.urls).error, /target/);
  assert.match(composeRules("routes", { entries: [{ key: "a.com", target: PROXY }] }, ed.urls).error, /target/);
  assert.deepEqual(composeRules("routes", { entries: [], fallback: null }), { raw: "" });
  assert.equal(composeRules("routes", { entries: [], fallback: "direct" }).raw, "*=direct");
  // A host named twice in the stored value keeps its first rule, as the fork matches it.
  assert.deepEqual(editableRules("routes", "a.com=direct;a.com=proxy").entries, [{ key: "a.com", target: "direct" }]);
  const be = editableRules("backends", `claude-cli=proxy;google-gemini-cli=${OTHER}`);
  assert.deepEqual(be.entries, [{ key: "claude-cli", target: "proxy" }, { key: "google-gemini-cli", target: "url:0" }]);
  assert.equal(composeRules("backends", { entries: [...be.entries, { key: "codex-cli", target: "direct" }] }, be.urls).raw,
    `claude-cli=proxy;google-gemini-cli=${OTHER};codex-cli=direct`);
  assert.match(composeRules("backends", { entries: [{ key: "Bad id!", target: "direct" }] }).error, /backend id/);
  // The page (which normalizes hosts on add) shows the same value, with URL targets redacted.
  const shown = { ...edited, entries: edited.entries.map((e) => ({ ...e, key: uiNormalizeHost(e.key) })) };
  assert.equal(previewValue("routes", shown), "example.com,models.example.io=proxy;intranet.example.com=direct;other.example.com=<proxy URL>;*=direct");
  assert.equal(uiNormalizeHost(" *.Example.COM. "), "example.com");
  assert.equal(uiNormalizeHost("a b"), null);
});

test("proxy page: the overview shows no proxy URL, and Claude Code and installer keys only as booleans", async () => {
  // claude-cli follows its own API host, so a route for anthropic.com covers it.
  const settingsFile = path.join("/home/test", ".claude", "settings.json");
  const envFile = path.join("/home/test", ".openclaw", ".env");
  const { call, methods, descriptor } = fakeApi({
    config: { proxy: { proxyUrl: PROXY }, env: { vars: { [ROUTES]: `anthropic.com=${PROXY};*=direct` } } },
    env: { OPENCLAW_PROXY_ACTIVE: "1", [ROUTES]: `anthropic.com=${PROXY};*=direct`, [BACKENDS]: `google-gemini-cli=${OTHER}` },
    files: {
      [settingsFile]: JSON.stringify({ env: { HTTPS_PROXY: PROXY, HTTP_PROXY: "", NO_PROXY: "localhost" } }),
      [envFile]: `WORKBENCH_PROXY_URL="${PROXY}"\nWORKBENCH_PROXY_HOSTS=\n# WORKBENCH_PROXY_ROUTES=x\n`,
    },
  });
  assert.equal(methods[METHODS.proxy].scope, "operator.read");
  assert.equal(methods[METHODS.proxyCheck].scope, "operator.admin");
  assert.equal(methods[METHODS.set].scope, "operator.admin");
  assert.deepEqual([descriptor().id, descriptor().label, descriptor().requiredScopes], ["proxy", "Proxy", ["operator.read"]]);
  const { ok, payload } = await call(METHODS.proxy);
  assert.ok(ok);
  const text = JSON.stringify(payload);
  assert.ok(!text.includes(SECRET) && !text.includes("10.0.0.5") && !text.includes("localhost\""), text);
  assert.equal(payload.proxy.address, "http://127.0.0.1:3128");
  assert.equal(payload.routes.state, "active");
  assert.equal(payload.routes.effect, "routes");
  assert.equal(payload.routes.editor.raw, "anthropic.com=<proxy URL>;*=direct");
  assert.deepEqual(payload.routes.editor.entries, [{ key: "anthropic.com", target: "url:0" }]);
  assert.equal(payload.routes.editor.source, "env.vars");
  assert.deepEqual(Object.fromEntries(payload.backends.effective.map((b) => [b.id, [b.effective, b.by]])), {
    "claude-cli": ["inherit", "route"], "google-gemini-cli": ["url", "explicit"], "codex-cli": ["direct", "route"], codex: ["direct", "route"],
  });
  assert.deepEqual(payload.claudeCode, { file: "~/.claude/settings.json", found: true, keys: { HTTPS_PROXY: true, HTTP_PROXY: false, NO_PROXY: true } });
  assert.deepEqual(payload.installer.keys, { WORKBENCH_PROXY_URL: true, WORKBENCH_PROXY_HOSTS: false, WORKBENCH_PROXY_ROUTES: false, WORKBENCH_CLAUDE_CODE_PROXY: false });
  assert.equal(payload.installer.rewritesRoutes, true);
  assert.deepEqual(payload.checkDefaults, DEFAULT_CHECK_HOSTS);
});

test("proxy page: saving an edited list writes the original URL, dry run writes nothing, a stale revision is refused", async () => {
  const stored = `example.com=${PROXY};*=direct`;
  const fake = fakeApi({
    config: { proxy: { proxyUrl: PROXY }, env: { vars: { [ROUTES]: stored } } },
    env: { OPENCLAW_PROXY_ACTIVE: "1", [ROUTES]: stored },
    files: { [path.join("/home/test", ".openclaw", ".env")]: "WORKBENCH_PROXY_HOSTS=example.com\nWORKBENCH_PROXY_URL=http://127.0.0.1:3128\n" },
  });
  const { payload } = await fake.call(METHODS.proxy);
  const { revision, entries } = payload.routes.editor;
  const rules = { entries: [...entries, { key: "models.example.io", target: "proxy" }], fallback: "direct" };

  const preview = await fake.call(METHODS.set, { name: ROUTES, rules, revision, dryRun: true });
  assert.ok(preview.ok, preview.error?.message);
  assert.equal(preview.payload.stored, "example.com=<proxy URL>;models.example.io=proxy;*=direct");
  assert.equal(preview.payload.dryRun, true);
  assert.match(preview.payload.installerNote, /next install/);
  assert.equal(fake.writes.length, 0);

  const saved = await fake.call(METHODS.set, { name: ROUTES, rules, revision });
  assert.ok(saved.ok);
  assert.ok(!JSON.stringify(saved.payload).includes(SECRET));
  assert.equal(fake.state.config.env.vars[ROUTES], `example.com=${PROXY};models.example.io=proxy;*=direct`);

  // The stored value changed (env.vars now differs from what was read): the old revision is refused.
  const stale = await fake.call(METHODS.set, { name: ROUTES, rules, revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "CONFLICT");

  // An empty list removes the setting.
  const fresh = (await fake.call(METHODS.proxy)).payload.routes.editor.revision;
  const cleared = await fake.call(METHODS.set, { name: ROUTES, rules: { entries: [], fallback: null }, revision: fresh });
  assert.ok(cleared.ok && cleared.payload.unset);
  assert.ok(!(ROUTES in fake.state.config.env.vars));

  // Validation errors and rules for other settings.
  const bad = await fake.call(METHODS.set, { name: ROUTES, rules: { entries: [{ key: "not a host", target: "proxy" }] },
    revision: (await fake.call(METHODS.proxy)).payload.routes.editor.revision });
  assert.equal(bad.error.code, "INVALID_REQUEST");
  const other = await fake.call(METHODS.set, { name: "OPENCLAW_WORKER_HEAP_MB", rules: { entries: [] } });
  assert.match(other.error.message, /rules apply only/);
  // The plain value form still works.
  const plain = await fake.call(METHODS.set, { name: BACKENDS, value: "claude-cli=direct" });
  assert.ok(plain.ok);
  assert.equal(fake.state.config.env.vars[BACKENDS], "claude-cli=direct");
});

test("proxy check: error classes, hints and the host list", () => {
  const err = (props, cause) => Object.assign(new Error(props.message || "x"), props, cause ? { cause } : {});
  assert.equal(classifyError(Object.assign(new Error("t"), { name: "TimeoutError" })).error, "timeout");
  assert.deepEqual(classifyError(err({ code: "UND_ERR_CONNECT_TIMEOUT" })), { error: "timeout", code: "UND_ERR_CONNECT_TIMEOUT" });
  assert.equal(classifyError(err({ message: "fetch failed" }, err({ code: "ECONNREFUSED" }))).error, "refused");
  assert.equal(classifyError(err({ code: "ENOTFOUND" })).error, "dns");
  assert.equal(classifyError(err({ code: "ECONNRESET" })).error, "reset");
  assert.equal(classifyError(err({ code: "CERT_HAS_EXPIRED" })).error, "tls");
  assert.equal(classifyError(err({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).error, "tls");
  assert.deepEqual(classifyError(err({ code: "UND_ERR_ABORTED", message: "Proxy response (407) !== 200 when HTTP Tunneling" })),
    { error: "proxy", code: "UND_ERR_ABORTED", proxyStatus: 407 });
  assert.equal(classifyError(err({ code: "weird code with spaces" })).code, undefined);

  assert.equal(hintFor({ error: "timeout" }, { status: 200 }, "direct").code, "add-to-proxy");
  assert.match(hintFor({ error: "timeout" }, { status: 200 }, "direct").text, /blocked directly.*works via proxy → add to proxy list/);
  assert.equal(hintFor({ status: 403 }, { status: 404 }, "direct").code, "add-to-proxy");
  assert.equal(hintFor({ error: "timeout" }, { status: 200 }, "proxy").code, "proxy-needed");
  assert.equal(hintFor({ status: 200 }, { error: "proxy" }, "proxy").code, "route-direct");
  assert.equal(hintFor({ status: 200 }, { status: 301 }, "direct"), null);
  assert.equal(hintFor({ error: "dns" }, { error: "dns" }, "direct").code, "unreachable");
  assert.equal(hintFor({ status: 200 }, { skipped: "no managed proxy URL" }, "direct"), null);

  const list = checkList({ routeHosts: ["example.com", "registry.npmjs.org"], extra: ["Example.org"] });
  assert.deepEqual(list.hosts.slice(0, 3), [{ host: "example.org", from: "extra" }, { host: "example.com", from: "routes" }, { host: "registry.npmjs.org", from: "routes" }]);
  assert.equal(list.hosts.filter((h) => h.host === "registry.npmjs.org").length, 1);
  assert.match(checkList({ extra: ["https://x.com/path"] }).error, /not a host name/);
  assert.equal(checkList({ extra: Array.from({ length: 60 }, (_, i) => `h${i}.example`) }).hosts.length, CHECK_MAX_HOSTS);
});

test("proxy check: every host direct and via proxy with bounded concurrency, through the Gateway method, no network", async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport = {
    hasProxy: true,
    async request(url, via) {
      calls.push([url, via]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      const host = new URL(url).hostname;
      if (host === "blocked.example" && via === "direct") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      if (host === "api.telegram.org" && via === "proxy") throw Object.assign(new Error("Proxy response (403) !== 200 when HTTP Tunneling"), { code: "UND_ERR_ABORTED" });
      return { status: 200 };
    },
    closed: false,
    async close() { this.closed = true; },
  };
  let given;
  const fake = fakeApi({
    config: { proxy: { proxyUrl: PROXY } },
    env: { OPENCLAW_PROXY_ACTIVE: "1", [ROUTES]: "example.com=proxy;*=direct" },
    makeTransport: async (opts) => { given = opts; return transport; },
  });
  const { ok, payload, error } = await fake.call(METHODS.proxyCheck, { hosts: ["blocked.example"] });
  assert.ok(ok, error?.message);
  assert.equal(given.proxyUrl, PROXY);   // read server side, never from params
  assert.ok(transport.closed);
  const hosts = payload.results.map((r) => r.host);
  assert.deepEqual(hosts.slice(0, 2), ["blocked.example", "example.com"]);
  for (const h of DEFAULT_CHECK_HOSTS) assert.ok(hosts.includes(h), h);
  assert.equal(calls.length, hosts.length * 2);
  assert.ok(calls.every(([url]) => /^https:\/\/[^/]+\/$/.test(url)));
  assert.ok(maxInFlight <= 12, `max in flight ${maxInFlight}`);
  const by = Object.fromEntries(payload.results.map((r) => [r.host, r]));
  assert.equal(by["blocked.example"].route, "direct");
  assert.equal(by["blocked.example"].direct.error, "timeout");
  assert.equal(by["blocked.example"].hint.code, "add-to-proxy");
  assert.equal(by["example.com"].route, "proxy");
  assert.equal(by["api.telegram.org"].proxy.error, "proxy");
  assert.equal(by["api.telegram.org"].hint.code, "direct-only");
  assert.ok(!JSON.stringify(payload).includes(SECRET));

  const bad = await fake.call(METHODS.proxyCheck, { hosts: ["not a host"] });
  assert.equal(bad.error.code, "INVALID_REQUEST");

  // Without a proxy URL only the direct path runs.
  const direct = await checkHosts({ hosts: [{ host: "a.example", from: "extra" }],
    transport: { hasProxy: false, request: async () => ({ status: 204 }) } });
  assert.deepEqual(direct[0].proxy, { skipped: "no managed proxy URL" });
});

test("proxy check transport: direct through its own undici Agent, proxied through a ProxyAgent to the managed URL", async () => {
  const made = [];
  const requests = [];
  class Agent { constructor(o) { this.kind = "agent"; this.opts = o; made.push(this); } close() {} }
  class ProxyAgent { constructor(o) { this.kind = "proxy"; this.opts = o; made.push(this); } close() {} }
  const undici = {
    Agent, ProxyAgent,
    request: async (url, opts) => {
      requests.push({ url, method: opts.method, dispatcher: opts.dispatcher.kind, signal: opts.signal instanceof AbortSignal });
      return { statusCode: 404, body: { dump: async () => {} } };
    },
  };
  const t = createTransport({ undici, proxyUrl: PROXY, proxyCa: "CA", timeoutMs: 1000 });
  assert.deepEqual(await t.request("https://a.example/", "direct"), { status: 404 });
  await t.request("https://a.example/", "proxy");
  assert.deepEqual(requests.map((r) => [r.method, r.dispatcher, r.signal]), [["HEAD", "agent", true], ["HEAD", "proxy", true]]);
  assert.equal(made.find((m) => m.kind === "proxy").opts.uri, PROXY);
  assert.deepEqual(made.find((m) => m.kind === "proxy").opts.proxyTls, { ca: "CA" });
  assert.equal(made.find((m) => m.kind === "agent").opts.connect.timeout, 1000);
  assert.equal(createTransport({ undici, proxyUrl: null }).hasProxy, false);
  await t.close();
});
