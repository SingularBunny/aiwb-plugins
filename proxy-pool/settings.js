// Settings of the proxy pool and one pool refresh; no OpenClaw imports, so tests run them with node.
import { checkProxy, grabProxies, mapLimit } from "./pool.js";

const PLUGIN_ID = "aiwb-proxy-pool";

export const DEFAULTS = {
  port: 18795,
  minPool: 5,
  maxPool: 40,
  refreshMinutes: 60,
  grabLimit: 400,
  checkUrl: "https://api.jetbrains.ai/",
  excludeCountries: ["RU"],
  proxybrokerPython: "python3",
  proxybrokerDir: "",
};

/** Plugin config with defaults; invalid values fall back to the default. */
export function resolveSettings(raw = {}) {
  const number = (value, fallback, min, max) =>
    Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max ? Math.floor(Number(value)) : fallback;
  return {
    port: number(raw.port, DEFAULTS.port, 1024, 65535),
    minPool: number(raw.minPool, DEFAULTS.minPool, 1, 200),
    maxPool: number(raw.maxPool, DEFAULTS.maxPool, 1, 500),
    refreshMinutes: number(raw.refreshMinutes, DEFAULTS.refreshMinutes, 5, 24 * 60),
    grabLimit: number(raw.grabLimit, DEFAULTS.grabLimit, 20, 5000),
    checkUrl: typeof raw.checkUrl === "string" && /^https:\/\//.test(raw.checkUrl) ? raw.checkUrl : DEFAULTS.checkUrl,
    excludeCountries: Array.isArray(raw.excludeCountries)
      ? raw.excludeCountries.map((code) => String(code).trim().toUpperCase()).filter(Boolean)
      : DEFAULTS.excludeCountries,
    proxybrokerPython: typeof raw.proxybrokerPython === "string" && raw.proxybrokerPython ? raw.proxybrokerPython : DEFAULTS.proxybrokerPython,
    proxybrokerDir: typeof raw.proxybrokerDir === "string" ? raw.proxybrokerDir : DEFAULTS.proxybrokerDir,
  };
}

/** One refresh: grab, drop excluded countries, check in parallel, keep the good ones (fastest first). */
export async function refreshPool({ pool, settings, grab = grabProxies, check = checkProxy, logger }) {
  const candidates = (await grab({
    python: settings.proxybrokerPython,
    cwd: settings.proxybrokerDir || undefined,
    limit: settings.grabLimit,
  })).filter((proxy) => !settings.excludeCountries.includes(proxy.country));
  const results = await mapLimit(candidates, 40, async (proxy) => ({ ...proxy, ...(await check(proxy, { url: settings.checkUrl })) }));
  const good = results.filter((result) => result.ok).sort((a, b) => a.ms - b.ms).slice(0, settings.maxPool)
    .map(({ host, port, country, ms, status }) => ({ host, port, country, ms, status }));
  pool.replace(good, { error: good.length ? "" : `none of ${candidates.length} candidates passed the check` });
  logger?.info?.(`${PLUGIN_ID}: ${good.length} of ${candidates.length} proxies passed ${settings.checkUrl}`);
  return { candidates: candidates.length, good: good.length };
}
