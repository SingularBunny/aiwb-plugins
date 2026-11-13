// GPU use for the Control UI: load and memory of each NVIDIA GPU (nvidia-smi), and who holds the memory —
// the Gateway (local memory-search embeddings), local model servers (Ollama, llama.cpp, LM Studio) and the rest.
// Ollama's own /api/ps adds its loaded models with the part of each that is in GPU memory.
// Per-process GPU load is not shown: nvidia-smi gives it only by sampling (pmon), memory is exact.
import { readFileSync } from "node:fs";

const num = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;   // "[N/A]", "[Not Supported]" → null
};
const csvRows = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split(/,\s*/));

/** `nvidia-smi --query-gpu=uuid,index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`. */
export function parseGpus(text) {
  return csvRows(text).map(([uuid, index, name, util, used, total]) => ({
    uuid, index: num(index), name, utilization: num(util), memoryUsedMb: num(used), memoryTotalMb: num(total),
  }));
}

/** `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits`. */
export function parseApps(text) {
  return csvRows(text).map(([gpuUuid, pid, name, used]) => ({ gpuUuid, pid: num(pid), name, memoryMb: num(used) }));
}

/** Who a GPU process is: { kind, label }. cmdline: the process's command line; gatewayPid: this Gateway. */
export function processKind({ pid, name, cmdline = "", gatewayPid, parentPid }) {
  const text = `${name} ${cmdline}`.toLowerCase();
  if (pid === gatewayPid) return { kind: "gateway", label: "OpenClaw Gateway" };
  if (/\bollama\b/.test(text)) return { kind: "ollama", label: "Ollama" };
  if (/lm[- ]?studio|\blms\b/.test(text)) return { kind: "lm-studio", label: "LM Studio" };
  if (/llama[-_]server|llama\.cpp/.test(text)) {
    return parentPid === gatewayPid ? { kind: "embeddings", label: "Memory search embeddings (llama.cpp)" } : { kind: "llama.cpp", label: "llama.cpp server" };
  }
  return { kind: "other", label: String(name || `pid ${pid}`).split("/").pop() };
}

/** Ollama /api/ps → [{ name, sizeMb, vramMb }]. */
export function parseOllamaPs(body) {
  return (body?.models ?? []).map((m) => ({ name: m.name || m.model, sizeMb: Math.round((m.size ?? 0) / 2 ** 20),
    vramMb: Math.round((m.size_vram ?? 0) / 2 ** 20) }));
}

/**
 * The status the UI shows. gpus/apps: parsed nvidia-smi; describe(pid) → { cmdline, parentPid }; ollama: parsed
 * /api/ps or null. Each GPU lists its consumers by memory, largest first; Ollama's models go with the Ollama row.
 */
export function gpuStatus({ gpus, apps, describe = () => ({}), gatewayPid, ollama = null }) {
  return gpus.map((gpu) => {
    const rows = new Map();
    for (const app of apps.filter((a) => a.gpuUuid === gpu.uuid)) {
      const who = processKind({ ...app, ...describe(app.pid), gatewayPid });
      const key = who.kind === "other" ? `other:${who.label}` : who.kind;
      const row = rows.get(key) ?? { ...who, memoryMb: 0, pids: [] };
      row.memoryMb += app.memoryMb ?? 0;
      row.pids.push(app.pid);
      rows.set(key, row);
    }
    if (ollama?.length && rows.has("ollama")) rows.get("ollama").models = ollama;
    const consumers = [...rows.values()].sort((a, b) => b.memoryMb - a.memoryMb);
    return { ...gpu, consumers };
  });
}

/** Command line and parent of a Linux process from /proc; empty elsewhere or when it is gone. */
export function describeProcess(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const parentPid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return { cmdline, parentPid };
  } catch {
    return {};
  }
}
