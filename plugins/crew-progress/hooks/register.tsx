import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiOpenResult } from 'claude-code'

import type { AgentRun, Layout, Plan, PlanStep } from '../types'
import { BOT_COLUMNS, BOT_ROWS, GLYPHS, colorOfType, drawBar, drawBot, drawLineGauge, drawPillBar, hex } from './art'
import type { Glyphs, Tone } from './art'
import {
  MAX_AGENTS,
  MAX_NOTE,
  MAX_RETIRED_TASKS,
  activeStep,
  activityOf,
  addTask,
  applyReport,
  cellWidth,
  changeTask,
  clean,
  clip,
  contextWindowOf,
  costOf,
  doneCount,
  elapsed,
  emptyPlan,
  formatCost,
  formatTime,
  formatTokens,
  isPlanComplete,
  isRunning,
  newAgentRun,
  overviewOf,
  promptTokens,
  reportedSteps,
  resumeRun,
  statusOfEngineAgent,
  statusOfTurnEnd,
  stepsFromTodos,
  syncTaskList,
  totals,
  viewOfAgent,
  wholeNumber,
} from './model'
import type { Report } from './model'

const PANE = 'crew'
const PANE_TITLE = 'Crew'
// A pattern, as this mod's own tool is not in the tool types the engine lays down at load.
const PROGRESS_TOOL = /^mcp__crew-progress__progress$/

const TICK_MS = 500
const TICKS_PER_RECONCILE = 8
const MAX_FINISHED_SHOWN = 30
const PANE_INSET = 2

const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'
const FAILED = '#e06c75'
const SPINNER = ['◐', '◓', '◑', '◒']
const TONE_COLORS: Record<Tone, string> = { active: ACCENT, done: DONE, failed: FAILED }

const initialLayout = (): Layout => ({ isDoneCollapsed: false, hasAutoOpened: false, bandSince: 0, retiredTasks: [] })

// Change a tag when that value's fields change: what an earlier version stored
// outlives a reload, and the tag makes the new code decline it.
const plan = atom({ plugin: 'crew-progress', key: 'plan' } as const, null, { shape: 'plan-2' })
const agents = atom({ plugin: 'crew-progress', key: 'agents' } as const, [], { shape: 'agents-2' })
const layout = atom({ plugin: 'crew-progress', key: 'layout' } as const, initialLayout(), { shape: 'layout-2' })
const now = atom({ plugin: 'crew-progress', key: 'now' } as const, 0)
const isMainTurnRunning = atom({ plugin: 'crew-progress', key: 'isMainTurnRunning' } as const, false)

const patchAgent = ($: EngineInterface, id: string, change: (a: AgentRun) => AgentRun) =>
  update($, agents, list => list.map(a => (a.id === id ? change(a) : a)))

// A safety net under turn.complete: a row whose end went unheard would spin forever.
async function reconcileAgents($: EngineInterface): Promise<void> {
  const inEngine = new Map((await $.agent.list()).map(info => [info.id, info.status]))
  const at = await $.clock.now()
  await update($, agents, list =>
    list.map(a => {
      const ended = isRunning(a) ? statusOfEngineAgent(inEngine.get(a.id) ?? '') : undefined
      return ended ? { ...a, status: ended, endedAt: at, activity: '' } : a
    }),
  )
}

// The person's ✕: the plan goes on being followed, off the bar.
async function dismissBand($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, plan, prev => prev && { ...prev, isDismissed: true })
  await update($, layout, prev => ({ ...prev, bandSince: at }))
}

const retireTasks = ($: EngineInterface, finished: Plan) =>
  update($, layout, prev => ({
    ...prev,
    retiredTasks: [...prev.retiredTasks, ...finished.steps.map(step => step.id)].slice(-MAX_RETIRED_TASKS),
  }))

async function resetSession($: EngineInterface): Promise<void> {
  await update($, agents, () => [])
  await update($, plan, () => null)
  await update($, layout, initialLayout)
  await update($, isMainTurnRunning, () => false)
}

type PaneAnswer = { text: string; isWaiting: boolean }

const answerOfOpen = (opened: UiOpenResult): PaneAnswer =>
  opened.isPlaced
    ? { text: 'Crew panel opened.', isWaiting: false }
    : { text: `Crew panel is waiting: ${opened.reason}`, isWaiting: true }

async function openPane($: EngineInterface): Promise<PaneAnswer> {
  const at = await $.clock.now()
  await update($, now, () => at)
  return answerOfOpen(await $.ui.open({ id: PANE, title: PANE_TITLE }))
}

// A pane opened unasked on a narrow terminal is open but undrawn: asking shows it.
async function togglePane($: EngineInterface): Promise<PaneAnswer> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane?.isPlaced) {
    await $.ui.close({ id: PANE })
    return { text: 'Crew panel closed.', isWaiting: false }
  }
  return openPane($)
}

const agentColor = (a: AgentRun): string => (isRunning(a) ? ACCENT : a.status === 'done' ? DONE : FAILED)

const agentMark = (a: AgentRun, marks: Glyphs, running: string): string =>
  isRunning(a) ? running : a.status === 'done' ? marks.done : a.status === 'stopped' ? marks.stopped : marks.failed

const stepMark = (step: PlanStep, marks: Glyphs): string =>
  step.status === 'done' ? marks.done : step.status === 'active' ? marks.active : marks.pending

export const register: Register = (on, options) => {
  const glyphs = GLYPHS[options.glyphs === 'plain' ? 'plain' : 'nerd']

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // Where Claude has its own task list the mod reads that and adds no tool,
    // and where nobody is watching there is no bar to feed.
    const tools = (await $.tool.list()).map(tool => tool.name)
    if (e.isInteractive && !tools.includes('TaskCreate') && !tools.includes('TodoWrite')) {
      await $.tool.register({
        name: 'progress',
        description:
          'Show a progress bar to the person for work of 3 or more steps. When you start, call it with `title` (a few words) ' +
          'and `steps` (the plan, in order). As each step finishes, call it with `done` (steps finished so far) and optionally ' +
          '`note` (what is happening now, a few words). At the end, call it with `finished: true`. ' +
          'Resend `steps` to change the plan. From a subagent, it updates that subagent\'s own row. It only draws.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A few words naming the whole job. A new title starts a new bar.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'The planned steps in order, a few words each.' },
            done: { type: 'integer', minimum: 0, description: 'How many steps are finished.' },
            note: { type: 'string', description: 'What is happening now, a few words.' },
            finished: { type: 'boolean', description: 'True once the whole job is done.' },
          },
        },
        isDeferred: false,
      })
    }

    await $.command.register({
      name: 'crew',
      description: 'Show or hide the panel of subagents and the plan. /crew open only opens it.',
    })

    // Drives the clocks and the animation; quiet when nothing is moving.
    let ticks = 0
    const tick = async (): Promise<void> => {
      const isBusy = (await read($, agents)).some(isRunning)
      if (isBusy && ++ticks % TICKS_PER_RECONCILE === 0) await reconcileAgents($)
      if (!isBusy) {
        if (!(await read($, isMainTurnRunning))) return
        const p = await read($, plan)
        if (!p || isPlanComplete(p)) return
      }
      const at = await $.clock.now()
      await update($, now, () => at)
    }
    $.clock.every(TICK_MS, () => void tick().catch(() => undefined))

    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, isMainTurnRunning, () => true)
    return next(e)
  })

  // /clear and /resume carry on in this process under another session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await resetSession($)
    return next(e)
  })

  // A new prompt after everything finished starts the band over. The panel
  // keeps the session's history. A slash command, a message typed while Claude
  // is working, and a prompt another hook drops are not new work.
  on('prompt.submit', async ($, e, next) => {
    const isNewWork =
      e.command === undefined &&
      !e.isMeta &&
      !(await read($, isMainTurnRunning)) &&
      !(await read($, agents)).some(isRunning)
    const submitted = await next(e)
    if (isNewWork && submitted.drop === undefined) {
      const p = await read($, plan)
      const at = await $.clock.now()
      if (p && isPlanComplete(p)) {
        await retireTasks($, p)
        await update($, plan, () => null)
      }
      await update($, layout, prev => ({ ...prev, bandSince: at }))
    }
    return submitted
  })

  on('command.run', { command: 'crew' }, async ($, e) => {
    const answer = (e.args ?? '').trim() === 'open' ? await openPane($) : await togglePane($)
    return { text: answer.text }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const input = e as unknown as Report
    const { agentId } = e
    if (agentId) {
      // A worker reports on its own row and cannot touch the session's plan.
      await patchAgent($, agentId, a => {
        const total = reportedSteps(input.steps)?.length ?? a.stepTotal
        return {
          ...a,
          stepTotal: total,
          stepDone: input.finished === true ? total : Math.min(total, wholeNumber(input.done) ?? a.stepDone),
          note: clean(input.note, MAX_NOTE),
        }
      })
      return { result: 'ok' }
    }
    const reported = await update($, plan, prev => applyReport(prev, input))
    return { result: reported ? `ok: ${doneCount(reported.steps)}/${reported.steps.length}` : 'ok' }
  })

  // Subagents write the session's one task list, so their calls count too.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const p = await read($, plan)
      if (p && isPlanComplete(p)) await retireTasks($, p)
      const { id, subject } = ran.result.task
      await update($, plan, prev => addTask(prev, id, subject, e.activeForm))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && ran.result.success !== false) {
      await update($, plan, prev => changeTask(prev, e))
    }
    return ran
  })

  // The whole list, so a session that resumed mid-plan catches up here.
  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const { retiredTasks } = await read($, layout)
      await update($, plan, prev => syncTaskList(prev, ran.result.tasks, retiredTasks))
    }
    return ran
  })

  // TodoWrite lists are per agent: a worker's goes on its own row.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const steps = stepsFromTodos(e.todos)
      const { agentId } = e
      if (agentId) {
        const active = activeStep(steps)
        await patchAgent($, agentId, a => ({
          ...a,
          stepDone: doneCount(steps),
          stepTotal: steps.length,
          note: clip(active?.activeText ?? active?.text ?? '', MAX_NOTE),
        }))
      } else {
        await update($, plan, prev => (steps.length ? { ...(prev ?? emptyPlan()), steps } : null))
      }
    }
    return ran
  })

  // What each worker is doing right now, with nothing asked of the model.
  on('tool.call', async ($, e, next) => {
    const { agentId } = e
    if (!agentId || PROGRESS_TOOL.test(String(e.tool))) return next(e)
    await patchAgent($, agentId, a => ({ ...a, activity: activityOf(e) }))
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await patchAgent($, agentId, a => ({ ...a, toolCalls: a.toolCalls + 1 }))
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    const id = started.agentId ?? e.tool_use_id
    await update($, agents, list => {
      const earlier = list.find(a => a.id === id)
      const run = earlier ? resumeRun(earlier, at) : newAgentRun(id, e.subagentType, e.description, started.model, at)
      return [...list.filter(a => a.id !== id), run].slice(-MAX_AGENTS)
    })
    await update($, now, () => at)

    if (options.autoOpen !== 'never' && !(await read($, layout)).hasAutoOpened) {
      try {
        await $.ui.open({ id: PANE, title: PANE_TITLE })
        await update($, layout, prev => ({ ...prev, hasAutoOpened: true }))
      } catch {
        // Refused this time: the next subagent asks again.
      }
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const { agentId } = e
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    const prompt = promptTokens(usage)
    const at = await $.clock.now()
    await patchAgent($, agentId, earlier => {
      const a = resumeRun(earlier, at)
      return {
        ...a,
        model,
        ...(typeof e.effort === 'string' ? { effort: e.effort } : {}),
        contextTokens: prompt + usage.output_tokens,
        contextMax: contextWindowOf(model),
        tokens: a.tokens + usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
        costUsd: a.costUsd + costOf(model, usage, prompt),
        requests: a.requests + 1,
      }
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const { agentId, usage } = e
    if (!agentId) {
      await update($, isMainTurnRunning, () => false)
      return next(e)
    }
    const at = await $.clock.now()
    await patchAgent($, agentId, a => ({
      ...a,
      status: statusOfTurnEnd(e.reason),
      endedAt: at,
      activity: '',
      // A run whose requests went unseen still gets the turn's own sum.
      ...(a.requests === 0 && usage
        ? {
            model: usage.model || a.model,
            tokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
            costUsd: costOf(usage.model || a.model, usage, 0),
          }
        : {}),
    }))
    await update($, now, () => at)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, plan)
    const list = await read($, agents)
    const { bandSince } = await read($, layout)
    const shown = list.filter(a => isRunning(a) || a.startedAt >= bandSince)
    const overview = overviewOf(p, shown)
    if (overview === null || e.props.hasSurvey) return next(e)

    // Other mods' bands stay, beneath this one. The engine's own placeholder is
    // not nested: the desktop drops a band that holds it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && drawn.type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : undefined
    const isBusy = shown.some(isRunning)
    const tick = isBusy || (e.props.isWorking && !overview.isComplete) ? await read($, now) : 0
    const frame = Math.floor(tick / TICK_MS)
    const spinner = SPINNER[frame % SPINNER.length] ?? '●'
    const tone: Tone = !overview.isComplete ? 'active' : overview.failed > 0 ? 'failed' : 'done'
    const color = TONE_COLORS[tone]

    const ratio = overview.total ? overview.done / overview.total : 0
    const percent = overview.total ? `${Math.round(ratio * 100)}%` : ''
    const count = `${overview.done}/${overview.total}`

    // Agents of this piece of work, or the session's when none has started yet.
    const crewLabel = `×${shown.length || list.length}`
    const crewButton = list.length > 0 && (
      <Button
        key="crew"
        label={crewLabel}
        plain
        onPress={async () => {
          const answer = await togglePane($)
          if (answer.isWaiting) $.ui.toast(answer.text)
        }}
      />
    )
    const dismissButton = <Button key="dismiss" label="✕" plain role="dismiss" dimColor onPress={() => dismissBand($)} />

    if (Raster) {
      const marks = glyphs
      const mark = tone === 'done' ? marks.done : tone === 'failed' ? marks.failed : isBusy ? spinner : '●'
      const width = Math.max(10, e.props.bodyColumns)
      const isNarrow = width < 60
      const title = clip(overview.label, isNarrow ? Math.floor(width / 4) : Math.min(34, Math.floor(width / 3)))
      const showBot = isBusy && !isNarrow
      const hasCrew = list.length > 0
      const parts = [cellWidth(title) + 2, percent.length, showBot ? 1 : 0, hasCrew ? crewLabel.length : 0, 1].filter(Boolean)
      // The row's elements sit one cell apart: those above, and the bar.
      const room = width - parts.reduce((sum, part) => sum + part, 0) - parts.length
      const barWidth = overview.total > 0 && room >= 8 ? Math.min(44, room) : 0
      const detailRoom = room - barWidth - 1
      const failedLabel = `${overview.failed} failed`
      return (
        // The empty row above balances the one Claude Code keeps below the band.
        <Box key="band" flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={0}>
              <Text wrap="truncate-end">
                <Text color={color}>{mark} </Text>
                <Text weight="bold">{title}</Text>
              </Text>
            </Box>
            {barWidth > 0 && (
              <Raster
                key="bar"
                columns={barWidth}
                rows={1}
                cells={drawPillBar({
                  width: barWidth,
                  ratio,
                  runRatio: overview.total ? (overview.done + overview.inFlight) / overview.total : 0,
                  label: tone === 'done' ? 'Done' : tone === 'failed' ? failedLabel : `${overview.kind} ${count}`,
                  shortLabel: tone === 'done' ? 'Done' : tone === 'failed' ? 'Failed' : count,
                  steps: overview.total,
                  isComplete: overview.isComplete,
                  tone,
                  frame,
                  glyphs,
                })}
              />
            )}
            {percent && (
              <Text dimColor tabular>
                {percent}
              </Text>
            )}
            {overview.detail && detailRoom > 8 && (
              <Text dimColor wrap="truncate-end">
                {clip(overview.detail, detailRoom)}
              </Text>
            )}
            {showBot && <Text color={ACCENT}>{glyphs.robot}</Text>}
            {crewButton}
            {dismissButton}
          </Box>
          {below}
        </Box>
      )
    }

    const mark = tone === 'done' ? '✓' : tone === 'failed' ? '✗' : isBusy ? spinner : '●'
    const cols = Math.max(30, e.props.bodyColumns)
    const label = clip(overview.label, Math.min(36, Math.floor(cols / 3)))
    const summary = overview.total ? `${count}  ${percent}` : ''
    const barWidth = Math.max(6, Math.min(40, cols - cellWidth(label) - summary.length - 18))
    const [filled, empty] = drawBar(ratio, barWidth)
    const detailRoom = cols - cellWidth(label) - summary.length - barWidth - 18

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color={color}>{mark} </Text>
              <Text weight="semibold">{label}</Text>
              {overview.total > 0 && (
                <Text>
                  {'  '}
                  <Text color={color}>{filled}</Text>
                  <Text dimColor>{empty}</Text>
                  {'  '}
                  <Text tabular>{summary}</Text>
                </Text>
              )}
              {overview.failed > 0 && <Text color={FAILED}>{`  ${overview.failed} failed`}</Text>}
              {overview.detail && detailRoom > 8 && <Text dimColor>{`  ${clip(overview.detail, detailRoom)}`}</Text>}
            </Text>
          </Box>
          {crewButton}
          {dismissButton}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : undefined
    const marks: Glyphs = Raster ? glyphs : GLYPHS.plain
    const p = await read($, plan)
    const list = await read($, agents)
    const { isDoneCollapsed } = await read($, layout)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)
    const frame = Math.floor(at / TICK_MS)
    const spinner = SPINNER[frame % SPINNER.length] ?? '●'

    const running = list.filter(isRunning).reverse()
    const finished = list.filter(a => !isRunning(a)).reverse()
    const shownFinished = finished.slice(0, MAX_FINISHED_SHOWN)
    const sum = totals(list, at)
    const cols = Math.max(24, e.props.bodyColumns)
    // Content is inset on the terminal; the separators still run the full width.
    const inset = Raster ? PANE_INSET : 0
    const contentCols = Math.max(20, cols - inset * 2)
    const textWidth = Math.max(16, contentCols - BOT_COLUMNS - 1)
    // Three tiles and two gaps fill the content width, spare cells going to the later tiles.
    const tileWidthAt = (index: number): number => Math.floor((contentCols - 2 + index) / 3)
    const textBarWidth = Math.max(6, Math.min(16, cols - 30))

    const viewAgent = async (id: string): Promise<void> => {
      const shownAgent = await $.ui.view({ agentId: id })
      if (shownAgent.deny !== undefined) $.ui.toast(shownAgent.deny)
    }

    const tile = (index: number, icon: string, name: string, value: string) => (
      <Box key={name} flexDirection="column" borderStyle="round" borderDimColor width={tileWidthAt(index)} paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {icon} {name}
        </Text>
        <Text weight="bold" tabular wrap="truncate-end">
          {value}
        </Text>
      </Box>
    )

    const agentRow = (a: AgentRun) => {
      const view = viewOfAgent(a)
      const color = agentColor(a)
      const openButton = (room: number) => (
        <Button key={`view-${a.id}`} label={clip(a.description || a.type, room)} plain onPress={() => viewAgent(a.id)} />
      )

      if (Raster) {
        const typeColor = hex(colorOfType(a.type))
        const [filled, rest] = drawLineGauge(view.ratio, textWidth)
        return (
          <Box key={a.id} flexDirection="column">
            <Box flexDirection="row" gap={1} paddingX={inset}>
              <Raster key={`bot-${a.id}`} columns={BOT_COLUMNS} rows={BOT_ROWS} cells={drawBot(a.type, a.status, frame)} />
              <Box flexDirection="column" width={textWidth}>
                <Box flexDirection="row" justifyContent="space-between">
                  {openButton(textWidth - 4)}
                  {/* Terminals such as Ghostty draw a Nerd Font icon two cells wide when the next cell is blank. */}
                  <Text color={color}>{agentMark(a, marks, marks.active)} </Text>
                </Box>
                <Text wrap="truncate-end">
                  <Text color={typeColor}>{a.type}</Text>
                  <Text dimColor>
                    {'  '}
                    {view.meta.join(' · ')}
                  </Text>
                </Text>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">{[view.stepCount, view.current].filter(Boolean).join(' · ')}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text dimColor tabular>
                      ctx {view.percent}% · {formatTokens(a.contextTokens)} ≈{formatCost(a.costUsd)} {formatTime(elapsed(a, at))}
                    </Text>
                  </Box>
                </Box>
                <Text>
                  {view.hasProgress ? (
                    <Text color={view.isFailed ? FAILED : typeColor}>{filled}</Text>
                  ) : (
                    <Text dimColor>{filled}</Text>
                  )}
                  <Text dimColor>{rest}</Text>
                </Text>
              </Box>
            </Box>
            <Text dimColor>{'─'.repeat(cols)}</Text>
          </Box>
        )
      }

      const [filled, empty] = drawBar(view.ratio, textBarWidth)
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>{agentMark(a, marks, spinner)}</Text>
            {openButton(cols - 4)}
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {[a.type, ...view.meta].join(' · ')}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {view.hasProgress ? <Text color={color}>{filled}</Text> : <Text dimColor>{filled}</Text>}
            <Text dimColor>
              {empty} {view.stepCount ? `${view.stepCount} · ` : ''}ctx {view.percent}% ≈{formatCost(a.costUsd)}{' '}
              {formatTime(elapsed(a, at))}
            </Text>
          </Text>
          {view.current && (
            <Text dimColor wrap="truncate-end">
              {'  ↳ '}
              {view.current}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {Raster ? (
          <Box flexDirection="row" gap={1} paddingX={inset}>
            {tile(0, glyphs.cost, 'Cost', `≈${formatCost(sum.cost)}`)}
            {tile(1, glyphs.tokens, 'Tokens', formatTokens(sum.tokens))}
            {tile(2, glyphs.time, 'Time', formatTime(sum.time))}
          </Box>
        ) : (
          <Text dimColor>
            ≈{formatCost(sum.cost)} · {formatTokens(sum.tokens)} tokens · {formatTime(sum.time)}
          </Text>
        )}
        {p && p.steps.length > 0 && (
          <Box flexDirection="column" marginTop={1} paddingX={inset}>
            <Text weight="bold" wrap="truncate-end">
              {p.title || 'Plan'} · {doneCount(p.steps)}/{p.steps.length}
            </Text>
            {p.steps.map(step => (
              <Text key={step.id} wrap="truncate-end" dimColor={step.status === 'pending'}>
                <Text color={step.status === 'done' ? DONE : step.status === 'active' ? ACCENT : undefined}>
                  {stepMark(step, marks)}{' '}
                </Text>
                {step.status === 'active' ? step.activeText || step.text : step.text}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Box key="running-heading" flexDirection="column" paddingX={inset} marginBottom={Raster && running.length > 0 ? 1 : 0}>
            {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
            {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
          </Box>
          {running.map(agentRow)}
          {finished.length > 0 && (
            <Box key="finished-heading" paddingX={inset} marginBottom={Raster && !isDoneCollapsed ? 1 : 0}>
              <Button
                key="finished"
                label={`${isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
                plain
                onPress={() => update($, layout, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
              />
            </Box>
          )}
          {!isDoneCollapsed && shownFinished.map(agentRow)}
          {!isDoneCollapsed && finished.length > shownFinished.length && (
            <Box paddingX={inset}>
              <Text dimColor>{finished.length - shownFinished.length} older not shown</Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
