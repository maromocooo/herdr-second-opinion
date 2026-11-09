import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildContext, declinedFor, followUpPrompt, lastReviewerFor, listRuns, parseFindings, reviewPrompt, saveRun, type Run,
} from "./core.js";
import { cli, getAgent, notify, paneExists, readAgent } from "./herdr.js";
import { t, type Lang } from "./i18n.js";

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Working files live in the repo (so the reviewer can read/write them) but stay out of git. */
export function prepareRunDir(run: Run): string {
  const root = fs.realpathSync(git(run.cwd, ["rev-parse", "--show-toplevel"])?.trim() || run.cwd);
  const base = path.join(root, ".second-opinion");
  // Never follow a symlinked working dir out of the repo.
  const st = fs.lstatSync(base, { throwIfNoEntry: false });
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${base} is not a plain directory; refusing to use it`);
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, run.id);
  fs.mkdirSync(dir); // fails if it already exists
  if (fs.realpathSync(dir) !== dir) throw new Error(`${dir} resolves elsewhere; refusing to use it`);
  const exclude = git(root, ["rev-parse", "--git-path", "info/exclude"])?.trim();
  if (exclude) {
    const f = path.resolve(root, exclude);
    const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    if (!cur.split("\n").includes(".second-opinion/")) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `${cur === "" || cur.endsWith("\n") ? "" : "\n"}.second-opinion/\n`);
    }
  }
  return dir;
}

async function gatherMaterial(run: Run): Promise<{ output?: string; diff?: string }> {
  const m: { output?: string; diff?: string } = {};
  if (run.subject !== "diff") m.output = (await readAgent(run.originPane, 160)).trim().slice(-24000);
  if (run.subject !== "output") {
    const diff = git(run.cwd, ["diff", "HEAD", "--no-color"]) ?? git(run.cwd, ["diff", "--no-color"]) ?? "";
    const untracked = git(run.cwd, ["ls-files", "--others", "--exclude-standard"])?.trim();
    m.diff = (diff + (untracked ? `\n# untracked files:\n${untracked}\n` : "")).slice(0, 40000);
  }
  return m;
}

/**
 * A freshly split pane needs a moment before its shell shows a prompt (longer with a heavy .zshrc);
 * until then herdr answers agent_pane_busy. Retry until the shell is ready.
 */
async function startWhenShellReady(name: string, kind: string, pane: string): Promise<void> {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await cli(["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "90000"], 120000);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "agent_pane_busy" || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Reuse this origin's reviewer pane when it is still alive (keeps its context); otherwise open one. */
async function ensureReviewer(run: Run, log: (s: string) => void): Promise<{ pane: string; name: string }> {
  const prev = lastReviewerFor(run.originPane);
  if (prev && (await paneExists(prev.pane))) {
    const a = await getAgent(prev.pane);
    if (a && a.agent === run.reviewerKind) {
      log(`reusing ${run.reviewerKind} in ${prev.pane}`);
      return prev;
    }
  }
  const split = await cli<{ pane: { pane_id: string } }>(["pane", "split", run.originPane, "--direction", "right", "--cwd", run.cwd]);
  const pane = split.pane.pane_id;
  // herdr agent names: lowercase letters, digits, '-' or '_', max 32 chars.
  const name = `so-${run.originPane.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${run.id.slice(-6)}`.slice(0, 32);
  log(`starting ${run.reviewerKind} in ${pane}`);
  try {
    await startWhenShellReady(name, run.reviewerKind, pane);
  } catch (err) {
    if ((err as { code?: string }).code !== "agent_not_ready") {
      await cli(["pane", "close", pane]).catch(() => {}); // don't leave an empty split behind
      throw err;
    }
    // e.g. a "trust this folder?" prompt: the user answers it in the pane; we wait.
    await notify("second-opinion", t(run.lang ?? "en", "needAnswer", run.reviewerKind, pane), "request");
    await cli(["agent", "wait", name, "--until", "idle", "--until", "done", "--timeout", "600000"], 610000);
  }
  return { pane, name };
}

/** Wait for the reviewer to finish, surfacing approval prompts to the user instead of answering them. */
async function waitSettled(name: string, pane: string, timeoutMs: number, lang: Lang = "en"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  while (Date.now() < deadline) {
    const left = Math.max(1000, deadline - Date.now());
    const r = await cli<{ agent?: { agent_status?: string } }>(["agent", "wait", name, "--timeout", String(left)], left + 10000);
    const status = r?.agent?.agent_status;
    if (status !== "blocked") return;
    if (!warned) {
      await notify("second-opinion", t(lang, "approval", pane), "request");
      warned = true;
    }
    await cli(["agent", "wait", name, "--until", "working", "--until", "idle", "--until", "done", "--timeout", String(left)], left + 10000).catch(() => {});
  }
  throw new Error("reviewer did not finish in time");
}

/**
 * Submit the prompt and wait for the reviewer to work and settle. `--wait` makes herdr confirm the agent
 * actually started (a TUI still booting can drop input); if it stalls, retry once.
 */
async function submitAndWait(name: string, pane: string, prompt: string, lang: Lang = "en"): Promise<void> {
  const total = 30 * 60 * 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await cli<{ agent?: { agent_status?: string } }>(
        ["agent", "prompt", name, prompt, "--wait", "--timeout", String(total)],
        total + 30000,
      );
      if (r?.agent?.agent_status === "blocked") await waitSettled(name, pane, total, lang);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "agent_prompt_stalled" && attempt < 2) {
        await new Promise((res) => setTimeout(res, 4000));
        continue;
      }
      if (code === "agent_blocked") {
        await notify("second-opinion", t(lang, "waitingPrompt", pane), "request");
      }
      throw err;
    }
  }
}

/** Run (or continue) the review for one run. Called from the background `review` action. */
export async function runReview(run: Run, log: (s: string) => void, followUp?: string): Promise<Run> {
  run.dir = run.dir || prepareRunDir(run);
  const relBase = path.relative(run.cwd, run.dir) || ".";
  const contextRel = path.join(relBase, "context.md");
  if (!followUp) {
    run.status = "reviewing";
    saveRun(run);
    // "wx": create only; never write through a pre-existing file or symlink.
    fs.writeFileSync(path.join(run.dir, "context.md"), buildContext(run, await gatherMaterial(run)), { flag: "wx" });
  }
  run.round += 1;
  const findingsRel = path.join(relBase, `findings-${run.round}.json`);
  const findingsAbs = path.join(run.dir, `findings-${run.round}.json`);
  fs.rmSync(findingsAbs, { force: true });

  const reviewer = run.reviewerPane && run.reviewerName && followUp ? { pane: run.reviewerPane, name: run.reviewerName } : await ensureReviewer(run, log);
  run.reviewerPane = reviewer.pane;
  run.reviewerName = reviewer.name;
  run.status = "reviewing";
  saveRun(run);

  const prompt = followUp
    ? followUpPrompt(followUp, contextRel, findingsRel, run.lang)
    : reviewPrompt(run, contextRel, findingsRel, declinedFor(run.originPane));
  log(`asking ${run.reviewerKind} (round ${run.round})…`);
  await submitAndWait(reviewer.name, reviewer.pane, prompt, run.lang ?? "en");

  if (!fs.existsSync(findingsAbs)) {
    run.status = "failed";
    run.error = `the reviewer finished without writing ${findingsRel} — see pane ${reviewer.pane}`;
    saveRun(run);
    throw new Error(run.error);
  }
  const fst = fs.lstatSync(findingsAbs);
  if (!fst.isFile() || fst.size > 1024 * 1024) throw new Error(`${findingsRel} is not a regular file (or too large); ignoring it`);
  run.findings = parseFindings(fs.readFileSync(findingsAbs, "utf8"));
  run.status = "reviewed";
  run.error = undefined;
  saveRun(run);
  return run;
}

/** Most recent run waiting for the background worker. */
export function nextPending(): Run | null {
  return listRuns().find((r) => r.status === "pending") ?? null;
}
