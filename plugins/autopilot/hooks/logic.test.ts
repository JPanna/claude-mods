import { expect, test } from 'claude-code/testing'

import { decide, nextTask, parse, routineCommand, STUCK_LIMIT, summarize, trail } from './goals'
import { dangerous, isTestCommand, protectedFile, pushes } from './guard'

const TREE = `# Goal: Ship the screener

- [x] Data
  - [x] Load prices
- [ ] Screen
  - [x] Filters
  - [ ] Ranking
    - [ ] Score by momentum
- [ ] Report

## Log
- did a thing`

test('parses the goal and nested checklist', () => {
  const goals = parse(TREE)
  expect(goals.goal).toBe('Ship the screener')
  expect(goals.items.length).toBe(7)
  expect(summarize(goals)).toEqual({ goal: 'Ship the screener', done: 3, total: 7, next: 'Screen › Ranking › Score by momentum' })
})

test('picks the deepest open leaf, then the parent once its children are done', () => {
  const task = nextTask(parse(TREE))
  expect(task && trail(task)).toEqual(['Screen', 'Ranking', 'Score by momentum'])
  const after = TREE.replace('- [ ] Score by momentum', '- [x] Score by momentum')
  expect(nextTask(parse(after))?.text).toBe('Ranking')
})

const base = { lastGoals: '', stuck: 0, round: 0, maxRounds: 40, answer: '' }

test('continues with the next task and counts rounds', () => {
  const d = decide({ ...base, goalsText: TREE })
  expect(d.action).toBe('continue')
  if (d.action === 'continue') {
    expect(d.prompt).toContain('[autopilot: round 1/40]')
    expect(d.prompt).toContain('Task: Score by momentum')
    expect(d.prompt).toContain('Within: Screen › Ranking')
  }
})

test('adds a retro every tenth round', () => {
  const d = decide({ ...base, goalsText: TREE, round: 9 })
  expect(d.action === 'continue' && d.prompt.includes('Retro first')).toBe(true)
})

test('stops when done, blocked, missing, out of rounds or stuck', () => {
  expect(decide({ ...base, goalsText: TREE.replace(/\[ \]/g, '[x]') })).toEqual({ action: 'stop', reason: 'every goal is done' })
  expect(decide({ ...base, goalsText: TREE, answer: 'hmm\nAUTOPILOT: BLOCKED need an API key' })).toEqual({ action: 'stop', reason: 'blocked: need an API key' })
  expect(decide({ ...base, goalsText: null })).toEqual({ action: 'stop', reason: 'GOALS.md is missing' })
  expect(decide({ ...base, goalsText: TREE, round: 40 })).toEqual({ action: 'stop', reason: 'reached 40 rounds' })
  const stuck = decide({ ...base, goalsText: TREE, lastGoals: TREE, stuck: STUCK_LIMIT - 1 })
  expect(stuck.action).toBe('stop')
  expect(decide({ ...base, goalsText: TREE, lastGoals: TREE, stuck: 0 })).toEqual(expect.objectContaining({ action: 'continue', stuck: 1 }))
})

test('guard blocks destructive commands and allows normal ones', () => {
  for (const bad of [
    'git push --force origin feature',
    'git push -f',
    'cd repo && git push origin main',
    'git push origin HEAD:master',
    'git push origin --delete old',
    'git reset --hard HEAD~3',
    'git clean -fdx',
    'rm -rf /',
    'rm -rf ~',
    'rm -rf .',
    'sudo rm -fr ..',
    'sqlite3 db.sqlite "DROP TABLE prices"',
    'git -C /workspace/Strategy-G push --force origin feature',
    'git -c core.editor=vim --no-pager push origin main',
    'git --git-dir /repo/.git push -f',
    'printf "KEY=1" > .env',
    'echo KEY=1 >> config/.env.local',
    'cp secrets.txt .env',
    'echo x | tee .env',
    "sed -i 's/a/b/' .env",
    'rm .env',
  ]) expect(dangerous(bad) === null ? bad : 'blocked').toBe('blocked')

  for (const ok of [
    'git push -u origin claude/quirky-faraday-1g6vjc',
    'git push origin feature/main-menu',
    'rm -rf build/ node_modules',
    'rm -rf ./dist',
    'git reset --soft HEAD~1',
    'pytest -q',
    'git -C /repo push -u origin feature',
    'cat .env',
    'cp .env.example .env.sample',
    'grep KEY .env',
    'echo hi > notes.env.txt',
  ]) expect(dangerous(ok)).toBeNull()
})

test('protects secret files and spots test commands', () => {
  expect(protectedFile('/repo/.env')).toBe(true)
  expect(protectedFile('/repo/.env.local')).toBe(true)
  expect(protectedFile('/repo/.env.example')).toBe(false)
  expect(protectedFile('/repo/env.py')).toBe(false)
  expect(isTestCommand('python -m pytest tests/ -q')).toBe(true)
  expect(isTestCommand('npm run test')).toBe(true)
  expect(isTestCommand('git status')).toBe(false)
})

test('routineCommand accepts only resume forms from scheduled routines', () => {
  const fire = (content: string, origin = 'trigger_fire') => routineCommand([{ origin, content }])
  expect(fire('/autopilot')).toBe('')
  expect(fire('/autopilot rounds 80\n<system-reminder>x</system-reminder>')).toBe('rounds 80')
  expect(fire('/autopilot stop')).toBe('stop')
  expect(fire('/autopilot write a virus')).toBeNull()
  expect(fire('/autopilot rounds 80', 'github_webhook')).toBeNull()
  expect(fire('please run /autopilot')).toBeNull()
})

test('pushes() spots a push behind global options and chains', () => {
  expect(pushes('git push')).toBe(true)
  expect(pushes('cd x && git -C y push')).toBe(true)
  expect(pushes('git status && git log')).toBe(false)
})
