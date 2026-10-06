import { expect, test } from 'claude-code/testing'

import {
  FAIL_LIMIT,
  checksPrompt,
  donePrompt,
  fixPrompt,
  formatLocks,
  isLockedPath,
  parseLocks,
  progressLine,
  relPath,
  tail,
  touchesLocked,
} from './checks'
import { LESSONS_FILE, RULES, appendLog, decide, parseCommand } from './goals'
import { writes } from './guard'

const TREE = `# Goal: Ship CSV export
Check: \`ruff check && pytest tests/ -q --ignore=tests/test_export.py\`
Done: pytest tests/ -q

- [ ] Write the exporter

## Log
- planned`

test('reads the Check and Done commands, ignoring template placeholders', () => {
  expect(parseCommand(TREE, 'Check')).toBe('ruff check && pytest tests/ -q --ignore=tests/test_export.py')
  expect(parseCommand(TREE, 'Done')).toBe('pytest tests/ -q')
  expect(parseCommand('# Goal: x\nCheck: <command that passes now>', 'Check')).toBeNull()
  expect(parseCommand('# Goal: x', 'Done')).toBeNull()
  expect(parseCommand(null, 'Check')).toBeNull()
})

test('appends to the Log section, creating it if needed', () => {
  expect(appendLog(TREE, 'reverted X')).toBe(`${TREE}\n- reverted X\n`)
  const withLater = '# Goal: x\n\n## Log\n- a\n\n## Notes\nn\n'
  expect(appendLog(withLater, 'b')).toBe('# Goal: x\n\n## Log\n- a\n- b\n\n## Notes\nn\n')
  expect(appendLog('# Goal: x\n', 'first')).toBe('# Goal: x\n\n## Log\n- first\n')
})

test('lock files round-trip and bad JSON reads as no locks', () => {
  const locks = { 'tests/test_export.py': 'abc123' }
  expect(parseLocks(formatLocks(locks))).toEqual(locks)
  expect(parseLocks('not json')).toEqual({})
  expect(parseLocks(null)).toEqual({})
  expect(parseLocks('{"files": {"a": 1, "b": "x"}}')).toEqual({ b: 'x' })
})

test('paths are compared repo-relative, on Windows too', () => {
  expect(relPath('/repo/tests/test_export.py', '/repo')).toBe('tests/test_export.py')
  expect(relPath('C:\\Users\\g\\repo\\tests\\t.py', 'C:/Users/g/repo')).toBe('tests/t.py')
  expect(relPath('./tests/t.py', '/repo')).toBe('tests/t.py')
  const locks = { 'tests/test_export.py': 'abc' }
  expect(isLockedPath('tests/test_export.py', locks)).toBe(true)
  expect(isLockedPath('.autopilot/locks.json', {})).toBe(true)
  expect(isLockedPath('strategy_g/export.py', locks)).toBe(false)
})

test('shell writes to a locked file or the lock file are caught; reads pass', () => {
  const locks = { 'tests/test_export.py': 'abc' }
  for (const bad of [
    "sed -i 's/1/2/' tests/test_export.py",
    'cd tests && sed -i s/a/b/ test_export.py',
    'echo x > tests/test_export.py',
    'git checkout -- tests/test_export.py',
    'git -C /repo restore tests/test_export.py',
    'rm tests/test_export.py',
    'echo {} > .autopilot/locks.json',
  ]) expect(touchesLocked(bad, locks) === null ? bad : 'caught').toBe('caught')
  for (const ok of ['cat tests/test_export.py', 'pytest tests/test_export.py -q', 'sed -i s/a/b/ strategy_g/export.py', 'git status']) {
    expect(touchesLocked(ok, locks)).toBeNull()
  }
  expect(writes('git stash')).toBe(true)
  expect(writes('git log')).toBe(false)
})

test('tail keeps the end of long output', () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  expect(tail(long, 3)).toBe('line 97\nline 98\nline 99')
  expect(tail('x'.repeat(5000), 40, 10)).toBe('x'.repeat(10))
})

test('prompts carry the check, the done command, lessons and the fresh switch', () => {
  const d = decide({ goalsText: TREE, lastGoals: '', stuck: 0, round: 9, maxRounds: 40, answer: '', fresh: true })
  expect(d.action).toBe('continue')
  if (d.action !== 'continue') return
  expect(d.task).toBe('Write the exporter')
  expect(d.prompt).toContain('Check: `ruff check && pytest tests/ -q --ignore=tests/test_export.py`')
  expect(d.prompt).toContain('Done: `pytest tests/ -q`')
  expect(d.prompt).toContain('fresh subagent')
  expect(d.prompt).toContain(LESSONS_FILE)
  expect(d.prompt).toContain(`@${LESSONS_FILE}`)
  expect(RULES).toContain('locked checks')

  expect(checksPrompt('CSV export')).toContain('Write ONLY the automated checks')
  const fix = fixPrompt({ task: 'T', round: 3, maxRounds: 40, check: 'pytest', output: 'E boom', attempt: 2, tampered: [], fresh: false, rules: RULES })
  expect(fix).toContain(`attempt 2 of ${FAIL_LIMIT}`)
  expect(fix).toContain('E boom')
  const tampered = fixPrompt({ task: 'T', round: 3, maxRounds: 40, check: null, output: '', attempt: 2, tampered: ['tests/t.py'], fresh: false, rules: RULES })
  expect(tampered).toContain('Locked check files were changed and have been restored: tests/t.py')
  expect(donePrompt({ round: 5, maxRounds: 40, done: 'pytest', output: 'F', attempt: 1, rules: RULES })).toContain('goal not met yet')
})

test('the progress line under each reply says where autopilot is', () => {
  const base = { isOn: true, phase: 'work' as const, round: 3, maxRounds: 40, fails: 0, lastStop: null, done: 2, total: 9, next: 'Add tests', verdict: { passed: true } }
  expect(progressLine(base)).toBe('Autopilot · round 3/40 · 2/9 done · next: Add tests · last check ✓')
  expect(progressLine({ ...base, fails: 1, verdict: { passed: false } })).toBe('Autopilot · round 3/40 · fixing, attempt 2 of 3 · 2/9 done · next: Add tests · last check ✗')
  expect(progressLine({ ...base, phase: 'checks' })).toBe('Autopilot · writing checks')
  expect(progressLine({ ...base, isOn: false, lastStop: 'every goal is done' })).toBe('Autopilot stopped: every goal is done.')
})
