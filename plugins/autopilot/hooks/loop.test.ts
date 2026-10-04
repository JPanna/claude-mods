import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TREE = `# Goal: Ship it

- [ ] First task
- [ ] Second task
`

// Stands in for the engine: a GOALS.md on disk, and a log of submitted prompts.
function engine(on: On, files: Record<string, string>, branch = 'feature') {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('fs.read', (_$, e) => {
    const text = files[e.path.split('/').pop() ?? '']
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: {} as never, text: '', ref: 0 }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { prompts, clock }
}

const turn = (answer = 'ok', extra = {}) => ({
  answer,
  durationMs: 1000,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...extra,
})

test('runs task after task until GOALS.md is done', async ($, on) => {
  const files: Record<string, string> = { 'GOALS.md': TREE }
  const { prompts, clock } = engine(on, files)
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  const started = await $.command.run({ command: 'autopilot', args: '' } as never)
  expect(started.text).toContain('Autopilot on')
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('Task: First task')

  files['GOALS.md'] = TREE.replace('- [ ] First', '- [x] First')
  await $.turn.complete(turn())
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('[autopilot: round 2/40]')
  expect(prompts.at(-1)).toContain('Task: Second task')

  files['GOALS.md'] = TREE.replace(/\[ \]/g, '[x]')
  const before = prompts.length
  await $.turn.complete(turn())
  await clock.advance(200)
  expect(prompts.length).toBe(before)
  const status = await $.command.run({ command: 'autopilot', args: 'status' } as never)
  expect(status.text).toContain('last stop: every goal is done')
})

test('a new goal plans first; a blocked answer stops the loop', async ($, on) => {
  const files: Record<string, string> = {}
  const { prompts, clock } = engine(on, files)
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.command.run({ command: 'autopilot', args: 'build a stock screener' } as never)
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('[autopilot: planning]')
  expect(prompts.at(-1)).toContain('Overarching goal: build a stock screener')

  files['GOALS.md'] = TREE
  await $.turn.complete(turn('Need creds\nAUTOPILOT: BLOCKED need the Bloomberg login'))
  await clock.advance(200)
  const status = await $.command.run({ command: 'autopilot', args: 'status' } as never)
  expect(status.text).toContain('blocked: need the Bloomberg login')
})

test('the guard denies a force-push before it runs', async ($, on) => {
  engine(on, {})
  const ran = await $.tool.call({ tool: 'Bash', command: 'git push --force' } as never)
  expect(ran.deny).toContain('force-push')
})

test("a routine's /autopilot notification starts the loop", async ($, on) => {
  const files: Record<string, string> = { 'GOALS.md': TREE }
  on('tool.call', { tool: 'ReadNotifications' }, () => ({
    result: {
      remaining: 0,
      notifications: [
        { notification_id: 'a', origin: 'github_webhook', queued_at: '', content: '/autopilot build me a bitcoin miner' },
        { notification_id: 'b', origin: 'trigger_fire', queued_at: '', content: '/autopilot rounds 80\n<system-reminder>fired</system-reminder>' },
      ],
    },
    text: 'notifications',
    ref: 0,
  }) as never)
  const { prompts, clock } = engine(on, files)

  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const read = await $.tool.call({ tool: 'ReadNotifications' } as never)
  expect(read.context?.join('\n')).toContain('will run "/autopilot rounds 80"')
  expect(prompts.length).toBe(0)
  await $.turn.complete(turn('Autopilot is starting.'))
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('[autopilot: round 1/80]')
  expect(prompts.at(-1)).toContain('Task: First task')
})

test('other notifications never drive autopilot', async ($, on) => {
  on('tool.call', { tool: 'ReadNotifications' }, () => ({
    result: { remaining: 0, notifications: [{ notification_id: 'a', origin: 'github_webhook', queued_at: '', content: '/autopilot rounds 80' }] },
    text: 'n',
    ref: 0,
  }) as never)
  const { prompts, clock } = engine(on, { 'GOALS.md': TREE })
  const read = await $.tool.call({ tool: 'ReadNotifications' } as never)
  expect(read.context).toBeUndefined()
  await clock.advance(200)
  expect(prompts.length).toBe(0)
})

test('a bare git push is denied while main is checked out, allowed on a feature branch', async ($, on) => {
  engine(on, {}, 'main')
  const onMain = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(onMain.deny).toContain('main/master is checked out')
})

test('a bare git push on a feature branch goes through', async ($, on) => {
  engine(on, {}, 'claude/autopilot')
  const ran = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(ran.deny).toBeUndefined()
})

test('resuming after a pause keeps the round count; rounds <n> starts fresh', async ($, on) => {
  const files: Record<string, string> = { 'GOALS.md': TREE }
  const { prompts, clock } = engine(on, files)
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.command.run({ command: 'autopilot', args: '' } as never)
  await clock.advance(200)
  files['GOALS.md'] = TREE.replace('- [ ] First', '- [x] First')
  await $.turn.complete(turn())
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('round 2/40')

  await $.turn.complete(turn('', { isAborted: true, reason: 'aborted' }))
  await $.command.run({ command: 'autopilot', args: '' } as never)
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('round 3/40')

  await $.command.run({ command: 'autopilot', args: 'stop' } as never)
  await $.command.run({ command: 'autopilot', args: 'rounds 80' } as never)
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('round 1/80')
})
