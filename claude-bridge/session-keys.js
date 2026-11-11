// Which agent sessions the "Projects" tree shows as rows. A project agent's sessions sit in its folder,
// scheduled ones (automations, agent:<id>:cron:<job>) included: the Control UI hides them, folder or
// not, while "Show automation sessions" is off (OpenClaw fork). Not shown: subagent runs, which live
// under their parent session, and the per-run records of an automation (agent:<id>:cron:<job>:run:<run>),
// which OpenClaw never lists either.

/** The main chat of an agent: agent:<id>:main. */
export const isMainKey = (sessionKey) => /^agent:[^:]+:main$/.test(sessionKey);

/** An automation (scheduled job) session: agent:<id>:cron:<job>, without its per-run records. */
export const isCronKey = (sessionKey) => /^agent:[^:]+:cron:[^:]+$/.test(sessionKey);

/** Whether an agent session is a row of the tree. */
export const isTreeSessionKey = (sessionKey) =>
  typeof sessionKey === "string" && !/:subagent:/.test(sessionKey) && !/:cron:[^:]+:run:/.test(sessionKey);
