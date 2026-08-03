# pi-mode-manager

Claude Code-style **Plan / Auto / Edit** mode manager for the [pi coding agent](https://github.com/earendil-works/pi).

Pi ships without a plan mode (see [earendil-works/pi#97](https://github.com/earendil-works/pi/issues/97) — "Add plan mode support"). This extension adds the full workflow:

- **Plan** — read-only exploration & planning (edit/write/bash hard-blocked)
- **Auto** — full tool access, executes directly
- **Edit** — read/write tools + search; bash requires per-command approval

The agent produces a numbered plan, the extension tracks its steps in a live todo widget, and the agent reports progress with `[DONE:n]` markers as it executes.

![modes](https://img.shields.io/badge/modes-Plan%20%7C%20Auto%20%7C%20Edit-4f8ef7)

## Features

- 🔄 **`Alt+M`** cycles modes: Plan → Auto → Edit
- 🔒 **Hard gate** on tool calls — Plan mode rejects `edit`/`write`/`bash` before the agent sees them; Edit mode prompts for bash approval
- 📋 **Live todo widget** (below the editor) — numbered plan steps with progress counter (`Plan (2/5)`), pending/current/done glyphs, auto-hides when the plan completes
- ✨ **Two-column layout** — todo lists > 5 items split into side-by-side columns (CJK-width aware, truncation-safe)
- ✅ **`[DONE:n]` protocol** — cumulative semantics: `[DONE:3]` marks steps 1–3 complete; `[DONE:all]`/`[DONE:*]` marks everything
- 🧠 **Mode instructions injected into context** — the agent knows which mode is active and what its rules are
- 💾 **Session persistence** — mode + todos survive restarts; plans are recovered from session history even if the extension was enabled after the plan was written
- ⌨️ **`/plan` toggle** and `--plan` CLI flag (start pi already in Plan mode)

## Installation

### From GitHub

```bash
pi install git:github.com/pkulyn/pi-mode-manager@v1
```

### From npm

```bash
pi install npm:pi-mode-manager
```

### Manual

Clone the repo and add it to your extension paths in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-mode-manager"]
}
```

The extension auto-loads on the next pi session. Requires **pi ≥ 0.80** and **Node ≥ 23.6**.

## Usage

| Action | Result |
|--------|--------|
| `/plan` | Toggle mode manager on/off |
| `Alt+M` | Cycle mode: Plan → Auto → Edit |
| `/todos` | Show the current plan todo list |
| `pi --plan` | Start pi with Plan mode already active |

### Workflow

1. Start with `/plan` (or `--plan`). You are in **Plan** mode: the agent explores the codebase and produces a numbered plan under a `Plan:` header. Tools that modify anything are blocked.
2. Press `Alt+M` to switch to **Auto** (execute directly) or **Edit** (focused editing, bash asks permission).
3. As the agent executes each step it reports `[DONE:n]`. The todo widget ticks up `(1/5) → (5/5)` and collapses with a 🎉 notification when the plan is done.

### Tool access matrix

| Mode | read / grep / find / ls | edit / write | bash | other tools |
|------|:---:|:---:|:---:|:---:|
| **Plan** | ✅ | ❌ blocked | ❌ blocked | ✅ |
| **Auto** | ✅ | ✅ | ✅ | ✅ |
| **Edit** | ✅ | ✅ | ⚠️ per-command approval | ✅ |

### `[DONE:n]` protocol

The agent signals completed plan steps in its response text:

```
Plan:
1. Refactor the parser
2. Add tests
3. Update docs

[DONE:2]
```

Cumulative semantics: `[DONE:2]` marks steps 1 *and* 2 complete (plan steps execute in order). `n` may exceed the list length (the agent may count its own steps). `[DONE:all]` / `[DONE:*]` mark every step complete.

## How it works

- **Tool gating** — `tool_call` interception returns `{ block: true, reason }` for disallowed tools; no shell-level sandboxing
- **Plan extraction** — scans assistant messages for `Plan:` headers + numbered lists (`extractTodoItems`), cleans step text (verb-stripping, markdown removal, truncation)
- **Progress tracking** — `turn_end` parses `[DONE:n]` markers; completion state is rebuilt from session history on restore, so the widget survives restarts
- **Context injection** — `before_agent_start` inserts mode instructions (tagged `customType`) filtered by `context` interception

## Development

```bash
npm test          # node:test — zero dependencies
```

Tests cover the pure utilities (`utils.ts`): plan extraction, `[DONE:n]` cumulative semantics, CJK-aware layout (`columnarize`, `displayWidth`, `truncateToWidth`), and ANSI handling.

## Compatibility notes

- Uses pi's public extension APIs (`setActiveTools`/`getActiveTools`, `ctx.ui.setWidget`, `appendEntry`, lifecycle events) — see [extensions.md](https://github.com/earendil-works/pi/blob/main/docs/extensions.md)
- Mode colors are hard-coded ANSI (warm orange / green / blue); adjust `MODE_ANSI` in `index.ts` to taste
- If the official pi plan mode ever lands, this extension can serve as a migration reference

## License

[MIT](LICENSE)
