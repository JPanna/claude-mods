// Pure logic: parsing GOALS.md, choosing the next task, writing the prompts
// and deciding whether the loop goes on. No `$` here, so it is easy to test.

import { FRESH_NOTE } from './checks'

export const GOALS_FILE = 'GOALS.md'
export const LESSONS_FILE = 'AUTOPILOT_LESSONS.md'
export const DEFAULT_MAX_ROUNDS = 40
export const STUCK_LIMIT = 3
export const RETRO_EVERY = 10
export const BLOCKED = /AUTOPILOT:\s*BLOCKED\b(.*)/i

export type Item = {
  text: string
  isDone: boolean
  indent: number
  parent: Item | null
  children: Item[]
}

export type Goals = { goal: string | null; items: Item[] }

const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/
const TITLE = /^#\s+(?:goal:\s*)?(.*\S)\s*$/i

// The command on GOALS.md's `Check:` line (run by the mod after every round)
// or `Done:` line (run before the goal counts as finished). A `<placeholder>`
// left from the template counts as no command.
export function parseCommand(markdown: string | null, label: 'Check' | 'Done'): string | null {
  const line = new RegExp(`^${label}:\\s*\`?(.+?)\`?\\s*$`, 'im')
  const command = markdown ? line.exec(markdown)?.[1]?.trim() : undefined
  return command && !command.startsWith('<') ? command : null
}

// GOALS.md with `- <line>` added at the end of its "## Log" section.
export function appendLog(markdown: string, line: string): string {
  const lines = markdown.replace(/\s+$/, '').split('\n')
  const start = lines.findIndex(l => /^##\s+log\b/i.test(l))
  if (start === -1) return `${lines.join('\n')}\n\n## Log\n- ${line}\n`
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end === -1) end = lines.length
  while (end > start + 1 && lines[end - 1]?.trim() === '') end -= 1
  lines.splice(end, 0, `- ${line}`)
  return `${lines.join('\n')}\n`
}

export function parse(markdown: string): Goals {
  let goal: string | null = null
  const items: Item[] = []
  const open: Item[] = []

  for (const line of markdown.split(/\r?\n/)) {
    const title: RegExpExecArray | null = goal === null ? TITLE.exec(line) : null
    if (title?.[1]) {
      goal = title[1]
      continue
    }
    const box = CHECKBOX.exec(line)
    if (!box) continue
    const [, lead = '', mark = ' ', text = ''] = box
    const indent = lead.replace(/\t/g, '  ').length
    while ((open.at(-1)?.indent ?? -1) >= indent) open.pop()
    const parent = open.at(-1) ?? null
    const item: Item = { text, isDone: mark !== ' ', indent, parent, children: [] }
    parent?.children.push(item)
    items.push(item)
    open.push(item)
  }

  return { goal, items }
}

// The first unchecked item whose children are all checked: a leaf task, or a
// subgoal whose tasks are finished and which now only needs verifying.
export function nextTask(goals: Goals): Item | null {
  return goals.items.find(item => !item.isDone && item.children.every(c => c.isDone)) ?? null
}

export function trail(item: Item): string[] {
  const path: string[] = []
  for (let at: Item | null = item; at; at = at.parent) path.unshift(at.text)
  return path
}

export function summarize(goals: Goals) {
  const next = nextTask(goals)
  return {
    goal: goals.goal,
    done: goals.items.filter(i => i.isDone).length,
    total: goals.items.length,
    next: next ? trail(next).join(' › ') : null,
  }
}

export const RULES = `Rules:
- Work on exactly this one task, as the smallest increment that works. Move fast.
- If it would take more than ~15 minutes, first split it into smaller "- [ ]" sub-tasks indented under it in ${GOALS_FILE}, then do the first one.
- Prove it works (run the tests, the app or the script). No proof, no tick.
- Follow ${LESSONS_FILE} (repository root) if it exists. Never edit locked checks (listed in .autopilot/locks.json at the repository root, if present): make the code satisfy them.
- When verified, tick it ("- [x]") in ${GOALS_FILE} and add one line to its "## Log" section: what changed and how you verified it.
- Add any new task or subgoal you discover to ${GOALS_FILE} where it belongs.
- Commit to the current branch with a clear message. Never commit to or push main/master, never force-push.
- If only the human can unblock you (a decision, a credential, access), end your reply with the line "AUTOPILOT: BLOCKED <what you need>".`

export const GOALS_FORMAT = `# Goal: <the overarching goal, one line>
Check: <command that passes now and must keep passing after every round>
Done: <command that passes only when the goal is met>

- [ ] <subgoal 1>
  - [ ] <task: small, concrete, verifiable in under ~15 minutes>
  - [ ] <task>
- [ ] <subgoal 2>
  - [ ] <task>

## Lessons

## Log`

export function planPrompt(goal: string): string {
  return `[autopilot: planning]
Overarching goal: ${goal}

Look at the codebase as needed, then write ${GOALS_FILE} at the repository root as a goal tree in exactly this shape (replace the file if it exists):

${GOALS_FORMAT}

The mod itself runs the two commands, non-interactively from the repository root:
- Check: run after every round; a round only counts when it passes. Use the repository's own lint and test command, limited to what passes today, so it guards against regressions. If .autopilot/locks.json lists locked checks that don't pass yet, leave those files out of Check (for pytest, --ignore=<file>). Run it now and make sure it passes.
- Done: run when every task is ticked; the goal only counts as finished when it passes. If .autopilot/locks.json exists, Done must run those locked checks (plus Check); otherwise use the tests that prove the goal is met.

Break it down until every leaf is a small, concrete, verifiable task. Order everything so the earliest items unblock the most and a working end-to-end slice exists as early as possible. Don't implement anything yet; the next turn starts on the first task.`
}

export function roundPrompt(o: {
  goal: string | null
  task: Item
  round: number
  maxRounds: number
  isRetro: boolean
  check: string | null
  done: string | null
  fresh: boolean
}): string {
  const path = trail(o.task)
  const where = path.length > 1 ? `\nWithin: ${path.slice(0, -1).join(' › ')}` : ''
  const verifying = o.task.children.length > 0
    ? '\nAll of its sub-tasks are ticked: verify the subgoal as a whole works, then tick it.'
    : ''
  const retro = o.isRetro
    ? `\n\nRetro first (every ${RETRO_EVERY} rounds): reread ${GOALS_FILE} and its Log. Reorder, merge or split what is left so the remaining path to the goal is shortest. Then distil what is general (habits to repeat or avoid in this repository, not notes about this goal) into ${LESSONS_FILE} at the repository root: short bullets, merge duplicates, at most about 30 lines. If CLAUDE.md lacks the line "@${LESSONS_FILE}", add it at the end (create CLAUDE.md with just that line if there is none), so every future session reads the lessons. Then do the task.`
    : ''
  const check = [
    o.check ? `\nCheck: \`${o.check}\` (the mod runs it after this round; the task only counts when it passes)` : '',
    o.done ? `\nDone: \`${o.done}\` (must pass before the goal is finished)` : '',
  ].join('')
  const fresh = o.fresh ? `\n\n${FRESH_NOTE}` : ''

  return `[autopilot: round ${o.round}/${o.maxRounds}]
Goal: ${o.goal ?? '(see GOALS.md)'}${where}
Task: ${o.task.text}${verifying}${check}${retro}${fresh}

${RULES}`
}

export type Decision =
  | { action: 'continue'; prompt: string; stuck: number; task: string }
  | { action: 'stop'; reason: string }

export function decide(o: {
  goalsText: string | null
  lastGoals: string
  stuck: number
  round: number
  maxRounds: number
  answer: string
  fresh?: boolean
}): Decision {
  const blocked = BLOCKED.exec(o.answer)
  if (blocked) return { action: 'stop', reason: `blocked: ${blocked[1]?.trim() || 'needs you'}` }
  if (o.goalsText === null) return { action: 'stop', reason: `${GOALS_FILE} is missing` }

  const goals = parse(o.goalsText)
  if (goals.items.length === 0) return { action: 'stop', reason: `${GOALS_FILE} has no "- [ ]" tasks` }
  const task = nextTask(goals)
  if (!task) return { action: 'stop', reason: 'every goal is done' }
  if (o.round >= o.maxRounds) return { action: 'stop', reason: `reached ${o.maxRounds} rounds` }

  const stuck = o.goalsText === o.lastGoals ? o.stuck + 1 : 0
  if (stuck >= STUCK_LIMIT) {
    return { action: 'stop', reason: `stuck: ${STUCK_LIMIT} rounds without changing ${GOALS_FILE} (on "${task.text}")` }
  }

  const round = o.round + 1
  return {
    action: 'continue',
    stuck,
    task: task.text,
    prompt: roundPrompt({
      goal: goals.goal,
      task,
      round,
      maxRounds: o.maxRounds,
      isRetro: round % RETRO_EVERY === 0,
      check: parseCommand(o.goalsText, 'Check'),
      done: parseCommand(o.goalsText, 'Done'),
      fresh: o.fresh ?? false,
    }),
  }
}

// A Routine that fires into an existing session delivers its prompt as a
// notification the model reads with ReadNotifications, not as a typed command,
// so `/autopilot` in it would never run. This finds that command in a
// notification from one of the account's own scheduled routines (origin
// `trigger_fire`), allowing only the resume forms, never a new goal.
const ROUTINE_COMMAND = /^\/autopilot(?:\s+(rounds\s+\d+|status|stop))?\s*$/

export function routineCommand(notifications: ReadonlyArray<{ origin: string; content: string }>): string | null {
  for (const n of notifications) {
    if (n.origin !== 'trigger_fire') continue
    const first = n.content.trim().split('\n')[0]?.trim() ?? ''
    const match = ROUTINE_COMMAND.exec(first)
    if (match) return match[1] ?? ''
  }
  return null
}
