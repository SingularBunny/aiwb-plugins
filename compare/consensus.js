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
