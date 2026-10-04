import type { Register } from 'claude-code'

// Each shortcut, typed as its own word anywhere in a prompt, is removed and its
// instruction appended. Several can be combined: `add CSV export ;tdd ;ship`.
export const SHORTCUTS: Record<string, { label: string; text: string }> = {
  cp: {
    label: 'Clarification Protocol: ask the questions that matter first',
    text: 'CLARIFICATION PROTOCOL: Do not answer the main request yet. First identify every missing variable that could materially change the conclusion. Ask all and only the necessary questions in one numbered batch. Use concrete multiple-choice options where practical, while allowing multiple selections and free-text answers. Ask about objectives, real-world use, priorities, constraints, preferences, trade-offs and deal-breakers only when relevant. Do not repeat known information, ask generic questions, or ask for facts you can determine yourself. After my response, ask another round only if material uncertainty remains. Then give one decisive, personalised answer, including the reasoning, important trade-offs and any remaining assumptions. If no clarification would materially improve the answer, answer immediately.',
  },
  plan: {
    label: 'Plan first and wait for my OK',
    text: 'PLAN FIRST: Do not change any files yet. Read what you need, then give a short plan: the goal in one line, the approach, the files you will touch, the risks, and exactly how you will verify it works. Break it into small steps. Then stop and wait for my OK.',
  },
  go: {
    label: 'Work autonomously to done without checking in',
    text: 'GO AUTONOMOUS: Do not stop to ask me unless you hit something only I can decide or provide. Break the work into small steps and do them one after another, verifying each (run the tests, the app or the script) before moving on. Make sensible default choices and note them. Commit to the current branch as you go. Finish with a short summary: what you did, how you verified it, the decisions you made, and anything left.',
  },
  tdd: {
    label: 'Test-driven: failing test first',
    text: 'TEST-DRIVEN: First write a test that captures the behaviour and run it to show it fails for the right reason. Then write the least code that makes it pass, run it again, refactor while green, and finish by running the full test suite.',
  },
  ship: {
    label: 'Finish it: test, review, commit and push',
    text: 'SHIP IT: Run the tests and any lint or type checks and fix what fails. Reread your whole diff as a strict reviewer would and fix anything wrong. Commit with a clear message and push to the current branch (never main/master, never force). Reply with what shipped and how you verified it.',
  },
  brief: {
    label: 'Short answer for reading on a phone',
    text: 'BRIEF: Answer in at most 5 short bullets or 100 words, leading with the answer. No preamble.',
  },
}

const TOKEN = /(^|\s);([a-z]+)(?=\s|$)/gi

export function expand(text: string): { text: string; used: string[] } | undefined {
  const used: string[] = []
  const rest = text.replace(TOKEN, (whole, lead: string, name: string) => {
    const key = name.toLowerCase()
    if (!SHORTCUTS[key]) return whole
    if (!used.includes(key)) used.push(key)
    return lead
  })
  if (used.length === 0) return undefined
  const blocks = used.map(key => SHORTCUTS[key]?.text ?? '')
  return { text: [rest.replace(/[ \t]{2,}/g, ' ').trim(), ...blocks].filter(Boolean).join('\n\n'), used }
}

export function help(): string {
  const rows = Object.entries(SHORTCUTS).map(([key, s]) => `;${key.padEnd(6)} ${s.label}`)
  return `Type a shortcut as its own word anywhere in a prompt; combine as many as you like.\n\n${rows.join('\n')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'shortcuts', description: 'List the ;shortcuts you can type in a prompt' })
    return next(e)
  })

  on('command.run', { command: 'shortcuts' }, () => ({ text: help() }))

  on('prompt.submit', ($, e, next) => {
    const expanded = expand(e.text)
    if (!expanded) return next(e)
    $.ui.toast(`Attached ${expanded.used.map(k => `;${k}`).join(' ')}`)
    return next({ ...e, text: expanded.text })
  })
}
