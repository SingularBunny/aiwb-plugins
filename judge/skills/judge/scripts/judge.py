#!/usr/bin/env python3
"""Answer judge: sends the question and answer to a judge model, prints a pass/fail report.

    python3 judge.py --input exchange.json        # {"question", "answer", "answer_model"}
    python3 judge.py < exchange.json

    python3 judge.py --from-session               # question and answer from this folder's Claude Code transcript
The judge model is any OpenAI-compatible provider (AI-agnostic) or Claude CLI:
    WORKBENCH_JUDGE_MODEL     provider model id, required (e.g. openai/gpt-…);
                              claude-cli/<id> uses `claude -p` and its login (Claude subscription), no key
    WORKBENCH_JUDGE_BASE_URL  default https://openrouter.ai/api/v1
    WORKBENCH_JUDGE_API_KEY   default OPENROUTER_API_KEY
    WORKBENCH_JUDGE_CRITERIA  path to a JSON list of criteria {"id","name","question"}
    WORKBENCH_JUDGE_PANEL     up to two more judge models, comma-separated (same base URL and key): a panel of
                              judges from different families, majority per criterion; the third judge is asked
                              only when the first two disagree, since it cannot change an agreed majority
Anything missing from the environment is read from ~/.openclaw/.env (the same file the Gateway uses).

The request bypasses the environment proxy: the key is never sent through someone else's proxy;
use your own proxy only explicitly, via WORKBENCH_JUDGE_PROXY.

Exit code: 0 — verdict given (PASS or FAIL); 2 — NOT EVALUATED; 1 — invalid invocation.
The OpenClaw Gateway (`/v1/chat/completions`) is not used as the judge: it runs an agent with its
own prompt and tools, while the judge needs a plain model call.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_core import (  # noqa: E402
    DEFAULT_CRITERIA,
    JudgeError,
    bias_warning,
    build_judge_messages,
    exchange_from_transcript,
    overall,
    panel_split,
    panel_verdicts,
    parse_verdicts,
    render_report,
    strip_report,
)

TIMEOUT_SECONDS = 120  # chosen, not measured
# Cap on the verdict length. Without it OpenRouter reserves the model's full output window and refuses
# keys with a smaller credit limit (HTTP 402). A verdict is a few hundred tokens; chosen, not measured.
DEFAULT_MAX_TOKENS = 4096


def load_env(env: dict, env_file: Path) -> dict:
    """Environment on top of ~/.openclaw/.env: the file does not override explicitly set values."""
    merged = {}
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() and not key.lstrip().startswith("#"):
                merged[key.strip()] = value.strip()
    merged.update({k: v for k, v in env.items() if v})
    return merged


def settings(env: dict) -> dict:
    model = env.get("WORKBENCH_JUDGE_MODEL", "").strip()
    if not model:
        raise JudgeError("judge model not set: WORKBENCH_JUDGE_MODEL in ~/.openclaw/.env")
    criteria = DEFAULT_CRITERIA
    if env.get("WORKBENCH_JUDGE_CRITERIA"):
        criteria = json.loads(Path(env["WORKBENCH_JUDGE_CRITERIA"]).read_text(encoding="utf-8"))
    return {
        "model": model,
        "base_url": env.get("WORKBENCH_JUDGE_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/"),
        "api_key": env.get("WORKBENCH_JUDGE_API_KEY") or env.get("OPENROUTER_API_KEY", ""),
        "proxy": env.get("WORKBENCH_JUDGE_PROXY", ""),
        "max_tokens": int(env.get("WORKBENCH_JUDGE_MAX_TOKENS") or DEFAULT_MAX_TOKENS),
        "criteria": criteria,
        "panel": [m.strip() for m in env.get("WORKBENCH_JUDGE_PANEL", "").split(",") if m.strip()][:2],
    }


USER_AGENT = "aiwb-judge/0.2.0"


def make_opener(proxy: str) -> urllib.request.OpenerDirector:
    """No explicit proxy means no proxy: ProxyHandler({}) disables the environment http(s)_proxy."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}))


def call_judge(cfg: dict, messages: list[dict], opener=None) -> str:
    opener = opener or make_opener(cfg["proxy"])
    req = urllib.request.Request(
        f"{cfg['base_url']}/chat/completions",
        data=json.dumps({"model": cfg["model"], "messages": messages, "temperature": 0,
                         "max_tokens": cfg.get("max_tokens", DEFAULT_MAX_TOKENS)}).encode(),
        # A User-Agent of our own: Groq's Cloudflare refuses Python-urllib's default (403, error code 1010).
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with opener.open(req, timeout=TIMEOUT_SECONDS) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as exc:
        raise JudgeError(f"HTTP {exc.code}: {exc.read()[:300].decode(errors='replace')}") from exc
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise JudgeError(f"provider response has no choices[0].message.content: {str(data)[:200]}") from exc


CLI_PREFIX = "claude-cli/"


def call_judge_cli(cfg: dict, messages: list[dict], run=subprocess.run) -> str:
    """Judge via Claude CLI: one turn with no tools, MCP, hooks or project settings, and no
    session persistence; uses its own system prompt. The environment proxy is not passed, as with
    the API; your own proxy only explicitly, via WORKBENCH_JUDGE_PROXY."""
    env = {k: v for k, v in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    if cfg.get("proxy"):
        env.update(HTTPS_PROXY=cfg["proxy"], HTTP_PROXY=cfg["proxy"])
    argv = ["claude", "-p", "--model", cfg["model"][len(CLI_PREFIX):], "--output-format", "json",
            "--system-prompt", messages[0]["content"], "--tools", "", "--max-turns", "1", "--no-session-persistence",
            "--setting-sources", "", "--settings", json.dumps({"disableAllHooks": True}),
            "--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": {}})]
    try:
        r = run(argv, input=messages[1]["content"], capture_output=True, text=True, timeout=TIMEOUT_SECONDS, env=env)
    except FileNotFoundError as exc:
        raise JudgeError("`claude` not found in PATH — the claude-cli/… judge runs through Claude CLI") from exc
    try:
        data = json.loads(r.stdout)
    except ValueError as exc:
        raise JudgeError(f"Claude CLI (exit code {r.returncode}): {(r.stderr or r.stdout)[-300:]}") from exc
    if data.get("is_error") or not isinstance(data.get("result"), str):
        raise JudgeError(f"Claude CLI: {str(data.get('result') or data)[:300]}")
    return data["result"]


def session_transcript(cwd: Path, home: Path) -> Path:
    """Transcript of the current Claude Code chat: the newest .jsonl in ~/.claude/projects/<folder>,
    where <folder> is the working directory with every character except Latin letters and digits replaced by "-"."""
    folder = home / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))
    files = sorted(folder.glob("*.jsonl"), key=lambda f: f.stat().st_mtime)
    if not files:
        raise JudgeError(f"no Claude Code transcript in {folder}")
    return files[-1]


def judge(exchange: dict, cfg: dict, transport=None) -> tuple[str, str]:
    """Returns (result, report). Any failure is NOT EVALUATED, not PASS."""
    criteria = cfg["criteria"]
    answer = strip_report(str(exchange.get("answer", "")))
    messages = build_judge_messages(str(exchange.get("question", "")), answer, criteria)
    models = [cfg["model"], *cfg.get("panel", [])]
    warning = next(filter(None, (bias_warning(str(exchange.get("answer_model", "")), m) for m in models)), None)

    def ask(model):
        send = transport or (call_judge_cli if model.startswith(CLI_PREFIX) else call_judge)
        return parse_verdicts(send({**cfg, "model": model}, messages), criteria)

    if len(models) == 1:
        try:
            verdicts = ask(cfg["model"])
            return overall(verdicts, criteria), render_report(verdicts, criteria, cfg["model"], warning)
        except Exception as exc:  # noqa: BLE001 — network, timeout, garbage in the response: all of it is "not evaluated"
            return "NOT EVALUATED", render_report(None, criteria, cfg["model"], warning, error=str(exc) or type(exc).__name__)
    votes, asked, errors = [], [], []
    for model in models:
        if len(votes) >= 2 and not panel_split(votes, criteria):
            break
        asked.append(model)
        try:
            votes.append(ask(model))
        except Exception as exc:  # noqa: BLE001 — one judge failing leaves the others
            votes.append(None)
            errors.append(f"{model}: {str(exc) or type(exc).__name__}")
    label = " + ".join(asked)
    verdicts = panel_verdicts(votes, criteria)
    if not verdicts:
        return "NOT EVALUATED", render_report(None, criteria, label, warning, error="; ".join(errors) or "the judges disagree on every criterion")
    note = f"Judges that gave no verdict: {'; '.join(errors)}." if errors else None
    return overall(verdicts, criteria), render_report(verdicts, criteria, label, " ".join(filter(None, [warning, note])) or None)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--input", type=Path, help="JSON {question, answer, answer_model}; stdin if omitted")
    ap.add_argument("--from-session", action="store_true",
                    help="take question and answer from this working directory's Claude Code transcript (agent on Claude CLI)")
    args = ap.parse_args(argv)
    try:
        if args.from_session:
            records = []
            for line in session_transcript(Path.cwd(), Path.home()).read_text(encoding="utf-8").splitlines():
                try:
                    records.append(json.loads(line))
                except ValueError:
                    continue  # the last line is still being written
            exchange = exchange_from_transcript(records)
            if exchange is None:
                print("No finished answer in the transcript before the request to evaluate.", file=sys.stderr)
                return 1
        else:
            exchange = json.loads(args.input.read_text(encoding="utf-8") if args.input else sys.stdin.read())
    except (OSError, ValueError, JudgeError) as exc:
        print(f"Cannot read input: {exc}", file=sys.stderr)
        return 1
    if not str(exchange.get("answer", "")).strip():
        print("Input has no answer to evaluate (answer field).", file=sys.stderr)
        return 1
    env = load_env(dict(os.environ), Path.home() / ".openclaw" / ".env")
    try:
        cfg = settings(env)
    except (JudgeError, OSError, ValueError) as exc:
        print(render_report(None, DEFAULT_CRITERIA, env.get("WORKBENCH_JUDGE_MODEL", "?"), None, error=str(exc)))
        return 2
    result, report = judge(exchange, cfg)
    print(report)
    return 2 if result == "NOT EVALUATED" else 0


if __name__ == "__main__":
    sys.exit(main())
