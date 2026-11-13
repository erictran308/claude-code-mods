import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { AgentRun, PlanStep } from '../types'
import { applyTodos, capAgents, clip, cellWidth, contextWindowOf, costOf, elapsed, emptyPlan, formatCost, formatTokens, MAX_SPANS, modelName, namedRun, newAgentRun, overviewOf, resumeRun, skillLabel, syncTaskList, totals } from './model'

const PLUGIN = 'crew-progress'
const PROGRESS = 'mcp__crew-progress__progress'
const TEXT_SURFACES = ['desktop', 'vscode', 'mobile'] as const
const T0 = Date.parse('2026-11-09T10:00:00Z')

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'crew',
  props: { title: 'Crew', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const USAGE: Usage = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Each hook here stands for the engine, beneath the mod.
type OpenAnswer = { value: { isPlaced: true } } | { deny: string }

const engine = (
  on: On,
  model: string,
  usage: Usage = USAGE,
  open: () => OpenAnswer = () => ({ value: { isPlaced: true } }),
) => {
  const clock = mock.clock(on, { now: T0 })
  on('ui.open', open as never)
  on('agent.spawn', (_, e) => ({ model, agentId: e.tool_use_id }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model, ...usage } } as never
  })
  return clock
}

const emptySlot = (on: On) =>
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

const spawn = ($: Engine, id: string, description: string, isResume = false) =>
  $.agent.spawn({
    ...(isResume ? { resume: { agentId: id } } : {}),
    tool_use_id: id,
    prompt: 'p',
    description,
    subagentType: 'Explore',
    provider: 'engine',
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)

const step = async ($: Engine, agentId: string, model: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({
    turnId: 't',
    index: 0,
    model,
    messageCount: 1,
    agentId,
    effort: 'low',
  })
  for await (const chunk of stream) void chunk
}

const finish = ($: Engine, agentId: string, reason = 'answer') =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId, reason, answer: 'ok' })

test('with nothing to show, the band leaves the slot to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test("Claude's own task list fills the bar on the text surfaces, with no tool added", async ($, on) => {
  let id = 0
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({ result: { task: { id: String(++id), subject: e.subject } } }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }) as never)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Add schema', description: 'd', activeForm: 'Adding schema' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Add API', description: 'd', activeForm: 'Adding the API' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  for (const surface of TEXT_SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /1\/2/ })
    expect(row?.text).toContain('Adding the API')
    expect(row?.text).toContain('1/2  50%')
    await ui.unmount()
  }
})

test('a subagent shows up, reports live numbers and finishes', async ($, on) => {
  const model = 'claude-haiku-5-5'
  const clock = engine(on, model)
  on('tool.call', () => ({ result: {} }))

  await spawn($, 'a1', 'Map the auth flow')
  await step($, 'a1', model)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth/login.ts', agentId: 'a1' } as never)
  await clock.advance(65_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: 'Map the auth flow' } as never)).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toBe('  Explore · Haiku 5.5 · low · 1 tool')
  expect((await ui.find({ type: 'Text', text: /Read/ }))?.text).toBe('  ↳ Read auth/login.ts')
  await ui.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /0\/1/ }))?.text).toContain('Subagents')
  await band.unmount()

  await finish($, 'a1')
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await later.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  await later.unmount()

  const done = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await done.find({ type: 'Text', text: /1\/1/ }))?.text).toContain('✓')
  await done.unmount()
})

test('an interrupted subagent is marked stopped, a failed one failed', async ($, on) => {
  engine(on, 'claude-haiku-5-5')

  await spawn($, 'a1', 'Interrupted')
  await spawn($, 'a2', 'Broken')
  await finish($, 'a1', 'aborted')
  await finish($, 'a2', 'error')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^■$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✗$/ })).toBeDefined()
  await ui.unmount()
})

for (const [model, usage, shown] of [
  ['claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 2e6, cache_creation_input_tokens: 1e6 }, '$32.4'],
  ['claude-haiku-5-5', { input_tokens: 1e5, output_tokens: 1e5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '$0.06'],
  ['claude-haiku-5-5', { input_tokens: 1e5 + 1, output_tokens: 1e5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '$0.30'],
  ['some-other-model', USAGE, '$0.00'],
] as const) {
  test(`cost: ${model} with ${usage.input_tokens} input tokens reads ≈${shown}`, async ($, on) => {
    engine(on, model, usage)

    await spawn($, 'a1', 'Priced')
    await step($, 'a1', model)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /tokens/ }))?.text).toContain(`≈${shown} ·`)
    await ui.unmount()
  })
}

test('the progress tool drives the bar and a subagent cannot take it over', async $ => {
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', steps: ['One', 'Two', 'Three', 'Four'] } as never)
  const hijack = await $.tool.call({ tool: PROGRESS, title: 'Hijacked', finished: true, agentId: 'a1' } as never)
  const reported = await $.tool.call({ tool: PROGRESS, done: 1, note: 'on two' } as never)

  expect(hijack).toMatchObject({ result: 'ok' })
  expect(reported).toMatchObject({ result: 'ok: 1/4' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = await ui.find({ type: 'Text', text: /1\/4/ })
  expect(row?.text).toContain('Ship it')
  expect(row?.text).toContain('25%')
  expect(row?.text).toContain('on two')
  await ui.unmount()
})

test('a subagent reports its own steps on its row', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Worker')

  await $.tool.call({ tool: PROGRESS, steps: ['a', 'b', 'c'], done: 2, note: 'on c', agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ctx/ }))?.text).toContain('2/3 ·')
  expect((await ui.find({ type: 'Text', text: /↳/ }))?.text).toBe('  ↳ on c')
  await ui.unmount()
})

for (const [tools, isAdded] of [
  [['Read', 'TaskCreate'], false],
  [['Read', 'TodoWrite'], false],
  [['Read'], true],
] as const) {
  test(`with ${tools.join(', ')} the progress tool is ${isAdded ? 'added' : 'left out'}`, async ($, on) => {
    const added: string[] = []
    mock.clock(on, { now: T0 })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'crew' } }))
    on('tool.list', () => ({ value: tools.map(name => ({ name, description: '', mcp: false })) }) as never)
    on('tool.register', (_, e) => {
      added.push(e.name)
      return { value: { tool: e.name } } as never
    })

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    expect(added).toEqual(isAdded ? ['progress'] : [])
  })
}

test('the dismiss button clears the band and a later subagent brings it back', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  emptySlot(on)
  await spawn($, 'a1', 'First')
  await finish($, 'a1')
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeUndefined()

  await clock.advance(1000)
  await spawn($, 'a2', 'Second')
  expect(await ui.find({ type: 'Text', text: /0\/1/ })).toBeDefined()
  await ui.unmount()
})

test('a new prompt starts the band over once everything has finished', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  emptySlot(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  await spawn($, 'a1', 'Done before')
  await finish($, 'a1')
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeDefined()

  await ($.prompt.submit as (e: unknown) => Promise<unknown>)({ text: 'next job' })

  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeUndefined()
  await ui.unmount()
})

test('a slash command does not start the band over', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  emptySlot(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  await spawn($, 'a1', 'Done before')
  await finish($, 'a1')
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ($.prompt.submit as (e: unknown) => Promise<unknown>)({ text: '/crew', command: { name: 'crew', args: '' } })

  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeDefined()
  await ui.unmount()
})

test('a /clear empties the band and the panel', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  await spawn($, 'a1', 'Old work')

  await ($.session.end as (e: unknown) => Promise<unknown>)({ reason: 'clear', sessionId: 's', resume: {} })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: [{ id: 'old' }], version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

// --- The terminal's cell-grid drawing

const glyphsOf = (raster: unknown): string => {
  const { cells } = (raster as { props: { cells: string } }).props
  const bytes = (Uint8Array as unknown as { fromBase64(text: string): Uint8Array }).fromBase64(cells)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let text = ''
  for (let i = 0; i + 12 <= bytes.length; i += 12) text += String.fromCodePoint(view.getUint32(i, true))
  return text
}

const hasPrivateUseGlyph = (text: string): boolean => /[-]/.test(text)

test('terminal: the bar is a pill with the count inside and rounded Nerd Font caps', async $ => {
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', steps: ['a', 'b', 'c', 'd'], done: 3 } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = glyphsOf(await ui.find({ key: 'bar' }))

  expect(text).toContain('Tasks 3/4')
  expect(text).toContain('')
  expect(text).toContain('')
  expect(await ui.find({ type: 'Text', text: /^75%$/ })).toBeDefined()
  await ui.unmount()
})

test('terminal: a finished plan fills the pill and says Done', async $ => {
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', steps: ['a', 'b'], finished: true } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(glyphsOf(await ui.find({ key: 'bar' }))).toContain('Done')
  await ui.unmount()
})

test('terminal: the bar fits a narrow band and keeps the count', async $ => {
  await $.tool.call({ tool: PROGRESS, title: 'A rather long title for a job', steps: ['a', 'b', 'c'], done: 1 } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 40 } })
  const bar = await ui.find({ key: 'bar' })

  expect((bar as unknown as { props: { columns: number } }).props.columns).toBeLessThan(40)
  expect(glyphsOf(bar)).toContain('1/3')
  await ui.unmount()
})

test('terminal: the plain setting draws no Nerd Font glyph', { options: { glyphs: 'plain' } }, async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Worker')
  await finish($, 'a1')
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', steps: ['a', 'b'], done: 1 } as never)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(hasPrivateUseGlyph(glyphsOf(await band.find({ key: 'bar' })))).toBe(false)
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const text of await pane.findAll({ type: 'Text' })) expect(hasPrivateUseGlyph(text.text ?? '')).toBe(false)
  await pane.unmount()
})

test('terminal: each subagent gets a drawn robot and the panel has stat tiles', async ($, on) => {
  const model = 'claude-haiku-5-5'
  engine(on, model)
  await spawn($, 'a1', 'Running one')
  await step($, 'a1', model)
  await spawn($, 'a2', 'Finished one')
  await finish($, 'a2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'bot-a1' })).toBeDefined()
  expect(await ui.find({ key: 'bot-a2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cost$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  await ui.unmount()
})

test('the crew button never reads ×0: it falls back to the session count', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  emptySlot(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  await spawn($, 'a1', 'Earlier work')
  await finish($, 'a1')
  await clock.advance(1000)
  await ($.prompt.submit as (e: unknown) => Promise<unknown>)({ text: 'next job' })
  await $.tool.call({ tool: PROGRESS, title: 'New plan', steps: ['a', 'b'], done: 0 } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ key: 'crew' }))?.text).toBe('×1')
  await ui.unmount()
})

test('terminal: an empty row sits above the band', async $ => {
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', steps: ['a', 'b'], done: 1 } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ key: 'band' }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

// --- Regressions from the code review

const runCrew = ($: Engine, args = '') =>
  ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'crew', args, origin: { kind: 'composer' } })

const submit = ($: Engine, text = 'next job') => ($.prompt.submit as (e: unknown) => Promise<unknown>)({ text })

const paneListed = (isPlaced: boolean) =>
  ({ value: [{ id: 'crew', title: 'Crew', isShown: isPlaced, isFocused: false, isPlaced }] }) as never

const startSession = async ($: Engine, on: On, isInteractive: boolean, tools: readonly string[]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'crew' } }))
  on('tool.list', () => ({ value: tools.map(name => ({ name, description: '', mcp: false })) }) as never)
  on('tool.register', (_, e) => ({ value: { tool: e.name } }) as never)
  await $.session.start({ cwd: '/', surface: isInteractive ? 'terminal' : null, isInteractive } as never)
}

for (const [isPlaced, expected, text] of [
  [false, 'open', 'Crew panel opened.'],
  [true, 'close', 'Crew panel closed.'],
] as const) {
  test(`/crew with the panel ${isPlaced ? 'on screen closes it' : 'waiting undrawn shows it'}`, async ($, on) => {
    const calls: string[] = []
    mock.clock(on, { now: T0 })
    on('ui.panes', () => paneListed(isPlaced))
    on('ui.open', () => (calls.push('open'), { value: { isPlaced: true } }))
    on('ui.close', () => (calls.push('close'), { value: undefined }) as never)

    expect((await runCrew($))?.text).toBe(text)
    expect(calls).toEqual([expected])
  })
}

test('/crew says why when the panel cannot be shown', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }) as never)

  expect((await runCrew($, 'open'))?.text).toBe('Crew panel is waiting: no-surface')
})

test('a failed subagent is not shown as a success, and a stopped one is not counted as failed', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'One')
  await spawn($, 'a2', 'Two')
  await finish($, 'a1', 'error')
  await finish($, 'a2', 'aborted')

  const text = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = await text.find({ type: 'Text', text: /2\/2/ })
  expect(row?.text).toContain('✗')
  expect(row?.text).not.toContain('✓')
  expect(row?.text).toContain('1 failed')
  expect(row?.text).toContain('1 stopped')
  await text.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pill = glyphsOf(await terminal.find({ key: 'bar' }))
  expect(pill).toContain('1 failed')
  expect(pill).not.toContain('Done')
  await terminal.unmount()
})

test('a crew whose only end was a stop reads as stopped, not as failed in red', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Done')
  await spawn($, 'a2', 'Interrupted')
  await finish($, 'a1')
  await finish($, 'a2', 'aborted')

  const text = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = await text.find({ type: 'Text', text: /2\/2/ })
  expect(row?.text).toContain('✓')
  expect(row?.text).not.toContain('failed')
  expect(row?.text).toContain('1 stopped')
  await text.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pill = glyphsOf(await terminal.find({ key: 'bar' }))
  expect(pill).toContain('1 stopped')
  expect(pill).not.toContain('failed')
  await terminal.unmount()
})

test('a message typed while Claude is working does not reset the band', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  emptySlot(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ text: 'go', turnId: 'main' })
  await spawn($, 'a1', 'First of two')
  await finish($, 'a1')
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await submit($, 'also do this')

  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeDefined()
  await ui.unmount()
})

test('a prompt another hook drops does not reset the band', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  emptySlot(on)
  on('prompt.submit', () => ({ drop: 'refused' }) as never)
  await spawn($, 'a1', 'Done before')
  await finish($, 'a1')
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await submit($)

  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeDefined()
  await ui.unmount()
})

test('a report with nothing new leaves a finished plan alone', async $ => {
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', steps: ['a', 'b'], finished: true } as never)

  const again = await $.tool.call({ tool: PROGRESS, finished: true } as never)
  const note = await $.tool.call({ tool: PROGRESS, note: 'wrapping up' } as never)

  expect(again).toMatchObject({ result: 'ok: 2/2' })
  expect(note).toMatchObject({ result: 'ok: 2/2' })
})

test('after ✕ a progress report does not bring the bar back, and a new title does', async ($, on) => {
  mock.clock(on, { now: T0 })
  emptySlot(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', steps: ['a', 'b', 'c'], done: 1 } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dismiss' })

  await $.tool.call({ tool: PROGRESS, done: 2 } as never)
  expect(await ui.find({ type: 'Text', text: /2\/3/ })).toBeUndefined()

  await $.tool.call({ tool: PROGRESS, title: 'New job', steps: ['x', 'y'], done: 1 } as never)
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
  await ui.unmount()
})

test('headless sessions get no progress tool, so it costs them no tokens', async ($, on) => {
  const added: string[] = []
  mock.clock(on, { now: T0 })
  on('tool.register', (_, e) => (added.push(e.name), { value: { tool: e.name } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'crew' } }))
  on('tool.list', () => ({ value: [] }) as never)

  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)

  expect(added).toEqual([])
})

const taskEngine = (on: On) => {
  let id = 0
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({ result: { task: { id: String(++id), subject: e.subject } } }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }) as never)
}

const createTask = ($: Engine, subject: string) => $.tool.call({ tool: 'TaskCreate', subject, description: 'd' })

test('the task list is still followed behind a dismissed bar', async ($, on) => {
  mock.clock(on, { now: T0 })
  emptySlot(on)
  taskEngine(on)
  await createTask($, 'One')
  await createTask($, 'Two')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dismiss' })

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await createTask($, 'Three')

  expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
  await ui.unmount()
})

const todos = ($: Engine, items: readonly [string, string][]) =>
  $.tool.call({ tool: 'TodoWrite', todos: items.map(([content, status]) => ({ content, status, activeForm: content })) } as never)

test('the same todo list moving along stays dismissed, and a new one brings the bar back', async ($, on) => {
  mock.clock(on, { now: T0 })
  emptySlot(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {} }) as never)
  await todos($, [['Run tests', 'pending'], ['Fix lint', 'pending'], ['Commit', 'pending']])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /0\/3/ })).toBeDefined()
  await ui.press({ key: 'dismiss' })

  await todos($, [['Run tests', 'completed'], ['Fix lint', 'in_progress'], ['Commit', 'pending']])
  expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeUndefined()

  // Fewer steps, all of them seen before: still new work.
  await todos($, [['Run tests', 'pending'], ['Commit', 'pending']])
  expect(await ui.find({ type: 'Text', text: /0\/2/ })).toBeDefined()
  await ui.unmount()
})

test('the dismiss button hides a running subagent too', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  emptySlot(on)
  await spawn($, 'a1', 'Long worker')
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /0\/1/ })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /0\/1/ })).toBeUndefined()
  await ui.unmount()
})

test('a refused TaskUpdate does not move the bar', async ($, on) => {
  emptySlot(on)
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({ result: { task: { id: '1', subject: e.subject } } }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: false, taskId: e.taskId, updatedFields: [], error: 'no' } }) as never)
  await createTask($, 'One')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /0\/1/ })).toBeDefined()
  await ui.unmount()
})

test('TaskList does not bring a finished plan back, and leaves its tasks out of the next one', async ($, on) => {
  mock.clock(on, { now: T0 })
  emptySlot(on)
  taskEngine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  const done = [{ id: '1', subject: 'Old', status: 'completed', blockedBy: [] }]
  on('tool.call', { tool: 'TaskList' }, () => ({ result: { tasks: listed } }) as never)
  let listed = done
  await createTask($, 'Old')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await submit($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await $.tool.call({ tool: 'TaskList' })
  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeUndefined()

  await createTask($, 'New')
  listed = [...done, { id: '2', subject: 'New', status: 'pending', blockedBy: [] }]
  await $.tool.call({ tool: 'TaskList' })
  expect(await ui.find({ type: 'Text', text: /0\/1/ })).toBeDefined()
  await ui.unmount()
})

for (const reason of ['clear', 'resume']) {
  test(`/${reason} starts over, and the panel may auto-open again`, async ($, on) => {
    let opens = 0
    engine(on, 'claude-haiku-5-5', USAGE, () => (opens++, { value: { isPlaced: true } }))
    on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
    await spawn($, 'a1', 'Old session')
    await $.tool.call({ tool: PROGRESS, title: 'Old', steps: ['a'] } as never)

    await ($.session.end as (e: unknown) => Promise<unknown>)({ reason, sessionId: 's', resume: {} })
    await spawn($, 'a2', 'New session')

    expect(opens).toBe(2)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Old/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('auto-open is tried again when it was refused', async ($, on) => {
  let opens = 0
  engine(on, 'claude-haiku-5-5', USAGE, () => {
    opens++
    return opens === 1 ? { deny: 'not now' } : { value: { isPlaced: true } }
  })

  await spawn($, 'a1', 'First')
  await spawn($, 'a2', 'Second')
  await spawn($, 'a3', 'Third')

  expect(opens).toBe(2)
})

test('a run whose end went unheard is closed from the engine\'s own list', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'Explore', status: 'completed' }] }) as never)
  await startSession($, on, false, ['TaskCreate'])
  await spawn($, 'a1', 'Lost end')
  await clock.advance(4000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  await ui.unmount()
})

test('a row the engine listed, then dropped, ends when it was first missed', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  let onList = true
  on('agent.list', () => ({ value: onList ? [{ id: 'a1', description: 'x', type: 'Explore', status: 'running' }] : [] }) as never)
  await startSession($, on, false, ['TaskCreate'])
  await spawn($, 'a1', 'Lost end')
  // Seen on the list at the first check, then gone.
  await clock.advance(4000)
  onList = false
  await clock.advance(4000)
  for (let i = 0; i < 30; i++) await clock.advance(4000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: '▾ Finished · 1' } as never)).toBeDefined()
  // It ended when first missed, eight seconds in, not two minutes later.
  expect(await ui.find({ type: 'Text', text: /0:08/ })).toBeDefined()
  await ui.unmount()
})

test('a row the engine never listed, such as a remote agent, is left running', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  on('agent.list', () => ({ value: [] }) as never)
  await startSession($, on, false, ['TaskCreate'])
  await spawn($, 'r1', 'Remote')
  for (let i = 0; i < 40; i++) await clock.advance(4000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  await ui.unmount()
})

test('a run woken after an earlier miss gets its own two minutes', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  let onList = true
  on('agent.list', () => ({ value: onList ? [{ id: 't1', description: 'x', type: 'Explore', status: 'running' }] : [] }) as never)
  await startSession($, on, false, ['TaskCreate'])
  await spawn($, 't1', 'Teammate')
  // Seen, then missed, then its end is heard: no row runs, so the list goes unchecked.
  await clock.advance(4000)
  onList = false
  await clock.advance(4000)
  await finish($, 't1')
  for (let i = 0; i < 40; i++) await clock.advance(4000)
  // Woken long after, still off the list: the old miss does not end it.
  await startTurn($, 't1')
  for (let i = 0; i < 5; i++) await clock.advance(4000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  await ui.unmount()
})

test('an agent listed only when it was spawned still ends once it drops off the list', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  let onList = true
  on('agent.list', () => ({ value: onList ? [{ id: 'q1', description: 'x', type: 'Explore', status: 'running' }] : [] }) as never)
  await startSession($, on, false, ['TaskCreate'])
  await spawn($, 'q1', 'Quick')
  // Gone before any check of the list.
  onList = false
  for (let i = 0; i < 40; i++) await clock.advance(4000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: '▾ Finished · 1' } as never)).toBeDefined()
  await ui.unmount()
})

const startTurn = ($: Engine, agentId: string) =>
  ($.turn.start as (e: unknown) => Promise<unknown>)({ text: '', turnId: 't', agentId })

const listed = (on: On, agents: readonly { id: string; description: string; type: string; name?: string }[]) =>
  on('agent.list', () => ({ value: agents.map(a => ({ ...a, status: 'running' })) }) as never)

test('a forked skill, which no agent.spawn announces, gets a row from its first turn', async ($, on) => {
  const model = 'claude-opus-5-5'
  engine(on, model)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('tool.call', () => ({ result: {} }))
  listed(on, [{ id: 'f1', description: 'code-review', type: 'general-purpose' }])

  await startTurn($, 'f1')
  await step($, 'f1', model)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth.ts', agentId: 'f1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: 'code-review' } as never)).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /general-purpose/ }))?.text).toBe('  general-purpose · Opus 5.5 · low · 1 tool')
  await ui.unmount()

  await finish($, 'f1')
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await later.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await later.find({ type: 'Button', label: '▾ Finished · 1' } as never)).toBeDefined()
  await later.unmount()
})

const forkedSkill = (on: On, success = true) =>
  on('tool.call', { tool: 'Skill' }, () => ({
    result: { success, commandName: 'code-review', status: 'forked', agentId: 'f1', result: 'launched', background: true },
  }) as never)

for (const order of ['Skill call first', 'first turn first'] as const) {
  test(`a forked skill in the background is named for its command and typed skill (${order})`, async ($, on) => {
    engine(on, 'claude-opus-5-5')
    on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
    listed(on, [{ id: 'f1', description: 'Review the current diff for bugs', type: 'general-purpose' }])
    forkedSkill(on)

    const call = () => $.tool.call({ tool: 'Skill', skill: 'code-review', args: 'high --max-findings all' } as never)
    if (order === 'Skill call first') {
      await call()
      await startTurn($, 'f1')
    } else {
      await startTurn($, 'f1')
      await call()
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: '/code-review high --max-findings all' } as never)).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^ {2}\S/ }))?.text).toBe('  skill')
    await ui.unmount()
  })
}

test('a forked skill that did not launch adds no row', async ($, on) => {
  engine(on, 'claude-opus-5-5')
  listed(on, [])
  forkedSkill(on, false)

  await $.tool.call({ tool: 'Skill', skill: 'code-review' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a background forked skill whose launch failed ends the row its first turn made', async ($, on) => {
  engine(on, 'claude-opus-5-5')
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  listed(on, [{ id: 'f1', description: 'code-review', type: 'general-purpose' }])
  forkedSkill(on, false)

  await startTurn($, 'f1')
  await $.tool.call({ tool: 'Skill', skill: 'code-review' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: '▾ Finished · 1' } as never)).toBeDefined()
  await ui.unmount()
})

test('a Skill call whose args are not text is named for the command alone', async ($, on) => {
  engine(on, 'claude-opus-5-5')
  listed(on, [])
  forkedSkill(on)

  const ran = await $.tool.call({ tool: 'Skill', skill: 'code-review', args: { level: 'high' } } as never)

  expect(ran).toMatchObject({ result: { agentId: 'f1' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', label: '/code-review' } as never)).toBeDefined()
  await ui.unmount()
})

test('an agent first heard at the end of its turn gets no row and opens no pane', async ($, on) => {
  let opens = 0
  engine(on, 'claude-haiku-5-5', USAGE, () => {
    opens++
    return { value: { isPlaced: true } }
  })
  listed(on, [{ id: 'f1', description: 'code-review', type: 'general-purpose' }])

  await step($, 'f1', 'claude-haiku-5-5')
  await finish($, 'f1')

  expect(opens).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent whose end went unheard keeps its words when it is spawned again', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Map the auth flow')
  await step($, 'a1', 'claude-haiku-5-5')
  await spawn($, 'a1', 'Continue')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', label: 'Map the auth flow' } as never)).toBeDefined()
  await ui.unmount()
})

test('a spawned subagent with no request yet keeps its words when it is spawned again', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Map the auth flow')
  await spawn($, 'a1', 'Continue')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', label: 'Map the auth flow' } as never)).toBeDefined()
  await ui.unmount()
})

test('a teammate woken after its turn ended shows as running from its turn start', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  await spawn($, 'a1', 'Teammate')
  await finish($, 'a1')
  await startTurn($, 'a1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  await ui.unmount()
})

test('a spawn that is no resume names a listed row whose turn already ended, and leaves it ended', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  listed(on, [{ id: 'a1', description: '', type: '' }])
  await startTurn($, 'a1')
  await finish($, 'a1')
  await spawn($, 'a1', 'Quick job')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: 'Quick job' } as never)).toBeDefined()
  await ui.unmount()
})

test('a foreground forked skill whose turns went unheard is added as finished', async ($, on) => {
  let opens = 0
  engine(on, 'claude-opus-5-5', USAGE, () => (opens++, { value: { isPlaced: true } }))
  on('tool.call', { tool: 'Skill' }, () => ({
    result: { success: true, commandName: 'code-review', status: 'forked', agentId: 'f1', result: 'No issues.' },
  }) as never)

  await $.tool.call({ tool: 'Skill', skill: 'code-review', args: 'high' } as never)

  expect(opens).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: '▾ Finished · 1' } as never)).toBeDefined()
  expect(await ui.find({ type: 'Button', label: '/code-review high' } as never)).toBeDefined()
  await ui.unmount()
})

test('a spawn that changes nothing leaves the rows in their order', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'First')
  await spawn($, 'a2', 'Second')
  await spawn($, 'a1', 'First again')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const labels = (await ui.findAll({ type: 'Button' } as never)).map(b => (b as unknown as { props: { label: string } }).props.label)
  expect(labels.indexOf('Second')).toBeLessThan(labels.indexOf('First'))
  await ui.unmount()
})

test('a Skill result with no result object passes through untouched', async ($, on) => {
  engine(on, 'claude-opus-5-5')
  on('tool.call', { tool: 'Skill' }, () => ({ result: undefined }) as never)

  const ran = await $.tool.call({ tool: 'Skill', skill: 'code-review' } as never)

  expect(ran).toMatchObject({ result: undefined })
})

test('a skill label has one slash, and none without a name', () => {
  expect(skillLabel('code-review', 'high')).toBe('/code-review high')
  expect(skillLabel('/code-review', '  ')).toBe('/code-review')
  expect(skillLabel('', 'high')).toBe('')
  expect(skillLabel(undefined, { level: 'high' })).toBe('')
})

test('a resumed subagent keeps the words its row had', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Map the auth flow')
  await finish($, 'a1')
  await spawn($, 'a1', 'Continue', true)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: 'Map the auth flow' } as never)).toBeDefined()
  await ui.unmount()
})

test("a listed row answered by a resume keeps its words and takes the spawn's model", async ($, on) => {
  engine(on, 'claude-sonnet-4-5')
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  listed(on, [{ id: 'a1', description: 'Map the auth flow', type: '' }])

  await startTurn($, 'a1')
  await spawn($, 'a1', 'Continue', true)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', label: 'Map the auth flow' } as never)).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toBe('  Explore · Sonnet 4.5')
  await ui.unmount()
})

test("the engine's own forks, on no list, get no row", async ($, on) => {
  const model = 'claude-haiku-5-5'
  engine(on, model)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  listed(on, [])

  await startTurn($, 'compact-1')
  await step($, 'compact-1', model)
  await finish($, 'compact-1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent whose first turn is heard before its spawn answers keeps one row, named by the spawn', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  // The engine's list may not have the words yet, only a handle of its own.
  listed(on, [{ id: 'a1', description: '', type: '', name: 'agent-7f' }])

  await startTurn($, 'a1')
  await spawn($, 'a1', 'Map the auth flow')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: 'Map the auth flow' } as never)).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toBe('  Explore · Haiku 5.5')
  await ui.unmount()
})

test('a tool call that was refused does not count as a tool used', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  on('tool.call', () => ({ deny: 'refused' }))
  await spawn($, 'a1', 'Worker')

  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toBe('  Explore · Haiku 5.5')
  await ui.unmount()
})

test('a refused tool call puts back what the worker was doing', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'refused' }))
  await spawn($, 'a1', 'Worker')

  await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth/login.ts', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /↳/ }))?.text).toBe('  ↳ Read auth/login.ts')
  await ui.unmount()
})

test('terminal: with a running subagent the band still fits 40 columns', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Worker')
  await $.tool.call({ tool: PROGRESS, title: 'A rather long title for a job', steps: ['a', 'b', 'c'], done: 1 } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 40 } })
  const { columns } = (await ui.find({ key: 'bar' }) as unknown as { props: { columns: number } }).props

  // Title, gaps, percent, ×1 and ✕ take the rest.
  expect(columns).toBeLessThanOrEqual(40 - 12 - 4 - 3 - 2 - 1)
  expect(await ui.find({ key: 'crew' })).toBeDefined()
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()
  await ui.unmount()
})

const run = (overrides: Partial<AgentRun>): AgentRun => ({ ...newAgentRun('a', 'Explore', 'd', 'claude-haiku-5-5', 0), ...overrides })

test('a resumed subagent keeps its earlier time and loses the gap', () => {
  const resumed = resumeRun(run({ status: 'done', startedAt: 1000, endedAt: 3000 }), 60_000)

  expect(resumed.status).toBe('running')
  expect(resumed.startedAt).toBe(60_000)
  expect(elapsed(resumed, 61_000)).toBe(3000)
})

test('the Time total counts overlaps once and idle gaps not at all', () => {
  const list = [
    run({ status: 'done', startedAt: 0, endedAt: 2000 }),
    run({ status: 'done', startedAt: 1000, endedAt: 3000 }),
    run({ status: 'done', startedAt: 100_000, endedAt: 101_000 }),
  ]

  expect(totals(list, 200_000).time).toBe(4000)
})

test('the in-flight trail counts the active step, not the number of subagents', () => {
  const plan = { title: 'P', note: '', isFinished: false, isDismissed: false, steps: [
    { id: '1', text: 'a', status: 'done' as const },
    { id: '2', text: 'b', status: 'active' as const },
    { id: '3', text: 'c', status: 'pending' as const },
  ] }

  expect(overviewOf(plan, [run({}), run({ id: 'b' })])?.inFlight).toBe(1)
})

test('context windows follow the model id', () => {
  expect(contextWindowOf('claude-sonnet-4-20250514')).toBe(200_000)
  expect(contextWindowOf('claude-opus-4-5-20251101')).toBe(200_000)
  expect(contextWindowOf('claude-haiku-4-5')).toBe(200_000)
  expect(contextWindowOf('claude-sonnet-4-5[1m]')).toBe(1_000_000)
  expect(contextWindowOf('claude-opus-4-6')).toBe(1_000_000)
  expect(contextWindowOf('claude-opus-5-5')).toBe(1_000_000)
  // Vertex spells the date after an @.
  expect(contextWindowOf('claude-sonnet-4@20250514')).toBe(200_000)
  expect(contextWindowOf('claude-opus-4-1@20250805')).toBe(200_000)
  // A later model's minor version 4 is no 4.x model.
  expect(contextWindowOf('claude-sonnet-5-4-20270101')).toBe(1_000_000)
})

test('retired models count as unknown rather than mispriced', () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  expect(costOf('claude-opus-4-1', usage, 0)).toBe(0)
  expect(costOf('us.anthropic.claude-opus-4-1-20250805-v1:0', usage, 0)).toBe(0)
  expect(costOf('claude-opus-4-8', usage, 0)).toBe(30)
  // Every spelling of 4.0 and 4.1: a trailing -0, a date, a context suffix.
  expect(costOf('claude-opus-4-0', usage, 0)).toBe(0)
  expect(costOf('claude-sonnet-4-0', usage, 0)).toBe(0)
  expect(costOf('claude-sonnet-4[1m]', usage, 0)).toBe(0)
  expect(costOf('claude-sonnet-4-5', usage, 0)).toBe(18)
  // Vertex's @date spellings are retired too.
  expect(costOf('claude-opus-4-1@20250805', usage, 0)).toBe(0)
  expect(costOf('claude-sonnet-4@20250514', usage, 0)).toBe(0)
  expect(costOf('claude-opus-4-5@20251101', usage, 0)).toBe(30)
})

test('over-long task lists keep the newest tasks', () => {
  const tasks = Array.from({ length: 120 }, (_, i) => ({ id: String(i), subject: `T${i}`, status: 'pending' }))

  const steps = syncTaskList(null, tasks, [])?.steps ?? []

  expect(steps).toHaveLength(100)
  expect(steps.at(-1)?.id).toBe('119')
})

test('text is cut by terminal cells, so wide titles fit', () => {
  const cut = clip('日本語のタイトルです', 7)

  expect(cellWidth(cut)).toBeLessThanOrEqual(7)
  expect(cut.endsWith('…')).toBe(true)
})

test('numbers round into the next unit rather than past it', () => {
  expect(formatTokens(999_600)).toBe('1.0M')
  expect(formatTokens(999_400)).toBe('999k')
  expect(formatCost(9.996)).toBe('$10.0')
  expect(formatCost(9.99)).toBe('$9.99')
})

test('model names read the version, never a date, in either order', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(modelName('claude-3-haiku-20240307')).toBe('Haiku 3')
})

test('emoji symbols take two cells, and text selectors and marks none', () => {
  expect(cellWidth('✅ done')).toBe(7)
  expect(cellWidth(`a${String.fromCodePoint(0xfe0e)}`)).toBe(1)
  expect(cellWidth(String.fromCodePoint(0x1f004))).toBe(2)
  // A combining accent, and the Yi and angle-bracket ranges.
  expect(cellWidth(`e${String.fromCodePoint(0x0301)}`)).toBe(1)
  expect(cellWidth(String.fromCodePoint(0xa000))).toBe(2)
  expect(cellWidth(String.fromCodePoint(0x2329))).toBe(2)
})

test('a joined emoji sequence is one glyph of two cells', () => {
  const zwj = String.fromCodePoint(0x200d)
  const family = [0x1f468, 0x1f469, 0x1f467].map(code => String.fromCodePoint(code)).join(zwj)
  expect(cellWidth(family)).toBe(2)
  // A keycap: a digit, the emoji selector and the enclosing keycap mark.
  expect(cellWidth(`1${String.fromCodePoint(0xfe0f)}${String.fromCodePoint(0x20e3)}`)).toBe(2)
  // Cut text never ends on a joiner.
  const cut = clip(`ab${zwj}cdefgh`, 4)
  expect(cut.includes(`${zwj}…`)).toBe(false)
  expect(cellWidth(cut)).toBeLessThanOrEqual(4)
})

test('the emoji selector widens the one-cell character before it', () => {
  const heart = `${String.fromCodePoint(0x2764)}${String.fromCodePoint(0xfe0f)}`
  expect(cellWidth(`${heart} x`)).toBe(4)
  // A wide character stays two cells with it.
  expect(cellWidth(`${String.fromCodePoint(0x2705)}${String.fromCodePoint(0xfe0f)}`)).toBe(2)
  // Cut text counts the selector with what it follows.
  const cut = clip(`${heart}${heart}${heart} ship it`, 5)
  expect(cellWidth(cut)).toBeLessThanOrEqual(5)
})

test('a TodoWrite list keeps a dismissed bar hidden only while it is the same list', () => {
  const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ id: text, text, status })
  const dismissed = { ...emptyPlan(), steps: [step('Run tests'), step('Commit')], isDismissed: true }
  expect(applyTodos(dismissed, [step('Run tests', 'done'), step('Commit', 'active')])?.isDismissed).toBe(true)
  expect(applyTodos(dismissed, [step('Commit'), step('Run tests')])?.isDismissed).toBe(false)
  expect(applyTodos(dismissed, [step('Run tests')])?.isDismissed).toBe(false)
  expect(applyTodos(null, [step('Run tests')])?.isDismissed).toBe(false)
  expect(applyTodos(dismissed, [])).toBeNull()
})

test('terminal: the panel is inset, separators run full width, and the status icon has room to grow', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Finished one')
  await finish($, 'a1')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toHaveLength(60)
  expect((await ui.find({ type: 'Text', text: /^━+$/ }))?.text).toHaveLength(60 - 2 * 2 - 7 - 1)
  expect(await ui.find({ type: 'Text', text: /^ $/ })).toBeDefined()
  await ui.unmount()
})

for (const bodyColumns of [59, 60, 61]) {
  test(`terminal: the tiles fill the content width at ${bodyColumns} columns`, async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
    const widthOf = async (key: string) => (await ui.find({ key }))?.props.width as number

    const widths = [await widthOf('Cost'), await widthOf('Tokens'), await widthOf('Time')]

    expect(widths[0]! + widths[1]! + widths[2]! + 2).toBe(bodyColumns - 2 * 2)
    await ui.unmount()
  })
}

test('terminal: a blank row separates each heading from the first subagent', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Still going')
  await spawn($, 'a2', 'Finished one')
  await finish($, 'a2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: 'running-heading' }))?.props.marginBottom).toBe(1)
  expect((await ui.find({ key: 'finished-heading' }))?.props.marginBottom).toBe(1)
  await ui.unmount()
})

// --- Round 6

test("Claude Code's word that a subagent stopped ends its row, unless a hook keeps it going", async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  on('classic.SubagentStop', (_, e) => ((e as { agent_id?: string }).agent_id === 'a2' ? { block: 'keep going' } : {}) as never)
  await spawn($, 'a1', 'First')
  await spawn($, 'a2', 'Kept going')
  const stop = $.classic.SubagentStop as (e: unknown) => Promise<unknown>
  await stop({ agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: '', stop_hook_active: false })
  await stop({ agent_id: 'a2', agent_type: 'Explore', agent_transcript_path: '', stop_hook_active: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: '▾ Finished · 1' } as never)).toBeDefined()
  await ui.unmount()
})

test("the Time total counts an agent's earlier runs once beside the others", () => {
  const resumed = resumeRun(run({ status: 'done', startedAt: 0, endedAt: 10_000 }), 20_000)
  const a = { ...resumed, status: 'done' as const, endedAt: 30_000 }
  const b = run({ id: 'b', status: 'done', startedAt: 0, endedAt: 10_000 })
  // A and B share 0 to 10s; A runs again from 20s to 30s.
  expect(totals([a, b], 40_000).time).toBe(20_000)

  let many = run({ status: 'done', startedAt: 0, endedAt: 1 })
  for (let i = 1; i <= MAX_SPANS + 5; i++) many = { ...resumeRun(many, i * 10), status: 'done', endedAt: i * 10 + 1 }
  expect(many.spans).toHaveLength(MAX_SPANS)
})

test("a worker's new plan starts its count over", async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Worker')
  const countOnRow = async (): Promise<string | undefined> => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const text = (await ui.find({ type: 'Text', text: /ctx/ }))?.text
    await ui.unmount()
    return text
  }

  await $.tool.call({ tool: PROGRESS, steps: ['a', 'b', 'c'], finished: true, agentId: 'a1' } as never)
  expect(await countOnRow()).toContain('3/3 ·')
  // New steps after a finished plan, no count given: nothing of them is done yet.
  await $.tool.call({ tool: PROGRESS, steps: ['w', 'x', 'y', 'z'], agentId: 'a1' } as never)
  expect(await countOnRow()).toContain('0/4 ·')
  await $.tool.call({ tool: PROGRESS, done: 2, agentId: 'a1' } as never)
  expect(await countOnRow()).toContain('2/4 ·')
  // A new title starts over too; the same title again does not.
  await $.tool.call({ tool: PROGRESS, title: 'Phase 2', steps: ['p', 'q', 'r'], agentId: 'a1' } as never)
  expect(await countOnRow()).toContain('0/3 ·')
  await $.tool.call({ tool: PROGRESS, done: 1, agentId: 'a1' } as never)
  await $.tool.call({ tool: PROGRESS, title: 'Phase 2', agentId: 'a1' } as never)
  expect(await countOnRow()).toContain('1/3 ·')
})

test("a worker's plan that only reached its last step goes on when it grows", async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Worker')
  await $.tool.call({ tool: PROGRESS, steps: ['a', 'b', 'c'], agentId: 'a1' } as never)
  await $.tool.call({ tool: PROGRESS, done: 3, agentId: 'a1' } as never)
  // Two steps found on the way: the three done stay done.
  await $.tool.call({ tool: PROGRESS, steps: ['a', 'b', 'c', 'd', 'e'], agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ctx/ }))?.text).toContain('3/5 ·')
  await ui.unmount()
})

const finishWith = ($: Engine, agentId: string, model: string) =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId, reason: 'answer', answer: 'ok', usage: { model, ...USAGE } })

const tokensShown = async ($: Engine): Promise<string | undefined> => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = (await ui.find({ type: 'Text', text: / tokens · / }))?.text
  await ui.unmount()
  return text
}

test("each run whose requests went unseen adds its turn's sum to the row's totals", async ($, on) => {
  const model = 'claude-haiku-5-5'
  engine(on, model)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  await spawn($, 't1', 'Teammate')
  await finishWith($, 't1', model)
  expect(await tokensShown($)).toContain('12k tokens')
  // Woken twice more, its requests unseen each time: the sums add up.
  await startTurn($, 't1')
  await finishWith($, 't1', model)
  await startTurn($, 't1')
  await finishWith($, 't1', model)
  expect(await tokensShown($)).toContain('36k tokens')
})

test("a run whose requests went unseen adds its sum even after a run whose requests were seen", async ($, on) => {
  const model = 'claude-haiku-5-5'
  engine(on, model)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  await spawn($, 't1', 'Teammate')
  await step($, 't1', model)
  await finishWith($, 't1', model)
  expect(await tokensShown($)).toContain('12k tokens')
  await startTurn($, 't1')
  await finishWith($, 't1', model)
  expect(await tokensShown($)).toContain('24k tokens')
})

test("a workflow agent that comes back with no id of its own gets no row", async ($, on) => {
  mock.clock(on, { now: T0 })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5' }) as never)
  await $.agent.spawn({
    tool_use_id: 'wf-call',
    prompt: 'p',
    description: 'Remote step',
    subagentType: 'general-purpose',
    provider: 'engine',
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    workflow: { runId: 'wf_1', agentIndex: 1 },
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('terminal: the robot takes its own cell in the band, the gap after it holding the wider icon', async ($, on) => {
  engine(on, 'claude-haiku-5-5')
  await spawn($, 'a1', 'Worker')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 64 } })
  const { columns } = (await ui.find({ key: 'bar' }) as unknown as { props: { columns: number } }).props
  // Spinner, space and 'Subagents' (11), '0%' (2), the robot (1), '×1' (2), ✕ (1), and a cell between each of the six parts.
  expect(columns).toBe(64 - 11 - 2 - 1 - 2 - 1 - 5)
  await ui.unmount()
})

test("the Time total never goes down when an agent's oldest runs are dropped", () => {
  let many = run({ status: 'done', startedAt: 0, endedAt: 1000 })
  let total = totals([many], 0).time
  for (let i = 1; i <= MAX_SPANS + 5; i++) {
    many = { ...resumeRun(many, i * 10_000), status: 'done', endedAt: i * 10_000 + 1000 }
    const next = totals([many], i * 10_000 + 1000).time
    expect(next).toBeGreaterThanOrEqual(total)
    total = next
  }
  expect(many.spans).toHaveLength(MAX_SPANS)
  // Every run lasted one second.
  expect(total).toBe((MAX_SPANS + 6) * 1000)
})

test('a subagent that starts after a quiet spell still has its lost end caught from the list', async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  let onList = true
  on('agent.list', () => ({ value: onList ? [{ id: 'b1', description: 'x', type: 'Explore', status: 'running' }] : [] }) as never)
  await startSession($, on, false, ['TaskCreate'])
  await spawn($, 'a1', 'First')
  await finish($, 'a1')
  // Nothing moves for a while (the clock may stop: the kit cannot see an idle timer, so only the restart is checked).
  for (let i = 0; i < 10; i++) await clock.advance(4000)
  // A new subagent starts it again, so its lost end is still caught from the list.
  await spawn($, 'b1', 'Second')
  await clock.advance(4000)
  onList = false
  for (let i = 0; i < 40; i++) await clock.advance(4000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: '▾ Finished · 2' } as never)).toBeDefined()
  await ui.unmount()
})

test('over the limit, ended rows give way before running ones', () => {
  const rows = [
    run({ id: 'live', startedAt: 0 }),
    ...Array.from({ length: 200 }, (_, i) => run({ id: `e${i}`, status: 'done', startedAt: i, endedAt: i + 1 })),
  ]
  const kept = capAgents(rows, 200)
  expect(kept).toHaveLength(200)
  expect(kept.some(a => a.id === 'live')).toBe(true)
  expect(kept.some(a => a.id === 'e0')).toBe(false)
  // Only when every row runs does the oldest go.
  const running = Array.from({ length: 3 }, (_, i) => run({ id: `r${i}`, startedAt: i }))
  expect(capAgents(running, 2).map(a => a.id)).toEqual(['r1', 'r2'])
})

test('a joiner joins emoji to emoji, and nothing else', () => {
  const zwj = String.fromCodePoint(0x200d)
  const man = String.fromCodePoint(0x1f468)
  const woman = String.fromCodePoint(0x1f469)
  expect(cellWidth(`a${zwj}b`)).toBe(2)
  expect(cellWidth(`${zwj}${String.fromCodePoint(0x1f600)}`)).toBe(2)
  expect(cellWidth(`${man}${zwj}${woman}`)).toBe(2)
  expect(cellWidth(`${man}${zwj}a`)).toBe(3)
})

test('/crew says so when another plugin holds the pane, and throws nothing', async ($, on) => {
  engine(on, 'claude-haiku-5-5', USAGE, () => ({ deny: 'another plugin holds crew' }))
  on('ui.panes', () => ({ value: [] }) as never)

  expect((await runCrew($, 'open')).text).toMatch(/^Crew panel could not open: /)
  expect((await runCrew($)).text).toMatch(/^Crew panel could not open: /)
})

test("after a reload the engine's list is read at once, so a listed agent that drops off still ends", async ($, on) => {
  const clock = engine(on, 'claude-haiku-5-5')
  let calls = 0
  // Listed at session start only: the spawn's own look finds it gone already.
  on('agent.list', () => ({ value: ++calls === 1 ? [{ id: 'z1', description: 'x', type: 'Explore', status: 'running' }] : [] }) as never)
  await startSession($, on, false, ['TaskCreate'])
  await spawn($, 'z1', 'Before the reload')
  for (let i = 0; i < 40; i++) await clock.advance(4000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: '▾ Finished · 1' } as never)).toBeDefined()
  await ui.unmount()
})

test('several tasks in progress all count as in flight', () => {
  const plan = { ...emptyPlan(), title: 'P', steps: [
    { id: '1', text: 'a', status: 'done' as const },
    { id: '2', text: 'b', status: 'active' as const },
    { id: '3', text: 'c', status: 'active' as const },
    { id: '4', text: 'd', status: 'pending' as const },
  ] }
  const overview = overviewOf(plan, [])
  expect(overview?.inFlight).toBe(2)
  expect(overview?.label).toBe('P')
})

test('naming a row with the words it has leaves it as it is, so it keeps its place', () => {
  const a = run({ type: 'skill', description: '/code-review' })
  expect(namedRun(a, 'skill', '/code-review', '')).toBe(a)
  expect(namedRun({ ...a, fromList: true }, 'skill', '/code-review', '')).not.toBe(a)
  expect(namedRun(a, 'skill', '/simplify', '')).not.toBe(a)
})
