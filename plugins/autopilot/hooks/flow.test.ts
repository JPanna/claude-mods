import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A fake repo at /repo: files by repo-relative path, git answering from them
// (a blob id is "h:" + content), and the Check/Done commands answering from a queue.
function repo(on: On, files: Record<string, string>, results: boolean[] = []) {
  const clock = mock.clock(on)
  mock.store(on)
  const prompts: string[] = []
  const git: string[][] = []
  const key = (path: string) => (path.startsWith('/repo/') ? path.slice(6) : (path.split('/').pop() ?? path))
  const ok = (stdout = '', exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('fs.read', (_$, e) => {
    const text = files[key(e.path)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'sh') return run(e.argv[2] ?? '')
    if (cmd !== 'git') return ok('', 1)
    git.push(args)
    const [sub, ...rest] = args
    if (sub === 'rev-parse') return ok(rest[0] === '--show-toplevel' ? '/repo\n' : rest[0] === 'HEAD' ? 'base123\n' : 'feature\n')
    if (sub === 'hash-object') {
      const path = rest.at(-1) ?? ''
      return files[path] === undefined ? ok('', 128) : ok(`h:${files[path]}\n`)
    }
    if (sub === 'cat-file') return ok((rest[1] ?? '').slice(2))
    if (sub === 'ls-files') return ok(Object.keys(files).filter(p => p.startsWith('tests/')).join('\n'))
    return ok()
  })
  function run(command: string) {
    const passed = results.shift() ?? true
    return ok(passed ? `ran ${command}: passed` : `ran ${command}: FAILED test_export`, passed ? 0 : 1)
  }
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} as never, text: '', ref: 0 }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return { prompts, git, clock }
}

const turn = (answer = 'ok') =>
  ({ answer, durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' as const })
const cmd = (args: string) => ({ command: 'autopilot', args }) as never
const status = async ($: { command: { run: (i: never) => Promise<{ text?: string }> } }) =>
  (await $.command.run(cmd('status'))).text ?? ''

const GOALS = `# Goal: CSV export
Check: ruff check
Done: pytest tests/test_export.py

- [ ] First task
- [ ] Second task

## Log
`

test('checks, then lock: the tests get fingerprinted and the guard protects them', async ($, on) => {
  const files: Record<string, string> = {}
  const { prompts, clock } = repo(on, files)

  await $.command.run(cmd('checks add CSV export'))
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('[autopilot: writing checks]')

  files['tests/test_export.py'] = 'def test_export(): ...'
  await $.turn.complete(turn('Wrote tests/test_export.py'))
  expect(await status($)).toContain('checks written')

  const locked = await $.command.run(cmd('lock'))
  expect(locked.text).toContain('Locked 1 file')
  expect(JSON.parse(files['.autopilot/locks.json'] ?? '{}')).toEqual({
    files: { 'tests/test_export.py': 'h:def test_export(): ...' },
  })

  const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/tests/test_export.py', old_string: 'a', new_string: 'b' } as never)
  expect(edit.deny).toContain('locked check')
  const sed = await $.tool.call({ tool: 'Bash', command: "sed -i 's/a/b/' tests/test_export.py" } as never)
  expect(sed.deny).toContain('locked check')
  const lockFile = await $.tool.call({ tool: 'Write', file_path: '/repo/.autopilot/locks.json', content: '{}' } as never)
  expect(lockFile.deny).toContain('locked check')
  const read = await $.tool.call({ tool: 'Bash', command: 'cat tests/test_export.py' } as never)
  expect(read.deny).toBeUndefined()

  expect((await $.command.run(cmd('unlock'))).text).toContain('Unlocked 1 file')
})

test('a failed Check sends a fix round; a pass moves on to the next task', async ($, on) => {
  const files: Record<string, string> = { 'GOALS.md': GOALS }
  const { prompts, clock } = repo(on, files, [false, true])

  await $.command.run(cmd(''))
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('Task: First task')
  expect(prompts.at(-1)).toContain('Check: `ruff check`')

  await $.turn.complete(turn())
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('fixing, attempt 2 of 3')
  expect(prompts.at(-1)).toContain('FAILED test_export')

  files['GOALS.md'] = GOALS.replace('- [ ] First', '- [x] First')
  const shown = await $.turn.complete(turn())
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('Task: Second task')
  expect(shown.text).toBe('Autopilot · round 3/40 · 1/2 done · next: Second task · last check ✓')
  expect(await status($)).toContain('last check passed: ruff check')
})

test('three failed Checks revert the task and stop', async ($, on) => {
  const files: Record<string, string> = { 'GOALS.md': GOALS }
  const { git, clock } = repo(on, files, [false, false, false])

  await $.command.run(cmd(''))
  await clock.advance(200)
  for (let i = 0; i < 3; i += 1) {
    await $.turn.complete(turn())
    await clock.advance(200)
  }
  const text = await status($)
  expect(text).toContain('"First task" failed its check 3 times')
  expect(text).toContain('reverted')
  expect(git.some(a => a[0] === 'restore' && a.includes('--source=base123'))).toBe(true)
  expect(files['GOALS.md']).toContain('- Reverted "First task" after 3 failed checks.')
})

test('an edited locked check is put back and the round is sent back to fix it', async ($, on) => {
  const files: Record<string, string> = {
    'GOALS.md': GOALS.replace('Check: ruff check\n', ''),
    'tests/test_export.py': 'original',
    '.autopilot/locks.json': JSON.stringify({ files: { 'tests/test_export.py': 'h:original' } }),
  }
  const { prompts, clock } = repo(on, files)

  await $.command.run(cmd(''))
  await clock.advance(200)
  files['tests/test_export.py'] = 'weakened'
  await $.turn.complete(turn())
  await clock.advance(200)
  expect(files['tests/test_export.py']).toBe('original')
  expect(prompts.at(-1)).toContain('Locked check files were changed and have been restored: tests/test_export.py')
})

test('the goal only finishes when the Done command passes', async ($, on) => {
  const done = GOALS.replace(/- \[ \]/g, '- [x]').replace('Check: ruff check\n', '')
  const files: Record<string, string> = { 'GOALS.md': GOALS.replace('Check: ruff check\n', '') }
  const { prompts, clock } = repo(on, files, [false, true])

  await $.command.run(cmd(''))
  await clock.advance(200)
  files['GOALS.md'] = done
  await $.turn.complete(turn())
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('goal not met yet')
  expect(prompts.at(-1)).toContain('pytest tests/test_export.py')

  await $.turn.complete(turn())
  await clock.advance(200)
  expect(await status($)).toContain('every goal is done and the done check passes')
})

test('fresh on hands each round to a new subagent', async ($, on) => {
  const files: Record<string, string> = { 'GOALS.md': GOALS.replace('Check: ruff check\n', '') }
  const { prompts, clock } = repo(on, files)

  expect((await $.command.run(cmd('fresh on'))).text).toContain('Fresh subagents on')
  await $.command.run(cmd(''))
  await clock.advance(200)
  expect(prompts.at(-1)).toContain('fresh subagent')
  expect(await status($)).toContain('fresh subagents on')
  expect((await $.command.run(cmd('fresh maybe'))).text).toContain('Usage')
})
