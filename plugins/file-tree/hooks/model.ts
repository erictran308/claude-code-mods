// Everything here is pure: what a tool call touches, what git says, which rows to draw.

import type { Activity, Change, Entry, GitView, Layout, Listing, Touch, TouchKind, TreeView } from '../types'

export const MAX_CHANGES = 3000
export const MAX_ENTRIES = 400
export const MAX_ROWS = 2000
export const MAX_TOUCHES = 200
export const MAX_TRAIL = 120
export const MAX_NAMED_PATHS = 40
export const MAX_ATTRIBUTED = 24
export const MAX_FOUND = 60
export const FLASH_MS = 2600
export const AUTO_CLOSE_MS = 15_000

const WIDE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

export const cellWidth = (text: string): number => [...text].reduce((width, ch) => width + (WIDE.test(ch) ? 2 : 1), 0)

/** Cuts the text to at most `max` terminal cells. */
export const clip = (text: string, max: number): string => {
  if (cellWidth(text) <= max) return text
  if (max <= 0) return ''
  const room = max - 1
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

// Paths ----------------------------------------------------------------------

export const posix = (path: string): string => (/^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\\/g, '/') : path)

export const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path)

export const resolvePath = (base: string, path: string, home = ''): string => {
  let target = posix(path)
  if (home && (target === '~' || target.startsWith('~/'))) target = home + target.slice(1)
  const drive = /^[A-Za-z]:\//.test(target) ? target.slice(0, 2) : ''
  const parts = isAbsolute(target) ? [drive] : posix(base).replace(/\/+$/, '').split('/')
  for (const segment of target.slice(drive.length).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(segment)
  }
  const resolved = parts.join('/') || '/'
  return /^[A-Za-z]:$/.test(resolved) ? `${resolved}/` : resolved
}

export const join = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

export const isTopFolder = (path: string): boolean => path === '/' || /^[A-Za-z]:\/?$/.test(path)

export const dirname = (path: string): string => {
  if (/^[A-Za-z]:\/[^/]*$/.test(path)) return path.slice(0, 3)
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path

export const isInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

/** For the eye: relative inside the tree, ~ under home, whole otherwise. */
export const shownPath = (root: string, path: string, home = ''): string => {
  if (path !== root && isInside(root, path)) return path.slice(root.endsWith('/') ? root.length : root.length + 1)
  if (home && isInside(home, path)) return `~${path.slice(home.length)}`
  return path
}

/** How an `@` mention spells a path: relative to the session's folder, or whole. */
export const mentionPath = (cwd: string, path: string): string => (path !== cwd && isInside(cwd, path) ? shownPath(cwd, path) : path)

/** Every folder from just under `root` down to the one holding `path`. */
export const foldersBetween = (root: string, path: string): string[] => {
  if (!isInside(root, path) || path === root) return []
  const folders: string[] = []
  for (let dir = dirname(path); dir !== root && isInside(root, dir); dir = dirname(dir)) folders.unshift(dir)
  return folders
}

// What a tool call touches ---------------------------------------------------

export type Planned = {
  reads: string[]
  writes: string[]
  /** It may change files it does not name: look at the folder afterwards. */
  mayWrite: boolean
}

const NOTHING: Planned = { reads: [], writes: [], mayWrite: false }

const SEARCH_TOOL = /search|grep|glob|find|list/i
const READ_TOOL = /read|view|open|cat|head|tail|load/i
const WRITE_TOOL = /edit|write|replace|create|patch|update|apply|insert|append|delete|remove|move|rename/i

const PATH_KEYS = [
  'path',
  'paths',
  'file_path',
  'filePath',
  'filepath',
  'file',
  'files',
  'filename',
  'notebook_path',
  'relative_path',
  'relativePath',
  'target_file',
  'targetFile',
  'old_path',
  'new_path',
  'oldPath',
  'newPath',
]

// To other tools these words mean other things, so their values must look like paths.
const LOOSE_PATH_KEYS = ['source', 'destination', 'src', 'dst', 'from', 'to', 'target']

const looksLikePath = (value: string): boolean =>
  !value.includes('@') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && (value.includes('/') || /^[\w.-]+\.\w{1,8}$/.test(value))

const stringsOf = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

// A script of fastwrite's MCP edit tool names its files on its `@`, `>`, `rm` and `mv` lines.
const scriptFiles = (script: unknown): string[] => {
  if (typeof script !== 'string') return []
  return script.split('\n').flatMap(line => {
    const file = /^(?:[@>]|rm) +(\S.*?) *$/.exec(line)?.[1] ?? /^mv +\S+ +(\S+) *$/.exec(line)?.[1]
    return file ? [file] : []
  })
}

// A heredoc's body is text, not commands.
const dropHeredocs = (command: string): string => {
  const kept: string[] = []
  let endings: string[] = []
  for (const line of command.split('\n')) {
    if (endings.length > 0) {
      if (line.trim() === endings[0]) endings = endings.slice(1)
      continue
    }
    kept.push(line)
    for (const match of line.matchAll(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g)) {
      if (match[2]) endings.push(match[2])
    }
  }
  return kept.join('\n')
}

type Word = { text: string; isPlain: boolean }

const splitShell = (command: string): Word[][] => {
  const segments: Word[][] = []
  let words: Word[] = []
  let text = ''
  let quote = ''
  let hasWord = false
  let isPlain = true
  const endWord = (): void => {
    if (hasWord) words.push({ text, isPlain })
    text = ''
    hasWord = false
    isPlain = true
  }
  const endSegment = (): void => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ''
    if (quote) {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) text += command[++i]
      else text += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
      isPlain = false
    } else if (ch === '\\' && i + 1 < command.length) {
      text += command[++i]
      hasWord = true
    } else if (ch === ' ' || ch === '\t') endWord()
    else if (ch === '\n' || ch === ';' || ch === '|' || ch === '(' || ch === ')' || (ch === '&' && command[i - 1] !== '>' && command[i + 1] !== '>')) endSegment()
    else {
      text += ch
      hasWord = true
    }
  }
  endSegment()
  return segments
}

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '{', '!', 'time'])

/** A segment's command and arguments, past shell keywords and `NAME=value` settings. */
const commandWords = (segment: readonly Word[]): readonly Word[] => {
  let start = 0
  for (const word of segment) {
    if (!(word.isPlain && SHELL_KEYWORDS.has(word.text)) && !/^[A-Za-z_]\w*=/.test(word.text)) break
    start++
  }
  return segment.slice(start)
}

const isInPlaceFlag = (word: Word): boolean => /^-[^-]*i/.test(word.text) || word.text.startsWith('--in-place')

const SHELL_READERS = new Set(['cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'wc'])

/** The files a shell command plainly reads: searches and globs do not count. */
export const shellReads = (command: string, cwd: string, home = ''): string[] => {
  let here = cwd
  const found = new Set<string>()
  for (const segment of splitShell(dropHeredocs(command))) {
    const invocation = commandWords(segment)
    const first = basename(invocation[0]?.text ?? '')
    const rest = invocation.slice(1)
    if (first === 'cd') {
      const target = rest[0]?.text
      if (target && !target.startsWith('-')) here = resolvePath(here, target, home)
      continue
    }
    const isFw = first === 'fw' && rest[0]?.text === 'read'
    const isSed = first === 'sed' && !rest.some(isInPlaceFlag)
    if (!isFw && !isSed && !SHELL_READERS.has(first)) continue
    let words = isFw ? rest.slice(1) : rest
    if (isSed) words = words.filter(word => !word.text.startsWith('-')).slice(1)
    for (const word of words) {
      // What follows a redirection is written to, not read.
      if (word.isPlain && /^\d*>{1,2}$/.test(word.text)) break
      if (word.text.startsWith('-') || (word.isPlain && /[*?$<>|`]/.test(word.text))) continue
      // The value of a flag such as `-n 20` or `-l 10-50`.
      if (word.isPlain && /^\d[\d,-]*$/.test(word.text)) continue
      found.add(resolvePath(here, word.text, home))
    }
  }
  return [...found].slice(0, MAX_NAMED_PATHS)
}

const READ_ONLY_SHELL = new Set([
  'ls', 'll', 'la', 'eza', 'exa', 'tree', 'pwd', 'cd', 'pushd', 'popd', 'echo', 'printf', 'true', 'false', 'test', '[', '[[',
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'sort', 'uniq', 'cut', 'tr', 'column', 'awk', 'rg', 'grep', 'egrep',
  'fgrep', 'ag', 'file', 'stat', 'du', 'df', 'which', 'where', 'type', 'date', 'whoami', 'id', 'hostname', 'uname', 'printenv',
  'sleep', 'wait', 'jq', 'yq', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'ps', 'man', 'for', 'case', 'fi',
  'done', 'esac', '}',
])
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'grep', 'describe', 'reflog',
  'shortlog', 'cat-file', 'merge-base', 'check-ignore', 'version', 'help',
])
const READ_ONLY_FW = new Set(['read', 'search', 'rules'])
const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/

const writesByRedirect = (words: readonly Word[]): boolean =>
  words.some((word, i) => {
    if (!word.isPlain || !word.text.includes('>')) return false
    const target = word.text.slice(word.text.lastIndexOf('>') + 1) || words[i + 1]?.text || ''
    return target !== '/dev/null' && !/^&\d$/.test(target)
  })

const gitSubcommand = (args: readonly Word[]): string => {
  let i = 0
  while (args[i]?.text.startsWith('-')) i += /^-[Cc]$/.test(args[i]?.text ?? '') ? 2 : 1
  return args[i]?.text ?? ''
}

/** False for commands known only to look. Anything unknown may have changed files. */
export const shellMayWrite = (command: string): boolean =>
  splitShell(dropHeredocs(command)).some(segment => {
    const words = commandWords(segment)
    const first = basename(words[0]?.text ?? '')
    const rest = words.slice(1)
    if (!first) return false
    if (writesByRedirect(words)) return true
    if (first === 'git') return !READ_ONLY_GIT.has(gitSubcommand(rest))
    if (first === 'fw') return !READ_ONLY_FW.has(rest[0]?.text ?? '')
    if (first === 'sed') return rest.some(isInPlaceFlag)
    if (first === 'find' || first === 'fd') return rest.some(word => FIND_WRITES.test(word.text))
    return !READ_ONLY_SHELL.has(first)
  })

export const planOfTool = (tool: string, input: Record<string, unknown>, cwd: string, home = ''): Planned => {
  const absolute = (paths: readonly string[]): string[] =>
    [...new Set(paths.filter(Boolean).map(path => resolvePath(cwd, path, home)))].slice(0, MAX_NAMED_PATHS)

  if (input.dry_run === true || input.dryRun === true) return NOTHING
  if (tool === 'Read') return { ...NOTHING, reads: absolute(stringsOf(input.file_path)) }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return { ...NOTHING, writes: absolute(stringsOf(input.file_path)) }
  if (tool === 'NotebookEdit') return { ...NOTHING, writes: absolute(stringsOf(input.notebook_path)) }
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (typeof input.command !== 'string') return { ...NOTHING, mayWrite: true }
    return { reads: shellReads(input.command, cwd, home), writes: [], mayWrite: shellMayWrite(input.command) }
  }
  if (!tool.startsWith('mcp__')) return NOTHING

  const name = tool.slice(tool.lastIndexOf('__') + 2)
  const named = absolute([
    ...PATH_KEYS.flatMap(key => stringsOf(input[key])),
    ...LOOSE_PATH_KEYS.flatMap(key => stringsOf(input[key]).filter(looksLikePath)),
    ...scriptFiles(input.script),
  ])
  if (named.length === 0) return NOTHING
  // A write first: `find_and_replace` is a write that also says find.
  if (WRITE_TOOL.test(name)) return { reads: [], writes: named, mayWrite: true }
  if (SEARCH_TOOL.test(name)) return NOTHING
  if (READ_TOOL.test(name)) return { ...NOTHING, reads: named }
  return { ...NOTHING, mayWrite: true }
}

// Claude's record -------------------------------------------------------------

export const applyTouches = (
  list: readonly Touch[],
  paths: readonly string[],
  action: TouchKind,
  at: number,
  turn: number,
): Touch[] => {
  if (paths.length === 0) return [...list]
  const named = new Set(paths)
  const earlier = new Map(list.map(touch => [touch.path, touch]))
  // `paths` run oldest to newest, the record newest first.
  const fresh = [...named].reverse().map((path): Touch => {
    const old = earlier.get(path)
    return {
      path,
      kind: action === 'read' ? (old?.kind ?? 'read') : action,
      lastAction: action,
      // A read does not undo what this same turn did to the file.
      turnAction: action === 'read' && old?.turn === turn ? old.turnAction : action,
      lastAt: at,
      turn,
      liveUntil: at + FLASH_MS,
    }
  })
  return [...fresh, ...list.filter(touch => !named.has(touch.path))].slice(0, MAX_TOUCHES)
}

export const appendTrail = (activity: Activity, action: TouchKind, count: number): Activity => {
  const earlier = activity.trailTurn === activity.turn ? activity.trail : []
  const added = Array.from({ length: Math.min(count, MAX_TRAIL) }, () => action)
  return { ...activity, trail: [...earlier, ...added].slice(-MAX_TRAIL), trailTurn: activity.turn }
}

/** Files that changed during a shell or MCP call and were not already written down, oldest first. */
export const pickChanged = (
  candidates: readonly { path: string; mtimeMs: number }[],
  since: number,
  touches: readonly Touch[],
): string[] => {
  // File times can be a second coarse.
  const from = since - 1000
  const recorded = new Set(touches.filter(t => t.kind !== 'read' && t.lastAt >= from).map(t => t.path))
  return candidates
    .filter(c => c.mtimeMs >= from && !recorded.has(c.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_ATTRIBUTED)
    .reverse()
    .map(c => c.path)
}

export const workingKinds = (activity: Activity): Map<string, TouchKind> => {
  const kinds = new Map<string, TouchKind>()
  for (const work of activity.working) {
    for (const path of work.paths) {
      if (kinds.get(path) !== 'edited') kinds.set(path, work.kind)
    }
  }
  return kinds
}

export type Summary = {
  status: 'READY' | 'WORKING' | 'READING' | 'EDITING' | 'DONE'
  title: string
  path: string
  tone: TouchKind | null
  barLabel: string
}

const plural = (count: number): string => `${count} file${count === 1 ? '' : 's'}`

export const summaryOf = (touches: readonly Touch[], activity: Activity): Summary => {
  const current = activity.working.find(w => w.kind === 'edited') ?? activity.working[0]
  const turn = activity.isWorking ? activity.turn : (touches[0]?.turn ?? activity.turn)
  const inTurn = touches.filter(touch => touch.turn === turn)
  const count = (kind: TouchKind): number => inTurn.filter(touch => touch.turnAction === kind).length
  const [read, edited, committed] = [count('read'), count('edited'), count('committed')]
  const top: TouchKind | null = committed ? 'committed' : edited ? 'edited' : read ? 'read' : null
  const latest = inTurn.find(touch => touch.turnAction !== 'read') ?? inTurn[0]
  const barLabel = [
    committed ? `${committed} committed` : '',
    edited ? `${edited} edited` : '',
    read ? `${read} read` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  if (current) {
    const path = current.paths[0] ?? ''
    const verb = current.kind === 'edited' ? 'editing' : 'reading'
    const more = current.paths.length > 1 ? ` +${current.paths.length - 1}` : ''
    return {
      status: current.kind === 'edited' ? 'EDITING' : 'READING',
      title: `Claude is ${verb} ${basename(path)}${more}`,
      path,
      tone: current.kind,
      barLabel,
    }
  }
  const title = committed
    ? `Claude committed ${plural(committed)}`
    : edited
      ? `Claude edited ${plural(edited)}`
      : read
        ? `Claude read ${plural(read)}`
        : activity.isWorking
          ? 'Claude is working'
          : 'Nothing touched yet'
  const status = activity.isWorking ? 'WORKING' : inTurn.length ? 'DONE' : 'READY'
  return { status, title, path: latest?.path ?? '', tone: top, barLabel }
}

// Git --------------------------------------------------------------------------

export const NO_GIT: GitView = {
  root: '',
  isRepo: false,
  top: '',
  prefix: '',
  gitDir: '',
  stamp: '',
  branch: '',
  ahead: 0,
  behind: 0,
  head: '',
  changes: {},
  changedTotal: 0,
  ignored: [],
  added: 0,
  removed: 0,
  isCountPartial: false,
}

/** Maps a path git printed from the top of the repository to the tree's own spelling. */
export const pathMapper =
  (root: string, top: string, prefix: string) =>
  (relative: string): string =>
    prefix && relative.startsWith(prefix)
      ? join(root, relative.slice(prefix.length))
      : prefix
        ? join(top, relative)
        : join(root, relative)

export type ParsedStatus = Pick<GitView, 'branch' | 'ahead' | 'behind' | 'changes' | 'changedTotal' | 'ignored'>

export const parseBranch = (record: string): Pick<GitView, 'branch' | 'ahead' | 'behind'> => {
  const body = record.replace(/^## /, '')
  if (body.startsWith('HEAD (no branch)')) return { branch: 'detached', ahead: 0, behind: 0 }
  return {
    branch: /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/.exec(body)?.[1] ?? body,
    ahead: Number(/ahead (\d+)/.exec(body)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(body)?.[1] ?? 0),
  }
}

export const parseStatus = (stdout: string, toPath: (relative: string) => string): ParsedStatus => {
  const records = stdout.split('\0')
  let branch: Pick<GitView, 'branch' | 'ahead' | 'behind'> = { branch: '', ahead: 0, behind: 0 }
  const changes: Record<string, Change> = {}
  let changedTotal = 0
  const ignored: string[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? ''
    if (!record) continue
    if (record.startsWith('## ')) {
      branch = parseBranch(record)
      continue
    }
    const code = record.slice(0, 2)
    const relative = record.slice(3)
    // A rename or copy has its old name as the next record.
    if (code.includes('R') || code.includes('C')) i++
    if (code === '!!') ignored.push(toPath(relative.replace(/\/$/, '')))
    else if (!relative.endsWith('/')) {
      changedTotal++
      if (changedTotal <= MAX_CHANGES) changes[toPath(relative)] = { code: code === '??' ? '?' : (code.trim()[0] ?? 'M'), added: 0, removed: 0 }
    }
  }
  return { ...branch, changes, changedTotal, ignored }
}

export type ReflogEntry = { sha: string; action: string }

export const parseReflog = (stdout: string): ReflogEntry[] =>
  stdout.split('\n').flatMap(line => {
    const cut = line.indexOf('\0')
    return cut > 0 ? [{ sha: line.slice(0, cut), action: line.slice(cut + 1) }] : []
  })

/** The commits made since `before`: a checkout, pull, reset or rebase moves HEAD and is none. */
export const commitsSince = (entries: readonly ReflogEntry[], before: string): string[] => {
  const found: string[] = []
  for (const entry of entries) {
    if (before && entry.sha.startsWith(before)) break
    if (/^commit( \(|:)/.test(entry.action)) found.push(entry.sha)
  }
  return found
}

const GIT_SCALARS = [
  'root', 'isRepo', 'top', 'prefix', 'gitDir', 'stamp', 'branch', 'ahead', 'behind', 'head', 'changedTotal', 'added', 'removed', 'isCountPartial',
] as const

export const sameGitView = (a: GitView, b: GitView): boolean => {
  if (GIT_SCALARS.some(key => a[key] !== b[key])) return false
  if (a.ignored.length !== b.ignored.length || a.ignored.some((path, i) => path !== b.ignored[i])) return false
  const paths = Object.keys(a.changes)
  if (paths.length !== Object.keys(b.changes).length) return false
  return paths.every(path => {
    const one = a.changes[path]
    const other = b.changes[path]
    return one && other && one.code === other.code && one.added === other.added && one.removed === other.removed
  })
}

export const parseNumstat = (stdout: string, toPath: (relative: string) => string): Map<string, [number, number]> => {
  const counts = new Map<string, [number, number]>()
  for (const record of stdout.split('\0')) {
    const [added, removed, ...name] = record.split('\t')
    if (added === undefined || removed === undefined || name.length === 0) continue
    counts.set(toPath(name.join('\t')), [Number(added) || 0, Number(removed) || 0])
  }
  return counts
}

export const parseNames = (stdout: string, toPath: (relative: string) => string): string[] =>
  stdout.split('\0').filter(Boolean).map(toPath)

export const countLines = (text: string): number => {
  if (text.length === 0) return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

// The tree ----------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export const listingOf = (raw: readonly Entry[]): Listing => ({
  entries: [...raw]
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name))
    .slice(0, MAX_ENTRIES),
  total: raw.length,
})

const sameEntry = (a: Entry, b: Entry): boolean =>
  a.name === b.name && a.isDir === b.isDir && a.isLink === b.isLink && a.size === b.size && a.mtimeMs === b.mtimeMs

export const sameListing = (a: Listing | undefined, b: Listing | undefined): boolean => {
  if (a === b) return true
  if (!a || !b || a.total !== b.total || a.entries.length !== b.entries.length) return false
  return a.entries.every((entry, i) => {
    const other = b.entries[i]
    return other !== undefined && sameEntry(entry, other)
  })
}

/** Open folders the tree can actually show: every folder above them is open too. */
export const visibleFolders = (layout: Layout): string[] => {
  const open = new Set(layout.expanded)
  return layout.expanded.filter(
    dir => dir !== layout.root && isInside(layout.root, dir) && foldersBetween(layout.root, dir).every(parent => open.has(parent)),
  )
}

export type TreeRow = {
  path: string
  name: string
  depth: number
  isDir: boolean
  isOpen: boolean
  isLink: boolean
  isHidden: boolean
  isIgnored: boolean
  size: number
  mtimeMs: number
  /** Set on the closing row of a folder cut short: how many more it holds. */
  more: number
}

export const buildRows = (
  layout: Layout,
  listings: Readonly<Record<string, Listing>>,
  ignored: ReadonlySet<string>,
): TreeRow[] => {
  const open = new Set(layout.expanded)
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number, isParentIgnored: boolean): void => {
    const listing = listings[dir]
    if (!listing) return
    for (const entry of listing.entries) {
      if (rows.length >= MAX_ROWS) return
      if (!layout.showHidden && entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const isIgnored = isParentIgnored || ignored.has(path)
      // Open with nothing read yet draws as closed, rather than open and empty.
      const isOpen = entry.isDir && open.has(path) && listings[path] !== undefined
      rows.push({ ...entry, path, depth, isOpen, isIgnored, isHidden: entry.name.startsWith('.'), more: 0 })
      if (isOpen) walk(path, depth + 1, isIgnored)
    }
    if (listing.total > listing.entries.length && rows.length < MAX_ROWS) {
      rows.push({
        path: join(dir, '…more'),
        name: '',
        depth,
        isDir: false,
        isOpen: false,
        isLink: false,
        isHidden: false,
        isIgnored: false,
        size: 0,
        mtimeMs: 0,
        more: listing.total - listing.entries.length,
      })
    }
  }
  walk(layout.root, 0, false)
  return rows
}

type TouchedFolder = { folders: Map<string, TouchedFolder>; files: string[] }

/**
 * The tree cut down to these files, so a long session still fits on a screen.
 * Folders stand open unless folded by hand, and one holding nothing but a single
 * folder shares that folder's row. Files outside `root` have no place here.
 */
export const buildTouchedRows = (
  root: string,
  paths: Iterable<string>,
  folded: ReadonlySet<string>,
  ignored: ReadonlySet<string>,
): TreeRow[] => {
  const top: TouchedFolder = { folders: new Map(), files: [] }
  for (const path of new Set(paths)) {
    if (path === root || !isInside(root, path)) continue
    const parts = shownPath(root, path).split('/')
    const file = parts.pop() ?? ''
    let folder = top
    for (const part of parts) {
      let next = folder.folders.get(part)
      if (!next) {
        next = { folders: new Map(), files: [] }
        folder.folders.set(part, next)
      }
      folder = next
    }
    folder.files.push(file)
  }

  const rowOf = (path: string, name: string, depth: number, isDir: boolean, isOpen: boolean, isIgnored: boolean): TreeRow => ({
    path,
    name,
    depth,
    isDir,
    isOpen,
    isIgnored,
    isLink: false,
    isHidden: name.startsWith('.'),
    size: 0,
    mtimeMs: 0,
    more: 0,
  })

  const rows: TreeRow[] = []
  const walk = (folder: TouchedFolder, dir: string, depth: number, isParentIgnored: boolean): void => {
    for (const [name, child] of [...folder.folders].sort(([a], [b]) => collator.compare(a, b))) {
      let shown = name
      let path = join(dir, name)
      let inner = child
      let isIgnored = isParentIgnored || ignored.has(path)
      while (inner.files.length === 0 && inner.folders.size === 1 && !folded.has(path)) {
        const [only] = inner.folders
        if (!only) break
        shown = `${shown}/${only[0]}`
        path = join(path, only[0])
        inner = only[1]
        isIgnored ||= ignored.has(path)
      }
      const isOpen = !folded.has(path)
      rows.push(rowOf(path, shown, depth, true, isOpen, isIgnored))
      if (isOpen) walk(inner, path, depth + 1, isIgnored)
    }
    for (const name of [...folder.files].sort(collator.compare)) {
      // A file since replaced by a folder of that name: the folder's row stands for it.
      if (folder.folders.has(name)) continue
      const path = join(dir, name)
      rows.push(rowOf(path, name, depth, false, false, isParentIgnored || ignored.has(path)))
    }
  }
  walk(top, root, 0, false)
  return rows
}

export type FolderMark = TouchKind | 'changed'

const MARK_RANK: Record<FolderMark, number> = { read: 1, changed: 2, committed: 3, edited: 4 }

/** What the files under each folder have been through: its name takes that color. */
export const folderMarks = (
  root: string,
  touches: readonly Touch[],
  changes: Readonly<Record<string, Change>>,
): Map<string, FolderMark> => {
  const marks = new Map<string, FolderMark>()
  const mark = (path: string, value: FolderMark): void => {
    for (const dir of foldersBetween(root, path)) {
      const held = marks.get(dir)
      if (!held || MARK_RANK[value] > MARK_RANK[held]) marks.set(dir, value)
    }
  }
  for (const path of Object.keys(changes)) mark(path, 'changed')
  for (const touch of touches) mark(touch.path, touch.kind)
  return marks
}

const NEVER_OPENED = /(^|\/)(\.git|node_modules)(\/|$)/

/** The closed folders to open so these files show. Unless asked, ignored folders stay shut. */
export const foldersToOpen = (layout: Layout, paths: readonly string[], ignored: ReadonlySet<string>, isAsked = false): string[] => {
  const open = new Set(layout.expanded)
  const opening = new Set<string>()
  for (const path of paths) {
    if (!isInside(layout.root, path)) continue
    if (!isAsked && NEVER_OPENED.test(shownPath(layout.root, path))) continue
    const folders = foldersBetween(layout.root, path)
    if (!isAsked && folders.some(dir => ignored.has(dir))) continue
    for (const dir of folders) if (!open.has(dir)) opening.add(dir)
  }
  return [...opening]
}

/** A changed setting decides the view; an unchanged one leaves the person's own choice alone. */
export const withTreeSetting = (layout: Layout, treeView: TreeView): Layout =>
  layout.treeView === treeView ? layout : { ...layout, treeView, touchedOnly: treeView === 'touched' }

/** The person is using this file or folder: what holds it stops closing by itself. */
export const withPinned = (layout: Layout, path: string): Layout => ({
  ...layout,
  autoOpened: Object.fromEntries(Object.entries(layout.autoOpened).filter(([dir]) => !isInside(dir, path))),
})

/** Folders opened for Claude that have gone quiet and hold nothing it changed. */
export const foldersToClose = (layout: Layout, touches: readonly Touch[], at: number): string[] =>
  Object.entries(layout.autoOpened).flatMap(([dir, openedAt]) => {
    const inside = touches.filter(touch => isInside(dir, touch.path))
    if (inside.some(touch => touch.kind !== 'read' || touch.liveUntil > at)) return []
    const quietSince = Math.max(openedAt, ...inside.map(touch => touch.lastAt))
    return at - quietSince >= AUTO_CLOSE_MS ? [dir] : []
  })

/** Closes the folders, forgetting any that were opened for Claude. */
export const withClosed = (layout: Layout, dirs: readonly string[]): Layout => {
  const gone = new Set(dirs)
  return {
    ...layout,
    expanded: layout.expanded.filter(dir => !gone.has(dir)),
    autoOpened: Object.fromEntries(Object.entries(layout.autoOpened).filter(([dir]) => !gone.has(dir))),
  }
}

export const findFiles = (paths: readonly string[], query: string, limit = MAX_FOUND): string[] => {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const isSubsequence = (text: string): boolean => {
    let at = 0
    for (const ch of text) if (ch === needle[at]) at++
    return at === needle.length
  }
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const name = basename(lower)
    const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : isSubsequence(lower) ? 3 : -1
    if (score >= 0) scored.push({ path, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || collator.compare(a.path, b.path))
    .slice(0, limit)
    .map(found => found.path)
}

// Picture icons ------------------------------------------------------------------

/** Names to icons, in lower case and in Maps: a file called `constructor` must find nothing. */
export type IconMap = {
  file: string
  folder: string
  folderOpen: string
  fileNames: ReadonlyMap<string, string>
  extensions: ReadonlyMap<string, string>
  folderNames: ReadonlyMap<string, string>
}

const stringMap = (value: unknown): Map<string, string> =>
  new Map(
    Object.entries(value && typeof value === 'object' ? value : {}).flatMap(([key, icon]): [string, string][] =>
      typeof icon === 'string' ? [[key.toLowerCase(), icon]] : [],
    ),
  )

export const parseIconMap = (text: string): IconMap | null => {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const { file, folder, folderOpen } = raw
    if (typeof file !== 'string' || typeof folder !== 'string' || typeof folderOpen !== 'string') return null
    return {
      file,
      folder,
      folderOpen,
      fileNames: stringMap(raw.fileNames),
      extensions: stringMap(raw.extensions),
      folderNames: stringMap(raw.folderNames),
    }
  } catch {
    return null
  }
}

/** With its folder, then the whole name, then the longest extension: `a.test.ts` is `test.ts`, then `ts`. */
export const iconOf = (map: IconMap, path: string, isDir: boolean, isOpen: boolean): string => {
  const lower = basename(path).toLowerCase()
  const nested = `${basename(dirname(path)).toLowerCase()}/${lower}`
  if (isDir) {
    const icon = map.folderNames.get(nested) ?? map.folderNames.get(lower)
    if (icon) return isOpen ? `${icon}-open` : icon
    return isOpen ? map.folderOpen : map.folder
  }
  const exact = map.fileNames.get(nested) ?? map.fileNames.get(lower)
  if (exact) return exact
  for (let dot = lower.indexOf('.'); dot !== -1; dot = lower.indexOf('.', dot + 1)) {
    const icon = map.extensions.get(lower.slice(dot + 1))
    if (icon) return icon
  }
  return map.file
}

export type ImagePlan = {
  /** A file the terminal opens itself, or the picture's bytes sent through it. */
  via: 'file' | 'bytes'
  /** iTerm2 draws pictures only under the fullscreen renderer. */
  needsFullscreen: boolean
}

/** What tmux is asked, for `tmuxPlanOf` to read. */
export const TMUX_IMAGE_QUESTION = '#{client_termtype}\t#{allow-passthrough}\t#{focus-events}'

const isAtLeast = (version: RegExpExecArray, major: number, minor: number): boolean => {
  const [, first = '0', second = '0'] = version
  return Number(first) > major || (Number(first) === major && Number(second) >= minor)
}

/** Reads tmux's answer on the terms the engine draws pictures there. */
export const tmuxPlanOf = (answer: string): ImagePlan | null => {
  const [termtype = '', passthrough = '', focusEvents = ''] = answer.replace(/\r?\n$/, '').split('\t')
  const isOn = passthrough === 'on' || passthrough === '1'
  if ((!isOn && passthrough !== 'all') || focusEvents !== '1') return null
  const kitty = /^kitty\((\d+)\.(\d+)/.exec(termtype)
  if (/^(ghostty|kitty)( |$)/.test(termtype) || (kitty && isAtLeast(kitty, 0, 28))) return { via: 'bytes', needsFullscreen: false }
  const iterm = /^iTerm2\s+(\d+)\.(\d+)/.exec(termtype)
  return isOn && iterm && isAtLeast(iterm, 3, 5) ? { via: 'bytes', needsFullscreen: true } : null
}

/** Whether this terminal can draw pictures, and how. Null means the chips. */
export const imagePlanOf = (
  setting: unknown,
  env: Readonly<Record<string, string | undefined>>,
  tmuxAnswer?: string,
): ImagePlan | null => {
  if (setting === 'chips') return null
  // herdr lands on this too: it answers the engine as `libghostty`, which the engine
  // does not count as able to draw, so pictures there wait for the engine's own override.
  const isForced = setting === 'images' || /^(1|true|yes|on)$/i.test(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES ?? '')
  const forced: ImagePlan | null = isForced ? { via: 'bytes', needsFullscreen: false } : null
  // Told to try regardless, tmux's answer has no say; and it cannot speak for a multiplexer around it.
  if (!forced && env.TMUX && !env.ZELLIJ && !env.STY && tmuxAnswer !== undefined) return tmuxPlanOf(tmuxAnswer)
  // Between here and the terminal, only bytes can pass, and only if it was set up to let them.
  if (env.SSH_CONNECTION || env.SSH_TTY || env.TMUX || env.ZELLIJ || env.STY) return forced

  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  const term = env.TERM ?? ''
  if (program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || (program === '' && env.KITTY_WINDOW_ID)) {
    return { via: 'file', needsFullscreen: false }
  }
  if (program === 'iterm.app') {
    const [major = 0, minor = 0] = (env.TERM_PROGRAM_VERSION ?? '').split('.').map(Number)
    return major > 3 || (major === 3 && minor >= 5) ? { via: 'bytes', needsFullscreen: true } : forced
  }
  return forced
}

// Words on the row ---------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const formatWhen = (ms: number, now: number): string => {
  if (!ms) return ''
  const date = new Date(ms)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (date.getFullYear() === today.getFullYear()) return `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return String(date.getFullYear())
}

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['K', 'M', 'G', 'T']
  let value = bytes
  let unit = -1
  // 1023.5 and up would round to `1024`, which reads better as the next unit.
  while (value >= 1023.5 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
