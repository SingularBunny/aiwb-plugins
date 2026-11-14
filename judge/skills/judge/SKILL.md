---
name: judge
description: Checks an assistant answer with an independent judge model against binary criteria (substance, format, safety, tone) and reports PASS/FAIL. Use when asked to evaluate, check or "send to the judge" an answer — your own last one or a provided text. Not for self-assessment: a different model judges via the script.
---

# Answer judge

The verdict is made **not by you** but by the judge model via the script: grading your own answer
biases toward your own model (Zheng et al., 2023). Your job is to collect the input faithfully and
show the report as is.

## Steps

1. **What to evaluate.** By default, your last answer and the user's question before it. If the
   user pointed to another answer or sent a text, use that. If it is unclear which one, ask.
2. **For your last answer, first try without retyping it:** the script takes the question and
   answer from this workspace's transcript (works when you run through Claude CLI):

   ```bash
   python3 {baseDir}/scripts/judge.py --from-session
   ```

   Got a report — go to step 4. Exit code 1 ("no transcript", "no finished answer") or another
   text needs evaluating — collect the input yourself (step 3).
3. **Collect the input verbatim**, without paraphrasing or shortening, into a JSON file in a temp
   folder:

   ```json
   {"question": "<user question>", "answer": "<answer being evaluated>", "answer_model": "<id of the model that answered, if known; otherwise empty>"}
   ```

   Do not include a previous judge report (everything after `<!-- judge-report -->`) in the
   answer — the script strips it, but better not to send extra. Then run the script next to this
   file:

   ```bash
   python3 {baseDir}/scripts/judge.py --input <file>
   ```

4. **Show the report in full**, exactly as the script printed it. Do not paraphrase, soften or
   add your own opinion of the verdict on top. Exit code 2 means "NOT EVALUATED": say so and give
   the reason from the report.

## Do not

- Do not give a verdict yourself if the script failed: "not evaluated" is an honest answer, a
  made-up PASS is not.
- Do not change the judge model or criteria on the fly unless the user asks: they are set in
  `~/.openclaw/.env` (`WORKBENCH_JUDGE_MODEL`, `WORKBENCH_JUDGE_PANEL`, `WORKBENCH_JUDGE_CRITERIA`).
- Do not print keys or the contents of `~/.openclaw/.env`.
