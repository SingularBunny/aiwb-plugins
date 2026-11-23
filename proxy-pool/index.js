// Proxy pool for programs that a country block or a blocked exit address keeps out (JetBrains Junie:
// 451 from Russia, 403 from the shared proxy's data-centre exit). A Gateway service keeps a pool of
// free proxies found by proxybroker2 and checked here (an HTTPS tunnel to `checkUrl`, certificate
// verified, no 451), and listens on 127.0.0.1:<port> as an HTTP proxy that sends each connection
// through a pool proxy, trying the next one when a tunnel fails. Only programs pointed at it use it
// (bin/junie-via-pool); the Gateway's own traffic does not go through it.
//
// Free proxies see the host names a program connects to, not the content: HTTPS stays end to end
// (CONNECT tunnels; the program verifies the certificate). Plain http:// URLs are visible to them.
//
// Gateway methods: aiwb-proxy-pool.status (operator.read), aiwb-proxy-pool.refresh (operator.admin).
import { mkdirSync } from "node:fs";
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { createLocalProxy, createPool } from "./pool.js";
import { refreshPool, resolveSettings } from "./settings.js";

const PLUGIN_ID = "aiwb-proxy-pool";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Proxy pool",
  description: "A local proxy that sends chosen programs through checked free proxies (proxybroker2)",
  register(api) {
    const settings = resolveSettings(api.pluginConfig ?? {});
    let pool = null;
    let server = null;
    let listening = false;
    let refreshing = null;
    let timer = null;

    const refresh = () => {
      if (!pool) return Promise.reject(new Error("the proxy pool service is not running"));
      refreshing ??= refreshPool({ pool, settings, logger: api.logger })
        .catch((error) => {
          pool.note(`refresh failed: ${String(error?.message || error).split("\n")[0]}`);
          api.logger?.warn?.(`${PLUGIN_ID}: refresh failed: ${error?.message || error}`);
          return { candidates: 0, good: 0 };
        })
        .finally(() => { refreshing = null; void pool?.save().catch(() => {}); });
      return refreshing;
    };

    api.registerService({
      id: `${PLUGIN_ID}-service`,
      reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}`] },
      async start(ctx) {
        const dir = path.join(ctx.stateDir, "workbench");
        mkdirSync(dir, { recursive: true });
        pool = createPool({ file: path.join(dir, "proxy-pool.json") });
        await pool.load();
        server = createLocalProxy({ pool, logger: ctx.logger });
        server.on("error", (error) => {
          listening = false;
          ctx.logger.warn(`${PLUGIN_ID}: cannot listen on 127.0.0.1:${settings.port}: ${error.message}`);
        });
        server.listen(settings.port, "127.0.0.1", () => { listening = true; });
        const due = () => pool.size() < settings.minPool || Date.now() - pool.state().refreshedAt > settings.refreshMinutes * 60_000;
        timer = setInterval(() => { if (due()) void refresh(); }, 60_000);
        timer.unref?.();
        if (due()) void refresh();
      },
      async stop() {
        clearInterval(timer);
        listening = false;
        await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
        server = null;
        await pool?.save().catch(() => {});
      },
    });

    api.registerGatewayMethod(`${PLUGIN_ID}.status`, async ({ respond }) => {
      respond(true, {
        port: settings.port,
        listening,
        refreshing: Boolean(refreshing),
        settings,
        ...(pool ? pool.state() : { refreshedAt: 0, lastError: "the proxy pool service is not running" }),
        proxies: pool ? pool.list().map(({ host, port, country, ms, status, failures }) => ({ host, port, country, ms, status, failures })) : [],
      }, undefined);
    }, { scope: "operator.read" });

    api.registerGatewayMethod(`${PLUGIN_ID}.refresh`, async ({ respond }) => {
      try {
        respond(true, await refresh(), undefined);
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error?.message || error) });
      }
    }, { scope: "operator.admin" });
  },
});
