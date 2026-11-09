# herdr-second-opinion

**Get a second opinion from another coding agent without leaving your session.** Watch it in a split, steer it, and send back only the findings you adopt.

[English](README.md) | [日本語](README.ja.md)

A [herdr](https://github.com/herdrdev/herdr) plugin. You're working with Claude Code (or Codex) and want the other one to look over the plan or the diff. Normally that means copying text between panes, waiting, and pasting the answer back. This plugin does that round trip for you:

1. **Press a key** on the agent you're working with and choose what to review: its latest output (plan / answer), the uncommitted diff, or both. Add a note if you like ("focus on races").
2. **The other agent opens in a split on the right** and reviews it. It's a normal pane, so you can watch it and type to it at any time.
3. **A picker pops up** with its findings: severity, evidence (`file:line`) and a suggestion. Tick the ones you agree with, press `f` to ask a follow-up, or `d` to discard.
4. **Press Enter** and only the adopted points, plus your note, go back to the original agent. It's also told what you declined, so it leaves those alone.

```
 ┌ claude (your session) ───────────┐┌ codex (second opinion) ──────────┐
 │ ❯ add a Clear button + persist    ││ reading .second-opinion/…/context │
 │   to localStorage                 ││ checking main.js:12, :18-21 …     │
 │ ⏺ Done. Summary: …                ││ wrote findings-1.json             │
 └───────────────────────────────────┘└───────────────────────────────────┘
   ┌ Codex's second opinion ────────────────────────────────────────────┐
   │ › [x] med  Validate saved item types before rendering              │
   │   [ ] med  Stale tabs can undo clearing and lose additions         │
   │   [x] med  Failed writes appear successful and old items return    │
   │ ↑↓ move · Space toggle · Enter send · f follow-up · d discard      │
   └────────────────────────────────────────────────────────────────────┘
```

## Install

```sh
herdr plugin install maromocooo/herdr-second-opinion
```

Bind the action to a key in `~/.config/herdr/config.toml`, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "second-opinion.ask"
```

Requirements:
- herdr 0.9.5+ and Node 20+
- Claude Code and Codex CLI, both installed and logged in. Claude gets Codex as its reviewer, and Codex gets Claude.

## Language

The popups, notifications and the reviewer's findings can be in English or Japanese. Press `l` in the first popup to switch; your choice is remembered. You can also set it from a shell with `second-opinion lang ja` or `second-opinion lang en`. Without a saved choice, a Japanese locale (`LANG=ja_*`) picks Japanese.

In Japanese mode, the reviewer is asked to write its findings in Japanese, and the message sent back to the original agent is in Japanese too.

## How it works

- **Same agents you already use.** The reviewer is started with herdr's `agent start`, so it uses your existing login and settings. No API keys are involved.
- **Context stays.** The reviewer pane is reused for later reviews of the same session, so follow-ups don't start from zero.
- **Files, not screen scraping.** The request goes to `.second-opinion/<run>/context.md` and the reviewer writes `findings-N.json`. Both are inside the repo so the reviewer can read and write them, and they are added to `.git/info/exclude`. The findings are validated before they're shown.
- **Review only.** The reviewer is told not to edit project files. It's a normal agent with your normal permissions, though, so watch the pane if that matters to you.
- **You stay in charge.** If the reviewer stops at a question or an approval, you get a notification and answer it in its pane. The plugin never answers on your behalf.
- **Doesn't interrupt.** If the original agent is busy when you send, the plugin waits until it's ready.
- **Declined points aren't repeated.** Findings you chose not to send back are passed to the next review of the same session, so the reviewer only raises them again with a reason.

## What gets sent where

The reviewer reads:
- the original agent's recent terminal output, which may include your status line
- and/or the uncommitted diff
- your note

Like anything you'd paste into that agent yourself, this goes to the model provider of the reviewer CLI. Choose "diff" if you don't want terminal output included.

## Limits (v0.1)

- Claude Code ↔ Codex only. Other agents can be the origin; the reviewer is Codex.
- One reviewer, one round plus follow-ups. No voting or multi-agent panels.
- Tested on macOS with herdr 0.9.5. Linux should work.
- If `node` on herdr's PATH is broken, the plugin falls back to your login shell, which adds a few seconds to the popup.

## Develop

```sh
npm install && npm test
herdr plugin link "$PWD"
second-opinion ask --pane <agent-pane-id> --subject both --yes   # non-interactive start
second-opinion list                                              # recent runs
```

MIT © maromocooo
