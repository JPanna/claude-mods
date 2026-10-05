// Pure logic for locked checks and the mod's own verdict: the prompts for
// writing checks and fixing a failed round, the lock file's format, and which
// paths and shell commands touch a locked file. No `$` here.

import { writes } from './guard'

export const LOCKS_FILE = '.autopilot/locks.json'
export const FAIL_LIMIT = 3

// Locked path (relative to the repo root, forward slashes) -> git blob id.
export type Locks = Record<string, string>

export function parseLocks(text: string | null): Locks {
  if (!text) return {}
  try {
    const data: unknown = JSON.parse(text)
    const files = (data as { files?: unknown })?.files
    if (!files || typeof files !== 'object') return {}
    return Object.fromEntries(
      Object.entries(files).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  } catch {
    return {}
  }
}

export function formatLocks(locks: Locks): string {
  return `${JSON.stringify({ files: locks }, null, 2)}\n`
}

// A tool's absolute or relative path as a repo-relative, forward-slash path.
export function relPath(path: string, root: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p
}

export function isLockedPath(rel: string, locks: Locks): boolean {
  return rel === LOCKS_FILE || rel.startsWith('.autopilot/') || rel in locks
}

// A shell command that writes to a locked file or the lock file: a writing
// segment that names one by path or file name. What slips past this is still
// caught by the fingerprint check after the round.
export function touchesLocked(command: string, locks: Locks): string | null {
  const names = new Set<string>(['.autopilot', LOCKS_FILE])
  for (const path of Object.keys(locks)) {
    names.add(path)
    names.add(path.split('/').pop() ?? path)
  }
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    if (!writes(segment)) continue
    const words = segment.split(/[\s'"=<>]+/).filter(Boolean).map(w => w.replace(/^\.\//, ''))
    const hit = words.find(w => names.has(w) || [...names].some(n => n.includes('/') && w.endsWith(`/${n}`)))
    if (hit) return hit
  }
  return null
}

export function tail(output: string, lines = 40, max = 3000): string {
  const kept = output.trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  return kept.length > max ? kept.slice(-max) : kept
}

export const FRESH_NOTE =
  'Do the work in a fresh subagent: hand it this whole prompt (task, check and rules) through the Agent tool, then review what it changed, and update GOALS.md and commit yourself.'

export function checksPrompt(goal: string): string {
  return `[autopilot: writing checks]
Goal: ${goal}

Write ONLY the automated checks (tests) that define "done" for this goal, following this repository's existing test conventions and locations. Don't implement the goal and don't change existing tests.
- Cover the behaviour that matters, including the edge cases and failure messages the goal implies.
- Run them and show they fail now for the right reason (missing behaviour, not a typo or import error).
- End with the exact list of test files you created or changed, and the one command that runs them.

The human reviews these and locks them with /autopilot lock; after that they can't be edited, and the goal is done only when they pass.`
}

export function donePrompt(o: {
  round: number
  maxRounds: number
  done: string
  output: string
  attempt: number
  rules: string
}): string {
  return `[autopilot: round ${o.round}/${o.maxRounds}, goal not met yet, attempt ${o.attempt} of ${FAIL_LIMIT}]
Every task in GOALS.md is ticked, but the done check \`${o.done}\` fails. Last lines of its output:

\`\`\`
${o.output}
\`\`\`

Work out what is still missing, add it to GOALS.md as new "- [ ]" tasks under the right subgoal, then do the first of them.

${o.rules}`
}

export function fixPrompt(o: {
  task: string
  round: number
  maxRounds: number
  check: string | null
  output: string
  attempt: number
  tampered: string[]
  fresh: boolean
  rules: string
}): string {
  const why = o.tampered.length > 0
    ? `Locked check files were changed and have been restored: ${o.tampered.join(', ')}. Locked checks define "done" and must not be edited; make the code satisfy them instead.`
    : `The check \`${o.check}\` failed after your last round, so this task isn't done; untick it in GOALS.md if you ticked it. Last lines of its output:\n\n\`\`\`\n${o.output}\n\`\`\``
  return `[autopilot: round ${o.round}/${o.maxRounds}, fixing, attempt ${o.attempt} of ${FAIL_LIMIT}]
Task: ${o.task}

${why}

Find and fix the cause. After attempt ${FAIL_LIMIT}, this task's changes are reverted and autopilot stops.${o.fresh ? `\n\n${FRESH_NOTE}` : ''}

${o.rules}`
}
