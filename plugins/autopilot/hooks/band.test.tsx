import { expect, mock, test } from 'claude-code/testing'

const TREE = `# Goal: Ship it

- [x] First task
- [ ] Second task
`

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
} as never

for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
  test(`draws progress and hides on ${surface}`, async ($, on) => {
    mock.clock(on)
    on('fs.read', () => ({ value: TREE }))
    on('ui.status', () => ({ value: undefined }))
    // The engine's own (empty) band, drawn once ours is hidden.
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })

    // Loads GOALS.md into the band's state.
    await $.command.run({ command: 'autopilot', args: 'status' } as never)

    const band = await $.ui.mount({ plugin: 'autopilot', surface, component: 'AbovePrompt', props: PROPS })
    const text = JSON.stringify(await band.drawn())
    expect(text).toContain('Autopilot off')
    expect(text).toContain('1/2 done')
    expect(text).toContain('Next: Second task')

    await band.press({ key: 'hide' } as never)
    expect(JSON.stringify(await band.drawn())).not.toContain('Next: Second task')
  })
}
