import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Lang = "en" | "ja";

/** Plugin config lives where herdr puts plugin config (also used when run outside herdr). */
function configFile(): string {
  const dir =
    process.env.HERDR_PLUGIN_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr", "plugins", "config", "second-opinion");
  return path.join(dir, "config.json");
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

/** The saved language, else a Japanese locale → ja, else en. */
export function getLang(): Lang {
  const v = readConfig().language;
  if (v === "ja" || v === "en") return v;
  const loc = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  return loc.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function setLang(lang: Lang): void {
  const f = configFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...readConfig(), language: lang }, null, 2) + "\n");
}

type Dict = Record<string, (...a: string[]) => string>;

const en: Dict = {
  notAgent: () => "The focused pane is not a coding agent.",
  focusAgent: () => "Focus a Claude Code / Codex pane and try again.",
  askTitle: (who, agent, pane) => `Second opinion from ${who}  ` + `\x1b[2mfor ${agent} in ${pane}\x1b[0m`,
  whatReview: () => "What should it review?",
  optOutput: (agent) => `${agent}'s latest output (its plan / answer)`,
  optDiff: () => "uncommitted changes (git diff)",
  optDiffNone: () => "uncommitted changes (none right now)",
  optBoth: () => "both",
  askKeys: () => "↑↓ / 1-3 choose · Enter next · l language · Esc cancel",
  langLine: () => "Language: English",
  focusPrompt: () => "Anything to focus on? ",
  optionalSkip: () => "(optional, Enter to skip) ",
  willOpen: (who) => `✓ ${who} will open on the right. You can watch it and type to it.`,
  willNotify: () => "You'll get a notification and a picker when the findings are ready.",
  readyN: (n) => `${n} finding(s) ready — pick what to send back`,
  readyNone: () => "No issues found",
  openPicker: () => "Open the picker with the second-opinion.pick action",
  failed: (e) => `Review failed: ${e}`,
  needAnswer: (who, pane) => `${who} needs your answer in pane ${pane}`,
  approval: (pane) => `The reviewer is asking for approval in pane ${pane}`,
  waitingPrompt: (pane) => `The reviewer is waiting on a prompt in pane ${pane}`,
  noReview: () => "No review is waiting. Start one with the second-opinion.ask action.",
  pickTitle: (who) => `${who}'s second opinion`,
  pickSub: (agent, pane, round) => `  → back to ${agent} in ${pane} · round ${round}`,
  noIssues: () => "No issues found.",
  pickKeys: (n) => `↑↓ move · Space toggle · a all/none · Enter review & send (${n} selected) · f ask a follow-up · d discard · q later`,
  followUpQ: (who) => `Follow-up for ${who}: `,
  followUpSent: (who) => `✓ Sent to ${who}. The picker reopens when it answers.`,
  noteFor: (agent) => `Note for ${agent} `,
  optionalSend: () => "(optional, Enter to continue) ",
  previewTitle: (agent, pane) => `This will be sent to ${agent} in ${pane}:`,
  confirm: () => "Send it? ",
  confirmKeys: () => "y = send · any other key = back",
  gone: (agent, pane) => `${agent} in ${pane} is gone. Nothing was sent.`,
  busy: (agent) => `${agent} is busy — waiting until it's ready (Ctrl-C to cancel)…`,
  sent: (n, agent) => `✓ Sent ${n} point(s) to ${agent}.`,
  evidence: () => "evidence",
  suggest: () => "suggest ",
};

const ja: Dict = {
  notAgent: () => "フォーカス中のペインはコーディングエージェントではありません。",
  focusAgent: () => "Claude Code か Codex のペインにフォーカスしてから、もう一度試してください。",
  askTitle: (who, agent, pane) => `${who} にセカンドオピニオンを依頼  ` + `\x1b[2m${pane} の ${agent} について\x1b[0m`,
  whatReview: () => "何をレビューしてもらいますか？",
  optOutput: (agent) => `${agent} の直近の出力（計画・回答）`,
  optDiff: () => "未コミットの変更（git diff）",
  optDiffNone: () => "未コミットの変更（今はありません）",
  optBoth: () => "両方",
  askKeys: () => "↑↓ / 1-3 選択 · Enter 次へ · l 言語 · Esc キャンセル",
  langLine: () => "言語: 日本語",
  focusPrompt: () => "重点的に見てほしい点は？ ",
  optionalSkip: () => "（任意・Enter でスキップ） ",
  willOpen: (who) => `✓ 右側に ${who} が開きます。様子を見たり話しかけたりできます。`,
  willNotify: () => "指摘がそろったら、通知と選択画面でお知らせします。",
  readyN: (n) => `指摘が ${n} 件そろいました。返すものを選んでください`,
  readyNone: () => "問題は見つかりませんでした",
  openPicker: () => "second-opinion.pick アクションで選択画面を開いてください",
  failed: (e) => `レビューに失敗しました: ${e}`,
  needAnswer: (who, pane) => `${pane} の ${who} があなたの回答を待っています`,
  approval: (pane) => `${pane} のレビュー役が承認を待っています`,
  waitingPrompt: (pane) => `${pane} のレビュー役が確認画面で止まっています`,
  noReview: () => "待機中のレビューはありません。second-opinion.ask アクションから始めてください。",
  pickTitle: (who) => `${who} のセカンドオピニオン`,
  pickSub: (agent, pane, round) => `  → ${pane} の ${agent} に返す · ${round} 回目`,
  noIssues: () => "問題は見つかりませんでした。",
  pickKeys: (n) => `↑↓ 移動 · Space 選択 · a 全選択/解除 · Enter 確認して送る（${n} 件選択中） · f 追加で質問 · d 破棄 · q あとで`,
  followUpQ: (who) => `${who} への追加の質問: `,
  followUpSent: (who) => `✓ ${who} に送りました。回答が来たら選択画面がまた開きます。`,
  noteFor: (agent) => `${agent} へのメモ `,
  optionalSend: () => "（任意・Enter で次へ） ",
  previewTitle: (agent, pane) => `${pane} の ${agent} に次の内容を送ります:`,
  confirm: () => "送信しますか？ ",
  confirmKeys: () => "y 送信 · ほかのキー 戻る",
  gone: (agent, pane) => `${pane} の ${agent} が見つかりません。何も送っていません。`,
  busy: (agent) => `${agent} が作業中です。終わるまで待っています（Ctrl-C で中止）…`,
  sent: (n, agent) => `✓ ${agent} に ${n} 件送りました。`,
  evidence: () => "根拠",
  suggest: () => "提案",
};

export function t(lang: Lang, key: keyof typeof en, ...args: string[]): string {
  return (lang === "ja" ? ja : en)[key](...args);
}
