"""Judge monitor: a local log of verdicts, human labels on some of them, and the PASS rate corrected for the judge's
errors. No network, no dependencies.

Method — Lee et al., "How to Correctly Report LLM-as-a-Judge Evaluations" (ICML 2026,
https://arxiv.org/abs/2511.21140): the share of PASS a judge gives is not the share of good answers, since the
judge errs both ways. Human labels on some judged answers give its sensitivity q1 (PASS where a human says PASS) and
specificity q0 (FAIL where a human says FAIL); the corrected rate is the Rogan–Gladen estimator
(p + q0 − 1) / (q0 + q1 − 1), with their adjusted Wald interval (Eq. 8–11). There is no fixed alarm threshold:
"PASS above 80%" has no source, and a high rate is fine when the answers are good — a judge that is too lenient
shows as a low q0. A calibration holds for one judge and one set of criteria; another judge or criteria start anew.
The raw rate's interval is Agresti–Coull, as in the paper.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

Z95 = 1.959963984540054


def criteria_key(criteria: list[dict]) -> str:
    return hashlib.sha1(json.dumps(criteria, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:8]


def make_record(exchange: dict, result: str, judge: str, criteria: list[dict], now: Optional[datetime] = None) -> dict:
    ts = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")
    question, answer = str(exchange.get("question", "")), str(exchange.get("answer", ""))
    rid = hashlib.sha1(f"{ts}\n{question}\n{answer}".encode()).hexdigest()[:8]
    return {"id": rid, "ts": ts, "judge": judge, "criteria": criteria_key(criteria),
            "answer_model": str(exchange.get("answer_model", "")), "result": result, "question": question, "answer": answer}


def append(path: Path, rec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def read_log(path: Path) -> tuple[list[dict], dict[str, str]]:
    """Verdict records and human labels (id → PASS/FAIL, the last label wins). Broken lines are skipped."""
    verdicts, labels = [], {}
    if not path.exists():
        return verdicts, labels
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if "label_for" in rec and rec.get("human") in ("PASS", "FAIL"):
            labels[rec["label_for"]] = rec["human"]
        elif "id" in rec and "result" in rec:
            verdicts.append(rec)
    return verdicts, labels


def agresti_coull(k: int, n: int, z: float = Z95) -> tuple[float, float]:
    nt = n + z * z
    pt = (k + z * z / 2) / nt
    half = z * math.sqrt(pt * (1 - pt) / nt)
    return max(0.0, pt - half), min(1.0, pt + half)


def corrected_rate(p: float, n: int, q0: float, m0: int, q1: float, m1: int, z: float = Z95) -> Optional[dict]:
    """Rogan–Gladen estimate and the adjusted Wald interval of Lee et al. (Eq. 7–11), truncated to [0, 1].
    None when the judge is no better than chance on the labelled answers (q0 + q1 ≤ 1): the correction is undefined."""
    pt = (n * p + z * z / 2) / (n + z * z)
    q0t, q1t = (m0 * q0 + 1) / (m0 + 2), (m1 * q1 + 1) / (m1 + 2)
    nt, m0t, m1t = n + z * z, m0 + 2, m1 + 2
    den = q0t + q1t - 1
    if q0 + q1 - 1 <= 0 or den <= 0:
        return None
    clip = lambda x: min(1.0, max(0.0, x))  # noqa: E731
    th = (pt + q0t - 1) / den
    dth = 2 * z * z * (-(1 - th) * q0t * (1 - q0t) / m0t + th * q1t * (1 - q1t) / m1t)
    var = (pt * (1 - pt) / nt + (1 - th) ** 2 * q0t * (1 - q0t) / m0t + th ** 2 * q1t * (1 - q1t) / m1t) / den ** 2
    half = z * math.sqrt(var)
    return {"rate": clip((p + q0 - 1) / (q0 + q1 - 1)), "low": clip(th + dth - half), "high": clip(th + dth + half)}


def stats(verdicts: list[dict], labels: dict[str, str]) -> list[dict]:
    """Per judge and criteria set, newest first: counts, raw PASS rate and interval, calibration, corrected rate."""
    groups: dict[tuple, list[dict]] = {}
    for rec in verdicts:
        groups.setdefault((rec.get("judge", "?"), rec.get("criteria", "?")), []).append(rec)
    out = []
    for (judge, crit), recs in groups.items():
        judged = [r for r in recs if r["result"] in ("PASS", "FAIL")]
        n, k = len(judged), sum(r["result"] == "PASS" for r in judged)
        row = {"judge": judge, "criteria": crit, "n": n, "passes": k, "not_evaluated": len(recs) - n,
               "last": max(r.get("ts", "") for r in recs), "rate": k / n if n else None,
               "interval": agresti_coull(k, n) if n else None}
        human = [(labels[r["id"]], r["result"]) for r in judged if r["id"] in labels]
        m1 = sum(h == "PASS" for h, _ in human)
        m0 = len(human) - m1
        q1 = sum(h == j == "PASS" for h, j in human) / m1 if m1 else None
        q0 = sum(h == j == "FAIL" for h, j in human) / m0 if m0 else None
        row.update({"m1": m1, "m0": m0, "q1": q1, "q0": q0, "corrected": None})
        if n and m0 and m1:
            row["corrected"] = corrected_rate(k / n, n, q0, m0, q1, m1)
        out.append(row)
    return sorted(out, key=lambda r: r["last"], reverse=True)


def _pct(x: float) -> str:
    return f"{100 * x:.0f}%"


def render_stats(rows: list[dict]) -> str:
    if not rows:
        return "No verdicts in the log yet."
    lines = []
    for r in rows:
        lines.append(f"Judge {r['judge']} (criteria {r['criteria']}): {r['n']} verdicts"
                     + (f", {r['not_evaluated']} not evaluated" if r["not_evaluated"] else "") + f", last {r['last']}")
        if not r["n"]:
            continue
        lo, hi = r["interval"]
        lines.append(f"  PASS given: {_pct(r['rate'])} ({r['passes']} of {r['n']}; 95% interval {_pct(lo)}–{_pct(hi)})")
        cal = []
        if r["m1"]:
            cal.append(f"PASS where a human says PASS {_pct(r['q1'])} of {r['m1']}")
        if r["m0"]:
            cal.append(f"FAIL where a human says FAIL {_pct(r['q0'])} of {r['m0']}")
        lines.append("  Human labels: " + ("; ".join(cal) if cal else "none"))
        if r["corrected"]:
            c = r["corrected"]
            lines.append(f"  Share of good answers, corrected for the judge's errors: {_pct(c['rate'])} "
                         f"(95% interval {_pct(c['low'])}–{_pct(c['high'])})")
        elif r["m0"] and r["m1"]:
            lines.append("  The judge is no better than chance on the labelled answers: its PASS rate says nothing.")
        else:
            need = " and ".join(x for x, m in (("PASS", r["m1"]), ("FAIL", r["m0"])) if not m)
            lines.append(f"  Not calibrated: label answers a human finds {need} too (judge.py --to-label) — "
                         "until then the PASS rate is the judge's, not the share of good answers.")
    return "\n".join(lines)


def to_label(verdicts: list[dict], labels: dict[str, str], count: int) -> str:
    rest = [r for r in verdicts if r["result"] in ("PASS", "FAIL") and r["id"] not in labels][-count:]
    if not rest:
        return "Every judged answer in the log is labelled."
    cut = lambda s, n: s if len(s) <= n else s[:n] + "…"  # noqa: E731
    return "\n\n".join(f"[{r['id']}] judge: {r['result']} ({r['judge']}, {r['ts']})\nQ: {cut(r['question'], 300)}\n"
                       f"A: {cut(r['answer'], 600)}" for r in reversed(rest)) \
        + "\n\nLabel with: judge.py --label <id> pass|fail — your own verdict on the answer, not on the judge."
