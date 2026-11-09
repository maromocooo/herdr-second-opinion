import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface Agent {
  pane_id: string;
  workspace_id: string;
  tab_id?: string;
  agent: string;
  agent_status: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused?: boolean;
  terminal_title_stripped?: string;
}

export interface PluginContext {
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  focused_pane_agent?: string | null;
  focused_pane_status?: string;
  workspace_id?: string;
}

export function pluginContext(): PluginContext {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as PluginContext;
  } catch {
    return {};
  }
}

function socketPath(): string {
  const p = [process.env.HERDR_SOCKET_PATH, path.join(os.homedir(), ".config", "herdr", "herdr.sock")].find(
    (x): x is string => !!x && fs.existsSync(x),
  );
  if (!p) throw new Error("herdr socket not found — is herdr running?");
  return p;
}

let seq = 0;
/** One newline-delimited JSON request over the herdr socket. */
export function request<T = unknown>(method: string, params: object = {}, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `so_${process.pid}_${++seq}`;
    const s = net.connect(socketPath());
    let buf = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`herdr ${method} timed out`));
    }, timeoutMs);
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: string; result?: T; error?: { code: string; message: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        s.end();
        if (msg.error) reject(Object.assign(new Error(`${msg.error.code}: ${msg.error.message}`), { code: msg.error.code }));
        else resolve(msg.result as T);
      }
    });
    s.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/** Run the herdr CLI (argv, no shell) and parse its JSON output. */
export function cli<T = unknown>(args: string[], timeoutMs = 60000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(herdrBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = (code === 0 ? out : err || out).trim();
      let json: { result?: T; error?: { code: string; message: string } } | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (code === 0) resolve((json?.result ?? (text as unknown)) as T);
      else {
        const e = json?.error;
        reject(Object.assign(new Error(e ? `${e.code}: ${e.message}` : text || `herdr ${args[0]} failed (${code})`), { code: e?.code }));
      }
    });
  });
}

export async function listAgents(): Promise<Agent[]> {
  return (await request<{ agents: Agent[] }>("agent.list")).agents ?? [];
}

export async function getAgent(target: string): Promise<Agent | null> {
  return (await listAgents()).find((a) => a.pane_id === target) ?? null;
}

export async function paneExists(paneId: string): Promise<boolean> {
  const r = await request<{ panes: { pane_id: string }[] }>("pane.list");
  return (r.panes ?? []).some((p) => p.pane_id === paneId);
}

export async function readAgent(pane: string, lines: number): Promise<string> {
  const r = await cli<unknown>(["agent", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)]).catch(() => "");
  return typeof r === "string" ? r : ((r as { text?: string })?.text ?? JSON.stringify(r));
}

export async function notify(title: string, body: string, sound: "done" | "request" | "none" = "done"): Promise<void> {
  await cli(["notification", "show", title, "--body", body, "--sound", sound]).catch(() => {});
}
