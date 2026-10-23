import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'jay-claude-switcher',
  component: 'Pane',
  requestId: 'switcher-sessions',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the Sessions tab draws its actions and starts reading on first draw, on every surface', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-10-23T12:00:00Z') }))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ key: 'auto' })).toBeDefined()
    expect(await ui.find({ key: 'import' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Reading accounts|Could not read the accounts/ })).toBeDefined()
    await ui.unmount()
  }
})
