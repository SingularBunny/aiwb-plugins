"""Tests check the judge's decisions, not wording: no verdict means no PASS,
re-evaluation does not stack reports, own-model bias is called out, the key never goes
through the environment proxy. Core: judge/skills/judge/scripts/."""

import io
import json
import sys
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "judge" / "skills" / "judge" / "scripts"))
import judge  # noqa: E402
import judge_core as core  # noqa: E402

CRITERIA = core.DEFAULT_CRITERIA
CFG = {"model": "openai/gpt-x", "base_url": "http://judge.invalid/v1", "api_key": "k", "proxy": "", "criteria": CRITERIA}


def verdicts_json(**states):
    return json.dumps(
        {"criteria": [{"id": cid, "critique": f"why {cid}", "verdict": v} for cid, v in states.items()]}
    )


ALL_PASS = {c["id"]: "PASS" for c in CRITERIA}


class TestOverall:
    def test_all_pass_is_pass(self):
        assert core.overall(core.parse_verdicts(verdicts_json(**ALL_PASS), CRITERIA), CRITERIA) == "PASS"

    def test_missing_criterion_is_not_pass(self):
        partial = dict(ALL_PASS)
        partial.pop("security")
        assert core.overall(core.parse_verdicts(verdicts_json(**partial), CRITERIA), CRITERIA) == "NOT EVALUATED"

    def test_fail_wins_over_missing(self):
        v = core.parse_verdicts(verdicts_json(answers="FAIL", format="PASS"), CRITERIA)
        assert core.overall(v, CRITERIA) == "FAIL"


class TestParse:
    def test_json_inside_code_fence(self):
        raw = "Here is the evaluation:\n```json\n" + verdicts_json(**ALL_PASS) + "\n```"
        assert len(core.parse_verdicts(raw, CRITERIA)) == len(CRITERIA)

    def test_unknown_ids_and_verdicts_ignored(self):
        raw = verdicts_json(answers="PASS", made_up="PASS", format="MAYBE")
        assert set(core.parse_verdicts(raw, CRITERIA)) == {"answers"}

    @pytest.mark.parametrize("raw", ["", "no idea", "{not json}", json.dumps({"criteria": []})])
    def test_no_verdict_raises(self, raw):
        with pytest.raises(core.JudgeError):
            core.parse_verdicts(raw, CRITERIA)


class TestBiasWarning:
    def test_same_family_warns(self):
        assert "same family" in core.bias_warning("claude-sonnet-5-5", "anthropic/claude-haiku-5-5")

    def test_other_family_silent(self):
        assert core.bias_warning("claude-opus-5-5", "openai/gpt-x") is None

    def test_unknown_family_warns(self):
        assert core.bias_warning("my-local-model", "openai/gpt-x") is not None

    def test_aggregator_id_resolves_to_vendor(self):
        # The judge family comes from the model id, not from a manual setting.
        assert core.model_family("openrouter/anthropic/claude-haiku-5-5") == "anthropic"
        assert "same family" in core.bias_warning("anthropic/claude-opus-5-5", "openrouter/anthropic/claude-x")

    def test_free_openrouter_ids_resolve(self):
        # Free OpenRouter models: the family is resolved from the id too.
        assert core.model_family("nvidia/nemotron-3-ultra-550b-a55b:free") == "nvidia"
        assert core.model_family("google/gemma-4-26b-a4b-it:free") == "google"
        assert core.bias_warning("anthropic/claude-sonnet-5-5", "nvidia/nemotron-3-ultra-550b-a55b:free") is None


def run(raw=None, error=None, answer="Answer", answer_model="claude-opus-5-5"):
    seen = {}

    def transport(cfg, messages):
        seen["user"] = messages[1]["content"]
        if error:
            raise error
        return raw

    result, report = judge.judge({"question": "Question", "answer": answer, "answer_model": answer_model}, CFG, transport)
    return result, report, seen


class TestJudge:
    def test_verdict_report(self):
        result, report, _ = run(raw=verdicts_json(**ALL_PASS))
        assert result == "PASS"
        assert "Judge verdict: PASS" in report

    def test_transport_failure_is_not_pass(self):
        result, report, _ = run(error=TimeoutError())
        assert result == "NOT EVALUATED"
        assert "PASS" not in report

    def test_garbage_from_judge_is_not_pass(self):
        result, _, _ = run(raw="All good, PASS!")
        assert result == "NOT EVALUATED"

    def test_rejudge_does_not_stack_reports(self):
        _, first, _ = run(raw=verdicts_json(**ALL_PASS))
        _, second, seen = run(raw=verdicts_json(**ALL_PASS), answer="Answer\n\n" + first)
        assert second.count(core.REPORT_MARKER) == 1
        assert core.REPORT_MARKER not in seen["user"]
        assert "Judge verdict" not in seen["user"]


class TestConfig:
    def test_missing_model_is_not_evaluated(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.delenv("WORKBENCH_JUDGE_MODEL", raising=False)
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"question": "q", "answer": "a"})))
        assert judge.main([]) == 2
        assert "NOT EVALUATED" in capsys.readouterr().out

    def test_env_file_does_not_override_explicit_env(self, tmp_path):
        f = tmp_path / ".env"
        f.write_text("WORKBENCH_JUDGE_MODEL=from-file\nOPENROUTER_API_KEY=file-key\n# comment=x\n")
        env = judge.load_env({"WORKBENCH_JUDGE_MODEL": "explicit"}, f)
        assert env["WORKBENCH_JUDGE_MODEL"] == "explicit"
        assert env["OPENROUTER_API_KEY"] == "file-key"
        assert "# comment" not in env

    def test_api_key_falls_back_to_openrouter(self):
        cfg = judge.settings({"WORKBENCH_JUDGE_MODEL": "m", "OPENROUTER_API_KEY": "or"})
        assert cfg["api_key"] == "or"
        assert cfg["base_url"] == "https://openrouter.ai/api/v1"

    def test_no_proxy_from_environment(self, monkeypatch):
        # The key must not go through the environment http(s)_proxy: the environment proxy points
        # to a dead port, yet the request to the local judge still arrives, so it went direct.
        import http.server
        import threading

        class Fake(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps({"choices": [{"message": {"content": verdicts_json(**ALL_PASS)}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=srv.handle_request, daemon=True).start()
        for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
            monkeypatch.setenv(k, "http://127.0.0.1:9")
        monkeypatch.delenv("no_proxy", raising=False)
        monkeypatch.delenv("NO_PROXY", raising=False)
        cfg = dict(CFG, base_url=f"http://127.0.0.1:{srv.server_port}/v1")
        try:
            assert "PASS" in judge.call_judge(cfg, [{"role": "user", "content": "x"}])
        finally:
            srv.server_close()

    def test_request_caps_the_verdict_length(self):
        # Without max_tokens OpenRouter reserves the model's whole output window: a key with a smaller
        # credit limit gets HTTP 402 (seen live 10.11.2026: 65 536 asked, 24 900 allowed).
        sent = {}

        class Opener:
            def open(self, req, timeout):
                sent.update(json.loads(req.data))
                return io.BytesIO(json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())

        judge.call_judge(dict(CFG), [{"role": "user", "content": "x"}], opener=Opener())
        assert sent["max_tokens"] == judge.DEFAULT_MAX_TOKENS
        cfg = judge.settings({"WORKBENCH_JUDGE_MODEL": "m", "WORKBENCH_JUDGE_MAX_TOKENS": "1500"})
        judge.call_judge(cfg, [{"role": "user", "content": "x"}], opener=Opener())
        assert sent["max_tokens"] == 1500

    def test_explicit_proxy_is_used(self):
        handlers = [h for h in judge.make_opener("http://p:1").handlers if isinstance(h, urllib.request.ProxyHandler)]
        assert handlers[0].proxies == {"http": "http://p:1", "https": "http://p:1"}


class TestFromSession:
    """Question and answer from the Claude Code transcript: the agent does not need to retype its answer."""

    @staticmethod
    def rec(role, content, **extra):
        return {"type": role, "message": {"role": role, "content": content, **({"model": "claude-x"} if role == "assistant" else {})}, **extra}

    def test_last_answer_before_request(self):
        records = [
            self.rec("user", "old question"), self.rec("assistant", [{"type": "text", "text": "old answer"}]),
            self.rec("user", "What is 2+2?"),
            self.rec("assistant", [{"type": "text", "text": "Let me calculate."}, {"type": "tool_use", "id": "t", "name": "x", "input": {}}]),
            self.rec("user", [{"type": "tool_result", "tool_use_id": "t", "content": "4"}]),
            self.rec("assistant", [{"type": "text", "text": "It is 4."}]),
            self.rec("user", "meta", isMeta=True),
            self.rec("user", "Send to the judge"),
        ]
        assert core.exchange_from_transcript(records) == {"question": "What is 2+2?", "answer": "It is 4.", "answer_model": "claude-x"}

    def test_nothing_to_judge(self):
        assert core.exchange_from_transcript([self.rec("user", "Send to the judge")]) is None

    def test_transcript_folder_by_cwd(self, tmp_path):
        folder = tmp_path / ".claude" / "projects" / "-w-Proj----"
        folder.mkdir(parents=True)
        (folder / "old.jsonl").write_text("{}\n")
        new = folder / "new.jsonl"
        new.write_text("{}\n")
        import os
        os.utime(folder / "old.jsonl", (1, 1))
        assert judge.session_transcript(Path("/w/Proj/Сад"), tmp_path) == new


class TestClaudeCli:
    """The claude-cli/<id> judge runs via `claude -p`: no key, no tools, bypassing the proxy."""

    CLI = {**CFG, "model": "claude-cli/claude-small"}

    def test_calls_cli_without_tools_and_proxy(self, monkeypatch):
        monkeypatch.setenv("https_proxy", "http://proxy.invalid:1")
        seen = {}

        def run(argv, **kw):
            seen.update(argv=argv, env=kw["env"], input=kw["input"])
            return type("R", (), {"returncode": 0, "stdout": json.dumps({"type": "result", "is_error": False, "result": verdicts_json(**ALL_PASS)}), "stderr": ""})()

        msgs = core.build_judge_messages("q", "a", CRITERIA)
        raw = judge.call_judge_cli(self.CLI, msgs, run=run)
        assert json.loads(raw)["criteria"][0]["verdict"] == "PASS"
        a = seen["argv"]
        assert a[:4] == ["claude", "-p", "--model", "claude-small"]
        assert a[a.index("--tools") + 1] == "" and "--no-session-persistence" in a
        assert a[a.index("--system-prompt") + 1] == msgs[0]["content"] and seen["input"] == msgs[1]["content"]
        assert "https_proxy" not in seen["env"]

    def test_cli_explicit_proxy_only(self):
        seen = {}

        def run(argv, **kw):
            seen.update(env=kw["env"])
            return type("R", (), {"returncode": 0, "stdout": json.dumps({"is_error": False, "result": verdicts_json(**ALL_PASS)}), "stderr": ""})()

        judge.call_judge_cli({**self.CLI, "proxy": "http://own.invalid:3"}, core.build_judge_messages("q", "a", CRITERIA), run=run)
        assert seen["env"]["HTTPS_PROXY"] == "http://own.invalid:3"

    def test_cli_error_is_not_judged(self):
        def run(argv, **kw):
            return type("R", (), {"returncode": 1, "stdout": json.dumps({"is_error": True, "result": "Not logged in"}), "stderr": ""})()

        result, report = judge.judge({"question": "q", "answer": "a"}, self.CLI,
                                     transport=lambda cfg, m: judge.call_judge_cli(cfg, m, run=run))
        assert result == "NOT EVALUATED" and "Not logged in" in report

    def test_same_family_warned(self):
        _, report = judge.judge({"question": "q", "answer": "a", "answer_model": "anthropic/claude-big"}, self.CLI,
                                transport=lambda cfg, m: verdicts_json(**ALL_PASS))
        assert "same family" in report
