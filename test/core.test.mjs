import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFindings, returnMessage, reviewerFor, buildContext, reviewPrompt } from "../dist/core.js";

const run = { id: "r", createdAt: "", status: "reviewed", originPane: "w1:p1", originAgent: "claude", reviewerKind: "codex", cwd: "/repo", subject: "both", note: "focus on races", round: 1, dir: "" };

test("reviewer is the other agent", () => {
  assert.equal(reviewerFor("claude"), "codex");
  assert.equal(reviewerFor("codex"), "claude");
  assert.equal(reviewerFor("opencode"), "codex");
});

test("parseFindings validates model output", () => {
  const f = parseFindings(JSON.stringify({ summary: "ok", findings: [{ severity: "high", title: "Race", detail: "d", evidence: "a.ts:3" }, { severity: "weird", title: "x" }] }));
  assert.equal(f.findings.length, 2);
  assert.equal(f.findings[1].severity, "medium", "unknown severity → medium");
  assert.deepEqual(f.findings.map((x) => x.id), [1, 2]);
  assert.throws(() => parseFindings("not json"), /valid JSON/);
  assert.throws(() => parseFindings(JSON.stringify({ findings: [{ severity: "low" }] })), /no title/);
  assert.equal(parseFindings(JSON.stringify({ findings: Array.from({ length: 40 }, (_, i) => ({ title: `t${i}` })) })).findings.length, 20);
});

test("return message carries only adopted points, plus what was declined", () => {
  const a = [{ id: 1, severity: "high", title: "Race in save()", detail: "two writers", suggestion: "lock" }];
  const r = [{ id: 2, severity: "low", title: "Rename var", detail: "" }];
  const m = returnMessage(run, a, r, "keep the API stable");
  assert.match(m, /Second opinion from Codex/);
  assert.match(m, /1\. \[high\] Race in save\(\)/);
  assert.match(m, /Suggestion: lock/);
  assert.match(m, /Note from the user: keep the API stable/);
  assert.match(m, /NOT to act on: "Rename var"/);
  assert.doesNotMatch(m, /\n2\. /);
});

test("context and prompt tell the reviewer where to read and write, and not to edit", () => {
  const ctx = buildContext(run, { output: "PLAN: add retry", diff: "" });
  assert.match(ctx, /focus on races/);
  assert.match(ctx, /PLAN: add retry/);
  assert.match(ctx, /no uncommitted changes/);
  const p = reviewPrompt(run, ".second-opinion/r/context.md", ".second-opinion/r/findings-1.json");
  assert.match(p, /Do NOT edit any project files/);
  assert.match(p, /findings-1\.json/);
});

test("declined findings are passed to the next review so they aren't repeated", () => {
  const p = reviewPrompt(run, "c.md", "f.json", ["Stale tabs can undo clearing"]);
  assert.match(p, /chose NOT to act on these earlier findings: "Stale tabs can undo clearing"/);
  assert.doesNotMatch(reviewPrompt(run, "c.md", "f.json", []), /chose NOT to act/);
});
