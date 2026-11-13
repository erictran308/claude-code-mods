import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiOpenResult } from 'claude-code'

import type { AgentRun, Layout, Plan, PlanStep } from '../types'
import { BOT_COLUMNS, BOT_ROWS, GLYPHS, colorOfType, drawBar, drawBot, drawLineGauge, drawPillBar, hex } from './art'
import type { Glyphs, Tone } from './art'
import {
  MAX_NOTE,
  MAX_RETIRED_TASKS,
  activeStep,
  activityOf,
  addTask,
  applyReport,
  applyTodos,
  capAgents,
  cellWidth,
  changeTask,
  clean,
  clip,
  contextWindowOf,
  costOf,
  doneCount,
  elapsed,
  emptyPlan,
  endedRun,
  formatCost,
  formatTime,
  formatTokens,
  isPlanComplete,
  isRunning,
  listedAgentRun,
  namedRun,
  newAgentRun,
  overviewOf,
  promptTokens,
  reportedSteps,
  resumeRun,
  skillLabel,
  startsNewPlan,
  statusOfEngineAgent,
  statusOfTurnEnd,
  stepsFromTodos,
  syncTaskList,
  tokensOf,
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
// The type of a forked skill's row, however the mod first heard of it.
const SKILL_TYPE = 'skill'

const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'
const FAILED = '#e06c75'
const SPINNER = ['◐', '◓', '◑', '◒']
const TONE_COLORS: Record<Tone, string> = { active: ACCENT, done: DONE, failed: FAILED }

const initialLayout = (): Layout => ({ isDoneCollapsed: false, hasAutoOpened: false, bandSince: 0, retiredTasks: [] })

// Change a tag when that value's fields change: what an earlier version stored
// outlives a reload, and the tag makes the new code decline it.
const plan = atom({ plugin: 'crew-progress', key: 'plan' } as const, null, { shape: 'plan-2' })
// agents-3: a row keeps its earlier runs' spans and its last reported plan's title.
const agents = atom({ plugin: 'crew-progress', key: 'agents' } as const, [], { shape: 'agents-3' })
const layout = atom({ plugin: 'crew-progress', key: 'layout' } as const, initialLayout(), { shape: 'layout-2' })
const now = atom({ plugin: 'crew-progress', key: 'now' } as const, 0)
const isMainTurnRunning = atom({ plugin: 'crew-progress', key: 'isMainTurnRunning' } as const, false)

/**
 * Changes one row. `update` always writes, so the change is tried on a read
 * first: with no such row, or no change, nothing is written and nothing redraws.
 */
const patchAgent = async ($: EngineInterface, id: string, change: (a: AgentRun) => AgentRun): Promise<void> => {
  const row = (await read($, agents)).find(a => a.id === id)
  if (!row || change(row) === row) return
  await update($, agents, list => list.map(a => (a.id === id ? change(a) : a)))
}

/** The clock that drives the animation: running only while something moves. */
let ticker: { cancel: () => void } | null = null
/** Counts the calls that ask the clock to run, so a tick that finds nothing moving does not stop one just asked for. */
let kicks = 0
/** Starts the clock if it is not running; set once a session has started. */
let startTicking: () => void = () => undefined

/** When each running row was first found missing from the engine's list. */
const missingSince = new Map<string, number>()
/** Ids the engine's list has held: only these can go missing from it. A remote or workflow agent never is on it. */
const seenOnList = new Set<string>()
/** How long a running row may be off the list before it counts as ended: the list can lag a new agent. */
const MISSING_GRACE_MS = 120_000

// A safety net under turn.complete: a row whose end went unheard would spin forever.
async function reconcileAgents($: EngineInterface): Promise<void> {
  const inEngine = new Map((await $.agent.list()).map(info => [info.id, info.status]))
  for (const id of inEngine.keys()) seenOnList.add(id)
  const at = await $.clock.now()
  const list = await read($, agents)
  const rowIds = new Set(list.map(a => a.id))
  // Only ids that still have a row or are on the list are worth remembering.
  for (const id of seenOnList) if (!rowIds.has(id) && !inEngine.has(id)) seenOnList.delete(id)
  const running = new Map(list.filter(isRunning).map(a => [a.id, a]))
  // An entry lasts only while its row runs this same run and stays off the list.
  for (const [id, since] of missingSince) {
    const row = running.get(id)
    if (inEngine.has(id) || !row || since < row.startedAt) missingSince.delete(id)
  }
  for (const id of running.keys()) {
    if (!inEngine.has(id) && seenOnList.has(id) && !missingSince.has(id)) missingSince.set(id, at)
  }
  const ending = (a: AgentRun): AgentRun => {
    if (!isRunning(a)) return a
    const status = inEngine.get(a.id)
    if (status !== undefined) {
      const ended = statusOfEngineAgent(status)
      return ended ? endedRun(a, ended, at) : a
    }
    // The engine drops an agent from its list a while after it ends: it ended when it was first missed.
    // A mark from before this run started belongs to an earlier run and counts for nothing.
    const since = missingSince.get(a.id)
    return since !== undefined && since >= a.startedAt && at - since >= MISSING_GRACE_MS ? endedRun(a, 'done', since) : a
  }
  // Nothing ended: nothing is written.
  if (!list.some(a => ending(a) !== a)) return
  await update($, agents, rows => rows.map(ending))
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
  missingSince.clear()
  seenOnList.clear()
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
  try {
    return answerOfOpen(await $.ui.open({ id: PANE, title: PANE_TITLE }))
  } catch (error) {
    // Another plugin may hold a pane of this id.
    return { text: `Crew panel could not open: ${error instanceof Error ? error.message : String(error)}`, isWaiting: true }
  }
}

// A pane opened unasked on a narrow terminal is open but undrawn: asking shows it.
async function togglePane($: EngineInterface): Promise<PaneAnswer> {
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isPlaced) {
      await $.ui.close({ id: PANE })
      return { text: 'Crew panel closed.', isWaiting: false }
    }
  } catch (error) {
    return { text: `Crew panel could not close: ${error instanceof Error ? error.message : String(error)}`, isWaiting: true }
  }
  return openPane($)
}

// Asked once a session, when the first subagent starts.
async function autoOpen($: EngineInterface, mayOpen: boolean): Promise<void> {
  if (!mayOpen || (await read($, layout)).hasAutoOpened) return
  try {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    await update($, layout, prev => ({ ...prev, hasAutoOpened: true }))
  } catch {
    // Refused this time: the next subagent asks again.
  }
}

/**
 * Adds or changes one subagent's row: `change` gets the row there is, if any,
 * and returns the row to keep, or nothing (or that same row) to leave the list
 * as it was. A changed row moves to the end, the newest; one left running also
 * wakes the clock and may open the panel.
 */
async function upsertAgent(
  $: EngineInterface,
  id: string,
  change: (earlier: AgentRun | undefined) => AgentRun | undefined,
  at: number,
  mayOpen: boolean,
): Promise<void> {
  const list = await update($, agents, prev => {
    const earlier = prev.find(a => a.id === id)
    const run = change(earlier)
    return run && run !== earlier ? capAgents([...prev.filter(a => a.id !== id), run]) : prev
  })
  const run = list.find(a => a.id === id)
  if (!run || !isRunning(run)) return
  await update($, now, () => at)
  startTicking()
  await autoOpen($, mayOpen)
}

// A subagent's turn is starting. A loop the engine runs with no agent.spawn,
// such as a forked skill, gets a row from the engine's list; the engine's own
// forks (compaction, memory) are on no list and get none. A row that had
// ended, such as a teammate's woken by a message, runs again.
async function startAgentTurn($: EngineInterface, id: string, mayOpen: boolean): Promise<void> {
  const earlier = (await read($, agents)).find(a => a.id === id)
  if (earlier && isRunning(earlier)) return
  const info = earlier ? undefined : (await $.agent.list().catch(() => [])).find(one => one.id === id)
  if (!earlier && !info) return
  if (info) seenOnList.add(info.id)
  // A row made or woken here starts a run of its own: no earlier miss counts against it.
  missingSince.delete(id)
  const at = await $.clock.now()
  await upsertAgent(
    $,
    id,
    a => (a ? resumeRun(a, at) : info && listedAgentRun(info, at)),
    at,
    mayOpen,
  )
}

const agentColor = (a: AgentRun): string => TONE_COLORS[isRunning(a) ? 'active' : a.status === 'done' ? 'done' : 'failed']

/** The band's mark for its tone: done, failed, or the spinner while something runs. */
const toneMark = (tone: Tone, marks: Glyphs, isBusy: boolean, spinner: string): string =>
  tone === 'done' ? marks.done : tone === 'failed' ? marks.failed : isBusy ? spinner : '●'

/**
 * Cells a glyph takes in a row's layout. A Nerd Font icon is drawn two cells
 * wide over the blank after it, and every row here gives it that blank: a space
 * written after it, or the gap to the next element, which the budget counts
 * already. So the icon itself takes its own cell width, never two.
 */
const glyphCells = (glyph: string): number => cellWidth(glyph)

const agentMark = (a: AgentRun, marks: Glyphs, running: string): string =>
  isRunning(a) ? running : a.status === 'done' ? marks.done : a.status === 'stopped' ? marks.stopped : marks.failed

const stepMark = (step: PlanStep, marks: Glyphs): string =>
  step.status === 'done' ? marks.done : step.status === 'active' ? marks.active : marks.pending

export const register: Register = (on, options) => {
  const glyphs = GLYPHS[options.glyphs === 'plain' ? 'plain' : 'nerd']

  const mayOpen = options.autoOpen !== 'never'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload empties what the module remembers: the engine's list fills it again.
    for (const info of await $.agent.list().catch(() => [])) seenOnList.add(info.id)

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

    // Drives the clocks and the animation; quiet when nothing is moving. It
    // stops itself when a tick finds nothing moving, and starts again when a
    // row starts running, a main turn starts or the plan changes.
    let ticks = 0
    const tick = async (): Promise<void> => {
      const kicked = kicks
      const isBusy = (await read($, agents)).some(isRunning)
      if (isBusy && ++ticks % TICKS_PER_RECONCILE === 0) await reconcileAgents($)
      if (!isBusy) {
        const p = (await read($, isMainTurnRunning)) ? await read($, plan) : null
        if (!p || isPlanComplete(p)) {
          if (kicks === kicked) {
            ticker?.cancel()
            ticker = null
          }
          return
        }
      }
      const at = await $.clock.now()
      await update($, now, () => at)
    }
    ticker?.cancel()
    ticker = null
    startTicking = () => {
      kicks++
      ticker ??= $.clock.every(TICK_MS, () => void tick().catch(() => undefined))
    }
    startTicking()

    return started
  })

  // A subagent's row is made or woken before its turn goes on, so its first
  // request and tool call find it. An error in that bookkeeping never stops the turn.
  on('turn.start', async ($, e, next) => {
    if (e.agentId) await startAgentTurn($, e.agentId, mayOpen).catch(() => undefined)
    else {
      await update($, isMainTurnRunning, () => true)
      startTicking()
    }
    return next(e)
  })

  // /clear and /resume carry on in this process under another session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await resetSession($)
    return next(e)
  })

  // Claude Code's own word that a subagent stopped: a second end signal beside turn.complete.
  // A hook that keeps the agent going (a block) leaves its row running.
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id && !result?.block) {
      const at = await $.clock.now()
      await patchAgent($, e.agent_id, a => (isRunning(a) ? endedRun(a, 'done', at) : a)).catch(() => undefined)
    }
    return result
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
        const texts = reportedSteps(input.steps)
        const total = texts?.length ?? a.stepTotal
        const title = clean(input.title)
        // The main plan's rule: a new title, or new steps after a plan reported finished, start the count over.
        // A plan that merely reached its last step goes on.
        const startsOver = startsNewPlan({ title: a.stepTitle, isFinished: a.stepFinished === true }, title, texts)
        const isFinished = input.finished === true
        const done = isFinished ? total : Math.min(total, wholeNumber(input.done) ?? (startsOver ? 0 : a.stepDone))
        return {
          ...a,
          stepTitle: title || a.stepTitle,
          stepTotal: total,
          stepDone: done,
          // A report with nothing new keeps a finished plan finished.
          stepFinished: isFinished || (!startsOver && texts === undefined && a.stepFinished === true),
          note: clean(input.note, MAX_NOTE),
        }
      })
      return { result: 'ok' }
    }
    const reported = await update($, plan, prev => applyReport(prev, input))
    startTicking()
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
      startTicking()
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && ran.result.success !== false) {
      await update($, plan, prev => changeTask(prev, e))
      startTicking()
    }
    return ran
  })

  // The whole list, so a session that resumed mid-plan catches up here.
  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const { retiredTasks } = await read($, layout)
      await update($, plan, prev => syncTaskList(prev, ran.result.tasks, retiredTasks))
      startTicking()
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
        await update($, plan, prev => applyTodos(prev, steps))
        startTicking()
      }
    }
    return ran
  })

  // A forked skill's row is named for its command. A background one is added
  // here if its first turn has not been heard yet. A foreground one has ended
  // by now: its first turn made its row, or, if that went unheard, it is added
  // here as ended.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || ran.result?.status !== 'forked' || !ran.result.agentId) return ran
    const { agentId, commandName, background, success } = ran.result
    const label = skillLabel(commandName || e.skill, e.args)
    try {
      const at = await $.clock.now()
      await upsertAgent(
        $,
        agentId,
        earlier => {
          if (background) {
            // It runs on: named if its first turn made the row, added if not; a launch that failed adds none,
            // and ends a row its first turn made.
            if (earlier) {
              const named = namedRun(earlier, SKILL_TYPE, label, '')
              return success || !isRunning(named) ? named : endedRun(named, 'failed', at)
            }
            return success ? newAgentRun(agentId, SKILL_TYPE, label, '', at) : undefined
          }
          // A foreground skill has ended by now, whether or not its turn's end was heard.
          const named = namedRun(earlier ?? newAgentRun(agentId, SKILL_TYPE, label, '', at), SKILL_TYPE, label, '')
          return isRunning(named) ? endedRun(named, success ? 'done' : 'failed', at) : named
        },
        at,
        mayOpen,
      )
    } catch {
      // The panel's bookkeeping never fails the call: the skill has already run.
    }
    return ran
  })

  // What each worker is doing right now, with nothing asked of the model.
  on('tool.call', async ($, e, next) => {
    const { agentId } = e
    if (!agentId || PROGRESS_TOOL.test(String(e.tool))) return next(e)
    const doing = activityOf(e)
    let before = ''
    await patchAgent($, agentId, a => {
      before = a.activity
      // The same activity again is no change: nothing to write.
      return a.activity === doing ? a : { ...a, activity: doing }
    })
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await patchAgent($, agentId, a => ({ ...a, toolCalls: a.toolCalls + 1 }))
    } else if (ran.deny !== undefined) {
      // Refused, so nothing ran: the row goes back to what it was doing.
      await patchAgent($, agentId, a => (a.activity === doing ? { ...a, activity: before } : a))
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const asked = await $.clock.now()
    const started = await next(e)
    if (started.deny !== undefined) return started
    // A workflow agent with no id of its own would be keyed by the Workflow call, which all of the run's
    // agents share: no loop could ever end that row, so none is made.
    if (e.workflow && !started.agentId) return started

    const at = await $.clock.now()
    const id = started.agentId ?? e.tool_use_id
    missingSince.delete(id)
    // An agent that starts and ends between two checks of the list is still seen on it once.
    if (started.agentId) {
      const onList = await $.agent.list().catch(() => [])
      if (onList.some(info => info.id === started.agentId)) seenOnList.add(started.agentId)
    }
    // A resume runs the row again, unless its resumed turn already ran and ended
    // before the spawn answered. A row made from the engine's list takes the
    // spawn's type and model, and its words unless this is a resume, which keeps its own.
    await upsertAgent(
      $,
      id,
      earlier => {
        if (!earlier) return newAgentRun(id, e.subagentType, e.description, started.model, at)
        const hasRunAgain = earlier.endedAt !== undefined && earlier.endedAt > asked
        const run = e.resume && !hasRunAgain ? resumeRun(earlier, at) : earlier
        return earlier.fromList ? namedRun(run, e.subagentType, e.resume ? '' : e.description, started.model) : run
      },
      at,
      mayOpen,
    )
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
    // A request is proof of life: no earlier miss counts against this run.
    missingSince.delete(agentId)
    await patchAgent($, agentId, earlier => {
      const a = resumeRun(earlier, at)
      return {
        ...a,
        model,
        ...(typeof e.effort === 'string' ? { effort: e.effort } : {}),
        contextTokens: prompt + usage.output_tokens,
        contextMax: contextWindowOf(model),
        tokens: a.tokens + tokensOf(usage),
        costUsd: a.costUsd + costOf(model, usage, prompt),
        requests: a.requests + 1,
        runRequests: (a.runRequests ?? a.requests) + 1,
      }
    })
    startTicking()
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const { agentId, usage } = e
    if (!agentId) {
      await update($, isMainTurnRunning, () => false)
      return next(e)
    }
    const at = await $.clock.now()
    await patchAgent($, agentId, a => {
      const ended = endedRun(a, statusOfTurnEnd(e.reason), at)
      // A run whose requests went unseen still gets the turn's own sum, added to what earlier runs had.
      const seenThisRun = a.runRequests ?? a.requests
      if (seenThisRun > 0 || !usage) return ended
      const model = usage.model || a.model
      return {
        ...ended,
        model,
        contextMax: contextWindowOf(model),
        tokens: a.tokens + tokensOf(usage),
        costUsd: a.costUsd + costOf(model, usage, 0),
      }
    })
    await update($, now, () => at)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, plan)
    const list = await read($, agents)
    const { bandSince } = await read($, layout)
    // The person's ✕ hides every row started before it, running or not.
    const shown = list.filter(a => a.startedAt >= bandSince)
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
    const dismissButton = <Button key="dismiss" label="✕" plain role="dismiss" dimColor onPress={() => dismissBand($).catch(() => undefined)} />

    if (Raster) {
      const marks = glyphs
      const mark = toneMark(tone, marks, isBusy, spinner)
      const width = Math.max(10, e.props.bodyColumns)
      const isNarrow = width < 60
      const title = clip(overview.label, isNarrow ? Math.floor(width / 4) : Math.min(34, Math.floor(width / 3)))
      const showBot = isBusy && !isNarrow
      const hasCrew = list.length > 0
      // The mark, the space written after it, and the title.
      const titleCells = glyphCells(mark) + 1 + cellWidth(title)
      const parts = [titleCells, percent.length, showBot ? glyphCells(glyphs.robot) : 0, hasCrew ? crewLabel.length : 0, 1].filter(Boolean)
      // The row's elements sit one cell apart: those above, and the bar.
      const room = width - parts.reduce((sum, part) => sum + part, 0) - parts.length
      const barWidth = overview.total > 0 && room >= 8 ? Math.min(44, room) : 0
      const detailRoom = room - barWidth - 1
      const failedLabel = `${overview.failed} failed`
      const doneLabel = overview.stopped > 0 ? `${overview.stopped} stopped` : 'Done'
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
                  label: tone === 'done' ? doneLabel : tone === 'failed' ? failedLabel : `${overview.kind} ${count}`,
                  shortLabel: tone === 'done' ? (overview.stopped > 0 ? 'Stopped' : 'Done') : tone === 'failed' ? 'Failed' : count,
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

    const mark = toneMark(tone, GLYPHS.plain, isBusy, spinner)
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
              {overview.stopped > 0 && <Text dimColor>{`  ${overview.stopped} stopped`}</Text>}
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
    const running = list.filter(isRunning).reverse()
    // The clock is read only while something runs: a finished row's times are its own.
    const at = running.length > 0 ? Math.max(await read($, now), ...list.map(a => a.startedAt), 0) : Math.max(0, ...list.map(a => a.endedAt ?? a.startedAt))
    const frame = Math.floor(at / TICK_MS)
    const spinner = SPINNER[frame % SPINNER.length] ?? '●'

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
            <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
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
