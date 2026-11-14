// Choosing the common answer of several models (research R-54, standard ST-8 of the project):
//
//   Select — Universal Self-Consistency (Chen et al., 2023, https://arxiv.org/abs/2311.17311): one model gets all
//   the answers and picks the one most consistent with the others. It is a choice, not a score, and works for free
//   text. A judge prefers answers by position, length and its own family (Zheng et al., 2023), so the choice is made
//   twice, the second time with the answers in reverse order; two different picks mean "no clear agreement".
//   Merge — a synthesis of all answers (as Mixture-of-Agents and Open WebUI's Merge Responses do). It can lose a
//   standout right answer, so it is offered separately and labelled a synthesis.

/** The selection prompt: the answers as "Response 1…N" and the instruction to name the most consistent one. */
export function selectionPrompt(question, answers) {
  return [
    "Several responses were generated for the question below.",
    "",
    "Question:", question, "",
    ...answers.flatMap((a, i) => [`Response ${i + 1}:`, a, ""]),
    "Evaluate these responses and select the one that is most consistent with the others, by majority consensus on",
    "their key claims and conclusions — not the longest or the most elaborate one.",
    `Start your answer with "The most consistent response is Response N" (N from 1 to ${answers.length}), then give one or two`,
    "sentences on what the responses agree and disagree on.",
  ].join("\n");
}

/** The response number the judge named, 0-based, or null. */
export function parseChoice(text, count) {
  const m = /most consistent response is\s*(?:response\s*)?#?\s*(\d+)/i.exec(String(text ?? ""))
    || /^\s*(?:response\s*)?#?\s*(\d+)\b/i.exec(String(text ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null;
}

/**
 * Select the most consistent answer. complete(prompt) → judge text. Returns { choice (index or null), agreed,
 * picks: [first, second], notes: [two judge texts] }. Fewer than two answers: the one answer, nothing to compare.
 */
export async function selectConsensus({ question, answers, complete }) {
  if (answers.length < 2) return { choice: answers.length ? 0 : null, agreed: answers.length === 1, picks: [], notes: [] };
  const order = answers.map((_, i) => i);
  const reversed = [...order].reverse();
  const [first, second] = await Promise.all([order, reversed].map(async (o) => {
    const text = await complete(selectionPrompt(question, o.map((i) => answers[i])));
    const picked = parseChoice(text, answers.length);
    return { pick: picked === null ? null : o[picked], text };
  }));
  const agreed = first.pick !== null && first.pick === second.pick;
  return { choice: agreed ? first.pick : null, agreed, picks: [first.pick, second.pick], notes: [first.text, second.text] };
}

/** The merge prompt: one answer written from all of them, weighing them critically. */
export function mergePrompt(question, answers) {
  return [
    "Several models answered the question below. Write one answer to the question that uses what is right in them:",
    "weigh their claims critically, as some may be wrong or biased; do not simply copy one of them or list them; where",
    "they contradict each other, say so and say which view is better supported. Answer in the language of the question.",
    "",
    "Question:", question, "",
    ...answers.flatMap((a, i) => [`Answer ${i + 1}:`, a, ""]),
  ].join("\n");
}

// Agreement matrix — how the answers relate pairwise, as semantic entropy clusters answers (Kuhn et al., 2023,
// https://arxiv.org/abs/2302.09664; Farquhar et al., Nature 2024, https://doi.org/10.1038/s41586-024-07421-0): an
// LLM checks whether one answer semantically entails the other, in both directions. The prompt and the reading of
// the reply are those of the authors' code (github.com/jlko/semantic_uncertainty, uncertainty_measures/
// semantic_entropy.py, EntailmentLLM): 2 entailment, 1 neutral, 0 contradiction, an unreadable reply counts as
// neutral. Pair relation by its are_equivalent: "same" — entailment both ways (their strict equivalence, the
// pipeline's default); "compatible" — one way entailment, no contradiction (their non-strict equivalence);
// "contradict" — a contradiction either way; "different" — neutral both ways. Their check was made for short
// answers; long ones are compared as a whole, so the matrix is a coarse signal next to the judge's pick.

/** The authors' entailment prompt: does answer 1 semantically entail answer 2? */
export function entailmentPrompt(question, text1, text2) {
  return `We are evaluating answers to the question "${question}"\n`
    + "Here are two possible answers:\n"
    + `Possible Answer 1: ${text1}\nPossible Answer 2: ${text2}\n`
    + "Does Possible Answer 1 semantically entail Possible Answer 2? Respond with entailment, contradiction, or neutral.";
}

/** 2 entailment, 1 neutral, 0 contradiction — from the first 30 characters, unreadable → 1, as the authors do. */
export function parseEntailment(text) {
  const head = String(text ?? "").toLowerCase().slice(0, 30);
  if (head.includes("entailment")) return 2;
  if (head.includes("neutral")) return 1;
  if (head.includes("contradiction")) return 0;
  return 1;
}

/** The relation of a pair from its two directions. */
export function pairRelation(forward, backward) {
  if (forward === 2 && backward === 2) return "same";
  if (forward === 0 || backward === 0) return "contradict";
  if (forward === 2 || backward === 2) return "compatible";
  return "different";
}

/**
 * Every pair of answers in both directions: N·(N−1) judge calls, run `parallel` at a time. complete(prompt) → text.
 * Returns { pairs: [{ a, b, forward, backward, relation }] (a < b, forward = does a entail b), groups } where
 * groups are the answers that say the same thing ("same" pairs, joined transitively), largest first.
 */
export async function agreementMatrix({ question, answers, complete, parallel = 4 }) {
  const jobs = [];
  for (let a = 0; a < answers.length; a += 1) for (let b = a + 1; b < answers.length; b += 1) jobs.push([a, b], [b, a]);
  const verdicts = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      verdicts.set(`${x}>${y}`, parseEntailment(await complete(entailmentPrompt(question, answers[x], answers[y]))));
    }
  }));
  const pairs = [];
  for (let a = 0; a < answers.length; a += 1) for (let b = a + 1; b < answers.length; b += 1) {
    const forward = verdicts.get(`${a}>${b}`);
    const backward = verdicts.get(`${b}>${a}`);
    pairs.push({ a, b, forward, backward, relation: pairRelation(forward, backward) });
  }
  const group = answers.map((_, i) => i);
  const root = (i) => (group[i] === i ? i : (group[i] = root(group[i])));
  for (const p of pairs) if (p.relation === "same") group[root(p.b)] = root(p.a);
  const byRoot = new Map();
  answers.forEach((_, i) => byRoot.set(root(i), [...(byRoot.get(root(i)) ?? []), i]));
  return { pairs, groups: [...byRoot.values()].sort((x, y) => y.length - x.length || x[0] - y[0]) };
}
