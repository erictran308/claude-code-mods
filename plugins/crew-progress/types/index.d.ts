export type StepStatus = 'pending' | 'active' | 'done'

export type PlanStep = {
  id: string
  text: string
  /** The present-tense form, shown while the step runs ("Running tests"). */
  activeText?: string
  status: StepStatus
}

export type Plan = {
  title: string
  note: string
  steps: PlanStep[]
  isFinished: boolean
  /** Hidden from the band by the person, and still followed. */
  isDismissed: boolean
}

export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

export type AgentRun = {
  id: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  /** When this run of the agent began; a resumed agent starts a new run. */
  startedAt: number
  endedAt?: number
  /** Time spent in earlier runs of this agent. */
  priorMs: number
  contextTokens: number
  contextMax: number
  /** Tokens processed, cache reads left out: they repeat on every request. */
  tokens: number
  costUsd: number
  requests: number
  toolCalls: number
  /** The tool call in flight or last made, for example "Read src/auth.ts". */
  activity: string
  stepDone: number
  stepTotal: number
  note: string
  /** Made from the engine's list before any spawn named it, so the spawn's words win. */
  fromList?: boolean
}

export type Layout = {
  isDoneCollapsed: boolean
  hasAutoOpened: boolean
  /** The band counts only agents started at or after this time. */
  bandSince: number
  /** Tasks of finished plans, still in Claude's list but no longer on the bar. */
  retiredTasks: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'crew-progress': {
      plan: Shaped<Plan | null>
      agents: Shaped<AgentRun[]>
      layout: Shaped<Layout>
      now: number
      isMainTurnRunning: boolean
    }
  }
}
