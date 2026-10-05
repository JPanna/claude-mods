import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, ProcessRunInit, Register } from 'claude-code'

import type { GoalsSummary, Run, Stats } from '../types'
import {
  BLOCKED,
  DEFAULT_MAX_ROUNDS,
  GOALS_FILE,
  RULES,
  appendLog,
  decide,
  parse,
  parseCommand,
  planPrompt,
  routineCommand,
  summarize,
} from './goals'
import {
  FAIL_LIMIT,
  LOCKS_FILE,
  type Locks,
  checksPrompt,
  donePrompt,
  fixPrompt,
  formatLocks,
  isLockedPath,
  parseLocks,
  relPath,
  tail,
  touchesLocked,
} from './checks'
import { dangerous, isTestCommand, protectedFile, pushes } from './guard'

const OFF: Run = {
  isOn: false,
  round: 0,
  maxRounds: DEFAULT_MAX_ROUNDS,
  stuck: 0,
  lastGoals: '',
  lastStop: null,
  phase: 'work',
  task: null,
  base: null,
  fails: 0,
  checksBase: null,
  fresh: false,
  verdict: null,
}
const EMPTY: Stats = { turnSeconds: null, turnTools: 0, files: [], lastTest: null }
// The task name a done-check failure is worked under; it has no commit to revert to.
const DONE_TASK = 'Make the done check pass'

const run = atom({ plugin: 'autopilot', key: 'run' } as const, OFF)
const goals = atom({ plugin: 'autopilot', key: 'goals' } as const, null)
const stats = atom({ plugin: 'autopilot', key: 'stats' } as const, EMPTY)
const isHidden = atom({ plugin: 'autopilot', key: 'isHidden' } as const, false)

const HELP = `/autopilot <goal>        plan GOALS.md for a new goal, then work through it
/autopilot plan <goal>   only write GOALS.md, so you can review it first
/autopilot checks <goal> only write the tests that define done, so you can review them
/autopilot lock [paths]  lock those tests (default: the files /autopilot checks changed)
/autopilot unlock        remove every lock
/autopilot               resume from GOALS.md
/autopilot rounds <n>    fresh budget of n rounds (default ${DEFAULT_MAX_ROUNDS}), then resume
/autopilot fresh on|off  do each round in a fresh subagent (off by default)
/autopilot stop          stop after the current turn
/autopilot status        where things stand`

async function readGoals($: Engine): Promise<string | null> {
  try {
    return await $.fs.read(GOALS_FILE)
  } catch {
    return null
  }
}

async function refreshGoals($: Engine): Promise<GoalsSummary | null> {
  const text = await readGoals($)
  const summary = text === null ? null : summarize(parse(text))
  await update($, goals, () => summary)
  return summary
}

async function showStatus($: Engine) {
  const r = await read($, run)
  const g = await read($, goals)
  const progress = g ? ` · ${g.done}/${g.total}` : ''
  $.ui.status(r.isOn ? `autopilot ${r.round}/${r.maxRounds}${progress}` : undefined)
}

// A command.run hook may not submit a prompt (it would wait on the turn it is
// holding), so the commands submit theirs just after they return.
function submitSoon($: Engine, text: string) {
  $.clock.after(100, () => void $.prompt.submit({ text }))
}

async function notify($: Engine, message: string) {
  $.ui.toast(message, { timeoutMs: 10000 })
  try {
    // Reaches the phone in sessions that have push notifications; harmless elsewhere.
    await $.tool.call({ tool: 'PushNotification', message: message.slice(0, 190), status: 'proactive' })
  } catch {}
}

async function stop($: Engine, reason: string, isQuiet = false) {
  await update($, run, r => ({ ...r, isOn: false, phase: 'work', lastStop: reason }))
  await showStatus($)
  if (!isQuiet) await notify($, `Autopilot stopped: ${reason}`)
}

// ---- git and the shell, run by the mod itself (not through tool calls, so the guard doesn't apply)

let root: string | null = null

async function repoRoot($: Engine): Promise<string | null> {
  if (root !== null) return root
  try {
    const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    if (r.exitCode === 0) root = r.stdout.trim()
  } catch {}
  return root
}

async function git($: Engine, args: string[]): Promise<{ ok: boolean; out: string }> {
  const cwd = await repoRoot($)
  try {
    const r = await $.process.run(['git', ...args], cwd ? { cwd } : undefined)
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

async function headCommit($: Engine): Promise<string | null> {
  const r = await git($, ['rev-parse', 'HEAD'])
  return r.ok ? r.out.trim() : null
}

async function atRoot($: Engine, rel: string): Promise<string> {
  const r = await repoRoot($)
  return r ? `${r}/${rel}` : rel
}

async function readLocks($: Engine): Promise<Locks> {
  try {
    return parseLocks(await $.fs.read(await atRoot($, LOCKS_FILE)))
  } catch {
    return {}
  }
}

// Locked files whose content no longer matches their fingerprint, each put
// back from the blob stored when it was locked.
async function verifyLocks($: Engine, locks: Locks): Promise<{ changed: string[]; lost: string[] }> {
  const changed: string[] = []
  const lost: string[] = []
  for (const [path, blob] of Object.entries(locks)) {
    const now = await git($, ['hash-object', '--', path])
    if (now.ok && now.out.trim() === blob) continue
    changed.push(path)
    const saved = await git($, ['cat-file', 'blob', blob])
    if (saved.ok) await $.fs.write(await atRoot($, path), saved.out)
    else lost.push(path)
  }
  return { changed, lost }
}

// Runs a Check or Done command from the repo root: sh where there is one, cmd on Windows.
async function runCommand($: Engine, command: string): Promise<{ passed: boolean; output: string }> {
  const cwd = await repoRoot($)
  const init: ProcessRunInit = { timeoutMs: 600_000, ...(cwd ? { cwd } : {}) }
  for (const argv of [['sh', '-c', command], ['cmd', '/c', command]]) {
    try {
      const r = await $.process.run(argv, init)
      return { passed: r.exitCode === 0, output: tail(`${r.stdout}\n${r.stderr}`) }
    } catch {}
  }
  return { passed: false, output: 'The command could not run: it timed out after 10 minutes, or no shell (sh or cmd) was found.' }
}

// Puts every file but the locks back to the task's starting commit, in a new commit.
async function revertTask($: Engine, base: string, task: string, locks: Locks): Promise<string> {
  const keep = [LOCKS_FILE, ...Object.keys(locks)].map(p => `:(top,exclude)${p}`)
  const restored = await git($, ['restore', `--source=${base}`, '--staged', '--worktree', '--', ':/', ...keep])
  if (!restored.ok) return 'its changes could not be reverted automatically and are still there'
  const text = await readGoals($)
  if (text !== null) await $.fs.write(GOALS_FILE, appendLog(text, `Reverted "${task}" after ${FAIL_LIMIT} failed checks.`))
  await git($, ['add', '--', GOALS_FILE])
  const message = `Revert autopilot task after ${FAIL_LIMIT} failed checks: ${task}`.slice(0, 120)
  const committed = await git($, ['commit', '-m', message])
  return committed.ok ? 'its changes were reverted in a new commit' : 'its changes were reverted (not committed)'
}

async function lockFiles($: Engine, paths: string[]): Promise<string> {
  const r = await read($, run)
  let targets: string[] = []
  if (paths.length > 0) {
    for (const p of paths) {
      const listed = await git($, ['ls-files', '-co', '--exclude-standard', '--', p])
      targets.push(...(listed.ok && listed.out.trim() ? listed.out.trim().split('\n') : [p]))
    }
  } else if (r.checksBase) {
    const changed = await git($, ['diff', '--name-only', r.checksBase])
    const added = await git($, ['ls-files', '--others', '--exclude-standard'])
    targets = [changed.out, added.out].join('\n').split('\n').map(s => s.trim()).filter(Boolean)
  } else {
    return 'Name the files to lock, for example /autopilot lock tests/test_export.py, or write them first with /autopilot checks <goal>.'
  }
  targets = [...new Set(targets)].filter(p => p !== GOALS_FILE && !p.startsWith('.autopilot/') && !p.endsWith('AUTOPILOT_LESSONS.md'))
  if (targets.length === 0) return 'No files to lock: nothing changed since /autopilot checks. Name them: /autopilot lock <paths>.'

  const locks = await readLocks($)
  const failed: string[] = []
  for (const p of targets) {
    const blob = await git($, ['hash-object', '-w', '--', p])
    if (blob.ok) locks[p] = blob.out.trim()
    else failed.push(p)
  }
  await $.fs.write(await atRoot($, LOCKS_FILE), formatLocks(locks))
  const locked = targets.filter(p => !failed.includes(p))
  await git($, ['add', '--', LOCKS_FILE, ...locked])
  const committed = await git($, ['commit', '-m', 'Lock the autopilot checks', '--', LOCKS_FILE, ...locked])
  await update($, run, x => ({ ...x, checksBase: null }))
  return [
    `Locked ${locked.length} file${locked.length === 1 ? '' : 's'}${committed.ok ? ' (committed)' : ''}:`,
    ...locked.map(p => `  ${p}`),
    ...(failed.length > 0 ? [`Couldn't lock (missing?): ${failed.join(', ')}`] : []),
    '',
    'Next: /autopilot plan <goal>. Its Done line will run these checks; autopilot can no longer edit them.',
  ].join('\n')
}

async function unlockAll($: Engine): Promise<string> {
  const count = Object.keys(await readLocks($)).length
  if (count === 0) return 'Nothing is locked.'
  await $.fs.write(await atRoot($, LOCKS_FILE), formatLocks({}))
  await git($, ['commit', '-m', 'Unlock the autopilot checks', '--', LOCKS_FILE])
  return `Unlocked ${count} file${count === 1 ? '' : 's'}.`
}

// ---- starting and resuming

async function start($: Engine, first: string, o: { round: number; stuck?: number; task?: string | null; fresh?: boolean }) {
  const lastGoals = (await readGoals($)) ?? ''
  const base = o.task ? await headCommit($) : null
  await update($, run, r => ({
    ...r,
    isOn: true,
    phase: 'work',
    round: o.round,
    stuck: o.stuck ?? 0,
    lastGoals,
    lastStop: null,
    task: o.task ?? null,
    base,
    fails: 0,
  }))
  await showStatus($)
  submitSoon($, first)
}

async function handle($: Engine, input: string): Promise<string> {
  const args = input.trim()
  const [verb = '', ...rest] = args.split(/\s+/)
  const tail = rest.join(' ').trim()

  if (verb === 'help') return HELP
  if (verb === 'status') return describe(await read($, run), await refreshGoals($), await readLocks($))
  if (verb === 'stop') {
    await stop($, 'stopped by you', true)
    return 'Autopilot will stop after the current turn.'
  }
  if (verb === 'fresh') {
    if (tail !== 'on' && tail !== 'off') return 'Usage: /autopilot fresh on|off'
    const fresh = tail === 'on'
    await $.store.set('fresh', fresh)
    await update($, run, r => ({ ...r, fresh }))
    return fresh
      ? 'Fresh subagents on: each round is handed to a new subagent (cleaner context, more tokens).'
      : 'Fresh subagents off: rounds run in this session.'
  }
  if (verb === 'lock') return lockFiles($, rest)
  if (verb === 'unlock') return unlockAll($)
  if (verb === 'checks') {
    if (!tail) return `Usage: /autopilot checks <goal>\n\n${HELP}`
    const checksBase = await headCommit($)
    await update($, run, r => ({ ...r, isOn: true, phase: 'checks', checksBase, lastStop: null, task: null }))
    await showStatus($)
    submitSoon($, checksPrompt(tail))
    return 'Writing the checks only. Review them when it finishes, then /autopilot lock.'
  }
  if (verb === 'plan') {
    if (!tail) return `Usage: /autopilot plan <goal>\n\n${HELP}`
    await update($, run, r => ({ ...r, isOn: false, round: 0, stuck: 0, lastGoals: '', task: null, base: null, fails: 0 }))
    submitSoon($, planPrompt(tail))
    return `Planning ${GOALS_FILE}. Review it, then run /autopilot to start.`
  }
  if (verb === 'rounds') {
    const n = Number(tail)
    if (!Number.isInteger(n) || n < 1) return 'Usage: /autopilot rounds <n>'
    await update($, run, r => ({ ...r, maxRounds: n }))
  } else if (args) {
    await start($, planPrompt(args), { round: 0 })
    return `Autopilot on: planning ${GOALS_FILE}, then working through it. /autopilot stop to stop.`
  }

  // Resume from GOALS.md: the first round's prompt comes from the same decision
  // every round uses. A plain resume carries on the paused run's round count and
  // stuck tally; `rounds <n>` starts a fresh budget (what the nightly routine sends).
  const goalsText = await readGoals($)
  const r = await read($, run)
  const from = verb === 'rounds' ? { round: 0, stuck: 0, lastGoals: '' } : r
  const decision = decide({
    goalsText,
    lastGoals: from.lastGoals,
    stuck: from.stuck,
    round: from.round,
    maxRounds: r.maxRounds,
    answer: '',
    fresh: r.fresh,
  })
  if (decision.action === 'stop') {
    const hint = decision.reason.startsWith('reached') ? ' Use /autopilot rounds <n> for a fresh budget.' : ''
    return `Autopilot can't start: ${decision.reason}.${hint}\n\n${HELP}`
  }
  await start($, decision.prompt, { round: from.round + 1, stuck: decision.stuck, task: decision.task })
  return `Autopilot on (up to ${r.maxRounds} rounds). /autopilot stop to stop.`
}

// ---- after each round: the mod's own verdict

async function afterRound($: Engine, r: Run, answer: string) {
  const blocked = BLOCKED.exec(answer)
  if (blocked) return stop($, `blocked: ${blocked[1]?.trim() || 'needs you'}`)

  const locks = await readLocks($)
  const { changed, lost } = await verifyLocks($, locks)
  if (lost.length > 0) return stop($, `locked checks were changed and can't be restored: ${lost.join(', ')}`)

  const goalsText = await readGoals($)
  const check = parseCommand(goalsText, 'Check')
  const done = parseCommand(goalsText, 'Done')
  const now = await $.clock.now()

  // A work round happened (not just planning): hold it to the locks and the Check.
  if (r.task !== null) {
    let output = ''
    let passed = changed.length === 0
    if (passed && check) {
      const ran = await runCommand($, check)
      passed = ran.passed
      output = ran.output
      await update($, run, x => ({ ...x, verdict: { passed, at: now, command: check } }))
    }
    if (!passed) {
      const attempt = r.fails + 1
      if (attempt >= FAIL_LIMIT) {
        const undone = r.base && r.task !== DONE_TASK ? `; ${await revertTask($, r.base, r.task, locks)}` : ''
        return stop($, `"${r.task}" failed its check ${FAIL_LIMIT} times${undone}`)
      }
      if (r.round >= r.maxRounds) return stop($, `reached ${r.maxRounds} rounds with "${r.task}" still failing its check`)
      await update($, run, x => ({ ...x, round: x.round + 1, fails: attempt }))
      await showStatus($)
      void $.prompt.submit({
        text: fixPrompt({
          task: r.task,
          round: r.round + 1,
          maxRounds: r.maxRounds,
          check,
          output,
          attempt: attempt + 1,
          tampered: changed,
          fresh: r.fresh,
          rules: RULES,
        }),
      })
      return
    }
  }

  const decision = decide({
    goalsText,
    lastGoals: r.lastGoals,
    stuck: r.stuck,
    round: r.round,
    maxRounds: r.maxRounds,
    answer,
    fresh: r.fresh,
  })

  if (decision.action === 'stop' && decision.reason === 'every goal is done' && done) {
    const ran = await runCommand($, done)
    await update($, run, x => ({ ...x, verdict: { passed: ran.passed, at: now, command: done } }))
    if (!ran.passed) {
      const attempt = r.task === DONE_TASK ? r.fails + 1 : 1
      if (attempt > FAIL_LIMIT) return stop($, `every task is ticked but the done check still fails after ${FAIL_LIMIT} tries`)
      if (r.round >= r.maxRounds) return stop($, `reached ${r.maxRounds} rounds with the done check failing`)
      await update($, run, x => ({ ...x, round: x.round + 1, task: DONE_TASK, base: null, fails: attempt, lastGoals: goalsText ?? '' }))
      await showStatus($)
      void $.prompt.submit({
        text: donePrompt({ round: r.round + 1, maxRounds: r.maxRounds, done, output: ran.output, attempt, rules: RULES }),
      })
      return
    }
    return stop($, 'every goal is done and the done check passes')
  }

  if (decision.action === 'stop') return stop($, decision.reason)

  const isNewTask = decision.task !== r.task
  const base = isNewTask ? await headCommit($) : r.base
  await update($, run, x => ({
    ...x,
    round: x.round + 1,
    stuck: decision.stuck,
    lastGoals: goalsText ?? '',
    task: decision.task,
    base,
    fails: 0,
  }))
  await showStatus($)
  void $.prompt.submit({ text: decision.prompt })
}

async function onMainBranch($: Engine): Promise<boolean> {
  try {
    const { stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    return /^(main|master)$/.test(stdout.trim())
  } catch {
    return false
  }
}

function describe(r: Run, g: GoalsSummary | null, locks: Locks): string {
  const state = r.isOn
    ? r.phase === 'checks'
      ? 'writing checks'
      : `running, round ${r.round}/${r.maxRounds}`
    : `off${r.lastStop ? ` (last stop: ${r.lastStop})` : ''}`
  const tree = g
    ? `${g.goal ?? 'GOALS.md'}: ${g.done}/${g.total} done${g.next ? `\nNext: ${g.next}` : ''}`
    : 'No GOALS.md yet.'
  const lockCount = Object.keys(locks).length
  const extras = [
    lockCount > 0 ? `${lockCount} locked check file${lockCount === 1 ? '' : 's'}` : 'no locked checks',
    r.verdict ? `last check ${r.verdict.passed ? 'passed' : 'failed'}: ${r.verdict.command}` : null,
    `fresh subagents ${r.fresh ? 'on' : 'off'}`,
  ].filter(Boolean)
  return `Autopilot ${state}.\n${tree}\n${extras.join(' · ')}`
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60000)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

export const register: Register = on => {
  let turnTools = 0
  let fromRoutine: string | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'autopilot',
      description: 'Work through GOALS.md autonomously, one small task per turn',
      argumentHint: '[<goal> | plan | checks | lock | rounds <n> | fresh on|off | stop | status]',
    })
    const fresh = (await $.store.get('fresh')) === true
    await update($, run, r => ({ ...r, fresh }))
    await refreshGoals($)
    await showStatus($)
    return next(e)
  })

  on('command.run', { command: 'autopilot' }, async ($, e) => ({ text: await handle($, e.args) }))

  on('prompt.submit', ($, e, next) => {
    turnTools = 0
    return next(e)
  })

  // A nightly Routine's "/autopilot rounds 80" arrives as a notification the
  // model reads, not as a typed command. Neither a tool hook nor a command may
  // start a turn, so it is queued here and run when this turn ends.
  on('tool.call', { tool: 'ReadNotifications' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const list: unknown = ran.result?.notifications
    const args = Array.isArray(list) ? routineCommand(list) : null
    if (args === null) return ran
    fromRoutine = args
    const note = `The autopilot mod will run "/autopilot ${args}" for the routine as soon as this turn ends; its next prompt carries the first task. Don't start any work now: reply in one line that autopilot is starting.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  // Safety guards: always on, since an unattended loop is exactly when they matter.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      const reason = dangerous(e.command) ?? (pushes(e.command) && (await onMainBranch($)) ? 'pushing while main/master is checked out; push a feature branch instead' : null)
      if (reason) return { deny: `autopilot guard: ${reason}. Find a safer way, or ask the human.` }
      const locks = await readLocks($)
      const hit = Object.keys(locks).length > 0 ? touchesLocked(e.command, locks) : null
      if (hit) return { deny: `autopilot guard: ${hit} is a locked check and can't be changed. Make the code satisfy it instead.` }
    }
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
      if (protectedFile(path)) {
        return { deny: `autopilot guard: ${path} holds secrets and is not edited automatically.` }
      }
      const rel = relPath(path, (await repoRoot($)) ?? '')
      if (isLockedPath(rel, await readLocks($))) {
        return { deny: `autopilot guard: ${rel} is a locked check and can't be changed. Make the code satisfy it instead.` }
      }
    }

    turnTools += 1
    const ran = await next(e)

    if (ran.deny === undefined) {
      if ((e.tool === 'Edit' || e.tool === 'Write') && !ran.isError) {
        const file = e.file_path
        await update($, stats, s => (s.files.includes(file) ? s : { ...s, files: [...s.files, file] }))
        if (file.endsWith(GOALS_FILE)) await refreshGoals($)
      }
      if (e.tool === 'Bash' && isTestCommand(e.command)) {
        const at = await $.clock.now()
        const lastTest = { passed: ran.isError !== true, at, command: e.command.slice(0, 80) }
        await update($, stats, s => ({ ...s, lastTest }))
      }
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const turnSeconds = Math.round(e.durationMs / 1000)
    await update($, stats, s => ({ ...s, turnSeconds, turnTools }))
    await refreshGoals($)

    if (fromRoutine !== null) {
      const args = fromRoutine
      fromRoutine = null
      $.ui.toast(await handle($, args), { timeoutMs: 10000 })
      return done
    }

    const r = await read($, run)
    if (!r.isOn) {
      await showStatus($)
      return done
    }
    if (e.isAborted) {
      await stop($, 'paused because you interrupted; /autopilot resumes', true)
      return done
    }
    if (e.reason === 'error' || e.reason === 'refusal') {
      await stop($, `the turn ended with ${e.reason === 'error' ? 'an API error' : 'a refusal'}`)
      return done
    }
    if (r.phase === 'checks') {
      await update($, run, x => ({ ...x, isOn: false, phase: 'work', lastStop: 'checks written; review them, then /autopilot lock' }))
      await showStatus($)
      await notify($, 'Autopilot wrote the checks: review them, then type /autopilot lock')
      return done
    }

    await afterRound($, r, e.answer)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const r = await read($, run)
    const g = await read($, goals)
    const s = await read($, stats)
    if (!r.isOn && !g && s.turnSeconds === null) return next(e)

    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const head = r.isOn
      ? r.phase === 'checks'
        ? 'Autopilot ▶ writing checks'
        : `Autopilot ▶ round ${r.round}/${r.maxRounds}${r.fails > 0 ? ` (fix ${r.fails + 1}/${FAIL_LIMIT})` : ''}`
      : `Autopilot off${r.lastStop ? ` (${r.lastStop})` : ''}`
    const turn = e.props.isWorking
      ? 'Working…'
      : s.turnSeconds === null
        ? null
        : `Last turn ${s.turnSeconds}s · ${s.turnTools} tool calls`
    const verdict = r.verdict ? `check ${r.verdict.passed ? '✓' : '✗'} ${ago(now - r.verdict.at)}` : null
    const test = !verdict && s.lastTest ? `tests ${s.lastTest.passed ? '✓ passed' : '✗ failed'} ${ago(now - s.lastTest.at)}` : null
    const work = [turn, `${s.files.length} files edited`, verdict ?? test, r.fresh ? 'fresh subagents' : null]
      .filter(Boolean)
      .join(' · ')

    return (
      <Box flexDirection="column">
        <Text bold color={r.isOn ? 'green' : undefined}>
          {[head, g && `${g.done}/${g.total} done`, g?.goal].filter(Boolean).join(' · ')}
        </Text>
        {g?.next && <Text>{`Next: ${g.next}`}</Text>}
        <Text dimColor>{work}</Text>
        <Box>
          {r.isOn && <Button key="stop" label="Stop autopilot" onPress={() => stop($, 'stopped by you', true)} />}
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
