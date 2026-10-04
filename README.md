# claude-mods

Two Claude Code mods, installed once so they load in every session and every project.

- **autopilot**: works through a `GOALS.md` goal tree one small task per turn, with safety guards and a progress band above the prompt.
- **shortcuts**: type `;cp`, `;plan`, `;go`, `;tdd`, `;ship` or `;brief` in any prompt to attach a saved instruction.

## Install

### Your computer (desktop app, terminal, VS Code), Windows/macOS/Linux

**Windows (PowerShell, e.g. VS Code's terminal):**

```powershell
Remove-Item -Recurse -Force "$env:TEMP\claude-mods" -ErrorAction SilentlyContinue
git clone --depth 1 https://github.com/JPanna/claude-mods "$env:TEMP\claude-mods"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\claude-mods\install.ps1"
```

**macOS/Linux:**

```
git clone --depth 1 -q https://github.com/JPanna/claude-mods /tmp/claude-mods && bash /tmp/claude-mods/install.sh
```

Both copy the mods into `~/.claude/skills/`, which every Claude Code surface loads. Then reload (VS Code: Ctrl+Shift+P → "Developer: Reload Window"; elsewhere `/reload-plugins` or a new session). Re-run to update.

**Or as plugins**, in the terminal CLI (the VS Code chat panel has no `/plugin`), so `claude plugin update` can update them:

```
/plugin marketplace add JPanna/claude-mods
/plugin install autopilot@claude-mods
/plugin install shortcuts@claude-mods
```

(or from any shell: `claude plugin marketplace add JPanna/claude-mods`, `claude plugin install autopilot@claude-mods`, `claude plugin install shortcuts@claude-mods`). Use one route, not both, or the mods load twice.

Update later with `/plugin marketplace update claude-mods`, then `/plugin update autopilot@claude-mods` and `/plugin update shortcuts@claude-mods`.

### Cloud sessions (claude.ai/code, mobile)

Cloud sessions start from a fresh container, so add this line to your cloud environment's **setup script** (environment menu in a session's title bar → Edit → Setup script):

```
git clone --depth 1 -q https://github.com/JPanna/claude-mods /tmp/claude-mods && bash /tmp/claude-mods/install.sh
```

Every new cloud session in that environment, in any repo, then has both mods. Updates arrive automatically, since each session installs the latest.

### Built-in extra

`/plugin enable cc-plugin-you-should-know@builtin` (or `claude plugin enable cc-plugin-you-should-know@builtin` in a shell): a side agent that flags things you might miss.

Check it worked: type `/shortcuts` or `/autopilot status`.

## Cheat sheet

```
AUTOPILOT
/autopilot <goal>        plan GOALS.md, then work through it
/autopilot plan <goal>   plan only: review/edit GOALS.md first
/autopilot               resume (keeps the round count)
/autopilot rounds <n>    fresh budget of n rounds (default 40)
/autopilot status        progress, next task, why it last stopped
/autopilot stop          stop after the current turn
Esc                      pause now; /autopilot resumes

SHORTCUTS (type anywhere in a prompt, combine freely)
;cp      ask the clarifying questions first, then one decisive answer
;plan    plan first, wait for my OK
;go      work autonomously to done, verify each step
;tdd     failing test first, then make it pass
;ship    test, self-review, commit, push to the current branch
;brief   at most 5 bullets
/shortcuts               list them

BLOCKED BY THE SAFETY GUARD (run these yourself if you must)
force-push · push/delete main or master (incl. a bare git push on main)
git reset --hard · git clean -f · rm -rf of / ~ . .. *
SQL DROP/TRUNCATE · changing .env files (reading is fine)
```

## autopilot

Each round does one task from `GOALS.md` (at the repo root): split it if it's bigger than ~15 minutes, prove it works, tick it, add a line to `## Log`, commit to the current branch. Every 10th round starts with a retro that reorders what's left and records lessons under `## Lessons`. Edit `GOALS.md` any time; each round reads it fresh.

It stops, with a toast and a push notification where the session supports them, when everything is done, the round limit is hit, 3 rounds in a row leave `GOALS.md` unchanged, Claude ends a reply with `AUTOPILOT: BLOCKED <reason>`, a turn errors, or you interrupt.

**Overnight:** a Routine that fires into a session with the prompt `/autopilot rounds 80` runs it every night. A Routine's prompt reaches an existing session as a notification rather than a typed command, so the mod picks up `/autopilot`, `rounds <n>`, `status` or `stop` from your own scheduled routines (never a new goal) and runs it when that turn ends.

**Band above the prompt:** state, goal progress, next task, last turn's time and tool calls, files edited, last test result. The status line shows `autopilot <round>/<max> · <done>/<total>`.

## shortcuts

Add your own in `plugins/shortcuts/hooks/register.ts`: each entry is a token, a label for `/shortcuts`, and the text appended to the prompt.

## Developing

```
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
```
