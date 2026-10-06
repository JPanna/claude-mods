# claude-mods

Two Claude Code mods, installed once so they load in every session and every project.

- **autopilot**: works through a `GOALS.md` goal tree one small task per turn. Tests you approve are locked so it can't weaken them, the mod runs your checks itself after every round (Claude's word doesn't count), failed tasks are reverted, and lessons carry over between goals. Also: safety guards and a progress band above the prompt.
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
/autopilot checks <goal> write only the tests that define done; review them
/autopilot lock [paths]  lock those tests (default: what `checks` changed)
/autopilot unlock        remove every lock
/autopilot plan <goal>   plan GOALS.md only: review/edit it first
/autopilot <goal>        plan GOALS.md, then work through it
/autopilot               resume (keeps the round count)
/autopilot rounds <n>    fresh budget of n rounds (default 40)
/autopilot fresh on|off  each round in a fresh subagent (off by default)
/autopilot status        progress, next task, locks, last check, why it stopped
/autopilot stop          stop after the current turn
Esc                      pause now; /autopilot resumes

GOALS.md lines the mod runs itself (from the repo root)
Check: <cmd>   after every round; a round only counts when it passes
Done:  <cmd>   when every task is ticked; the goal only finishes when it passes

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

### Giving it a goal

For anything that tests can measure, start with **locked checks** (next section), then plan. For quick goals, go straight to step 1.

1. **Open a session in the repo you want worked on** (a cloud session in an environment with the setup-script line, or Claude Code on your computer).
2. **Write the plan:**
   ```
   /autopilot plan <your goal>
   ```
   Claude reads the code and writes `GOALS.md` at the repo root, then stops so you can check it. Nothing is changed yet.
3. **Review `GOALS.md`.** Open it, or ask Claude to show it. Ask for changes in plain words ("split the API task", "drop the dashboard part", "do tests first"), or edit the file yourself.
4. **Start it:**
   ```
   /autopilot
   ```
   It works through the tasks one per turn until everything is done, it hits the round limit (40, or `/autopilot rounds <n>`), it gets stuck, or it needs you. Interrupt with Esc any time; `/autopilot` resumes.

Shortcut: `/autopilot <your goal>` plans and starts straight away, with no review step.

**What makes a good goal:** one outcome you could check at the end. Say what "done" looks like and anything off-limits.

- Good: `/autopilot plan make the setup and test suite pass on a fresh Windows machine, without changing the trading logic`
- Good: `/autopilot plan add CSV export to the screener with tests, matching the existing report columns`
- Too vague: `/autopilot plan improve the app`

**What `GOALS.md` looks like:**

```markdown
# Goal: Make setup and tests pass on a fresh Windows machine
Check: ruff check && pytest tests/ -q --ignore=tests/test_fresh_install.py
Done: ruff check && pytest tests/ -q

- [ ] Reproduce the current setup failures
  - [ ] Run setup.ps1 in a clean venv and record each error
  - [ ] Run the test suite and list failing tests
- [ ] Fix setup
  - [ ] Pin missing dependencies in requirements.txt
- [ ] Fix failing tests

## Lessons

## Log
```

Each task is a `- [ ]` line; subtasks are indented under it. `Check:` is the command that must keep passing after every round (lint plus the tests that pass today); `Done:` is the command that passes only when the goal is met (usually the locked checks). The plan writes both; fix them if they're wrong, since the mod trusts them. Autopilot ticks a task (`- [x]`) only after proving it works, and adds a line to `## Log` saying what changed and how it checked. Add, reorder or delete tasks any time; each round reads the file fresh. If it ends a reply with `AUTOPILOT: BLOCKED <reason>`, answer what it needs, then type `/autopilot`.

### Locked checks (test-first, so it can't cheat)

The idea behind the "Karpathy method": you decide what "done" means as tests, approve them, and lock them. Autopilot then has to make the code pass them and can't edit them to pass.

1. **Write the checks:**
   ```
   /autopilot checks <your goal>
   ```
   Claude writes only the tests that define done (following the repo's test conventions), shows they fail for the right reason, and stops.
2. **Review them.** This is the important step: the tests are the spec. Ask for changes in plain words until they say exactly what you want.
3. **Lock them:**
   ```
   /autopilot lock
   ```
   This locks every file `checks` added or changed (or name them: `/autopilot lock tests/test_export.py`). It records a fingerprint of each in `.autopilot/locks.json` and commits both.
4. **Plan and run:** `/autopilot plan <same goal>`, review, then `/autopilot`. The plan's `Done:` line runs the locked tests; `Check:` leaves them out until they can pass.

While locked:
- The guard blocks any edit to a locked file or to `.autopilot/`, through edit tools or shell writes (`sed -i`, `>`, `cp`, `git checkout`, …).
- After every round the mod re-checks each fingerprint. A changed file is put back automatically, and the round is sent back to fix the code instead.
- `/autopilot unlock` removes every lock (only you can type it; a routine can't).

### Fresh subagents (optional)

`/autopilot fresh on` hands each round to a new subagent with a clean context, which keeps long overnight runs from bloating and repeating themselves. It costs more tokens per round. `/autopilot fresh off` goes back. The setting is remembered on that computer (cloud sessions start with it off).

### Running it overnight

Give the goal in the session your nightly Routine fires into (step 2 above), review `GOALS.md`, then turn the Routine on: ask Claude "resume the nightly autopilot routine", or toggle it on under Routines in the Claude app. Each night it gets a fresh budget (`/autopilot rounds 80`) and continues where `GOALS.md` left off. In the morning, read `## Log` and the commits on the session's branch. Turn the Routine off when the goal is done or you have no goal, since an empty run still costs a turn.

### How it works

Each round does one task from `GOALS.md` (at the repo root): split it if it's bigger than ~15 minutes, make it work, tick it, add a line to `## Log`, commit to the current branch. Edit `GOALS.md` any time; each round reads it fresh.

**The mod's verdict, not Claude's.** After every round the mod itself runs the `Check:` command and re-checks the locked files:
- Pass: on to the next task.
- Fail: the next round is "fix this", with the failing output (attempt 2 of 3, then 3 of 3).
- Third failure on the same task: the mod puts every file except the locks back to how they were when the task started, in a new commit (no history is rewritten), notes it in `## Log`, and stops.

When every task is ticked, the mod runs `Done:`. If it fails, Claude adds the missing tasks and carries on (up to 3 tries); the goal only finishes when `Done:` passes.

**Lessons that carry over.** Every 10th round starts with a retro: reorder what's left, then distil general habits (not notes about this goal) into `AUTOPILOT_LESSONS.md` at the repo root, and add `@AUTOPILOT_LESSONS.md` to `CLAUDE.md` so every future session in that repo reads them, autopilot or not. Edit or delete lessons any time.

It stops, with a toast and a push notification where the session supports them, when the goal is done (and `Done:` passes), the round limit is hit, a task fails its check 3 times, 3 rounds in a row leave `GOALS.md` unchanged, a locked file can't be restored, Claude ends a reply with `AUTOPILOT: BLOCKED <reason>`, a turn errors, or you interrupt.

**Routines:** a Routine's prompt reaches an existing session as a notification rather than a typed command, so the mod picks up `/autopilot`, `rounds <n>`, `status` or `stop` from your own scheduled routines (never a new goal) and runs it when that turn ends.

**Progress under each reply (works everywhere):** while autopilot runs, a line like `Autopilot · round 3/40 · 2/9 done · next: Add tests · last check ✓` appears under every reply, and `Autopilot stopped: <reason>.` when it stops. It's part of the conversation, so it shows in the web app, the desktop app, VS Code and on your phone.

**Panel above the prompt (terminal):** state (and fix attempt), goal progress, next task, last turn's time and tool calls, files edited, last check verdict, fresh subagents, with Stop and Hide buttons. It draws in the terminal (`claude`). Some apps don't draw mod panels yet, including the VS Code extension and cloud sessions viewed in the web or desktop app; the progress line above covers those, and `/autopilot status` gives the same detail on demand.

## shortcuts

Add your own in `plugins/shortcuts/hooks/register.ts`: each entry is a token, a label for `/shortcuts`, and the text appended to the prompt.

## Developing

```
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
```
