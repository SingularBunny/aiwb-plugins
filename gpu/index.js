// GPU use in the Control UI: a GPU line in the chat header (load, memory) that opens a side panel with who holds
// the memory — the Gateway's local embeddings, Ollama with its models, llama.cpp, LM Studio, other processes.
// NVIDIA only (nvidia-smi); without it the line is not shown and the panel says why. The data: gpu.js; the
// Gateway method aiwb-gpu.status (operator.read), cached for a second so open panels share one nvidia-smi call;
// the views: dist/control-ui/gpu.js (hand-written, no build step).
import { execFile } from "node:child_process";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { describeProcess, gpuStatus, parseApps, parseGpus, parseOllamaPs } from "./gpu.js";

const PLUGIN_ID = "aiwb-gpu";
const CACHE_MS = 1000;

const run = (file, args) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));

/** Ollama's address: WORKBENCH_OLLAMA_URL (the installer's provider setting), else the provider's base URL. */
function ollamaUrl(config) {
  const fromConfig = config?.models?.providers?.ollama?.baseUrl;
  const url = process.env.WORKBENCH_OLLAMA_URL || (fromConfig && !fromConfig.includes("${") ? fromConfig : "");
  return url ? url.replace(/\/v1\/?$/, "").replace(/\/$/, "") : null;
}

async function ollamaModels(base) {
  if (!base) return null;
  try {
    const response = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? parseOllamaPs(await response.json()) : null;
  } catch {
    return null;
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "GPU",
  description: "GPU load and memory, and which models and processes hold it",
  register(api) {
    let cached = null;
    const read = async () => {
      try {
        const [gpus, apps] = await Promise.all([
          run("nvidia-smi", ["--query-gpu=uuid,index,name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]),
          run("nvidia-smi", ["--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"]),
        ]);
        const ollama = await ollamaModels(ollamaUrl(api.runtime?.config?.current?.()));
        return { available: true, at: Date.now(),
          gpus: gpuStatus({ gpus: parseGpus(gpus), apps: parseApps(apps), describe: describeProcess, gatewayPid: process.pid, ollama }) };
      } catch (error) {
        const reason = error?.code === "ENOENT" ? "nvidia-smi is not installed: GPU use is shown for NVIDIA GPUs only"
          : `nvidia-smi failed: ${String(error?.message || error).split("\n")[0]}`;
        return { available: false, at: Date.now(), reason };
      }
    };
    api.registerGatewayMethod(`${PLUGIN_ID}.status`, async ({ respond }) => {
      if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), value: read() };
      respond(true, await cached.value, undefined);
    }, { scope: "operator.read" });
  },
});
