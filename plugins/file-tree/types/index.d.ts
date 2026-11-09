export type TouchKind = 'read' | 'edited' | 'committed'

/** One file Claude has handled this session. */
export type Touch = {
  path: string
  /** Where the file stands: reading an edited file leaves it edited. */
  kind: TouchKind
  /** What was done last: the color of its flash. */
  lastAction: TouchKind
  /** What the latest turn to handle it did: what that turn's summary counts. */
  turnAction: TouchKind
  lastAt: number
  turn: number
  liveUntil: number
}

export type Entry = {
  name: string
  isDir: boolean
  isLink: boolean
  size: number
  mtimeMs: number
}

export type Listing = {
  entries: Entry[]
  /** Entries in the folder, which can be more than are kept. */
  total: number
}

export type Change = {
  /** One letter: M, A, D, R, C, or ? for untracked. */
  code: string
  added: number
  removed: number
}

export type GitView = {
  /** The folder this view was read for. */
  root: string
  isRepo: boolean
  top: string
  prefix: string
  gitDir: string
  /** The dates of the index and HEAD when this was read: a change means look again. */
  stamp: string
  branch: string
  ahead: number
  behind: number
  head: string
  /** At most a few thousand are kept: `changedTotal` is how many there are. */
  changes: Record<string, Change>
  changedTotal: number
  ignored: string[]
  added: number
  removed: number
  /** True when some files could not be counted, so the totals are a floor. */
  isCountPartial: boolean
}

export type Layout = {
  /** The session's folder: Back to project returns here. */
  project: string
  root: string
  expanded: string[]
  /** Folders opened to show Claude's work, with when: these close themselves. */
  autoOpened: Record<string, number>
  query: string
  showHidden: boolean
  showSizes: boolean
  showAllTouched: boolean
  hasAutoOpened: boolean
}

export type Working = {
  id: string
  kind: TouchKind
  paths: string[]
}

export type Activity = {
  turn: number
  isWorking: boolean
  /** Tools running now that named their files. */
  working: Working[]
  /** One mark per action of the turn, oldest first: the strip in the card. */
  trail: TouchKind[]
  trailTurn: number
  /** The last commit that took one of Claude's edits; empty before that. */
  commitSha: string
}

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      layout: Shaped<Layout>
      listings: Shaped<Record<string, Listing>>
      git: Shaped<GitView>
      touches: Shaped<Touch[]>
      activity: Shaped<Activity>
      now: number
    }
  }
}
