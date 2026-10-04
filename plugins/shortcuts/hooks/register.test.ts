import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { SHORTCUTS } from './register'

function capture(on: On) {
  const seen: string[] = []
  on('prompt.submit', (_$, e) => {
    seen.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  return seen
}

const cp = SHORTCUTS.cp?.text
const tdd = SHORTCUTS.tdd?.text
const ship = SHORTCUTS.ship?.text

test('leaves prompts without a shortcut alone', async ($, on) => {
  const seen = capture(on)
  for (const text of ['plan the backtest refactor', 'a;cp inside a word', 'unknown ;nope stays']) {
    await $.prompt.submit({ text } as never)
  }
  expect(seen).toEqual(['plan the backtest refactor', 'a;cp inside a word', 'unknown ;nope stays'])
})

test('appends each shortcut once, in order, and strips the tokens', async ($, on) => {
  const seen = capture(on)
  await $.prompt.submit({ text: ';cp which database should I use?' } as never)
  await $.prompt.submit({ text: 'add CSV export ;tdd ;ship ;TDD' } as never)
  await $.prompt.submit({ text: ';CP' } as never)
  expect(seen).toEqual([
    `which database should I use?\n\n${cp}`,
    `add CSV export\n\n${tdd}\n\n${ship}`,
    cp,
  ])
})

test('/shortcuts lists them all', async ($, on) => {
  const listed = await $.command.run({ command: 'shortcuts', args: '' } as never)
  for (const key of Object.keys(SHORTCUTS)) expect(listed.text).toContain(`;${key}`)
})
