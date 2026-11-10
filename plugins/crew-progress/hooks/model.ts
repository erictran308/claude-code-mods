// Everything here is plain data in and plain data out: what the plan and the
// subagents are, what they cost, and what the band should say about them.

import type { AgentInfo, ModelUsage } from 'claude-code'

import type { AgentRun, AgentStatus, Plan, PlanStep, StepStatus } from '../types'

export const MAX_AGENTS = 200
export const MAX_NOTE = 60
export const MAX_RETIRED_TASKS = 500
const MAX_STEPS = 100
const MAX_TEXT = 120

// ---------------------------------------------------------------------------
// Text and numbers

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u

/** Terminal cells the text takes: CJK and emoji take two. */
export const cellWidth = (text: string): number => [...text].reduce((width, ch) => width + (WIDE.test(ch) ? 2 : 1), 0)

/** Cuts the text to at most `max` terminal cells. */
export const clip = (text: string, max: number): string => {
  if (cellWidth(text) <= max) return text
  const room = Math.max(1, max - 1)
  let kept = ''
  let width = 0
  for (const ch of text) {
    const next = cellWidth(ch)
    if (width + next > room) break
    kept += ch
    width += next
  }
  return `${kept}…`
}

// Tool inputs are the model's words: the schema is advice, these are the limits.
export const clean = (value: unknown, max = MAX_TEXT): string =>
  typeof value === 'string' ? clip(value.replace(/\s+/g, ' ').trim(), max) : ''

export const wholeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined

export const formatTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

export const formatCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

export const formatTime = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export const modelName = (id: string): string => {
  const [, family = '', major = '', minor] =
    /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id) ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}`
}

// ---------------------------------------------------------------------------
// Cost: the engine reports tokens, not money, so this is an estimate.
// USD per million tokens from platform.claude.com/docs/en/about-claude/pricing,
// checked 2026-11-09. The first row that matches a model id wins. The usage
// report does not split cache writes by lifetime; they are priced at the
// 1-hour rate, so a session writing 5-minute entries reads slightly high.

type Price = readonly [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Retired models are not on the pricing page, and the family rows would misprice them.
const RETIRED = /claude-3|(?:opus|sonnet)-4(?:-1)?(?:-\d{8}|$)/

// Haiku 5.5 alone is priced by prompt length, per request.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

export const promptTokens = (u: ModelUsage): number =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const priceOf = (model: string, prompt: number): Price | undefined => {
  const id = model.toLowerCase()
  if (RETIRED.test(id)) return undefined
  if (prompt > HAIKU_LONG_PROMPT && id.includes('haiku-5-5')) return HAIKU_LONG
  return PRICES.find(([pattern]) => pattern.test(id))?.[1]
}

/**
 * `prompt` is the prompt length of one request, 0 for a turn's sum: a sum says
 * nothing about any one request, so it gets the ordinary prices. A model the
 * table does not know counts as nothing rather than as a guess.
 */
export const costOf = (model: string, u: ModelUsage, prompt: number): number => {
  const price = priceOf(model, prompt)
  if (!price) return 0
  const [input, output, cacheRead, cacheWrite] = price
  return (
    (u.input_tokens * input +
      u.output_tokens * output +
      u.cache_read_input_tokens * cacheRead +
      u.cache_creation_input_tokens * cacheWrite) /
    1e6
  )
}

// Models before the 4.6 generation have a 200K window unless the id asks for 1M.
export const contextWindowOf = (model: string): number =>
  !/\[1m\]/i.test(model) && /claude-3|-4-[0-5](?!\d)|-4-\d{8}|-4$/i.test(model) ? 200_000 : 1_000_000

// ---------------------------------------------------------------------------
// The plan: Claude's own task list, or the `progress` tool where it has none.

export type Report = { title?: unknown; steps?: unknown; done?: unknown; note?: unknown; finished?: unknown }

const TASK_STATUS: Record<string, StepStatus> = {
  pending: 'pending',
  in_progress: 'active',
  completed: 'done',
}

const statusOfTask = (status: string): StepStatus => TASK_STATUS[status] ?? 'pending'

export const emptyPlan = (): Plan => ({ title: '', note: '', steps: [], isFinished: false, isDismissed: false })

export const doneCount = (steps: readonly PlanStep[]): number => steps.filter(s => s.status === 'done').length

export const isPlanComplete = (p: Plan): boolean =>
  p.isFinished || (p.steps.length > 0 && doneCount(p.steps) === p.steps.length)

export const activeStep = (steps: readonly PlanStep[]): PlanStep | undefined => steps.find(s => s.status === 'active')

const toStep = (id: string, text: unknown, status: StepStatus, activeText?: unknown): PlanStep => {
  const active = clean(activeText)
  return { id, text: clean(text), status, ...(active ? { activeText: active } : {}) }
}

export const reportedSteps = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.map(s => clean(s)).filter(Boolean).slice(0, MAX_STEPS) : undefined

export const applyReport = (prev: Plan | null, input: Report): Plan | null => {
  const title = clean(input.title)
  const texts = reportedSteps(input.steps)
  const isNewTitle = title !== '' && title !== prev?.title
  const startsOver = isNewTitle || (texts !== undefined && (prev === null || prev.isFinished))
  // A report with nothing new must not wipe a finished plan or revive a cleared one.
  if (!startsOver && (prev === null || prev.isFinished)) return prev

  const base = startsOver || prev === null ? emptyPlan() : prev
  const steps = texts ? texts.map((text, i) => toStep(String(i + 1), text, 'pending')) : base.steps
  const isFinished = input.finished === true
  const done = isFinished ? steps.length : Math.min(steps.length, wholeNumber(input.done) ?? doneCount(base.steps))
  return {
    ...base,
    title: title || base.title,
    note: isFinished ? '' : clean(input.note, MAX_NOTE),
    steps: steps.map((step, i) => ({
      ...step,
      status: i < done ? 'done' : i === done ? 'active' : 'pending',
    })),
    isFinished,
  }
}

export const addTask = (prev: Plan | null, id: string, subject: unknown, activeForm: unknown): Plan => {
  // New work brings a dismissed bar back; a finished plan gives way to it.
  const base = !prev || isPlanComplete(prev) ? emptyPlan() : { ...prev, isDismissed: false }
  return { ...base, steps: [...base.steps.filter(s => s.id !== id), toStep(id, subject, 'pending', activeForm)].slice(-MAX_STEPS) }
}

export const changeTask = (
  prev: Plan | null,
  change: { taskId: string; subject?: unknown; activeForm?: unknown; status?: string },
): Plan | null => {
  if (!prev) return prev
  if (change.status === 'deleted') return { ...prev, steps: prev.steps.filter(s => s.id !== change.taskId) }
  return {
    ...prev,
    steps: prev.steps.map(step =>
      step.id === change.taskId
        ? toStep(
            step.id,
            clean(change.subject) || step.text,
            change.status === undefined ? step.status : statusOfTask(change.status),
            clean(change.activeForm) || step.activeText,
          )
        : step,
    ),
  }
}

type ListedTask = { id: string; subject: string; status: string }

/** The whole list as Claude reports it. Retired tasks belong to work the bar has already let go of. */
export const syncTaskList = (prev: Plan | null, tasks: readonly ListedTask[], retired: readonly string[]): Plan | null => {
  if (tasks.length === 0) return null
  const live = tasks.filter(task => !retired.includes(task.id))
  if (live.length === 0) return prev
  if (prev === null && live.every(task => task.status === 'completed')) return null
  const known = new Map((prev?.steps ?? []).map(step => [step.id, step]))
  return {
    ...(prev ?? emptyPlan()),
    steps: live.slice(-MAX_STEPS).map(task => toStep(task.id, task.subject, statusOfTask(task.status), known.get(task.id)?.activeText)),
  }
}

type Todo = { content: string; status: string; activeForm?: string }

export const stepsFromTodos = (todos: readonly Todo[]): PlanStep[] =>
  todos.slice(0, MAX_STEPS).map((todo, i) => toStep(String(i + 1), todo.content, statusOfTask(todo.status), todo.activeForm))

// ---------------------------------------------------------------------------
// Subagents

export const isRunning = (a: AgentRun): boolean => a.status === 'running'

const hasFailed = (a: AgentRun): boolean => a.status === 'failed' || a.status === 'stopped'

export const newAgentRun = (id: string, type: string, description: string, model: string, at: number): AgentRun => ({
  id,
  type,
  description: clean(description),
  model,
  status: 'running',
  startedAt: at,
  priorMs: 0,
  contextTokens: 0,
  contextMax: contextWindowOf(model),
  tokens: 0,
  costUsd: 0,
  requests: 0,
  toolCalls: 0,
  activity: '',
  stepDone: 0,
  stepTotal: 0,
  note: '',
})

/** A row for an agent loop that no `agent.spawn` announced, such as a forked skill. */
export const listedAgentRun = (info: Pick<AgentInfo, 'id' | 'type' | 'description' | 'name'>, at: number): AgentRun => ({
  ...newAgentRun(info.id, info.type || 'agent', info.description || info.name || '', '', at),
  fromList: true,
})

/** A row named by what announced it (a spawn, a Skill call): its words, and its model if it had none. */
export const namedRun = (a: AgentRun, type: string, description: unknown, model: string): AgentRun => ({
  ...a,
  fromList: false,
  type: type || a.type,
  description: clean(description) || a.description,
  ...(a.model ? {} : { model, contextMax: contextWindowOf(model) }),
})

/** A forked skill's row is named for the command as it was called; '' with no name. */
export const skillLabel = (name: unknown, args: unknown): string => {
  const command = typeof name === 'string' ? name.trim().replace(/^\/+/, '') : ''
  return command ? clean(`/${command} ${typeof args === 'string' ? args : ''}`) : ''
}

/** A run that ended and is working again. Its earlier time is kept and the gap is not. */
export const resumeRun = (a: AgentRun, at: number): AgentRun =>
  isRunning(a)
    ? a
    : { ...a, status: 'running', endedAt: undefined, priorMs: a.priorMs + (a.endedAt ?? at) - a.startedAt, startedAt: at }

export const statusOfTurnEnd = (reason: string): AgentStatus =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'

const ENDED_IN_ENGINE: Record<string, AgentStatus> = { completed: 'done', failed: 'failed', killed: 'stopped' }

export const statusOfEngineAgent = (status: string): AgentStatus | undefined => ENDED_IN_ENGINE[status]

export const elapsed = (a: AgentRun, at: number): number =>
  a.priorMs + (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

export const contextPercent = (a: AgentRun): number =>
  a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0

export const activityOf = (e: { tool: string }): string => {
  const args = e as unknown as Record<string, unknown>
  const detail = ['file_path', 'pattern', 'command', 'query', 'url', 'description']
    .map(key => args[key])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  if (detail === undefined) return e.tool
  const firstLine = detail.trim().split('\n')[0] ?? ''
  const shown = typeof args.file_path === 'string' ? firstLine.split('/').slice(-2).join('/') : firstLine
  return clip(`${e.tool} ${shown}`, 80)
}

// Time when at least one subagent was at work: overlaps count once, gaps not at all.
const busyTime = (list: readonly AgentRun[], at: number): number => {
  const spans = list
    .map(a => [a.startedAt, a.endedAt ?? Math.max(at, a.startedAt)] as const)
    .sort((x, y) => x[0] - y[0])
  let total = list.reduce((sum, a) => sum + a.priorMs, 0)
  let covered = -Infinity
  for (const [from, to] of spans) {
    total += Math.max(0, to - Math.max(from, covered))
    covered = Math.max(covered, to)
  }
  return total
}

export const totals = (list: readonly AgentRun[], at: number) => ({
  cost: list.reduce((sum, a) => sum + a.costUsd, 0),
  tokens: list.reduce((sum, a) => sum + a.tokens, 0),
  time: busyTime(list, at),
})

/** What every surface's row says about one subagent. */
export const viewOfAgent = (a: AgentRun) => {
  const percent = contextPercent(a)
  return {
    percent,
    isFailed: hasFailed(a),
    // Without reported steps the bar falls back to the context fill, drawn dim.
    hasProgress: a.stepTotal > 0 || a.status === 'done',
    ratio: a.status === 'done' ? 1 : a.stepTotal ? a.stepDone / a.stepTotal : percent / 100,
    stepCount: a.stepTotal ? `${a.stepDone}/${a.stepTotal}` : '',
    current: isRunning(a) ? a.note || a.activity : '',
    meta: [a.model ? modelName(a.model) : '', a.effort, a.toolCalls ? `${a.toolCalls} ${a.toolCalls === 1 ? 'tool' : 'tools'}` : ''].filter(
      (part): part is string => Boolean(part),
    ),
  }
}

// ---------------------------------------------------------------------------
// What the band says

export type Overview = {
  kind: 'Tasks' | 'Agents'
  label: string
  detail: string
  /** Steps finished, or subagents that have ended however they ended. */
  done: number
  total: number
  /** How many of the rest are being worked on now. */
  inFlight: number
  failed: number
  isComplete: boolean
}

export const overviewOf = (p: Plan | null, shown: readonly AgentRun[]): Overview | null => {
  if (p && !p.isDismissed && (p.steps.length > 0 || p.title)) {
    const active = activeStep(p.steps)
    const current = p.note || active?.activeText || active?.text || ''
    return {
      kind: 'Tasks',
      label: p.title || current || 'Plan',
      detail: p.title ? current : '',
      done: doneCount(p.steps),
      total: p.steps.length,
      inFlight: active ? 1 : 0,
      failed: 0,
      isComplete: isPlanComplete(p),
    }
  }
  if (shown.length === 0) return null
  const running = shown.filter(isRunning).length
  return {
    kind: 'Agents',
    label: 'Subagents',
    detail: '',
    done: shown.length - running,
    total: shown.length,
    inFlight: running,
    failed: shown.filter(hasFailed).length,
    isComplete: running === 0,
  }
}
