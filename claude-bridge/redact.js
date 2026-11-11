// Secrets out of memory before it is copied: Claude Code memory may hold a password or a key in plain
// text, and the agent memory lives in a git repository. Same rules as the chat importer of ai-workbench
// (migrate/claude-desktop/chats-core.mjs); keep the two in step.
export const REDACTED = "‹secret›";

// Not secrets, although in a value position: placeholders, substitutions, the Atlassian anti-XSRF header
// (`X-Atlassian-Token: no-check`), and the redaction token itself (the older Russian one included).
const keepName = (m, k, v) => (/^(no-check|null|undefined|\*+|‹secret›|‹секрет›|<[^>]*>?)$/i.test(v) || /^[$%{]/.test(v) ? m : k + REDACTED);

const SECRET_PATTERNS = [
  // The key body runs to END or to the end of the base64 lines (clipped output has no END).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\s*[A-Za-z0-9+\/=:,-]+)*(?:\s*-----END [A-Z ]*PRIVATE KEY-----)?/g, () => REDACTED],
  [/\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-or-v1-[a-f0-9]{16,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,})/g, () => REDACTED],
  // A quoted value may start with any character (a password like '}x…'): take the whole quoted string.
  // No whitespace inside, so shell code like grep "X_PASSWORD=" .env | cut … is left alone.
  [/(\b[A-Z0-9_]*(?:PASS|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*\s*[:=]\s*)(['"])([^'"\s]{6,})\2/g, (m, k, q, v) => (keepName(m, k, v) === m ? m : k + q + REDACTED + q)],
  // The name stays, the value goes: DB_PASS='…' (environment variables) and "password": "…".
  [/(\b[A-Z0-9_]*(?:PASS|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*["']?\s*[:=]\s*["']?)([^\s"'`,;}<>]{6,})/g, keepName],
  [/((?:^|[\s{,"'])(?:password|passwd|пароль|secret|client_secret|token|access_token|refresh_token|api_?key)["']?\s*[:=]\s*["']?)([^\s"'`,;}<>]{6,})/gim, keepName],
  [/(\bAuthorization:\s*(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+\/=-]{8,})/gi, (m, k) => k + REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)([^\s@\/]{3,})(@)/gi, (m, a, v, b) => a + REDACTED + b],
];

/** Secrets → ‹secret›: exact values first (from local .env files), then patterns. */
export function redact(text, values = []) {
  let count = 0;
  let out = text;
  for (const v of [...new Set(values)].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length)) {
    const parts = out.split(v);
    count += parts.length - 1;
    out = parts.join(REDACTED);
  }
  for (const [re, fn] of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => { const r = fn(...m); if (r !== m[0]) count++; return r; });
  }
  return { text: out, count };
}

/** Values of secret keys from .env text: *PASS*, *TOKEN*, *SECRET*, *KEY*. */
export function secretValues(envText) {
  const out = [];
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || !/PASS|TOKEN|SECRET|KEY/i.test(m[1])) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (v.length >= 6) out.push(v);
  }
  return out;
}
