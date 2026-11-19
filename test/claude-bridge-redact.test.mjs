import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, redact, secretValues } from "../claude-bridge/redact.js";

// Key-shaped samples are assembled at run time so the secret scanner does not flag the test itself.
const fake = (prefix, n, ch = "a") => prefix + ch.repeat(n);

test("known values from .env are replaced first, longest first", () => {
  const values = secretValues("DB_PASS='hunter2hunter'\nexport API_TOKEN=abcdef123456\nNAME=visible-value\nSHORT_KEY=abc\n");
  assert.deepEqual(values, ["hunter2hunter", "abcdef123456"]);
  const { text, count } = redact("login with hunter2hunter and abcdef123456; visible-value stays", values);
  assert.equal(text, `login with ${REDACTED} and ${REDACTED}; visible-value stays`);
  assert.equal(count, 2);
});

test("key shapes, assignments, auth headers and URL passwords are redacted", () => {
  const cases = [
    [`key ${fake("sk-ant-", 24)}`, `key ${REDACTED}`],
    [`aws ${fake("AKIA", 16, "B")}`, `aws ${REDACTED}`],
    ["DB_PASSWORD=s3cr3tvalue", `DB_PASSWORD=${REDACTED}`],
    [`MY_TOKEN: "}x9longvalue"`, `MY_TOKEN: "${REDACTED}"`],
    [`"password": "longpassword1"`, `"password": "${REDACTED}"`],
    [`пароль: Qwerty12345`, `пароль: ${REDACTED}`],
    ["Authorization: Bearer abcdefghijk.lmn", `Authorization: Bearer ${REDACTED}`],
    ["postgres://user:pa55word@db:5432/x", `postgres://user:${REDACTED}@db:5432/x`],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input).text, expected, input);
});

test("placeholders, references and shell code are left alone", () => {
  for (const input of [
    "API_KEY=${OPENROUTER_API_KEY}",
    "X-Atlassian-Token: no-check",
    "DB_PASS=<your password>",
    `grep "X_PASSWORD=" .env | cut -d= -f2`,
    `TOKEN=${REDACTED}`,
    "password: ********",
  ]) {
    const { text, count } = redact(input);
    assert.equal(text, input);
    assert.equal(count, 0, input);
  }
});

test("a private key block is removed whole, even when clipped", () => {
  const head = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
  const body = "\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAEbm9uZQ==";
  assert.equal(redact(`before ${head}${body}\n-----END OPENSSH PRIVATE KEY----- after`).text, `before ${REDACTED} after`);
  assert.equal(redact(`${head}${body}`).text, REDACTED);
});
