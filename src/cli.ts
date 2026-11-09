#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  listRuns, loadRun, newRunId, returnMessage, reviewerFor, saveRun, type Finding, type Run, type Subject,
} from "./core.js";
import { cli, getAgent, notify, pluginContext } from "./herdr.js";
import { nextPending, runReview } from "./review.js";
import { askLine, c, clear, done, nextKey, wrap } from "./ui.js";

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
async function askNow(pane: string, subject: Subject, note: string, autoPick: boolean) {
  const origin = await getAgent(pane);
  if (!origin) throw new Error(`${pane} is not an agent pane`);
  const run: Run = {
    id: newRunId(), createdAt: new Date().toISOString(), status: "pending",
    originPane: pane, originAgent: origin.agent, reviewerKind: reviewerFor(origin.agent),
    cwd: origin.foreground_cwd ?? origin.cwd ?? process.cwd(), subject, note, round: 0, dir: "", autoPick,
  };
  saveRun(run);
  await startWorker();
  console.log(run.id);
}

async function ask(paneArg?: string) {
  const ctx = pluginContext();
  const pane = paneArg ?? ctx.focused_pane_id;
  if (!pane) throw new Error("no focused pane");
  const origin = await getAgent(pane);
  if (!origin) {
    clear();
    console.log(c.yellow("The focused pane is not a coding agent."));
    console.log("Focus a Claude Code / Codex pane and try again.");
    await nextKey();
    return done(1);
  }
  const cwd = origin.foreground_cwd ?? origin.cwd ?? ctx.focused_pane_cwd ?? process.cwd();
  const reviewer = reviewerFor(origin.agent);
  const diffAvailable = hasDiff(cwd);
  const choices: { key: string; subject: Subject; label: string }[] = [
    { key: "1", subject: "output", label: `${origin.agent}'s latest output (its plan / answer)` },
    { key: "2", subject: "diff", label: diffAvailable ? "uncommitted changes (git diff)" : c.dim("uncommitted changes (none right now)") },
    { key: "3", subject: "both", label: "both" },
  ];
  let sel = diffAvailable ? 2 : 0;
  for (;;) {
    clear();
    console.log(c.bold(`Second opinion from ${reviewer === "codex" ? "Codex" : "Claude"}`) + c.dim(`  for ${origin.agent} in ${pane}`));
    console.log(c.dim(cwd));
    console.log("");
    console.log("What should it review?");
    choices.forEach((ch, i) => console.log(`${i === sel ? c.cyan("›") : " "} ${ch.key}  ${ch.label}`));
    console.log("");
    console.log(c.dim("↑↓ / 1-3 choose · Enter next · Esc cancel"));
    const k = await nextKey();
    if (k.name === "escape" || (k.ctrl && k.name === "c") || k.name === "q") return done(0);
    if (k.name === "up" || k.name === "k") sel = (sel + 2) % 3;
    else if (k.name === "down" || k.name === "j") sel = (sel + 1) % 3;
    else if (["1", "2", "3"].includes(k.sequence ?? "")) sel = Number(k.sequence) - 1;
    else if (k.name === "return") break;
  }
  console.log("");
  const note = (await askLine(c.cyan("Anything to focus on? ") + c.dim("(optional, Enter to skip) "))).trim();
  const run: Run = {
    id: newRunId(),
    createdAt: new Date().toISOString(),
    status: "pending",
    originPane: pane,
    originAgent: origin.agent,
    reviewerKind: reviewer,
    cwd,
    subject: choices[sel].subject,
    note,
    round: 0,
    dir: "",
  };
  saveRun(run);
  await startWorker();
  console.log("");
  console.log(c.green(`✓ ${reviewer === "codex" ? "Codex" : "Claude"} will open on the right.`) + " You can watch it and type to it.");
  console.log(c.dim("You'll get a notification and a picker when the findings are ready."));
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
      await notify("second-opinion", n ? `${n} finding(s) ready — pick what to send back` : "No issues found", "done");
      if (run.autoPick !== false) await cli(["plugin", "pane", "open", "--plugin", "second-opinion", "--entrypoint", "pick"]).catch(async () => {
        await notify("second-opinion", "Open the picker with the second-opinion.pick action", "request");
      });
    } catch (err) {
      run.status = "failed";
      run.error = String((err as Error).message ?? err);
      saveRun(run);
      log(`failed: ${run.error}`);
      await notify("second-opinion", `Review failed: ${run.error.slice(0, 120)}`, "request");
    }
  }
}

// ---------------- pick ----------------
function renderFinding(f: Finding, on: boolean, cursor: boolean): string[] {
  const box = on ? c.green("[x]") : "[ ]";
  const head = `${cursor ? c.cyan("›") : " "} ${box} ${SEV[f.severity]}  ${cursor ? c.bold(f.title) : f.title}`;
  if (!cursor) return [head];
  const body: string[] = [];
  if (f.detail) body.push(...wrap(f.detail, "         "));
  if (f.evidence) body.push(...wrap(`evidence: ${f.evidence}`, "         ").map(c.dim));
  if (f.suggestion) body.push(...wrap(`suggest:  ${f.suggestion}`, "         ").map(c.cyan));
  return [head, ...body];
}

async function pick(runId?: string) {
  const run = runId ? loadRun(runId) : listRuns().find((r) => r.status === "reviewed") ?? null;
  if (!run || !run.findings) {
    clear();
    console.log("No review is waiting. Start one with the second-opinion.ask action.");
    await nextKey();
    return done(0);
  }
  const fs = run.findings.findings;
  const on = new Set(fs.filter((f) => f.severity !== "low").map((f) => f.id));
  let cur = 0;
  const who = run.reviewerKind === "codex" ? "Codex" : "Claude";
  for (;;) {
    clear();
    console.log(c.bold(`${who}'s second opinion`) + c.dim(`  → back to ${run.originAgent} in ${run.originPane} · round ${run.round}`));
    if (run.findings.summary) wrap(run.findings.summary, "").forEach((l) => console.log(c.dim(l)));
    console.log("");
    if (!fs.length) console.log(c.green("No issues found."));
    fs.forEach((f, i) => renderFinding(f, on.has(f.id), i === cur).forEach((l) => console.log(l)));
    console.log("");
    console.log(c.dim("↑↓ move · Space toggle · a all/none · Enter send selected · f ask a follow-up · d discard · q later"));
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
      const q = (await askLine(c.cyan(`Follow-up for ${who}: `))).trim();
      if (!q) continue;
      run.followUp = q;
      run.status = "pending";
      saveRun(run);
      await startWorker();
      console.log(c.green(`✓ Sent to ${who}. The picker reopens when it answers.`));
      await new Promise((r) => setTimeout(r, 1500));
      return done(0);
    } else if (k.name === "return") {
      const adopted = fs.filter((f) => on.has(f.id));
      if (!adopted.length) continue;
      console.log("");
      const note = await askLine(c.cyan(`Note for ${run.originAgent} `) + c.dim("(optional, Enter to send) "));
      const msg = returnMessage(run, adopted, fs.filter((f) => !on.has(f.id)), note);
      const origin = await getAgent(run.originPane);
      if (!origin) {
        console.log(c.red(`${run.originAgent} in ${run.originPane} is gone. Nothing was sent.`));
        await nextKey();
        return done(1);
      }
      if (origin.agent_status === "working" || origin.agent_status === "blocked") {
        console.log(c.dim(`${run.originAgent} is busy — waiting until it's ready (Ctrl-C to cancel)…`));
        await cli(["agent", "wait", run.originPane, "--until", "idle", "--until", "done"], 24 * 3600 * 1000);
      }
      await cli(["agent", "prompt", run.originPane, msg]);
      run.status = "sent";
      run.declined = fs.filter((f) => !on.has(f.id)).map((f) => f.title);
      saveRun(run);
      await cli(["pane", "focus", run.originPane]).catch(() => {});
      console.log(c.green(`✓ Sent ${adopted.length} point(s) to ${run.originAgent}.`));
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
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0] ?? "help";
  if (values.help || cmd === "help") return void process.stdout.write(HELP);
  if (cmd === "ask" && values.yes) {
    if (!values.pane) throw new Error("--yes needs --pane");
    const subject = (["output", "diff", "both"].includes(values.subject ?? "") ? values.subject : "both") as Subject;
    return askNow(values.pane, subject, values.note ?? "", !values["no-pick"]);
  }
  if (cmd === "ask") return ask(values.pane);
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
