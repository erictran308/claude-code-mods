// Everything here is plain data in and plain data out: what the plan and the
// subagents are, what they cost, and what the band should say about them.

import type { AgentInfo, ModelUsage } from 'claude-code'

import type { AgentRun, AgentStatus, Plan, PlanStep, StepStatus } from '../types'

export const MAX_AGENTS = 200
/** Earlier runs kept per agent, for the Time total; the oldest go first. Few agents are ever woken this often. */
export const MAX_SPANS = 200
export const MAX_NOTE = 60
export const MAX_RETIRED_TASKS = 500
const MAX_STEPS = 100
const MAX_TEXT = 120

// ---------------------------------------------------------------------------
// Text and numbers

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u

/** Symbols of the Basic Multilingual Plane that emoji presentation draws two cells wide (✅ ⚡ ⌛), by code point. */
const EMOJI_SYMBOLS: readonly (readonly [number, number])[] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
]

/** Other two-cell characters the WIDE pattern leaves out. */
const WIDE_SYMBOLS: readonly (readonly [number, number])[] = [
  ...EMOJI_SYMBOLS,
  // And the wide ones below U+1F300: mahjong, cards, squared words and ideographs.
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265],
  // Angle brackets, Yi, vertical forms, and the Tangut and Kana supplements.
  [0x2329, 0x232a], [0xa000, 0xa4cf], [0xfe10, 0xfe19], [0x16fe0, 0x16fe4], [0x17000, 0x187f7],
  [0x18800, 0x18cd5], [0x1b000, 0x1b2fb],
]

const inRanges = (ranges: readonly (readonly [number, number])[], code: number): boolean =>
  ranges.some(([low, high]) => code >= low && code <= high)

const isWideSymbol = (code: number): boolean => inRanges(WIDE_SYMBOLS, code)

/** An emoji a joiner may join to another: the pictographs of U+1F000 to U+1FAFF and the emoji symbols above. */
const isEmoji = (code: number): boolean => (code >= 0x1f000 && code <= 0x1faff) || inRanges(EMOJI_SYMBOLS, code)

/** Joins the glyphs either side of it into one, as in a family emoji. */
const ZWJ = 0x200d

/** The selector that asks for emoji presentation: it widens a one-cell character before it to two. */
const EMOJI_PRESENTATION = 0xfe0f

/** Marks that change the character before them and take no cell: text selectors, skin tones, combining marks, the keycap. */
const isZeroWidth = (code: number): boolean =>
  (code >= 0xfe00 && code <= 0xfe0e) ||
  (code >= 0x1f3fb && code <= 0x1f3ff) ||
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x20d0 && code <= 0x20ff)

/**
 * Where a walk through the text stands: its cells so far, the last glyph's
 * cells, whether that glyph is an emoji, and whether a joiner after it joins
 * the next one to it.
 */
type WidthState = { width: number; last: number; isEmoji: boolean; isJoining: boolean }

const START: WidthState = { width: 0, last: 0, isEmoji: false, isJoining: false }

/** One character more: what `cellWidth` and `clip` both walk by. */
const stepWidth = (state: WidthState, ch: string): WidthState => {
  const code = ch.codePointAt(0) ?? 0
  // A joiner joins an emoji to the emoji after it. After other text, or at the start, it joins nothing.
  if (code === ZWJ) return { ...state, isJoining: state.isEmoji }
  if (state.isJoining && isEmoji(code)) return { ...state, isEmoji: true, isJoining: false }
  if (code === EMOJI_PRESENTATION) {
    const widened = state.last === 1 ? { width: state.width + 1, last: 2 } : {}
    return { ...state, ...widened, isEmoji: true, isJoining: false }
  }
  if (isZeroWidth(code)) return { ...state, isJoining: false }
  const cells = WIDE.test(ch) || isWideSymbol(code) ? 2 : 1
  return { width: state.width + cells, last: cells, isEmoji: isEmoji(code), isJoining: false }
}

/** Terminal cells the text takes: CJK and emoji take two, joiners, selectors and marks none. */
export const cellWidth = (text: string): number => {
  let state = START
  for (const ch of text) state = stepWidth(state, ch)
  return state.width
}

/** Cuts the text to at most `max` terminal cells, walking it once. */
export const clip = (text: string, max: number): string => {
  const room = Math.max(1, max - 1)
  let state = START
  let kept = ''
  let isCut = false
  for (const ch of text) {
    state = stepWidth(state, ch)
    if (state.width > max) {
      // A joiner left at the end would join the ellipsis to the glyph before it.
      const joiner = String.fromCodePoint(ZWJ)
      return `${kept.endsWith(joiner) ? kept.slice(0, -joiner.length) : kept}…`
    }
    // Past the room the ellipsis leaves, the rest is kept only if the whole text fits.
    if (state.width > room) isCut = true
    if (!isCut) kept += ch
  }
  return text
}

// Tool inputs are the model's words: the schema is advice, these are the limits.
export const clean = (value: unknown, max = MAX_TEXT): string =>
  typeof value === 'string' ? clip(value.replace(/\s+/g, ' ').trim(), max) : ''

export const wholeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined

// The unit is chosen by what the number rounds to, so 999,600 reads 1.0M, never 1000k.
export const formatTokens = (n: number): string =>
  n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

export const formatCost = (usd: number): string => `$${usd < 9.995 ? usd.toFixed(2) : usd.toFixed(1)}`

export const formatTime = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

const titled = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`

export const modelName = (id: string): string => {
  // A version is one or two digits: an eight-digit date after the family is no version.
  const [, family = '', major = '', minor] =
    /(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/i.exec(id) ?? []
  if (family) return `${titled(family)} ${major}${minor ? `.${minor}` : ''}`
  // The older order, version first: claude-3-5-sonnet-20241022.
  const [, oldMajor = '', oldMinor, oldFamily = ''] = /claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/i.exec(id) ?? []
  if (oldFamily) return `${titled(oldFamily)} ${oldMajor}${oldMinor ? `.${oldMinor}` : ''}`
  return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
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
// Opus and Sonnet 4.0 and 4.1, by any of their spellings: -4, -4-0, -4-1, a date, Vertex's @date, or [1m].
const RETIRED = /claude-3|(?:opus|sonnet)-4(?:-[01])?(?:-\d{8}|@|\[|$)/

// Haiku 5.5 alone is priced by prompt length, per request.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

export const promptTokens = (u: ModelUsage): number =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/** Tokens processed, cache reads left out: they repeat on every request. */
export const tokensOf = (u: ModelUsage): number => u.input_tokens + u.cache_creation_input_tokens + u.output_tokens

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

// Models before the 4.6 generation have a 200K window unless the id asks for 1M. The
// version is read right after the family name, so a later model's minor 4 is no 4.x.
export const contextWindowOf = (model: string): number =>
  !/\[1m\]/i.test(model) && /claude-3|(?:opus|sonnet|haiku)-4(?:-[0-5](?!\d)|-\d{8}|@|$)/i.test(model) ? 200_000 : 1_000_000

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

/** Whether a report starts a new plan: a new title, or steps sent after the last plan was finished. */
export const startsNewPlan = (prev: { title: string; isFinished: boolean } | null, title: string, texts: readonly string[] | undefined): boolean =>
  (title !== '' && title !== prev?.title) || (texts !== undefined && (prev === null || prev.isFinished))

export const applyReport = (prev: Plan | null, input: Report): Plan | null => {
  const title = clean(input.title)
  const texts = reportedSteps(input.steps)
  const startsOver = startsNewPlan(prev, title, texts)
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

/**
 * A TodoWrite list on the session's plan. The same steps in the same order are
 * the same work moving along, and keep a dismissed bar hidden; any other list is
 * new work and brings it back. An empty list clears the plan.
 */
export const applyTodos = (prev: Plan | null, steps: readonly PlanStep[]): Plan | null => {
  if (!steps.length) return null
  const isSameWork = prev !== null && steps.length === prev.steps.length && steps.every((step, i) => prev.steps[i]?.text === step.text)
  return { ...(prev ?? emptyPlan()), steps: [...steps], isDismissed: isSameWork && prev.isDismissed }
}

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
  stepTitle: '',
  note: '',
  spans: [],
})

/** A row for an agent loop that no `agent.spawn` announced, such as a forked skill. */
export const listedAgentRun = (info: Pick<AgentInfo, 'id' | 'type' | 'description' | 'name'>, at: number): AgentRun => ({
  ...newAgentRun(info.id, info.type || 'agent', info.description || info.name || '', '', at),
  fromList: true,
})

/** A row named by what announced it (a spawn, a Skill call): its words, and its model if it had none. The same row when nothing changes. */
export const namedRun = (a: AgentRun, type: string, description: unknown, model: string): AgentRun => {
  const nextType = type || a.type
  const nextDescription = clean(description) || a.description
  const nextModel = a.model || model
  if (!a.fromList && nextType === a.type && nextDescription === a.description && nextModel === a.model) return a
  return {
    ...a,
    fromList: false,
    type: nextType,
    description: nextDescription,
    ...(a.model ? {} : { model, contextMax: contextWindowOf(model) }),
  }
}

/** A forked skill's row is named for the command as it was called; '' with no name. */
export const skillLabel = (name: unknown, args: unknown): string => {
  const command = typeof name === 'string' ? name.trim().replace(/^\/+/, '') : ''
  return command ? clean(`/${command} ${typeof args === 'string' ? args : ''}`) : ''
}

/**
 * A run that ended and is working again. Its earlier time is kept, as a span for the Time total, and the gap is not.
 * A span dropped past the bound leaves its length in `droppedMs`, so the total never goes down; dropped spans count
 * in full, so past MAX_SPANS runs one agent's time that overlapped another's can count twice.
 */
export const resumeRun = (a: AgentRun, at: number): AgentRun => {
  if (isRunning(a)) return a
  const spans: [number, number][] = [...a.spans, [a.startedAt, a.endedAt ?? at]]
  const dropped = spans.slice(0, Math.max(0, spans.length - MAX_SPANS))
  return {
    ...a,
    status: 'running',
    endedAt: undefined,
    priorMs: a.priorMs + (a.endedAt ?? at) - a.startedAt,
    spans: spans.slice(-MAX_SPANS),
    droppedMs: (a.droppedMs ?? 0) + dropped.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0),
    runRequests: 0,
    startedAt: at,
  }
}

/** A run that ended, with how: what a turn's end, a Skill call and the safety net all write. */
export const endedRun = (a: AgentRun, status: AgentStatus, at: number): AgentRun => ({ ...a, status, endedAt: at, activity: '' })

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
// Each row brings its earlier runs' spans and its current run's; spans dropped past
// the bound count by their length alone.
const busyTime = (list: readonly AgentRun[], at: number): number => {
  const spans = list
    .flatMap(a => [...a.spans, [a.startedAt, a.endedAt ?? Math.max(at, a.startedAt)] as [number, number]])
    .sort((x, y) => x[0] - y[0])
  let total = list.reduce((sum, a) => sum + (a.droppedMs ?? 0), 0)
  let covered = -Infinity
  for (const [from, to] of spans) {
    total += Math.max(0, to - Math.max(from, covered))
    covered = Math.max(covered, to)
  }
  return total
}

/**
 * Keeps the list to MAX_AGENTS rows: ended rows go first, the longest ended
 * first, and a running row only when every row is running.
 */
export const capAgents = (rows: readonly AgentRun[], max = MAX_AGENTS): AgentRun[] => {
  if (rows.length <= max) return [...rows]
  const excess = rows.length - max
  const ended = rows.filter(a => !isRunning(a)).sort((x, y) => (x.endedAt ?? x.startedAt) - (y.endedAt ?? y.startedAt))
  const dropped = new Set(ended.slice(0, excess))
  const kept = rows.filter(a => !dropped.has(a))
  return kept.slice(kept.length - max)
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
  /** Subagents that failed. One the person stopped is not a failure. */
  failed: number
  /** Subagents the person stopped. */
  stopped: number
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
      // Several tasks can be in progress at once, each by its own subagent.
      inFlight: p.steps.filter(s => s.status === 'active').length,
      failed: 0,
      stopped: 0,
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
    failed: shown.filter(a => a.status === 'failed').length,
    stopped: shown.filter(a => a.status === 'stopped').length,
    isComplete: running === 0,
  }
}
