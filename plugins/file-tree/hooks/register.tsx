import { atom, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, Register, RenderElement } from 'claude-code'

import type { Activity, Change, Entry, GitView, Layout, Listing, Touch, TouchKind } from '../types'
import {
  BOT_COLUMNS,
  BOT_ROWS,
  GLYPHS,
  KIND_COLORS,
  chipOf,
  drawActivityBar,
  drawBot,
  hex,
  pulse,
  shimmerColors,
  tintOf,
  trailText,
} from './art'
import type { Glyphs } from './art'
import type { HitAction, HitProps } from './hit'
import {
  NO_GIT,
  appendTrail,
  applyTouches,
  basename,
  buildRows,
  cellWidth,
  clip,
  commitsSince,
  countLines,
  dirname,
  findFiles,
  folderMarks,
  foldersToClose,
  foldersToOpen,
  formatSize,
  formatWhen,
  iconOf,
  imagePlanOf,
  isInside,
  isTopFolder,
  join,
  listingOf,
  mentionPath,
  parseIconMap,
  parseNames,
  parseNumstat,
  parseReflog,
  parseStatus,
  pathMapper,
  pickChanged,
  planOfTool,
  posix,
  sameGitView,
  sameListing,
  shownPath,
  summaryOf,
  visibleFolders,
  withClosed,
  withPinned,
  workingKinds,
} from './model'
import type { IconMap, ImagePlan, Planned, TreeRow } from './model'

const PANE = 'file-tree'
const PANE_TITLE = 'Files'

const TICK_MS = 160
const WORKING_EVERY = 3
const CLOSE_EVERY = 12
const POLL_EVERY = 31
const FULL_SYNC_EVERY = 6
const SCAN_DELAY_MS = 350
const FOLLOW_DELAY_MS = 260
const GIT_TIMEOUT_MS = 6000
const PANE_INSET = 2
const MAX_OPEN_FOLDERS = 200
const MAX_REFLOG = 50
const MAX_COMMITS_READ = 20
const MAX_LINK_STATS = 40
const MAX_DIRTY_STATS = 200
const MAX_UNTRACKED_COUNTED = 30
const MAX_COUNTED_BYTES = 256 * 1024
const MAX_INDEXED = 8000
const MAX_INDEXED_FOLDERS = 400
const INDEX_FRESH_MS = 20_000
const TOUCHED_SHOWN = 6
const TOUCHED_SHOWN_ALL = 60
const WINDOW_FROM = 120
const CHIP_CELLS = 5
// A picture and the blank after it: two cells make it about square.
const PICTURE_COLUMNS = 2
const PICTURE_CELLS = 3
// How every PNG begins, signature and header tag, in base64: the engine checks both.
const PNG_START = 'iVBORw0KGgoAAAANSUhEU'

const ACCENT = '#8f8cf4'
const BLUE = '#6ca6f0'
const ADDED = '#5fbf8f'
const REMOVED = '#e06c75'
const AMBER = '#e5c07b'
const HOVER = '#26263a'

const LABELS: Record<TouchKind, string> = { read: 'read', edited: 'edited', committed: 'committed' }

const initialLayout = (project = ''): Layout => ({
  project,
  root: project,
  expanded: [],
  autoOpened: {},
  query: '',
  showHidden: true,
  showSizes: false,
  showAllTouched: false,
  hasAutoOpened: false,
})

const initialActivity = (): Activity => ({ turn: 0, isWorking: false, working: [], trail: [], trailTurn: 0, commitSha: '' })

// Change a tag when that value's fields change: what an earlier version stored
// outlives a reload, and the tag makes the new code decline it.
const layout = atom({ plugin: 'file-tree', key: 'layout' } as const, initialLayout(), { shape: 'layout-1' })
const listings = atom({ plugin: 'file-tree', key: 'listings' } as const, {}, { shape: 'listings-1' })
const gitView = atom({ plugin: 'file-tree', key: 'git' } as const, NO_GIT, { shape: 'git-2' })
const touches = atom({ plugin: 'file-tree', key: 'touches' } as const, [], { shape: 'touches-2' })
const activity = atom({ plugin: 'file-tree', key: 'activity' } as const, initialActivity(), { shape: 'activity-2' })
const now = atom({ plugin: 'file-tree', key: 'now' } as const, 0)

// A hot reload clears these, and each is only ever a cache or a timer's bookkeeping.
let home = ''
let willAutoOpen = true
let canDock = false
let isWatching = false
let isPanePlaced = false
let isPaneFocused = false
let isScanning = false
let scanAgain = false
let pendingSince: number | null = null
let isScanQueued = false
let gitSync: Promise<void> | null = null
let gitSyncQueued: Promise<void> | null = null
let findIndex: { root: string; paths: string[]; at: number } | null = null
let indexing: { root: string; done: Promise<void> } | null = null
const lineCounts = new Map<string, { mtimeMs: number; lines: number }>()
let iconMap: IconMap | null = null
let imagePlan: ImagePlan | null = null
let iconsDir = ''
const iconBytes = new Map<string, string>()

const rowKey = (path: string): string => `row:${path}`

const quietly = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // The panel can miss a beat; whatever it was watching goes on.
  }
}

// Messages in English, as one of them is read below.
const runGit = ($: EngineInterface, root: string, args: readonly string[]) =>
  $.process.run(['git', '--no-optional-locks', '-C', root, ...args], { timeoutMs: GIT_TIMEOUT_MS, env: { LC_ALL: 'C' } })

/** False when some files had to go uncounted, so the totals are only a floor. */
async function countUntracked($: EngineInterface, changes: Record<string, Change>): Promise<boolean> {
  const untracked = Object.entries(changes).filter(([, change]) => change.code === '?')
  const counted = untracked.slice(0, MAX_UNTRACKED_COUNTED)
  let isComplete = counted.length === untracked.length
  await Promise.all(
    counted.map(async ([path, change]) => {
      try {
        const stat = await $.fs.stat(path)
        if (stat.kind !== 'file') return
        if (stat.size > MAX_COUNTED_BYTES) {
          isComplete = false
          return
        }
        const known = lineCounts.get(path)
        const lines = known?.mtimeMs === stat.mtimeMs ? known.lines : countLines(await $.fs.read(path))
        lineCounts.set(path, { mtimeMs: stat.mtimeMs, lines })
        changes[path] = { ...change, added: lines }
      } catch {
        // Gone already, or not text: it simply shows no count.
      }
    }),
  )
  return isComplete
}

const readGitStamp = async ($: EngineInterface, gitDir: string): Promise<string> => {
  const times = await Promise.all(['index', 'HEAD'].map(name => $.fs.stat(join(gitDir, name)).then(s => s.mtimeMs, () => 0)))
  return times.join(':')
}

/** Null when git could not answer this time: the last answer stands. */
async function readGit($: EngineInterface, root: string): Promise<GitView | null> {
  try {
    const where = await runGit($, root, ['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir'])
    if (where.exitCode !== 0) return /not a git repository/i.test(where.stderr) ? { ...NO_GIT, root } : null
    const [top = '', prefix = '', gitDir = ''] = where.stdout.split('\n')
    // Taken before the status: a commit landing between the two shows up at the next look.
    const stamp = await readGitStamp($, gitDir)
    const toPath = pathMapper(root, top, prefix)
    const [status, numstat, head] = await Promise.all([
      runGit($, root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignored=matching']),
      // Fails in a repository with no commits yet, which leaves the counts at zero.
      runGit($, root, ['diff', '--numstat', '--no-renames', '-z', 'HEAD', '--']),
      runGit($, root, ['log', '-1', '--format=%h']),
    ])
    if (status.exitCode !== 0) return null
    const parsed = parseStatus(status.stdout, toPath)
    const changes = { ...parsed.changes }
    if (numstat.exitCode === 0) {
      for (const [path, [added, removed]] of parseNumstat(numstat.stdout, toPath)) {
        const change = changes[path]
        if (change) changes[path] = { ...change, added, removed }
      }
    }
    const isCounted = await countUntracked($, changes)
    const all = Object.values(changes)
    return {
      ...parsed,
      root,
      isRepo: true,
      top,
      prefix,
      gitDir,
      stamp,
      head: head.exitCode === 0 ? head.stdout.trim() : '',
      changes,
      added: all.reduce((sum, change) => sum + change.added, 0),
      removed: all.reduce((sum, change) => sum + change.removed, 0),
      isCountPartial: !isCounted || parsed.changedTotal > all.length,
    }
  } catch {
    return null
  }
}

async function listFolder($: EngineInterface, dir: string): Promise<Listing | null> {
  try {
    const raw = await $.fs.list(dir)
    let linkStats = 0
    const entries = await Promise.all(
      raw.map(async (entry): Promise<Entry> => {
        const base: Entry = { name: entry.name, isDir: entry.kind === 'dir', isLink: entry.isLink, size: entry.size, mtimeMs: entry.mtimeMs }
        if (!entry.isLink || linkStats >= MAX_LINK_STATS) return base
        linkStats++
        const target = await $.fs.stat(join(dir, entry.name)).catch(() => null)
        return target ? { ...base, isDir: target.kind === 'dir', size: target.size, mtimeMs: target.mtimeMs } : base
      }),
    )
    return listingOf(entries)
  } catch {
    return null
  }
}

/** Says whether anything in the tree changed. */
async function refreshListings($: EngineInterface): Promise<boolean> {
  const asked = await read($, layout)
  if (!asked.root) return false
  const foldersOf = (at: Layout): string[] => [at.root, ...visibleFolders(at).slice(-MAX_OPEN_FOLDERS)]
  const listed = new Map(await Promise.all(foldersOf(asked).map(async dir => [dir, await listFolder($, dir)] as const)))
  // The person may have opened or closed something meanwhile: what is wanted now decides.
  const wanted = foldersOf(await read($, layout))
  let didChange = false
  await update($, listings, prev => {
    const fresh: Record<string, Listing> = {}
    let isSame = Object.keys(prev).length === wanted.length
    for (const dir of wanted) {
      const kept = listed.get(dir) ?? prev[dir]
      if (kept) fresh[dir] = kept
      if (!sameListing(kept, prev[dir])) isSame = false
    }
    didChange = !isSame
    return isSame ? prev : fresh
  })
  return didChange
}

async function followCwd($: EngineInterface): Promise<void> {
  const cwd = posix(await $.session.cwd())
  await update($, layout, prev => {
    // A `cd` into a subfolder moves Claude, not the project this tree is showing.
    if (isInside(prev.project, cwd)) return prev
    return prev.root === prev.project
      ? { ...prev, project: cwd, root: cwd, expanded: [], autoOpened: {}, query: '' }
      : { ...prev, project: cwd }
  })
}

async function noteCommits($: EngineInterface, root: string, before: GitView, view: GitView): Promise<void> {
  const log = await runGit($, root, ['reflog', '-n', String(MAX_REFLOG), '--format=%H%x00%gs', 'HEAD']).catch(() => null)
  if (log?.exitCode !== 0) return
  const commits = commitsSince(parseReflog(log.stdout), before.head)
  if (commits.length === 0) return // HEAD moved some other way: a checkout, pull, reset or rebase.
  const shown = await runGit($, root, ['show', '--name-only', '--no-renames', '-z', '--format=', ...commits.slice(0, MAX_COMMITS_READ)]).catch(() => null)
  if (shown?.exitCode !== 0) return
  const inCommits = new Set(parseNames(shown.stdout, pathMapper(root, view.top, view.prefix)))
  const edited = (await read($, touches)).filter(touch => touch.kind === 'edited' && inCommits.has(touch.path)).map(touch => touch.path)
  if (edited.length === 0) return // Someone else's commit, of nothing Claude changed.
  const at = await $.clock.now()
  const act = await update($, activity, prev => ({ ...appendTrail(prev, 'committed', edited.length), commitSha: view.head }))
  await update($, touches, list => applyTouches(list, edited, 'committed', at, act.turn))
  await update($, now, () => at)
}

async function readAndNoteGit($: EngineInterface): Promise<void> {
  const { root } = await read($, layout)
  if (!root) return
  const view = await readGit($, root)
  // A slow answer for a folder the tree has since left is no use.
  if (!view || (await read($, layout)).root !== root) return
  const before = await read($, gitView)
  await update($, gitView, prev => (sameGitView(prev, view) ? prev : view))
  if (before.root === root && view.head && before.head !== view.head) await noteCommits($, root, before, view)
}

/** One look at a time, and at most one more waiting behind it. */
function syncGit($: EngineInterface): Promise<void> {
  if (!gitSync) {
    gitSync = quietly(() => readAndNoteGit($)).finally(() => {
      gitSync = null
    })
    return gitSync
  }
  gitSyncQueued ??= gitSync.then(() => {
    gitSyncQueued = null
    return syncGit($)
  })
  return gitSyncQueued
}

/** Files a shell or MCP call changed without naming them, found by their dates. */
async function attributeChanges($: EngineInterface, since: number): Promise<void> {
  const view = await read($, gitView)
  let candidates: { path: string; mtimeMs: number }[] = []
  if (view.isRepo) {
    const dirty = Object.entries(view.changes)
      .filter(([, change]) => change.code !== 'D')
      .slice(0, MAX_DIRTY_STATS)
      .map(([path]) => path)
    const stats = await Promise.all(
      dirty.map(path => $.fs.stat(path).then(stat => (stat.kind === 'file' ? { path, mtimeMs: stat.mtimeMs } : null), () => null)),
    )
    candidates = stats.filter(stat => stat !== null)
  } else {
    for (const [dir, listing] of Object.entries(await read($, listings))) {
      for (const entry of listing.entries) if (!entry.isDir) candidates.push({ path: join(dir, entry.name), mtimeMs: entry.mtimeMs })
    }
  }
  await record($, pickChanged(candidates, since, await read($, touches)), 'edited')
}

const checkPane = async ($: EngineInterface): Promise<boolean> => {
  isPanePlaced = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  return isPanePlaced
}

async function runScan($: EngineInterface): Promise<void> {
  if (isScanning) {
    scanAgain = true
    return
  }
  isScanning = true
  const since = pendingSince
  try {
    // With no panel to draw the work waits, and keeps its window for when one opens.
    if (!(await checkPane($))) return
    pendingSince = null
    await followCwd($)
    await refreshListings($)
    await syncGit($)
    if (since !== null) await attributeChanges($, since)
  } catch {
    if (since !== null) pendingSince = pendingSince === null ? since : Math.min(pendingSince, since)
  } finally {
    isScanning = false
    if (scanAgain) {
      scanAgain = false
      scheduleScan($, null)
    }
  }
}

function scheduleScan($: EngineInterface, since: number | null): void {
  if (since !== null) pendingSince = pendingSince === null ? since : Math.min(pendingSince, since)
  if (isScanQueued) return
  isScanQueued = true
  $.clock.after(SCAN_DELAY_MS, () => {
    isScanQueued = false
    void runScan($).catch(() => undefined)
  })
}

const followRow = ($: EngineInterface, path: string): void => {
  if (isPaneFocused) return
  $.clock.after(FOLLOW_DELAY_MS, () => {
    void $.ui.scroll({ in: PANE, to: { key: rowKey(path) } }).catch(() => undefined)
  })
}

/** `autoAt` is when, for folders opened to show Claude's work; null when the person asked. */
async function openFoldersFor($: EngineInterface, paths: readonly string[], autoAt: number | null): Promise<void> {
  const current = await read($, layout)
  const ignored = new Set((await read($, gitView)).ignored)
  const opening = foldersToOpen(current, paths, ignored, autoAt === null)
  if (opening.length === 0) return
  await update($, layout, prev => ({
    ...prev,
    expanded: [...new Set([...prev.expanded, ...opening])],
    autoOpened: autoAt === null ? prev.autoOpened : { ...prev.autoOpened, ...Object.fromEntries(opening.map(dir => [dir, autoAt])) },
  }))
  if (isPanePlaced) await refreshListings($)
}

// Unasked, the panel only opens where it docks beside the chat: above the prompt it would push the chat away.
async function maybeAutoOpen($: EngineInterface): Promise<void> {
  if (!willAutoOpen || !canDock || (await read($, layout)).hasAutoOpened) return
  await update($, layout, prev => ({ ...prev, hasAutoOpened: true }))
  await quietly(async () => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    void quietly(() => runScan($))
  })
}

/** `paths` run oldest to newest. */
async function record($: EngineInterface, paths: readonly string[], action: TouchKind): Promise<void> {
  if (paths.length === 0) return
  const at = await $.clock.now()
  const act = await update($, activity, prev => appendTrail(prev, action, paths.length))
  await update($, touches, list => applyTouches(list, paths, action, at, act.turn))
  await update($, now, () => at)
  await openFoldersFor($, paths, at)
  const newest = paths[paths.length - 1]
  if (action !== 'read' && newest) {
    await maybeAutoOpen($)
    followRow($, newest)
  }
}

const onlyFiles = async ($: EngineInterface, paths: readonly string[]): Promise<string[]> => {
  const kept = await Promise.all(paths.map(path => $.fs.stat(path).then(stat => (stat.kind === 'file' ? path : ''), () => '')))
  return kept.filter(Boolean)
}

async function recordPlanned($: EngineInterface, plan: Planned): Promise<void> {
  await record($, await onlyFiles($, plan.writes), 'edited')
  await record($, await onlyFiles($, plan.reads), 'read')
}

async function buildIndex($: EngineInterface, root: string, isRepo: boolean): Promise<string[]> {
  if (isRepo) {
    const listed = await runGit($, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => null)
    if (listed?.exitCode === 0) return parseNames(listed.stdout, relative => join(root, relative)).slice(0, MAX_INDEXED)
  }
  const found: string[] = []
  const queue = [root]
  for (let i = 0; i < queue.length && i < MAX_INDEXED_FOLDERS && found.length < MAX_INDEXED; i++) {
    const dir = queue[i] ?? root
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.kind === 'dir') queue.push(path)
      else found.push(path)
    }
  }
  return found
}

async function ensureIndex($: EngineInterface): Promise<void> {
  const { root } = await read($, layout)
  const at = await $.clock.now()
  if (findIndex?.root === root && at - findIndex.at < INDEX_FRESH_MS) return
  if (indexing?.root === root) return indexing.done
  const build = async (): Promise<void> => {
    const { isRepo } = await read($, gitView)
    const paths = await buildIndex($, root, isRepo)
    if ((await read($, layout)).root !== root) return
    findIndex = { root, paths, at }
    await update($, now, () => at)
  }
  const running = {
    root,
    done: build().finally(() => {
      if (indexing === running) indexing = null
    }),
  }
  indexing = running
  return running.done
}

async function poll($: EngineInterface, isFull: boolean): Promise<void> {
  if (!(await checkPane($))) return
  const didChange = await refreshListings($)
  const view = await read($, gitView)
  const stamp = view.isRepo ? await readGitStamp($, view.gitDir) : ''
  if (isFull || didChange || stamp !== view.stamp) await syncGit($)
}

async function loadIcons($: EngineInterface, setting: unknown): Promise<void> {
  // Each name written out: the engine lists what a mod reads from the source.
  imagePlan = imagePlanOf(setting, {
    TERM: await $.env.get('TERM'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    TERM_PROGRAM_VERSION: await $.env.get('TERM_PROGRAM_VERSION'),
    TMUX: await $.env.get('TMUX'),
    SSH_CONNECTION: await $.env.get('SSH_CONNECTION'),
    SSH_TTY: await $.env.get('SSH_TTY'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    ZELLIJ: await $.env.get('ZELLIJ'),
    STY: await $.env.get('STY'),
  })
  if (!imagePlan) return
  iconsDir = `${$.plugin.root}/assets/icons`
  iconMap = parseIconMap(await $.fs.read(`${iconsDir}/map.json`))
  const at = await $.clock.now()
  await update($, now, () => at)
}

async function loadIconBytes($: EngineInterface, icons: ReadonlySet<string>): Promise<void> {
  await Promise.all(
    [...icons]
      .filter(icon => !iconBytes.has(icon))
      .map(icon =>
        quietly(async () => {
          const { base64 } = await $.fs.read(`${iconsDir}/${icon}.png`, { as: 'bytes' })
          // The engine refuses a whole drawing over one bad picture; a damaged icon costs only its row.
          if (base64.startsWith(PNG_START)) iconBytes.set(icon, base64)
        }),
      ),
  )
}

/** Null when the bytes are not to hand: that row keeps its chip. */
const iconSource = (plan: ImagePlan, icon: string): ImageSource | null => {
  if (plan.via === 'file') return { file: `${iconsDir}/${icon}.png`, format: 'png' }
  const png = iconBytes.get(icon)
  return png ? { png } : null
}

type PaneAnswer = { text: string; isWaiting: boolean }

async function openPane($: EngineInterface): Promise<PaneAnswer> {
  // Asked once, the panel is the person's to manage: it no longer opens by itself.
  await update($, layout, prev => ({ ...prev, hasAutoOpened: true }))
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  void quietly(() => runScan($))
  return opened.isPlaced
    ? { text: 'File tree opened.', isWaiting: false }
    : { text: `File tree is waiting: ${opened.reason}`, isWaiting: true }
}

// A pane opened unasked on a narrow terminal is open but undrawn: asking shows it.
async function togglePane($: EngineInterface): Promise<PaneAnswer> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane?.isPlaced) {
    await update($, layout, prev => ({ ...prev, hasAutoOpened: true }))
    await $.ui.close({ id: PANE })
    isPanePlaced = false
    return { text: 'File tree closed.', isWaiting: false }
  }
  return openPane($)
}

async function changeRoot($: EngineInterface, root: string): Promise<void> {
  findIndex = null
  await update($, layout, prev => ({ ...prev, root, expanded: [], autoOpened: {}, query: '' }))
  await refreshListings($)
  await syncGit($)
}

/** Opens the folders above a file for the person, and brings its row into view. */
async function showFile($: EngineInterface, path: string): Promise<void> {
  const { root } = await read($, layout)
  if (!isInside(root, path)) {
    $.ui.toast(`${shownPath(root, path, home)} is outside this tree.`)
    return
  }
  await update($, layout, prev => ({ ...prev, query: '' }))
  await openFoldersFor($, [path], null)
  $.clock.after(FOLLOW_DELAY_MS, () => {
    void $.ui.scroll({ in: PANE, to: { key: rowKey(path) }, block: 'center' }).catch(() => undefined)
  })
}

async function toggleFolder($: EngineInterface, path: string): Promise<void> {
  const isOpen = (await read($, layout)).expanded.includes(path) && (await read($, listings))[path] !== undefined
  await update($, layout, prev =>
    isOpen
      ? withClosed(prev, prev.expanded.filter(dir => isInside(path, dir)))
      : { ...withPinned(prev, path), expanded: [...prev.expanded.filter(dir => dir !== path), path] },
  )
  await refreshListings($)
}

async function mentionFile($: EngineInterface, path: string): Promise<void> {
  await update($, layout, prev => withPinned(prev, path))
  const shown = mentionPath(posix(await $.session.cwd()), path)
  const filled = await $.prompt.fill({ text: `@${/\s/.test(shown) ? `"${shown}"` : shown} `, mode: 'insert' })
  if (!filled.isFilled) $.ui.toast('The prompt is busy: try again in a moment.')
}

async function pressRow($: EngineInterface, action: HitAction | undefined, path: string): Promise<void> {
  if (action === 'toggle') await toggleFolder($, path)
  else if (action === 'mention') await mentionFile($, path)
  else if (action === 'show') await showFile($, path)
}

export const register: Register = (on, options) => {
  const glyphs = GLYPHS[options.glyphs === 'plain' ? 'plain' : 'nerd']
  willAutoOpen = options.autoOpen !== 'never'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tree',
      description: 'Show or hide the file tree, with the files Claude reads and edits lit up. /tree open only opens it.',
    })
    isWatching = Boolean(e.isInteractive)
    if (!e.isInteractive) return started

    home = posix((await $.env.get('HOME')) ?? '')
    const cwd = posix(await $.session.cwd())
    await update($, layout, prev => (prev.project ? prev : initialLayout(cwd)))
    await quietly(() => loadIcons($, options.icons))
    // A search kept through a reload has lost its index, which lives only in memory.
    if ((await read($, layout)).query) await quietly(() => ensureIndex($))
    scheduleScan($, null)

    // Drives the animation, and quiet when nothing is lit or no panel is up.
    let ticks = 0
    let wasLive = false
    const tick = async (): Promise<void> => {
      ticks++
      if (ticks % POLL_EVERY === 0) await poll($, ticks % (POLL_EVERY * FULL_SYNC_EVERY) === 0)
      if (!isPanePlaced) return
      const at = await $.clock.now()
      const act = await read($, activity)
      const isLive = act.working.length > 0 || (await read($, touches)).some(touch => touch.liveUntil > at)
      if (isLive || wasLive || (act.isWorking && ticks % WORKING_EVERY === 0)) await update($, now, () => at)
      wasLive = isLive
      // Folders do not close under someone who is using the panel.
      if (ticks % CLOSE_EVERY === 0 && !isPaneFocused) {
        const closing = foldersToClose(await read($, layout), await read($, touches), at)
        if (closing.length) await update($, layout, prev => withClosed(prev, closing))
      }
    }
    $.clock.every(TICK_MS, () => void tick().catch(() => undefined))
    return started
  })

  // /clear and /resume carry on in this process under another session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, touches, () => [])
      await update($, activity, initialActivity)
      await update($, layout, prev => ({ ...prev, autoOpened: {}, hasAutoOpened: false }))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, activity, prev => ({ ...prev, turn: prev.turn + 1, isWorking: true, working: [] }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await update($, activity, prev => ({ ...prev, isWorking: false, working: [] }))
      const at = await $.clock.now()
      await update($, now, () => at)
      scheduleScan($, null)
    }
    return next(e)
  })

  on('command.run', { command: 'tree' }, async ($, e) => {
    const answer = (e.args ?? '').trim() === 'open' ? await openPane($) : await togglePane($)
    return { text: answer.text }
  })

  // Tools and MCP servers alike: what names a file lights it, and whatever may
  // have written something is followed by a look at the folder.
  // A fault in this bookkeeping must never reach the tool, so all of it is `quietly`.
  on('tool.call', async ($, e, next) => {
    if (!isWatching) return next(e)
    const id = e.tool_use_id
    let plan: Planned = { reads: [], writes: [], mayWrite: false }
    let startedAt = 0
    await quietly(async () => {
      const tool: string = e.tool
      plan = planOfTool(tool, e as unknown as Record<string, unknown>, posix(await $.session.cwd()), home)
      startedAt = await $.clock.now()
      const named = [...plan.writes, ...plan.reads]
      if (named.length === 0) return
      const kind: TouchKind = plan.writes.length > 0 ? 'edited' : 'read'
      await update($, activity, prev => ({ ...prev, working: [...prev.working, { id, kind, paths: named }] }))
      await update($, now, () => startedAt)
    })
    const isNamed = plan.reads.length + plan.writes.length > 0
    if (!isNamed && !plan.mayWrite) return next(e)

    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } finally {
      if (isNamed) void quietly(() => update($, activity, prev => ({ ...prev, working: prev.working.filter(work => work.id !== id) })))
    }
    if (result.deny !== undefined) return result
    // Display only, so the tool's answer goes back without waiting for it.
    const finished = result
    void quietly(async () => {
      if (!finished.isError) await recordPlanned($, plan)
      if (plan.mayWrite || plan.writes.length > 0) scheduleScan($, plan.mayWrite ? startedAt : null)
    })
    return result
  })

  // Only a drawing is told whether a pane would dock beside the chat.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    canDock = e.viewport?.isFullscreen ?? e.surface === 'desktop'
    return next(e)
  })

  // A click on a row, from its click area in hit.tsx.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !e.element.startsWith('hit:')) return next(e)
    const { action, path } = (e.data ?? {}) as Partial<HitProps>
    if (typeof path === 'string') await quietly(() => pressRow($, action, path))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input } = ui
    const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : undefined
    const Client = e.surface === 'terminal' && 'Client' in ui ? ui.Client : undefined
    const Picture = e.surface === 'terminal' && 'Image' in ui ? ui.Image : undefined

    isPaneFocused = e.props.isFocused
    isPanePlaced = true

    const marks: Glyphs = Raster ? glyphs : GLYPHS.plain
    const current = await read($, layout)
    const lists = await read($, listings)
    const git = await read($, gitView)
    const list = await read($, touches)
    const act = await read($, activity)
    const at = Math.max(await read($, now), ...list.map(touch => touch.lastAt), 0)
    const frame = Math.floor(at / TICK_MS)

    const cols = Math.max(24, e.props.bodyColumns)
    // Content is inset on the terminal; the separators still run the full width.
    const inset = Raster ? PANE_INSET : 0
    const contentCols = Math.max(20, cols - inset * 2)
    const cardCols = Math.max(16, contentCols - 4)

    const touchOf = new Map(list.map(touch => [touch.path, touch]))
    const inWork = workingKinds(act)
    const marksOfFolders = folderMarks(current.root, list, git.changes)
    const ignored = new Set(git.ignored)
    const liveOf = (path: string): TouchKind | undefined => {
      const touch = touchOf.get(path)
      return inWork.get(path) ?? (touch && touch.liveUntil > at ? touch.lastAction : undefined)
    }

    const touchedShown = list.slice(0, current.showAllTouched ? TOUCHED_SHOWN_ALL : TOUCHED_SHOWN)
    const query = current.query.trim()
    const found = query ? findFiles(findIndex?.root === current.root ? findIndex.paths : [], query) : []
    const rows = query ? [] : buildRows(current, lists, ignored)

    // A very long tree is drawn around the window the person is looking at, with
    // blank room standing in for the rest. A lit row is always drawn so it can be
    // scrolled to.
    const headerRows = 18 + (list.length ? touchedShown.length + 3 : 0)
    const { offset, bodyRows } = e.props.scroll
    const windowFrom = offset - headerRows - bodyRows
    const windowTo = offset - headerRows + bodyRows * 2
    const isDrawn = (row: TreeRow, index: number): boolean =>
      rows.length <= WINDOW_FROM || (index >= windowFrom && index < windowTo) || liveOf(row.path) !== undefined

    // Pictures need the click area too, as they cannot sit inside a Button.
    const pictures =
      Picture && Client && iconMap && imagePlan && !(imagePlan.needsFullscreen && e.viewport?.isFullscreen === false)
        ? { map: iconMap, plan: imagePlan }
        : null
    if (pictures?.plan.via === 'bytes') {
      const { map } = pictures
      await loadIconBytes(
        $,
        new Set([
          ...rows.filter((row, index) => !row.more && isDrawn(row, index)).map(row => iconOf(map, row.path, row.isDir, row.isOpen)),
          ...[...touchedShown.map(touch => touch.path), ...found].map(path => iconOf(map, path, false, false)),
        ]),
      )
    }
    const picture = (path: string, isDir: boolean, isOpen: boolean, alt: string) => {
      const source = pictures && iconSource(pictures.plan, iconOf(pictures.map, path, isDir, isOpen))
      return source && Picture ? <Picture source={source} columns={PICTURE_COLUMNS} rows={1} alt={alt} /> : null
    }

    const isLiveNow = act.working.length > 0 || list.some(touch => touch.liveUntil > at)
    const isAnimating = isLiveNow || act.isWorking
    const summary = summaryOf(list, act)
    const summaryChange = git.changes[summary.path]
    const toneColor = summary.tone ? hex(KIND_COLORS[summary.tone]) : ACCENT

    const capsule = (label: string, color: string, background: string) => (
      <Text>
        <Text color={background}>{marks.chipLeft}</Text>
        <Text color={color} backgroundColor={background} weight="bold">
          {label}
        </Text>
        <Text color={background}>{marks.chipRight}</Text>
      </Text>
    )
    const pill = (kind: TouchKind) => capsule(LABELS[kind], hex(KIND_COLORS[kind]), tintOf(KIND_COLORS[kind], 0.34))
    const pillCells = (kind: TouchKind): number => LABELS[kind].length + 2
    const chip = (name: string) => {
      const look = chipOf(name, marks)
      return (
        <Text>
          {capsule(look.label, look.color, look.background)}
          <Text> </Text>
        </Text>
      )
    }

    const hasCounts = (change: Change | undefined): change is Change => change !== undefined && change.added + change.removed > 0
    const countsText = (change: Change): string => `+${change.added} -${change.removed}`
    const counts = (change: Change) => (
      <Text tabular>
        <Text color={ADDED}>{`+${change.added}`}</Text>
        <Text> </Text>
        <Text color={REMOVED}>{`-${change.removed}`}</Text>
      </Text>
    )

    const nameSpans = (name: string, live: TouchKind | undefined, color: string | undefined, isDim: boolean, isBold: boolean) => {
      if (live) {
        const characters = [...name]
        const shades = shimmerColors(characters.length, frame, KIND_COLORS[live])
        return characters.map((character, i) => (
          <Text key={`c${i}`} color={shades[i] ?? hex(KIND_COLORS[live])} weight="bold">
            {character}
          </Text>
        ))
      }
      return (
        <Text {...(color ? { color } : {})} dimColor={isDim} {...(isBold ? { weight: 'bold' as const } : {})}>
          {name}
        </Text>
      )
    }

    const rowTint = (kind: TouchKind | undefined, live: TouchKind | undefined): string | undefined => {
      if (live) return tintOf(KIND_COLORS[live], pulse(frame))
      return kind && kind !== 'read' ? tintOf(KIND_COLORS[kind], 0.16) : undefined
    }

    type RowEnd = { change: Change | undefined; kind: TouchKind | undefined; tail: string }
    const endCells = ({ change, kind, tail }: RowEnd): number =>
      (hasCounts(change) ? countsText(change).length + 1 : 0) + (kind ? pillCells(kind) : tail.length)

    type FileLine = {
      boxKey: string
      pressKey: string
      name: string
      action: HitAction
      path: string
      paddingX: number
      /** Where the keyboard's one-cell Button sits, from the row's left edge. */
      gutter: number
      tint: string | undefined
      image: RenderElement | null
      /** What comes before the picture, or before the name when there is none. */
      lead: RenderElement | null
      label: RenderElement | RenderElement[]
      trail: RenderElement | null
      end: RowEnd
    }

    // On the terminal a row is plain text. The pointer lands on the click area
    // over it, and keyboard focus on a one-cell Button in the gutter, so the
    // engine's inverted Button never paints over the row.
    const fileLine = (line: FileLine) => {
      const { change, kind, tail } = line.end
      const body = line.image ? (
        <Box flexDirection="row">
          {line.lead}
          {line.image}
          <Text> </Text>
          <Text wrap="truncate-end">{line.label}</Text>
        </Box>
      ) : (
        <Text wrap="truncate-end">
          {line.lead}
          {line.label}
        </Text>
      )
      const press = (): Promise<void> => pressRow($, line.action, line.path)
      return (
        <Box
          key={line.boxKey}
          flexDirection="row"
          justifyContent="space-between"
          height={1}
          paddingX={line.paddingX}
          hover={{ backgroundColor: HOVER }}
          {...(line.tint ? { backgroundColor: line.tint } : {})}
        >
          <Box flexDirection="row" flexShrink={1}>
            {Client ? (
              body
            ) : (
              <Button key={line.pressKey} label={line.name} plain onPress={press}>
                {body}
              </Button>
            )}
            {line.trail}
          </Box>
          <Box flexShrink={0} flexDirection="row">
            {hasCounts(change) && (
              <Text>
                {counts(change)}
                <Text> </Text>
              </Text>
            )}
            {kind ? pill(kind) : tail ? <Text dimColor tabular>{tail}</Text> : null}
          </Box>
          {Client && (
            <Box key={`gutter:${line.pressKey}`} position="absolute" top={0} left={line.gutter}>
              <Button key={line.pressKey} label={line.name} plain onPress={press}>
                <Text> </Text>
              </Button>
            </Box>
          )}
          {Client && (
            <Box key={`hit-frame:${line.pressKey}`} position="absolute" top={0} left={0} right={0} bottom={0}>
              <Client
                key={`hit:${line.pressKey}`}
                module="./hit.tsx"
                props={{ action: line.action, path: line.path } satisfies HitProps}
                width="100%"
                height="100%"
              />
            </Box>
          )}
        </Box>
      )
    }

    const treeRow = (row: TreeRow) => {
      const indent = '  '.repeat(row.depth)
      if (row.more > 0) {
        return (
          <Box key={`more:${row.path}`} height={1} paddingX={inset}>
            <Text dimColor>{`${indent}… ${row.more} more not shown`}</Text>
          </Box>
        )
      }
      const touch = touchOf.get(row.path)
      const change = git.changes[row.path]
      const live = row.isDir ? undefined : liveOf(row.path)
      const folderMark = row.isDir ? marksOfFolders.get(row.path) : undefined
      const kind = row.isDir ? undefined : touch?.kind
      const tail = row.isDir || kind ? '' : current.showSizes ? formatSize(row.size) : formatWhen(row.mtimeMs, at)
      const end: RowEnd = { change, kind, tail }
      const leftCells = indent.length + CHIP_CELLS
      const rightCells = endCells(end)
      const name = clip(row.isLink ? `${row.name} ${marks.link}` : row.name, Math.max(4, contentCols - leftCells - rightCells - 1))
      const trailCells = live ? Math.max(0, contentCols - leftCells - cellWidth(name) - rightCells - 2) : 0
      const inkColor =
        kind !== undefined
          ? hex(KIND_COLORS[kind])
          : folderMark === 'changed'
            ? AMBER
            : folderMark
              ? hex(KIND_COLORS[folderMark])
              : change
                ? AMBER
                : undefined
      const isQuiet = row.isIgnored || (row.isHidden && !kind && !change)
      const image = picture(row.path, row.isDir, row.isOpen, row.isDir ? `${marks.folder} ` : chipOf(row.name, marks).label)
      const caret = <Text dimColor>{row.isOpen ? '▾ ' : '▸ '}</Text>
      const lead = image ? (
        <Text>
          {indent}
          {row.isDir ? caret : '  '}
        </Text>
      ) : (
        <Text>
          {indent}
          {row.isDir ? (
            <Text>
              {caret}
              <Text color={isQuiet ? undefined : BLUE} dimColor={isQuiet}>
                {row.isOpen ? marks.folderOpen : marks.folder}
              </Text>
              <Text>{'  '}</Text>
            </Text>
          ) : (
            chip(row.name)
          )}
        </Text>
      )
      return fileLine({
        boxKey: rowKey(row.path),
        pressKey: `open:${row.path}`,
        name: row.name,
        action: row.isDir ? 'toggle' : 'mention',
        path: row.path,
        paddingX: inset,
        gutter: inset - 1,
        tint: rowTint(kind, live),
        image,
        lead,
        label: nameSpans(name, live, inkColor, isQuiet, kind === 'edited' || kind === 'committed'),
        trail: trailCells > 0 && live ? <Text color={hex(KIND_COLORS[live])}> {trailText(trailCells, frame)}</Text> : null,
        end,
      })
    }

    const flatRow = (keyName: string, path: string, kind: TouchKind | undefined, width: number) => {
      const name = basename(path)
      const shown = shownPath(current.root, path, home)
      const folder = shown.includes('/') ? shown.slice(0, shown.lastIndexOf('/')) : ''
      const end: RowEnd = { change: git.changes[path], kind, tail: '' }
      const image = picture(path, false, false, chipOf(name, marks).label)
      const nameRoom = Math.max(6, width - (image ? PICTURE_CELLS : CHIP_CELLS) - endCells(end) - 1)
      const nameShown = clip(name, nameRoom)
      const folderRoom = nameRoom - cellWidth(nameShown) - 1
      return fileLine({
        boxKey: keyName,
        pressKey: `show:${keyName}`,
        name,
        action: 'show',
        path,
        paddingX: 0,
        gutter: -1,
        tint: undefined,
        image,
        lead: image ? null : chip(name),
        label: (
          <Text>
            {nameSpans(nameShown, liveOf(path), undefined, false, true)}
            <Text dimColor>{folderRoom >= 4 && folder ? ` ${clip(folder, folderRoom - 1)}` : ''}</Text>
          </Text>
        ),
        trail: null,
        end,
      })
    }

    const legend = (color: string, label: string) => (
      <Text key={label}>
        <Text color={color}>● </Text>
        <Text dimColor>{label}</Text>
      </Text>
    )

    const changedCount = git.changedTotal
    const heroText = Math.max(10, cardCols - (Raster ? BOT_COLUMNS + 1 : 0))
    const hero = (
      <Box key="hero-frame" paddingX={inset}>
        <Box
          key="hero"
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          paddingX={1}
          {...(isLiveNow ? { borderColor: toneColor } : { borderDimColor: true })}
        >
          <Box flexDirection="row" gap={1}>
            {Raster && <Raster key="bot" columns={BOT_COLUMNS} rows={BOT_ROWS} cells={drawBot(summary.tone, isAnimating, frame)} />}
            <Box flexDirection="column" width={heroText}>
              <Text color={toneColor} weight="bold">
                {summary.status}
              </Text>
              <Text weight="bold" wrap="truncate-end">
                {summary.title}
              </Text>
              <Text wrap="truncate-end">
                <Text dimColor>{summary.path ? clip(shownPath(current.root, summary.path, home), heroText - 12) : 'Waiting for Claude'}</Text>
                {hasCounts(summaryChange) && (
                  <Text>
                    <Text>{'  '}</Text>
                    {counts(summaryChange)}
                  </Text>
                )}
              </Text>
            </Box>
          </Box>
          {Raster && (
            <Raster
              key="strip"
              columns={cardCols}
              rows={1}
              cells={drawActivityBar({
                width: cardCols,
                kinds: act.trailTurn === act.turn || !act.isWorking ? act.trail : [],
                label: summary.barLabel || summary.status,
                isActive: isAnimating,
                frame,
                glyphs,
              })}
            />
          )}
          {git.isRepo && (
            <Box flexDirection="row" justifyContent="space-between" gap={1} marginTop={Raster ? 0 : 1}>
              <Box flexShrink={1}>
                <Text wrap="truncate-end">
                  <Text color={BLUE}>{marks.branch} </Text>
                  <Text weight="bold">{git.branch || 'no branch'}</Text>
                  <Text dimColor>
                    {git.ahead ? ` ↑${git.ahead}` : ''}
                    {git.behind ? ` ↓${git.behind}` : ''}
                  </Text>
                </Text>
              </Box>
              <Box flexShrink={0}>
                {changedCount > 0 ? (
                  <Text tabular>
                    {git.isCountPartial && <Text dimColor>≥ </Text>}
                    {git.added + git.removed > 0 && (
                      <Text>
                        {counts({ code: 'M', added: git.added, removed: git.removed })}
                        <Text dimColor> · </Text>
                      </Text>
                    )}
                    <Text color={AMBER}>{changedCount} changed</Text>
                  </Text>
                ) : (
                  <Text color={ADDED}>clean</Text>
                )}
              </Box>
            </Box>
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {legend(hex(KIND_COLORS.read), 'Read')}
            {legend(hex(KIND_COLORS.edited), 'Edited')}
            {legend(hex(KIND_COLORS.committed), 'Committed')}
            {git.isRepo && legend(AMBER, 'Not committed')}
          </Box>
        </Box>
      </Box>
    )

    const heading = (key: string, left: string, right: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" height={1}>
        <Text dimColor weight="bold">
          {left}
        </Text>
        <Text dimColor weight="bold">
          {right}
        </Text>
      </Box>
    )

    const toolbar = (
      <Box key="toolbar" flexDirection="row" flexWrap="wrap" columnGap={2} paddingX={inset} marginTop={1}>
        <Button key="refresh" hotkey="r" plain label="Refresh" onPress={() => runScan($)} />
        <Button key="collapse" hotkey="c" plain label="Collapse all" onPress={() => update($, layout, prev => ({ ...prev, expanded: [], autoOpened: {} }))} />
        <Button
          key="sizes"
          hotkey="s"
          plain
          label={current.showSizes ? 'Show dates' : 'Show sizes'}
          onPress={() => update($, layout, prev => ({ ...prev, showSizes: !prev.showSizes }))}
        />
        {!isTopFolder(current.root) && <Button key="up" hotkey="u" plain label="Up a folder" onPress={() => changeRoot($, dirname(current.root))} />}
        {current.root !== current.project && (
          <Button key="back" hotkey="b" plain label="Back to project" onPress={() => changeRoot($, current.project)} />
        )}
        <Button
          key="hidden"
          hotkey="h"
          plain
          label={current.showHidden ? 'Hide hidden files' : 'Show hidden files'}
          onPress={() => update($, layout, prev => ({ ...prev, showHidden: !prev.showHidden }))}
        />
        <Button key="find-focus" hotkey="f" plain label="Find" onPress={() => $.ui.focus({ requestId: PANE, key: 'find' })} />
      </Box>
    )

    const finder = (
      <Box key="finder-frame" paddingX={inset} marginTop={1}>
        <Box key="finder" flexDirection="row" flexGrow={1} borderStyle="round" borderDimColor paddingX={1} gap={1}>
          <Text dimColor>{marks.search} </Text>
          <Box flexGrow={1}>
            <Input
              key="find"
              placeholder="Find a file"
              value={current.query}
              submitLabel="show"
              onInput={value => {
                void update($, layout, prev => ({ ...prev, query: value }))
                  .then(() => ensureIndex($))
                  .catch(() => undefined)
              }}
              onSubmit={async value => {
                const [first] = findFiles(findIndex?.paths ?? [], value)
                if (first) await showFile($, first)
              }}
            />
          </Box>
        </Box>
      </Box>
    )

    const touchedCard = list.length > 0 && (
      <Box key="touched-frame" paddingX={inset} marginTop={1}>
        <Box key="touched" flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
          {heading('touched-heading', 'CLAUDE TOUCHED', `${list.length} FILE${list.length === 1 ? '' : 'S'}`)}
          {touchedShown.map(touch => flatRow(`touched:${touch.path}`, touch.path, touch.kind, cardCols))}
          {list.length > TOUCHED_SHOWN && (
            <Button
              key="touched-more"
              plain
              label={current.showAllTouched ? 'Show fewer' : `Show all ${Math.min(list.length, TOUCHED_SHOWN_ALL)}`}
              onPress={() => update($, layout, prev => ({ ...prev, showAllTouched: !prev.showAllTouched }))}
            />
          )}
        </Box>
      </Box>
    )

    const treeNodes = []
    let gap = 0
    rows.forEach((row, index) => {
      if (!isDrawn(row, index)) {
        gap++
        return
      }
      if (gap > 0) treeNodes.push(<Box key={`gap:${index}`} height={gap} />)
      gap = 0
      treeNodes.push(treeRow(row))
    })
    if (gap > 0) treeNodes.push(<Box key="gap:end" height={gap} />)

    const projectName = (basename(current.root) || current.root).toUpperCase()
    const rootListing = lists[current.root]

    return (
      <Box flexDirection="column">
        {hero}
        {finder}
        {toolbar}
        {touchedCard}
        <Box key="tree-heading" flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(cols)}</Text>
          <Box paddingX={inset} flexDirection="column">
            {heading('all-heading', query ? `FOUND ${found.length}` : 'ALL FILES', clip(projectName, Math.floor(contentCols / 2)))}
          </Box>
        </Box>
        {query ? (
          <Box key="found" flexDirection="column" paddingX={inset}>
            {found.length === 0 && <Text dimColor>{findIndex ? 'No file matches.' : 'Searching…'}</Text>}
            {found.map(path => flatRow(`found:${path}`, path, touchOf.get(path)?.kind, contentCols))}
          </Box>
        ) : rows.length === 0 ? (
          <Box key="empty" paddingX={inset}>
            <Text dimColor>{!rootListing ? 'Reading the folder…' : rootListing.entries.length > 0 ? 'Only hidden files here.' : 'This folder is empty.'}</Text>
          </Box>
        ) : (
          <Box key="tree" flexDirection="column">
            {treeNodes}
          </Box>
        )}
        {act.commitSha && (
          <Box key="footer" flexDirection="row" justifyContent="flex-end" paddingX={inset} marginTop={1}>
            <Text>
              <Text color={ADDED}>● committed </Text>
              <Text dimColor>{act.commitSha}</Text>
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
