import { test } from "node:test";
import assert from "node:assert/strict";

import { gpuStatus, parseApps, parseGpus, parseOllamaPs, processKind } from "../gpu/gpu.js";
import { formatMb, headerText } from "../gpu/dist/control-ui/gpu.js";

test("gpu: nvidia-smi rows, [N/A] as unknown", () => {
  assert.deepEqual(parseGpus("GPU-a, 0, NVIDIA RTX A4000 Laptop GPU, 35, 5222, 8192\nGPU-b, 1, Tesla, [N/A], 10, 16384\n").map((g) => [g.name, g.utilization, g.memoryUsedMb]),
    [["NVIDIA RTX A4000 Laptop GPU", 35, 5222], ["Tesla", null, 10]]);
  assert.deepEqual(parseApps("GPU-a, 4242, /usr/bin/ollama, 4900\n"), [{ gpuUuid: "GPU-a", pid: 4242, name: "/usr/bin/ollama", memoryMb: 4900 }]);
});

test("gpu: who holds the memory — Gateway, its embeddings server, Ollama with its models, the rest by name", () => {
  const gpus = parseGpus("GPU-a, 0, RTX, 35, 6300, 8192");
  const apps = parseApps(["GPU-a, 10, node, 300", "GPU-a, 20, /opt/llama/llama-server, 700", "GPU-a, 30, /usr/bin/ollama, 4900",
    "GPU-a, 31, /usr/bin/ollama, 100", "GPU-a, 40, /usr/lib/firefox/firefox, 250"].join("\n"));
  const describe = (pid) => ({ 20: { cmdline: "llama-server --embeddings", parentPid: 10 } }[pid] ?? {});
  const ollama = parseOllamaPs({ models: [{ name: "qwen3:8b", size: 6 * 2 ** 30, size_vram: 4.5 * 2 ** 30 }] });
  const [gpu] = gpuStatus({ gpus, apps, describe, gatewayPid: 10, ollama });
  assert.deepEqual(gpu.consumers.map((c) => [c.label, c.memoryMb]),
    [["Ollama", 5000], ["Memory search embeddings (llama.cpp)", 700], ["OpenClaw Gateway", 300], ["firefox", 250]]);
  assert.deepEqual(gpu.consumers[0].models, [{ name: "qwen3:8b", sizeMb: 6144, vramMb: 4608 }]);
  assert.equal(processKind({ pid: 50, name: "llama-server", gatewayPid: 10, parentPid: 1 }).label, "llama.cpp server");
});

test("gpu: the header line and memory sizes", () => {
  assert.equal(headerText({ utilization: 35, memoryUsedMb: 5222, memoryTotalMb: 8192 }), "GPU 35% · 5.1/8.0 GB");
  assert.equal(headerText({ utilization: null, memoryUsedMb: 29, memoryTotalMb: 8192 }), "GPU · 0.0/8.0 GB");
  assert.deepEqual([formatMb(900), formatMb(5120), formatMb(null)], ["900 MB", "5.0 GB", "?"]);
});
