// Approval before a file write inside a knowledge base folder: kept apart from the plugin so it is testable without
// the OpenClaw SDK. The plugin calls knowledgeApproval from before_tool_call for write, edit and apply_patch
// (OpenClaw's own tools and the Claude CLI's Write/Edit, which OpenClaw maps to the same names).
import { existsSync } from "node:fs";
import path from "node:path";

const PREVIEW_CHARS = 1200;

/** The agent's knowledge folders: those for every agent plus its own. */
export function agentKnowledgeDirs(knowledge, agentId) {
  return [...new Set([...(knowledge?.["*"] ?? []), ...((agentId && knowledge?.[agentId]) || [])])];
}

const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const clip = (text) => {
  const s = String(text ?? "");
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}\n…[${s.length - PREVIEW_CHARS} more characters]` : s;
};

/** Files a tool call writes: { file, kind, detail } with absolute paths; relative ones resolve against base. */
export function writtenFiles(toolName, params, { base, derivedPaths } = {}) {
  const abs = (p) => (path.isAbsolute(p) ? path.resolve(p) : base ? path.resolve(base, p) : null);
  const out = [];
  if (toolName === "write" || toolName === "edit") {
    const p = params?.path ?? params?.file_path;
    if (typeof p !== "string" || !p) return out;
    const file = abs(p);
    if (!file) return out;
    if (toolName === "write") {
      out.push({ file, kind: existsSync(file) ? "replace" : "create", detail: clip(params.content),
        bytes: Buffer.byteLength(String(params.content ?? "")) });
    }
    else {
      const edits = Array.isArray(params.edits) ? params.edits : [{ oldText: params.old_string, newText: params.new_string }];
      out.push({ file, kind: "edit", detail: edits.map((e) => `- ${clip(e.oldText ?? e.old_string)}\n+ ${clip(e.newText ?? e.new_string)}`).join("\n\n") });
    }
  } else if (toolName === "apply_patch") {
    const patch = String(params?.input ?? params?.patch ?? "");
    const named = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => [m[1].toLowerCase(), m[2].trim()]);
    const paths = named.length ? named : (derivedPaths ?? []).map((p) => ["update", p]);
    for (const [kind, p] of paths) {
      const file = abs(p);
      if (file) out.push({ file, kind: kind === "add" ? "create" : kind === "delete" ? "delete" : "edit", detail: clip(patch) });
    }
  }
  return out;
}

/**
 * A note above this size is written as asked, with a recommendation to split it: Obsidian has no hard limit, but users
 * report indexing slowdowns past about 1 MB and freezes at several MB (forum.obsidian.md, "Improve support for very
 * large notes"). A recommendation, never a refusal.
 */
export const LARGE_NOTE_BYTES = 1024 * 1024;

/** The Gateway refuses an approval whose title exceeds 80 or description 512 characters. */
export const APPROVAL_TITLE_MAX = 80;
export const APPROVAL_DESCRIPTION_MAX = 512;

/** Cuts text to max characters, saying how much was left out, so the approval card is never refused. */
export function boundApprovalText(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const note = (left) => `\n… (${left} more characters)`;
  let keep = max - note(value.length).length;
  return `${value.slice(0, keep).trimEnd()}${note(value.length - keep)}`;
}

/**
 * The before_tool_call decision: undefined when the call writes nothing in the agent's knowledge folders or the
 * session already chose "allow always"; otherwise a requireApproval naming the files and what changes.
 */
export function knowledgeApproval({ toolName, params, derivedPaths, agentId, base, knowledge, allowedSessions, sessionKey, onAllowAlways }) {
  const dirs = agentKnowledgeDirs(knowledge, agentId);
  if (!dirs.length || (sessionKey && allowedSessions?.has(sessionKey))) return undefined;
  const files = writtenFiles(toolName, params, { base, derivedPaths }).filter((f) => dirs.some((d) => inside(f.file, d)));
  if (!files.length) return undefined;
  const verb = { create: "Create", replace: "Replace", edit: "Edit", delete: "Delete" };
  // Every file's action and path come first, so a long change cannot push a path out of the bounded card.
  const large = files.filter((f) => f.bytes > LARGE_NOTE_BYTES);
  const targets = [
    ...files.map((f) => `${verb[f.kind]} ${f.file}`),
    ...large.map((f) => `Large note: ${(f.bytes / 1024 / 1024).toFixed(1)} MB. Obsidian may slow down above about 1 MB; splitting it is recommended, not required.`),
  ].join("\n");
  const details = files.map((f) => f.detail).filter(Boolean).join("\n\n---\n\n");
  const description = boundApprovalText(details ? `${targets}\n\n${details}` : targets, APPROVAL_DESCRIPTION_MAX);
  return {
    requireApproval: {
      title: boundApprovalText(files.length === 1 ? `Knowledge base: ${verb[files[0].kind].toLowerCase()} ${path.basename(files[0].file)}` : `Knowledge base: change ${files.length} notes`, APPROVAL_TITLE_MAX),
      description,
      severity: "info",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      onResolution: (decision) => {
        if (decision === "allow-always" && sessionKey) {
          allowedSessions?.add(sessionKey);
          onAllowAlways?.(sessionKey);
        }
      },
    },
  };
}
