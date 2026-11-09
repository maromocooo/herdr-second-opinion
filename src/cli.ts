#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  listRuns, loadRun, newRunId, returnMessage, reviewerFor, saveRun, type Finding, type Run, type Subject,
} from "./core.js";
import { cli, getAgent, notify, pluginContext } from "./herdr.js";
import { nextPending, runReview } from "./review.js";
import { askLine, c, clear, done, nextKey, wrap } from "./ui.js";
import { BUILTIN, getLang, langLabel, nextLang, normalizeLang, setLang, t, type Lang } from "./i18n.js";

const HELP = `second-opinion — get a second opinion from another coding agent, then send back what you adopt.

Inside herdr (plugin):
  ask      popup: choose what to review for the focused agent and start the reviewer
  pick     popup: choose which findings to send back (opens automatically when ready)
  review   background worker (started by "ask"; you don't run it yourself)

Debug:
  second-opinion list            recent runs
  second-opinion ask --pane <id> start from a specific agent pane
`;

const SEV = { high: c.red("high"), medium: c.yellow("med "), low: c.dim("low ") } as const;

function hasDiff(cwd: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

async function startWorker() {
  await cli(["plugin", "action", "invoke", "second-opinion.review"]);
}

// ---------------- ask ----------------
/** Non-interactive start (scripts/tests): second-opinion ask --pane <id> --subject both --note "…" --yes */
async function askNow(pane: string, subject: Subject, note: string, autoPick: boolean, lang: Lang) {
  const origin = await getAgent(pane);
  if (!origin) throw new Error(`${pane} is not an agent pane`);
  const run: Run = {
    id: newRunId(), createdAt: new Date().toISOString(), status: "pending",
    originPane: pane, originAgent: origin.agent, reviewerKind: reviewerFor(origin.agent),
    cwd: origin.foreground_cwd ?? origin.cwd ?? process.cwd(), subject, note, round: 0, dir: "", autoPick, lang,
  };
  saveRun(run);
  await startWorker();
  console.log(run.id);
}

async function ask(paneArg?: string) {
  const ctx = pluginContext();
  const pane = paneArg ?? ctx.focused_pane_id;
  if (!pane) throw new Error("no focused pane");
  let lang = getLang();
  const origin = await getAgent(pane);
  if (!origin) {
    clear();
    console.log(c.yellow(t(lang, "notAgent")));
    console.log(t(lang, "focusAgent"));
    await nextKey();
    return done(1);
  }
  const cwd = origin.foreground_cwd ?? origin.cwd ?? ctx.focused_pane_cwd ?? process.cwd();
  const reviewer = reviewerFor(origin.agent);
  const diffAvailable = hasDiff(cwd);
  const who = reviewer === "codex" ? "Codex" : "Claude";
  const choices = (): { key: string; subject: Subject; label: string }[] => [
    { key: "1", subject: "output", label: t(lang, "optOutput", origin.agent) },
    { key: "2", subject: "diff", label: diffAvailable ? t(lang, "optDiff") : c.dim(t(lang, "optDiffNone")) },
    { key: "3", subject: "both", label: t(lang, "optBoth") },
  ];
  let sel = diffAvailable ? 2 : 0;
  for (;;) {
    clear();
    console.log(c.bold(t(lang, "askTitle", who, origin.agent, pane)));
    console.log(c.dim(cwd));
    console.log("");
    console.log(t(lang, "whatReview"));
    choices().forEach((ch, i) => console.log(`${i === sel ? c.cyan("›") : " "} ${ch.key}  ${ch.label}`));
    console.log("");
    console.log(c.dim(t(lang, "langLine", langLabel(lang))));
    console.log(c.dim(t(lang, "askKeys")));
    const k = await nextKey();
    if (k.name === "escape" || (k.ctrl && k.name === "c") || k.name === "q") return done(0);
    if (k.name === "l") {
      lang = nextLang(lang);
      setLang(lang); // remembered for next time
      continue;
    }
    if (k.name === "up" || k.name === "k") sel = (sel + 2) % 3;
    else if (k.name === "down" || k.name === "j") sel = (sel + 1) % 3;
    else if (["1", "2", "3"].includes(k.sequence ?? "")) sel = Number(k.sequence) - 1;
    else if (k.name === "return") break;
  }
  console.log("");
  const note = (await askLine(c.cyan(t(lang, "focusPrompt")) + c.dim(t(lang, "optionalSkip")))).trim();
  const run: Run = {
    id: newRunId(),
    createdAt: new Date().toISOString(),
    status: "pending",
    originPane: pane,
    originAgent: origin.agent,
    reviewerKind: reviewer,
    cwd,
    subject: choices()[sel].subject,
    note,
    round: 0,
    dir: "",
    lang,
  };
  saveRun(run);
  await startWorker();
  console.log("");
  console.log(c.green(t(lang, "willOpen", who)));
  console.log(c.dim(t(lang, "willNotify")));
  await new Promise((r) => setTimeout(r, 1800));
  return done(0);
}

// ---------------- review (background action) ----------------
async function reviewWorker() {
  const log = (s: string) => process.stdout.write(`${new Date().toLocaleTimeString()} ${s}\n`);
  for (let run = nextPending(); run; run = nextPending()) {
    const followUp = run.followUp;
    run.followUp = undefined;
    try {
      await runReview(run, log, followUp);
      const n = run.findings?.findings.length ?? 0;
      const lang = run.lang ?? "en";
      await notify("second-opinion", n ? t(lang, "readyN", String(n)) : t(lang, "readyNone"), "done");
      if (run.autoPick !== false) await cli(["plugin", "pane", "open", "--plugin", "second-opinion", "--entrypoint", "pick"]).catch(async () => {
        await notify("second-opinion", t(lang, "openPicker"), "request");
      });
    } catch (err) {
      run.status = "failed";
      run.error = String((err as Error).message ?? err);
      saveRun(run);
      log(`failed: ${run.error}`);
      await notify("second-opinion", t(run.lang ?? "en", "failed", run.error.slice(0, 120)), "request");
    }
  }
}

// ---------------- pick ----------------
function renderFinding(f: Finding, on: boolean, cursor: boolean, lang: Lang): string[] {
  const box = on ? c.green("[x]") : "[ ]";
  const head = `${cursor ? c.cyan("›") : " "} ${box} ${SEV[f.severity]}  ${cursor ? c.bold(f.title) : f.title}`;
  if (!cursor) return [head];
  const body: string[] = [];
  if (f.detail) body.push(...wrap(f.detail, "         "));
  if (f.evidence) body.push(...wrap(`${t(lang, "evidence")}: ${f.evidence}`, "         ").map(c.dim));
  if (f.suggestion) body.push(...wrap(`${t(lang, "suggest")}: ${f.suggestion}`, "         ").map(c.cyan));
  return [head, ...body];
}

async function pick(runId?: string) {
  const run = runId ? loadRun(runId) : listRuns().find((r) => r.status === "reviewed") ?? null;
  if (!run || !run.findings) {
    clear();
    console.log(t(getLang(), "noReview"));
    await nextKey();
    return done(0);
  }
  const fs = run.findings.findings;
  // Nothing is preselected: every point sent back is one the user chose.
  const on = new Set<number>();
  let cur = 0;
  const who = run.reviewerKind === "codex" ? "Codex" : "Claude";
  const lang: Lang = run.lang ?? getLang();
  for (;;) {
    clear();
    console.log(c.bold(t(lang, "pickTitle", who)) + c.dim(t(lang, "pickSub", run.originAgent, run.originPane, String(run.round))));
    if (run.findings.summary) wrap(run.findings.summary, "").forEach((l) => console.log(c.dim(l)));
    console.log("");
    if (!fs.length) console.log(c.green(t(lang, "noIssues")));
    fs.forEach((f, i) => renderFinding(f, on.has(f.id), i === cur, lang).forEach((l) => console.log(l)));
    console.log("");
    console.log(c.dim(t(lang, "pickKeys", String(on.size))));
    const k = await nextKey();
    if (k.name === "q" || k.name === "escape" || (k.ctrl && k.name === "c")) return done(0);
    if ((k.name === "up" || k.name === "k") && fs.length) cur = (cur + fs.length - 1) % fs.length;
    else if ((k.name === "down" || k.name === "j") && fs.length) cur = (cur + 1) % fs.length;
    else if (k.name === "space" && fs[cur]) on.has(fs[cur].id) ? on.delete(fs[cur].id) : on.add(fs[cur].id);
    else if (k.name === "a") on.size === fs.length ? on.clear() : fs.forEach((f) => on.add(f.id));
    else if (k.name === "d") {
      run.status = "discarded";
      saveRun(run);
      return done(0);
    } else if (k.name === "f") {
      console.log("");
      const q = (await askLine(c.cyan(t(lang, "followUpQ", who)))).trim();
      if (!q) continue;
      run.followUp = q;
      run.status = "pending";
      saveRun(run);
      await startWorker();
      console.log(c.green(t(lang, "followUpSent", who)));
      await new Promise((r) => setTimeout(r, 1500));
      return done(0);
    } else if (k.name === "return") {
      const adopted = fs.filter((f) => on.has(f.id));
      if (!adopted.length) continue;
      console.log("");
      const note = await askLine(c.cyan(t(lang, "noteFor", run.originAgent)) + c.dim(t(lang, "optionalSend")));
      const msg = returnMessage(run, adopted, fs.filter((f) => !on.has(f.id)), note);
      // Show exactly what will be sent before sending it.
      clear();
      console.log(c.bold(t(lang, "previewTitle", run.originAgent, run.originPane)));
      console.log(c.dim("─".repeat(Math.min(80, process.stdout.columns ?? 80))));
      for (const l of msg.split("\n")) wrap(l, "").forEach((x) => console.log(x));
      console.log(c.dim("─".repeat(Math.min(80, process.stdout.columns ?? 80))));
      console.log(c.cyan(t(lang, "confirm")) + c.dim(t(lang, "confirmKeys")));
      const confirm = await nextKey();
      if (confirm.name !== "y") continue;
      const origin = await getAgent(run.originPane);
      if (!origin) {
        console.log(c.red(t(lang, "gone", run.originAgent, run.originPane)));
        await nextKey();
        return done(1);
      }
      if (origin.agent_status === "working" || origin.agent_status === "blocked") {
        console.log(c.dim(t(lang, "busy", run.originAgent)));
        await cli(["agent", "wait", run.originPane, "--until", "idle", "--until", "done"], 24 * 3600 * 1000);
      }
      await cli(["agent", "prompt", run.originPane, msg]);
      run.status = "sent";
      run.declined = fs.filter((f) => !on.has(f.id)).map((f) => f.title);
      saveRun(run);
      await cli(["pane", "focus", run.originPane]).catch(() => {});
      console.log(c.green(t(lang, "sent", String(adopted.length), run.originAgent)));
      await new Promise((r) => setTimeout(r, 1000));
      return done(0);
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pane: { type: "string" },
      run: { type: "string" },
      subject: { type: "string" },
      note: { type: "string" },
      yes: { type: "boolean" },
      "no-pick": { type: "boolean" },
      lang: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0] ?? "help";
  if (values.help || cmd === "help") return void process.stdout.write(HELP);
  if (cmd === "ask" && values.yes) {
    if (!values.pane) throw new Error("--yes needs --pane");
    const subject = (["output", "diff", "both"].includes(values.subject ?? "") ? values.subject : "both") as Subject;
    const lang: Lang = (values.lang && normalizeLang(values.lang)) || getLang();
    return askNow(values.pane, subject, values.note ?? "", !values["no-pick"], lang);
  }
  if (cmd === "ask") return ask(values.pane);
  if (cmd === "lang") {
    const v = positionals.slice(1).join(" ");
    if (v) {
      const n = normalizeLang(v);
      if (!n) throw new Error(`not a language name: ${v}`);
      setLang(n);
    }
    const cur = getLang();
    console.log(`${cur} (${langLabel(cur)})`);
    if (!v) console.log(`built-in UI: ${BUILTIN.map((b) => `${b.code}=${b.label}`).join(", ")}; any other language name works for reviews`);
    return;
  }
  if (cmd === "review") return reviewWorker();
  if (cmd === "pick") return pick(values.run);
  if (cmd === "list") {
    for (const r of listRuns().slice(0, 15)) {
      console.log(`${r.id}  ${r.status.padEnd(9)} ${r.originAgent}@${r.originPane} → ${r.reviewerKind}@${r.reviewerPane ?? "-"}  ${r.findings?.findings.length ?? "-"} finding(s)${r.error ? "  " + r.error : ""}`);
    }
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch(async (err) => {
  process.stderr.write(`second-opinion: ${String((err as Error).message ?? err)}\n`);
  if (process.stdout.isTTY && (process.argv[2] === "ask" || process.argv[2] === "pick")) {
    process.stdout.write("\nPress any key to close.");
    await nextKey().catch(() => {});
  }
  done(1);
});
