import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { GoalsSummary, Run, Stats } from '../types'
import { DEFAULT_MAX_ROUNDS, GOALS_FILE, decide, parse, planPrompt, routineCommand, summarize } from './goals'
import { dangerous, isTestCommand, protectedFile, pushes } from './guard'

const OFF: Run = { isOn: false, round: 0, maxRounds: DEFAULT_MAX_ROUNDS, stuck: 0, lastGoals: '', lastStop: null }
const EMPTY: Stats = { turnSeconds: null, turnTools: 0, files: [], lastTest: null }

const run = atom({ plugin: 'autopilot', key: 'run' } as const, OFF)
const goals = atom({ plugin: 'autopilot', key: 'goals' } as const, null)
const stats = atom({ plugin: 'autopilot', key: 'stats' } as const, EMPTY)
const isHidden = atom({ plugin: 'autopilot', key: 'isHidden' } as const, false)

const HELP = `/autopilot <goal>       plan GOALS.md for a new goal, then work through it
/autopilot              resume from the existing GOALS.md
/autopilot plan <goal>  only write GOALS.md, so you can review it first
/autopilot rounds <n>   set the round limit (default ${DEFAULT_MAX_ROUNDS}), then resume
/autopilot stop         stop after the current turn
/autopilot status       where things stand`

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
  await update($, run, r => ({ ...r, isOn: false, lastStop: reason }))
  await showStatus($)
  if (!isQuiet) await notify($, `Autopilot stopped: ${reason}`)
}

async function start($: Engine, first: string, round = 0, stuck = 0) {
  const lastGoals = (await readGoals($)) ?? ''
  await update($, run, r => ({ ...r, isOn: true, round, stuck, lastGoals, lastStop: null }))
  await showStatus($)
  submitSoon($, first)
}

async function handle($: Engine, input: string): Promise<string> {
  const args = input.trim()
  const [verb, ...rest] = args.split(/\s+/)
  const tail = rest.join(' ').trim()

  if (verb === 'help') return HELP
  if (verb === 'status') return describe(await read($, run), await refreshGoals($))
  if (verb === 'stop') {
    await stop($, 'stopped by you', true)
    return 'Autopilot will stop after the current turn.'
  }
  if (verb === 'plan') {
    if (!tail) return `Usage: /autopilot plan <goal>\n\n${HELP}`
    await update($, run, r => ({ ...r, isOn: false, round: 0, stuck: 0, lastGoals: '' }))
    submitSoon($, planPrompt(tail))
    return `Planning ${GOALS_FILE}. Review it, then run /autopilot to start.`
  }
  if (verb === 'rounds') {
    const n = Number(tail)
    if (!Number.isInteger(n) || n < 1) return 'Usage: /autopilot rounds <n>'
    await update($, run, r => ({ ...r, maxRounds: n }))
  } else if (args) {
    await start($, planPrompt(args))
    return `Autopilot on: planning ${GOALS_FILE}, then working through it. /autopilot stop to stop.`
  }

  // Resume from GOALS.md: the first round's prompt comes from the same decision
  // every round uses. A plain resume carries on the paused run's round count and
  // stuck tally; `rounds <n>` starts a fresh budget (what the nightly routine sends).
  const goalsText = await readGoals($)
  const r = await read($, run)
  const from = verb === 'rounds' ? { round: 0, stuck: 0, lastGoals: '' } : r
  const decision = decide({ goalsText, lastGoals: from.lastGoals, stuck: from.stuck, round: from.round, maxRounds: r.maxRounds, answer: '' })
  if (decision.action === 'stop') {
    const hint = decision.reason.startsWith('reached') ? ' Use /autopilot rounds <n> for a fresh budget.' : ''
    return `Autopilot can't start: ${decision.reason}.${hint}\n\n${HELP}`
  }
  await start($, decision.prompt, from.round + 1, decision.stuck)
  return `Autopilot on (up to ${r.maxRounds} rounds). /autopilot stop to stop.`
}

async function onMainBranch($: Engine): Promise<boolean> {
  try {
    const { stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    return /^(main|master)$/.test(stdout.trim())
  } catch {
    return false
  }
}

function describe(r: Run, g: GoalsSummary | null): string {
  const state = r.isOn
    ? `running, round ${r.round}/${r.maxRounds}`
    : `off${r.lastStop ? ` (last stop: ${r.lastStop})` : ''}`
  const tree = g
    ? `${g.goal ?? 'GOALS.md'}: ${g.done}/${g.total} done${g.next ? `\nNext: ${g.next}` : ''}`
    : 'No GOALS.md yet.'
  return `Autopilot ${state}.\n${tree}`
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
      argumentHint: '[<goal> | plan <goal> | rounds <n> | stop | status]',
    })
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
    }
    if ((e.tool === 'Edit' || e.tool === 'Write') && protectedFile(e.file_path)) {
      return { deny: `autopilot guard: ${e.file_path} holds secrets and is not edited automatically.` }
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

    const goalsText = await readGoals($)
    const decision = decide({
      goalsText,
      lastGoals: r.lastGoals,
      stuck: r.stuck,
      round: r.round,
      maxRounds: r.maxRounds,
      answer: e.answer,
    })

    if (decision.action === 'stop') {
      await stop($, decision.reason)
    } else {
      await update($, run, x => ({ ...x, round: x.round + 1, stuck: decision.stuck, lastGoals: goalsText ?? '' }))
      await showStatus($)
      void $.prompt.submit({ text: decision.prompt })
    }
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
      ? `Autopilot ▶ round ${r.round}/${r.maxRounds}`
      : `Autopilot off${r.lastStop ? ` (${r.lastStop})` : ''}`
    const turn = e.props.isWorking
      ? 'Working…'
      : s.turnSeconds === null
        ? null
        : `Last turn ${s.turnSeconds}s · ${s.turnTools} tool calls`
    const test = s.lastTest ? `tests ${s.lastTest.passed ? '✓ passed' : '✗ failed'} ${ago(now - s.lastTest.at)}` : null
    const work = [turn, `${s.files.length} files edited`, test].filter(Boolean).join(' · ')

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
