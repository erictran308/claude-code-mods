// media-gallery: pictures and videos in the chat.
//
// The model calls `show`, or the person runs /gallery: the call's row in the
// transcript grows a strip of thumbnails, and a pane opens on the whole set as
// a grid driven by its hotkeys (h j k l, Enter or o to view, f, q). A video in
// the pane plays muted, a frame at a time through ffmpeg; f hands the set to
// Pepper's pepper-play, which shows it over the whole tab with its sound.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ImageSource, Register, RenderElement } from 'claude-code'

import type { Gallery, GalleryMode, MediaItem, MediaSet } from '../types'
import {
  NO_GALLERY,
  PERL_IPC,
  answerOf,
  basename,
  clipMiddle,
  countOf,
  dirname,
  escapeRegExp,
  fitBox,
  formatDuration,
  formatSize,
  fullscreenPlanOf,
  galleryAt,
  galleryTagOf,
  hasWildcard,
  hashOf,
  imagePlanOf,
  inputOptionsOf,
  ipcLine,
  joinPath,
  kindOf,
  legendOf,
  naturalCompare,
  nearestIn,
  needsSips,
  newItem,
  outwardFrom,
  pageOf,
  placeCommandOf,
  parseDuration,
  patchItem,
  playableOf,
  pngSizeOf,
  printable,
  probeSizeOf,
  resolveInput,
  sipsSizeOf,
  splitArgs,
  step,
  stepInPlaylist,
  summaryOf,
  tagOfSetId,
  TMUX_IMAGE_QUESTION,
  needsTmuxAnswer,
  wildcardOf,
  withSet,
  wrappedRowsOf,
} from './model'
import type { Direction, Env, FullscreenPlan, ImagePlan, KeyAction, PanePlacement } from './model'

const PANE = 'media-gallery'
const TOOL = 'mcp__media-gallery__show'
const COMMAND = 'gallery'

const THUMB_PX = 360
const VIEW_PX = 1600
// Bytes go through the engine, at most 2 MiB a picture.
const VIEW_PX_BYTES = 1024
const MAX_PNG_BASE64 = Math.floor((2 * 1024 * 1024 * 4) / 3)
const PLAY_PX = 960
// Each frame crosses the engine as bytes there: smaller keeps it under the 2 MiB a picture.
const PLAY_PX_BYTES = 640
const PLAY_FPS = 12
const MAX_ITEMS = 500
const KEEP_SETS = 30
const LANES = 4

const TILE_WIDTH = 22
const TILE_PICTURE_ROWS = 6
// The picture, the name under it and the border.
const TILE_HEIGHT = TILE_PICTURE_ROWS + 3
const STRIP_WIDTH = 16
const STRIP_ROWS = 5

// Change a tag when its value's fields change: it declines what an earlier version stored.
const sets = atom({ plugin: 'media-gallery', key: 'sets' } as const, {}, { shape: 'sets-1' })
const gallery = atom({ plugin: 'media-gallery', key: 'gallery' } as const, NO_GALLERY, { shape: 'gallery-1' })

type Terminal = Elements['terminal']

/** `update` of the gallery, typed so the fields' literals stay literal. */
const editGallery = ($: EngineInterface, change: (value: Gallery) => Gallery): Promise<Gallery> => update($, gallery, change)

// The machine ---------------------------------------------------------------------

/** What the terminal can draw, read from the environment and tmux alone: all a drawing waits on. */
type Surface = {
  plan: ImagePlan | null
  fullscreen: FullscreenPlan
  home: string
  tmpdir: string
}

type Setup = Surface & {
  ffmpeg: string | null
  ffprobe: string | null
  /** ffmpeg 6.1 and later can write a file aside and rename it; an older one writes in place. */
  canWriteAtomically: boolean
  cache: string
}

let surfaceRun: Promise<Surface> | null = null
let setupRun: Promise<Setup> | null = null
/** The setup once it is done: what a drawing says about the tools without waiting for them. */
let setupDone: Setup | null = null
/** The home-folder cache is the one swept: only its pictures are touched on reuse. */
let isCacheSwept = false
/** The `Gallery takes the keys` setting: whether a `show` call hands the pane the keyboard too. */
let takesKeysOnShow = false

/** A promise kept for the module's life, or until it fails: the next call tries again. */
const cached = <T,>(run: Promise<T>, forget: () => void): Promise<T> =>
  run.catch((error: unknown) => {
    forget()
    throw error
  })

const surface = ($: EngineInterface): Promise<Surface> => {
  surfaceRun ??= cached(readSurface($), () => (surfaceRun = null))
  return surfaceRun
}

const setup = ($: EngineInterface): Promise<Setup> => {
  setupRun ??= cached(readSetup($), () => (setupRun = null))
  return setupRun
}

/** The first of a tool's usual places that answers, all asked at once. */
const findTool = async ($: EngineInterface, name: 'ffmpeg' | 'ffprobe'): Promise<string | null> => {
  const candidates = [name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
  const answers = await Promise.all(
    candidates.map(candidate => $.process.run([candidate, '-version'], { timeoutMs: 5000 }).then(ran => ran.exitCode === 0, () => false)),
  )
  return candidates[answers.indexOf(true)] ?? null
}

async function readSurface($: EngineInterface): Promise<Surface> {
  // Each name written out: the engine lists what a mod reads from its source.
  const [TERM, TERM_PROGRAM, TERM_PROGRAM_VERSION, TMUX, TMUX_PANE, SSH_CONNECTION, SSH_TTY, KITTY_WINDOW_ID, ZELLIJ, STY, CLAUDE_CODE_FORCE_TERMINAL_IMAGES, PEPPER_PLAY, TMPDIR, HOME] =
    await Promise.all([
      $.env.get('TERM'),
      $.env.get('TERM_PROGRAM'),
      $.env.get('TERM_PROGRAM_VERSION'),
      $.env.get('TMUX'),
      $.env.get('TMUX_PANE'),
      $.env.get('SSH_CONNECTION'),
      $.env.get('SSH_TTY'),
      $.env.get('KITTY_WINDOW_ID'),
      $.env.get('ZELLIJ'),
      $.env.get('STY'),
      $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
      $.env.get('PEPPER_PLAY'),
      $.env.get('TMPDIR'),
      $.env.get('HOME'),
    ])
  const env: Env = { TERM, TERM_PROGRAM, TERM_PROGRAM_VERSION, TMUX, TMUX_PANE, SSH_CONNECTION, SSH_TTY, KITTY_WINDOW_ID, ZELLIJ, STY, CLAUDE_CODE_FORCE_TERMINAL_IMAGES, PEPPER_PLAY }
  // tmux is asked only when its answer decides whether pictures get through it.
  const tmuxAnswer =
    TMUX_PANE && needsTmuxAnswer(env)
      ? await $.process
          .run(['tmux', 'display-message', '-p', '-t', TMUX_PANE, TMUX_IMAGE_QUESTION], { timeoutMs: 1000 })
          .then(ran => (ran.exitCode === 0 ? ran.stdout : undefined), () => undefined)
      : undefined
  return { plan: imagePlanOf(env, tmuxAnswer), fullscreen: fullscreenPlanOf(env), home: HOME ?? '/', tmpdir: TMPDIR ?? '' }
}

/** How long a cached picture lives without being made again. */
const CACHE_DAYS = 7
/** How long a frames file another session left may stay: a day. */
const FRAMES_LEFT_MINUTES = 24 * 60

async function readSetup($: EngineInterface): Promise<Setup> {
  const seen = await surface($)
  // Short, and the person's own: mpv's socket lives here, and a Unix socket's path ends at 104 bytes on macOS.
  const tmp = seen.tmpdir.replace(/\/+$/, '')
  const homeCache = `${seen.home.replace(/\/+$/, '')}/.cache/cmg`
  const isShort = (folder: string): boolean => folder.length <= 60
  let cache = tmp && isShort(`${tmp}/cmg`) ? `${tmp}/cmg` : isShort(homeCache) ? homeCache : ''
  if (!cache) {
    // Both too long: a fresh private folder of this session's, short by construction.
    const made = await $.process.run(['mktemp', '-d', '/tmp/cmg.XXXXXX'], { timeoutMs: 5000 }).catch(() => null)
    cache = made?.exitCode === 0 ? made.stdout.trim() : homeCache
  }
  const [ffmpeg, ffprobe] = await Promise.all([
    findTool($, 'ffmpeg'),
    findTool($, 'ffprobe'),
    $.process.run(['mkdir', '-p', '-m', '700', cache], { timeoutMs: 5000 }).catch(() => null),
  ])
  // The OS cleans its temp folder; the fallback in the home folder is swept here: a picture unused for a week goes.
  // Waited on, so no reuse of a picture can find it just before the sweep takes it.
  if (cache === homeCache) {
    isCacheSwept = true
    await $.process.run(['find', cache, '-type', 'f', '-mtime', `+${CACHE_DAYS}`, '-delete'], { timeoutMs: 30_000 }).catch(() => null)
  }
  // Frames files an earlier session left behind (one it was playing when it ended): never reused, so gone after a day.
  void $.process
    .run(['find', cache, '-type', 'f', '-name', 'play-*.png', '-mmin', `+${FRAMES_LEFT_MINUTES}`, '-delete'], { timeoutMs: 30_000 })
    .catch(() => null)
  const muxer = ffmpeg ? await $.process.run([ffmpeg, '-hide_banner', '-h', 'muxer=image2'], { timeoutMs: 5000 }).catch(() => null) : null
  const canWriteAtomically = (muxer?.stdout ?? '').includes('atomic_writing')
  setupDone = { ...seen, ffmpeg, ffprobe, canWriteAtomically, cache }
  // A drawing that said what it could before the tools were known (needs ffmpeg) draws again.
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // Nothing drawn yet.
  }
  return setupDone
}

// Finding the files ---------------------------------------------------------------

type Found = { items: MediaItem[]; skipped: string[]; total: number }

async function collect($: EngineInterface, inputs: readonly string[], home: string): Promise<Found> {
  const cwd = await $.session.cwd()
  const items: MediaItem[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  const add = (path: string): void => {
    const kind = kindOf(path)
    if (!kind || seen.has(path)) return
    seen.add(path)
    items.push(newItem(path, kind))
  }
  const addFolder = async (input: string, folder: string, matches: (name: string) => boolean, allowsHidden = false): Promise<void> => {
    const entries = await $.fs.list(folder).catch(() => null)
    if (!entries) {
      skipped.push(`${input} (no such folder)`)
      return
    }
    const names = entries
      .filter(entry => (entry.kind === 'file' || entry.isLink) && (allowsHidden || !entry.name.startsWith('.')) && matches(entry.name) && kindOf(entry.name))
      .map(entry => entry.name)
      .sort(naturalCompare)
    if (names.length === 0) skipped.push(`${input} (no pictures or videos there)`)
    for (const name of names) add(joinPath(folder, name))
  }

  for (const input of inputs) {
    if (!input.trim()) continue
    const path = resolveInput(input, cwd, home)
    // What a skip names: a bare `.` reads as nothing in a sentence.
    const shown = /^\.\/?$/.test(input.trim()) ? 'the working folder' : input
    // A file's own name may hold `*` or `?`: it is taken as it is first, as a pattern after. Only what the person
    // typed is checked for a folder pattern, so a working folder whose own name holds `?` does not count.
    const stat = await $.fs.stat(path).catch(() => null)
    const typedFolders = input.trim().split('/').slice(0, -1)
    if (!stat && typedFolders.some(part => /[*?]/.test(part))) {
      skipped.push(`${shown} (a * or ? works in the file name only)`)
    } else if (!stat && hasWildcard(path)) {
      const pattern = wildcardOf(basename(path))
      // A pattern that starts with a dot asks for hidden files.
      await addFolder(shown, dirname(path), name => pattern.test(name), basename(path).startsWith('.'))
    } else if (!stat) {
      skipped.push(`${shown} (not found)`)
    } else if (stat.kind === 'dir') await addFolder(shown, path, () => true)
    else if (kindOf(path)) add(path)
    else skipped.push(`${shown} (not a picture or video)`)
  }
  return { items: items.slice(0, MAX_ITEMS), skipped, total: items.length }
}

// Making pictures -----------------------------------------------------------------

const stampOf = async ($: EngineInterface, path: string): Promise<{ stamp: string; bytes: number } | null> => {
  const stat = await $.fs.stat(path).catch(() => null)
  return stat ? { stamp: hashOf(`${path}\n${stat.size}\n${stat.mtimeMs}`), bytes: stat.size } : null
}

/** Where a video's poster frame comes from: a little way in, past a black first frame. */
const posterAt = (seconds: number): number => Math.min(1, seconds / 3)

/** A name beside `out` that no other run writes, for a file made whole before it takes `out`'s name. */
const partOf = (out: string): string => out.replace(/\.png$/, `.${hashOf(`${out}:${Math.random()}`).slice(0, 8)}.part.png`)

/** Moves a finished file into place, so `out` is never a half-written picture a later run trusts. */
const settle = async ($: EngineInterface, part: string, out: string): Promise<boolean> => {
  const ran = await $.process.run(['mv', '-f', part, out], { timeoutMs: 10_000 }).catch(() => null)
  return ran?.exitCode === 0
}

/** Marks a cached picture as used now, so the week-old sweep keeps it. */
const touch = ($: EngineInterface, path: string): void => {
  void $.process.run(['touch', path], { timeoutMs: 5000 }).catch(() => null)
}

/** True when the picture is already in the cache; in the swept cache that counts as a use of it. */
const reuse = async ($: EngineInterface, path: string): Promise<boolean> => {
  if (!(await $.fs.exists(path))) return false
  if (isCacheSwept) touch($, path)
  return true
}

/** A PNG of `item` at most `px` on its longer side: ffmpeg, then sips for a picture it cannot read. */
async function makePicture($: EngineInterface, setup: Setup, item: MediaItem, out: string, px: number): Promise<boolean> {
  let source = item.path
  const scratch: string[] = []
  try {
    if (needsSips(item.path)) {
      const converted = partOf(`${out}.src.png`)
      scratch.push(converted)
      const ran = await $.process.run(['sips', '-s', 'format', 'png', item.path, '--out', converted], { timeoutMs: 60_000 }).catch(() => null)
      if (ran?.exitCode === 0) source = converted
    }
    const part = partOf(out)
    scratch.push(part)
    const scale = `scale=w='min(${px},iw)':h='min(${px},ih)':force_original_aspect_ratio=decrease`
    if (setup.ffmpeg) {
      const tries = item.kind === 'video' && item.seconds > 0 ? [posterAt(item.seconds), 0] : [0]
      for (const at of tries) {
        const seek = at > 0 ? ['-ss', at.toFixed(2)] : []
        // A name holding `%` is a name, not a numbered sequence for ffmpeg to expand.
        const argv = [setup.ffmpeg, '-v', 'error', '-y', ...seek, ...inputOptionsOf(source), '-i', source, '-frames:v', '1', '-update', '1', '-vf', scale, part]
        const ran = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => null)
        if (ran?.exitCode === 0 && (await $.fs.exists(part))) return await settle($, part, out)
      }
    }
    if (item.kind !== 'image') return false
    // sips enlarges to `-Z` as readily as it shrinks: only a picture larger than `px` is made smaller.
    const sized = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', source], { timeoutMs: 20_000 }).catch(() => null)
    const size = sized?.exitCode === 0 ? sipsSizeOf(sized.stdout) : null
    const shrink = !size || Math.max(size.width, size.height) > px ? ['-Z', String(px)] : []
    const ran = await $.process.run(['sips', '-s', 'format', 'png', ...shrink, source, '--out', part], { timeoutMs: 60_000 }).catch(() => null)
    return ran?.exitCode === 0 && (await settle($, part, out))
  } finally {
    // What a run left half done, or the HEIC it converted on the way.
    await $.process.run(['rm', '-f', ...scratch], { timeoutMs: 10_000 }).catch(() => null)
  }
}

const pictureBytes = new Map<string, string>()

const readBase64 = async ($: EngineInterface, path: string): Promise<string> => {
  const file = await $.fs.read(path, { as: 'bytes' }).catch(() => null)
  return file?.base64 ?? ''
}

/** How much base64 the bytes cache may hold, all pictures together. */
const BYTES_BUDGET = 64 * 1024 * 1024
let bytesHeld = 0

/** Keeps a picture's bytes for the terminals that are sent them: the most recently drawn first, up to a budget. */
const rememberBytes = (path: string, base64: string): void => {
  // One the terminal cannot be sent is not worth keeping.
  if (base64.length > MAX_PNG_BASE64) return
  bytesHeld -= pictureBytes.get(path)?.length ?? 0
  pictureBytes.delete(path)
  pictureBytes.set(path, base64)
  bytesHeld += base64.length
  for (const [oldest, held] of pictureBytes) {
    if (bytesHeld <= BYTES_BUDGET || oldest === path) break
    pictureBytes.delete(oldest)
    bytesHeld -= held.length
  }
}

/** What an `Image` draws for a PNG of ours: its path, or its bytes where the terminal cannot read files. */
async function sourceOf($: EngineInterface, plan: ImagePlan | null, path: string, generation?: number): Promise<ImageSource | null> {
  if (!plan || !path) return null
  if (plan.via === 'file') return generation === undefined ? { file: path, format: 'png' } : { file: path, format: 'png', generation }
  // A video's frames change under one name: those are read every time.
  let base64 = generation === undefined ? pictureBytes.get(path) : undefined
  if (base64 === undefined) base64 = await readBase64($, path)
  if (generation === undefined && base64) rememberBytes(path, base64)
  return base64 && base64.length <= MAX_PNG_BASE64 ? { png: base64 } : null
}

async function prepareItem($: EngineInterface, setup: Setup, item: MediaItem): Promise<Partial<MediaItem>> {
  const found = await stampOf($, item.path)
  if (!found) return { error: 'not found' }
  let seconds = 0
  if (item.kind === 'video' && setup.ffprobe) {
    const probe = await $.process
      .run([setup.ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', item.path], { timeoutMs: 20_000 })
      .catch(() => null)
    seconds = probe?.exitCode === 0 ? parseDuration(probe.stdout) : 0
  }
  // Nothing here draws pictures: the names, sizes and lengths are all that is shown.
  if (!setup.plan) return { ...found, seconds, error: '' }
  if (!setup.ffmpeg && item.kind === 'video') return { ...found, seconds, error: 'needs ffmpeg: brew install ffmpeg' }
  const thumb = `${setup.cache}/${found.stamp}-t.png`
  const isMade = (await reuse($, thumb)) || (await makePicture($, setup, { ...item, seconds }, thumb, THUMB_PX))
  if (!isMade) return { ...found, seconds, error: 'could not be read' }
  // Read once: its header gives the shape, and a terminal sent bytes draws these same bytes.
  const base64 = await readBase64($, thumb)
  if (setup.plan?.via === 'bytes' && base64) rememberBytes(thumb, base64)
  const size = pngSizeOf(base64)
  // A thumbnail whose size cannot be read leaves the shape as it is: the large picture may have measured it.
  return { ...found, seconds, thumb, ...(size ? { width: size.width, height: size.height } : {}), error: '' }
}

/** Sets whose thumbnails are being made, and those shown again meanwhile: those get one more pass. */
const preparing = new Set<string>()
const prepareAgain = new Set<string>()

/** Where each set's thumbnails start: the item the pane opens on, so its page fills first. */
const prepareFrom = new Map<string, number>()

/** Makes the thumbnails a set still lacks. A set shown again while this runs gets a pass after, not a second run beside it. */
async function prepare($: EngineInterface, setId: string, from?: number): Promise<void> {
  if (from !== undefined) prepareFrom.set(setId, from)
  if (preparing.has(setId)) {
    prepareAgain.add(setId)
    return
  }
  preparing.add(setId)
  try {
    do {
      prepareAgain.delete(setId)
      await prepareOnce($, setId)
    } while (prepareAgain.has(setId))
  } finally {
    preparing.delete(setId)
    // The start point served this run; a later show of the set brings its own.
    prepareFrom.delete(setId)
  }
}

/** Whether an item still needs work: a thumbnail where pictures are drawn, its size and length where not. */
const needsWork = (item: MediaItem, canDraw: boolean): boolean => !item.error && (canDraw ? !item.thumb : !item.stamp)

/** Patches written at once: a set of hundreds is not written, and drawn again, once an item. */
const PATCH_BATCH = 8
/** The longest a finished thumbnail waits for others before it is written. */
const PATCH_WAIT_MS = 250

/** A few at a time, drawn as they land: the first at once, then a handful to a write, or a quarter second's worth. */
async function prepareOnce($: EngineInterface, setId: string): Promise<void> {
  const machine = await setup($)
  const set = (await read($, sets))[setId]
  if (!set) return
  // Outward from the item the pane is on (or opens on), so the page in view fills first.
  const g = await read($, gallery)
  const from = g.setId === setId ? g.index : (prepareFrom.get(setId) ?? 0)
  const queue = outwardFrom(set.items.length, from).flatMap(index => {
    const item = set.items[index]
    return item && needsWork(item, machine.plan !== null) ? [{ item, index }] : []
  })
  const pending: { index: number; path: string; patch: Partial<MediaItem> }[] = []
  let lastFlush = Number.NEGATIVE_INFINITY
  let isGone = false
  const flush = async (): Promise<void> => {
    const batch = pending.splice(0)
    if (!batch.length) return
    lastFlush = await $.clock.now()
    const kept = await update($, sets, all => batch.reduce((next, one) => patchItem(next, setId, one.index, one.path, one.patch), all))
    // A set dropped for newer ones needs its thumbnails no more.
    if (!kept[setId]) isGone = true
  }
  const lane = async (): Promise<void> => {
    for (let job = queue.shift(); job && !isGone; job = queue.shift()) {
      const { item, index } = job
      const patch = await prepareItem($, machine, item).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      pending.push({ index, path: item.path, patch })
      if (pending.length >= PATCH_BATCH || (await $.clock.now()) - lastFlush >= PATCH_WAIT_MS) await flush()
    }
    await flush()
  }
  await Promise.all(Array.from({ length: LANES }, lane))
}

/** Keeps a set, never dropping the one the pane shows, and makes its thumbnails from `from` outward. */
async function keepSet($: EngineInterface, set: MediaSet, from = 0): Promise<void> {
  const shown = (await read($, gallery)).setId
  await update($, sets, all => withSet(all, set, KEEP_SETS, shown))
  void prepare($, set.id, from).catch(() => undefined)
}

async function showSet($: EngineInterface, id: string, title: string, found: Found, from = 0): Promise<MediaSet> {
  const set: MediaSet = { id, title, items: found.items, total: found.total, createdAt: await $.clock.now() }
  await keepSet($, set, from)
  return set
}

// The pane ------------------------------------------------------------------------

const tileKey = (index: number): string => `tile:${index}`
const focusOn = ($: EngineInterface, key: string): void => {
  void $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

/** Tiles in a row, as the pane last drew them: what j and k move by. */
let perRow = 1
/** The whole terminal, as the pane last saw it: what fullscreen covers if the terminal cannot be asked. */
let viewport: { columns: number; rows: number } | null = null

/**
 * Keeps the size the pane saw; a change of it (the tab resized) places the
 * fullscreen box again. Only the pane's: a transcript row's is the chat column.
 */
const noteViewport = (seen: { columns: number; rows: number } | undefined): void => {
  if (!seen || seen.columns <= 0 || seen.rows <= 0) return
  const isChanged = viewport !== null && (viewport.columns !== seen.columns || viewport.rows !== seen.rows)
  viewport = { columns: seen.columns, rows: seen.rows }
  if (isChanged) fullscreen?.refit()
}

/** `takesKeys`: the pane asks for the keyboard as it opens (the person opened it, or the setting says so). */
async function openGallery($: EngineInterface, setId: string, index: number, mode: GalleryMode, takesKeys = true): Promise<boolean> {
  stopPlayer()
  await leaveFullscreen($)
  const set = (await read($, sets))[setId]
  if (!set || set.items.length === 0) return false
  const at = Math.max(0, Math.min(set.items.length - 1, index))
  await editGallery($, () => galleryAt(setId, at, mode))
  const opened = await $.ui.open({ id: PANE, title: set.title, ...(takesKeys ? { focus: true as const } : {}), closeOnEscape: true, rows: 60, columns: 160 })
  // A pane waiting for room is drawn nowhere: its view starts when the pane is first drawn (see the Pane's drawing).
  if (mode === 'view') {
    if (opened.isPlaced) await enterView($, at)
    else viewPending = { setId, index: at }
  } else {
    viewPending = null
    focusOn($, tileKey(at))
  }
  return opened.isPlaced
}

async function enterView($: EngineInterface, index: number, offset = 0): Promise<void> {
  viewPending = null
  stopPlayer()
  await editGallery($, g => ({ ...g, index, mode: 'view', picture: '', pictureOf: '', frames: '', framesOf: '', isPaused: false }))
  void dropOldFrames($).catch(() => undefined)
  focusOn($, 'key:grid')
  const g = await read($, gallery)
  const item = (await read($, sets))[g.setId]?.items[index]
  if (!item || item.error) return
  // Nothing here draws pictures: no large one to make.
  if ((await surface($)).plan && paneCanDraw !== false) void makeLarge($, { setId: g.setId, index }).catch(() => undefined)
  if (item.kind === 'video') void startPlayer($, { setId: g.setId, index }, item, offset).catch(() => undefined)
}

/** Which item of which set a piece of work is for: it lands only while that item is in view. */
type Spot = { setId: string; index: number }

/** A view opened while its pane waited for room: its work starts once the pane is drawn. */
let viewPending: Spot | null = null

const isInView = (g: Gallery, spot: Spot): boolean => g.mode === 'view' && g.setId === spot.setId && g.index === spot.index

let largeWanted: Spot | null = null
let isMakingLarge = false

/**
 * Makes the large picture for the item in view. One at a time, the newest
 * wish first: holding l through a hundred pictures makes one or two, not a hundred.
 */
async function makeLarge($: EngineInterface, spot: Spot): Promise<void> {
  largeWanted = spot
  if (isMakingLarge) return
  isMakingLarge = true
  try {
    for (let want: Spot | null = largeWanted; want; want = largeWanted) {
      largeWanted = null
      // One that fails leaves the newer wishes to be made.
      if (isInView(await read($, gallery), want)) await makeLargeNow($, want).catch(() => undefined)
    }
  } finally {
    isMakingLarge = false
  }
}

async function makeLargeNow($: EngineInterface, spot: Spot): Promise<void> {
  const machine = await setup($)
  const item = (await read($, sets))[spot.setId]?.items[spot.index]
  if (!item) return
  const stamp = item.stamp || (await stampOf($, item.path))?.stamp
  if (!stamp) return
  const px = machine.plan?.via === 'bytes' ? VIEW_PX_BYTES : VIEW_PX
  const out = `${machine.cache}/${stamp}-v${px}.png`
  const isMade = (await reuse($, out)) || (await makePicture($, machine, item, out, px))
  if (!isMade) return
  // A shape not known yet (no thumbnail, or one whose size could not be read): the large picture's own size gives it,
  // so it is never stretched to its box.
  if (!(item.width > 0 && item.height > 0)) {
    const size = await sizeOfPicture($, machine, out)
    if (size) {
      await update($, sets, all => {
        const now = all[spot.setId]?.items[spot.index]
        return now && !(now.width > 0 && now.height > 0) ? patchItem(all, spot.setId, spot.index, item.path, size) : all
      })
    }
  }
  await editGallery($, g => (isInView(g, spot) ? { ...g, picture: out, pictureOf: item.path } : g))
}

/** A picture's width and height in pixels: ffprobe where there is one, sips where not. */
async function sizeOfPicture($: EngineInterface, machine: Setup, path: string): Promise<{ width: number; height: number } | null> {
  if (machine.ffprobe) {
    const probe = await $.process
      .run([machine.ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path], { timeoutMs: 20_000 })
      .catch(() => null)
    const size = probe?.exitCode === 0 ? probeSizeOf(probe.stdout) : null
    if (size) return size
  }
  const sized = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeoutMs: 20_000 }).catch(() => null)
  return sized?.exitCode === 0 ? sipsSizeOf(sized.stdout) : null
}

// A video in the pane -------------------------------------------------------------

type Player = { path: string; offset: number; startedAt: number | null; stop: () => void }

/** Counts plays: a stop moves it on, so a play still starting when stopped never begins. */
let plays = 0
let player: Player | null = null
/** Where a paused video stopped, to go on from there. */
let pausedAt: { path: string; at: number } | null = null
/** Counts the frames blitted, so each names new content under the same file. */
let frame = 0
/** Videos ffmpeg could not play in the pane: their poster stays, and the status says so. */
const unplayable = new Set<string>()
/** Counts the frame files made, so each play writes one of its own. */
let framesMade = 0
/** Frame files of plays that ended, kept while a paused view still shows their last frame. */
const framesLeft = new Set<string>()

/** Removes the frame files of ended plays that the gallery no longer shows. */
async function dropOldFrames($: EngineInterface): Promise<void> {
  if (framesLeft.size === 0) return
  const shown = (await read($, gallery)).frames
  const gone = [...framesLeft].filter(path => path !== shown)
  if (gone.length === 0) return
  for (const path of gone) {
    framesLeft.delete(path)
    framesStarted.delete(path)
  }
  await $.process.run(['rm', '-f', ...gone], { timeoutMs: 10_000 }).catch(() => null)
}

/** Every frames file this module started and has not removed: all go when the pane closes or the session ends. */
const framesStarted = new Set<string>()

/** The pane closed or the session ended: no frame is shown any more, and every frames file goes. */
async function dropAllFrames($: EngineInterface): Promise<void> {
  await editGallery($, g => (g.frames || g.framesOf ? { ...g, frames: '', framesOf: '' } : g)).catch(() => undefined)
  const all = [...framesStarted]
  framesStarted.clear()
  framesLeft.clear()
  if (all.length) await $.process.run(['rm', '-f', ...all], { timeoutMs: 10_000 }).catch(() => null)
}

function stopPlayer(): void {
  plays++
  player?.stop()
  player = null
}

/** Seconds into the video, where the play in the pane is now: its offset until the first frame shows. */
const playedTo = (running: Player, now: number): number => running.offset + (running.startedAt === null ? 0 : (now - running.startedAt) / 1000)

/**
 * Whether the pane can draw pictures, as it last drew: null before its first
 * drawing, when the session's plan speaks for it. iTerm2 off its fullscreen
 * renderer cannot, though the session's plan says bytes.
 */
let paneCanDraw: boolean | null = null

/** Swaps the pane's picture to the frame just read, unless the play stopped while it was read. */
async function blitFrame($: EngineInterface, plan: ImagePlan | null, out: string, generation: number, isCurrent: () => boolean): Promise<void> {
  const source = await sourceOf($, plan, out, generation)
  if (source && isCurrent()) await $.ui.blit({ requestId: PANE, key: 'view', source }).catch(() => undefined)
}

/**
 * Plays a video into one PNG that ffmpeg rewrites in real time (written aside
 * and renamed, so it is never read half done), and swaps it into the pane's
 * picture when it changes. Muted: the pane has no sound; fullscreen does.
 */
async function startPlayer($: EngineInterface, spot: Spot, item: MediaItem, offset: number): Promise<void> {
  stopPlayer()
  const id = plays
  if (unplayable.has(item.path)) return
  const machine = await setup($)
  const stamp = item.stamp || (await stampOf($, item.path))?.stamp || hashOf(item.path)
  // Stopped while it started (the person moved on, closed the pane or went
  // fullscreen), or the pane draws no pictures: no frames to make.
  if (!machine.ffmpeg || !machine.plan || paneCanDraw === false || id !== plays) return
  const plan = machine.plan
  // A file of this play's own: a stopped ffmpeg may write a moment longer, and must not write over the next one's.
  const out = `${machine.cache}/play-${stamp}-${hashOf(`${Math.random()}`).slice(0, 6)}-${++framesMade}.png`
  framesStarted.add(out)
  void dropOldFrames($).catch(() => undefined)
  const px = plan.via === 'bytes' ? PLAY_PX_BYTES : PLAY_PX
  const seek = offset > 0.05 ? ['-ss', offset.toFixed(2)] : []
  const argv = [
    machine.ffmpeg, '-v', 'error', '-re', '-stream_loop', '-1', ...seek, ...inputOptionsOf(item.path), '-i', item.path, '-an',
    // Bounded both ways, so a portrait video is no taller than a landscape one is wide.
    '-vf', `fps=${PLAY_FPS},scale=w='min(${px},iw)':h='min(${px},ih)':force_original_aspect_ratio=decrease`,
    // Progress on stdout every quarter second: the loop below wakes to it, and can end ffmpeg.
    '-progress', 'pipe:1', '-stats_period', '0.25',
    // Written aside and renamed where ffmpeg can, so a frame is never read half done.
    '-f', 'image2', '-update', '1', ...(machine.canWriteAtomically ? ['-atomic_writing', '1'] : []), '-y', out,
  ]
  let isStopped = false
  let isTicking = false
  let lastWritten = 0
  const timer = $.clock.every(Math.round(1000 / PLAY_FPS), () => {
    if (isStopped || isTicking || running.startedAt === null) return
    isTicking = true
    // Only a frame ffmpeg has written since the last: a stalled ffmpeg sends nothing again.
    void $.fs
      .stat(out)
      .then(async stat => {
        if (isStopped || stat.mtimeMs === lastWritten) return
        lastWritten = stat.mtimeMs
        frame += 1
        await blitFrame($, plan, out, frame, () => !isStopped)
      })
      .catch(() => undefined)
      .finally(() => (isTicking = false))
  })
  const stop = (): void => {
    isStopped = true
    timer.cancel()
  }
  const running: Player = { path: item.path, offset, startedAt: null, stop }
  player = running
  void (async () => {
    try {
      for await (const piece of $.process.spawn({ argv })) {
        if (isStopped) break
        if (running.startedAt === null && piece.stream === 'stdout' && /frame=\s*[1-9]/.test(piece.text)) {
          // Time counts from the first frame shown, so a pause resumes where it was.
          running.startedAt = await $.clock.now()
          await editGallery($, g => (isInView(g, spot) ? { ...g, frames: out, framesOf: item.path, isPaused: false } : g))
        }
      }
    } catch {
      // Told below: it ended without being stopped.
    } finally {
      const hasFailed = !isStopped
      stop()
      if (player === running) player = null
      if (hasFailed) {
        // `-stream_loop -1` never ends by itself: this is ffmpeg giving up on the file.
        unplayable.add(item.path)
        await editGallery($, g => (isInView(g, spot) ? { ...g, frames: '', framesOf: '' } : g)).catch(() => undefined)
      }
      // Its file goes once no paused view still shows its last frame.
      framesLeft.add(out)
      void dropOldFrames($).catch(() => undefined)
    }
  })()
}

async function togglePlay($: EngineInterface): Promise<void> {
  const g = await read($, gallery)
  const item = (await read($, sets))[g.setId]?.items[g.index]
  if (!item || item.kind !== 'video') return
  if (g.fullscreen !== 'off') {
    await toPlayer($, [['cycle', 'pause']])
    return
  }
  if (player && player.path === item.path) {
    const elapsed = playedTo(player, await $.clock.now())
    pausedAt = { path: item.path, at: item.seconds > 0 ? elapsed % item.seconds : elapsed }
    stopPlayer()
    await editGallery($, x => ({ ...x, isPaused: true }))
    return
  }
  // Asked again: one that failed before gets another try.
  unplayable.delete(item.path)
  await editGallery($, x => ({ ...x, isPaused: false }))
  await startPlayer($, g, item, pausedAt?.path === item.path ? pausedAt.at : 0)
}

// Fullscreen through pepper-play --------------------------------------------------

/**
 * A fullscreen player: its socket, and `playlist`, the set's indexes it was
 * given in order. mpv's list is fixed when it starts, so moves map through it.
 */
type Fullscreen = { sock: string; playlist: readonly number[]; stop: () => void; refit: () => void }

let fullscreen: Fullscreen | null = null
/** Counts starts and leaves: a start still on its way when the person leaves gives up. */
let fullscreens = 0
let isStarting = false
let canReach = false

/** pepper-play places its box by writing to /dev/tty: a child with no terminal cannot. Only a yes is kept. */
async function canReachTerminal($: EngineInterface): Promise<boolean> {
  if (!canReach) {
    const ran = await $.process.run(['/bin/sh', '-c', ': > /dev/tty'], { timeoutMs: 3000 }).catch(() => null)
    canReach = ran?.exitCode === 0
  }
  return canReach
}

/**
 * The whole tab in cells, from the terminal itself. A drawing's viewport is not
 * it: beside a docked pane, a transcript row's is the chat column alone.
 */
async function tabSize($: EngineInterface): Promise<{ columns: number; rows: number }> {
  const ran = await $.process.run(['/bin/sh', '-c', 'stty size < /dev/tty'], { timeoutMs: 3000 }).catch(() => null)
  const [rows = 0, columns = 0] = (ran?.stdout ?? '').trim().split(/\s+/).map(Number)
  if (rows > 0 && columns > 0) return { columns, rows }
  return viewport ?? { columns: 120, rows: 40 }
}

/** Every IPC call to the player, one after another: overlapping keys reach mpv in the order pressed. */
let ipcQueue: Promise<unknown> = Promise.resolve()

/** Hands mpv's IPC some lines; what it answered, or null when the socket did not take them. */
async function ipcAnswer($: EngineInterface, sock: string, lines: readonly string[]): Promise<string | null> {
  const run = ipcQueue.then(() =>
    $.process.run(['/usr/bin/perl', '-e', PERL_IPC, sock], { stdin: `${lines.join('\n')}\n`, timeoutMs: 4000 }).catch(() => null),
  )
  ipcQueue = run.catch(() => undefined)
  const ran = await run
  return ran?.exitCode === 0 ? ran.stdout : null
}

/** Hands mpv's IPC some commands; true when the socket took them. */
async function ipc($: EngineInterface, sock: string, commands: readonly (readonly (string | number)[])[]): Promise<boolean> {
  return (await ipcAnswer($, sock, commands.map(command => ipcLine(command)))) !== null
}

const toPlayer = async ($: EngineInterface, commands: readonly (readonly (string | number)[])[]): Promise<void> => {
  if (fullscreen) await ipc($, fullscreen.sock, commands)
}

/** Ends a pepper-play its socket cannot reach: found by that socket's path, which no other process names. */
const killPlayer = async ($: EngineInterface, sock: string): Promise<void> => {
  await $.process.run(['pkill', '-f', escapeRegExp(sock)], { timeoutMs: 3000 }).catch(() => null)
}

/** The item's place and name over the video. `$>` first: mpv expands `${...}` in show-text, and a name may hold one. */
const osdOf = (set: MediaSet, index: number): (string | number)[] => [
  'show-text',
  `$>${index + 1}/${set.items.length}  ${printable(set.items[index]?.name ?? '')}`,
  2500,
]

const lastLine = (text: string): string => text.trim().split('\n').pop()?.slice(0, 200) ?? ''

/** The tag of the question where mpv had got to, asked as it is told to quit. */
const TIME_ASKED = 7

/** Ends fullscreen; says how far into a video mpv had played, when it could tell. */
async function leaveFullscreen($: EngineInterface): Promise<number | null> {
  fullscreens++
  const running = fullscreen
  if (!running) return null
  fullscreen = null
  running.stop()
  const answer = await ipcAnswer($, running.sock, [ipcLine(['get_property', 'time-pos'], TIME_ASKED), ipcLine(['quit'])])
  if (answer === null) await killPlayer($, running.sock)
  await editGallery($, g => ({ ...g, fullscreen: 'off' }))
  return answer === null ? null : answerOf(answer, TIME_ASKED)
}

/** Back in the pane after fullscreen ended on its own: a video in view plays there again. */
async function backToPane($: EngineInterface): Promise<void> {
  const g = await read($, gallery)
  if (g.mode === 'view') await enterView($, g.index)
}

async function toggleFullscreen($: EngineInterface): Promise<void> {
  if (fullscreen) {
    const at = await leaveFullscreen($)
    // h and l walked the set while fullscreen: the pane lands on the item it ended on.
    const g = await read($, gallery)
    if (g.mode === 'view') await enterView($, g.index, at ?? 0)
    else focusOn($, tileKey(g.index))
    return
  }
  // A second f while the first is still starting (or cleaning up): one player only, and the person is told.
  if (isStarting) {
    $.ui.toast('Fullscreen is still starting.')
    return
  }
  isStarting = true
  try {
    await enterFullscreen($)
  } finally {
    isStarting = false
  }
}

async function enterFullscreen($: EngineInterface): Promise<void> {
  const ticket = ++fullscreens
  // Moves wait while it starts, so the pane and the player start on the same item.
  await editGallery($, x => ({ ...x, fullscreen: 'starting' }))
  const hasStarted = await startFullscreen($, ticket).catch(() => false)
  // Given up before a player started: the pane is as it was.
  if (!hasStarted) await editGallery($, x => (x.fullscreen === 'starting' ? { ...x, fullscreen: 'off' } : x))
}

/** True once a player was started: from then on, its own ending puts the state back. */
async function startFullscreen($: EngineInterface, ticket: number): Promise<boolean> {
  const machine = await setup($)
  const g = await read($, gallery)
  const set = (await read($, sets))[g.setId]
  const item = set?.items[g.index]
  if (!set || !item) return false
  if (item.error) {
    $.ui.toast(`Cannot show ${item.name}: ${item.error}.`)
    return false
  }
  if ('reason' in machine.fullscreen) {
    $.ui.toast(`No fullscreen here: ${machine.fullscreen.reason}.`)
    return false
  }
  if (!(await canReachTerminal($))) {
    $.ui.toast('No fullscreen: pepper-play cannot reach the terminal (/dev/tty) from Claude Code.')
    return false
  }
  const sock = `${machine.cache}/mpv-${hashOf(`${ticket}:${await $.clock.now()}:${Math.random()}`).slice(0, 10)}.sock`
  // Every wait comes before the ticket check: from the check to the spawn nothing waits, so no leave slips between.
  await editGallery($, x => ({ ...x, fullscreen: 'starting', frames: '', framesOf: '' }))
  // The set and the item the pane is on now, read again after the waits above. Only the items it can play
  // go in mpv's list, kept as they are now: that list does not change after this.
  const now = await read($, gallery)
  const shown = (await read($, sets))[now.setId] ?? set
  const playlist = playableOf(shown.items)
  if (playlist.length === 0) {
    $.ui.toast('Nothing here can be shown fullscreen.')
    return false
  }
  // An item found unreadable meanwhile is not in the list: the pane moves to the nearest that is, so mpv, its
  // text over the video and the pane all name one item.
  const startAt = playlist.includes(now.index) ? now.index : nearestIn(playlist, now.index)
  if (startAt !== now.index) await editGallery($, x => ({ ...x, index: startAt }))
  // Left, or the pane closed, while this was starting.
  if (ticket !== fullscreens) return false
  stopPlayer()
  const argv = [
    machine.fullscreen.player,
    `--input-ipc-server=${sock}`,
    '--idle=yes',
    '--keep-open=yes',
    '--image-display-duration=inf',
    '--loop-file=inf',
    `--playlist-start=${playlist.indexOf(startAt)}`,
    '--',
    ...playlist.map(index => shown.items[index]?.path ?? ''),
  ]
  let isStopped = false
  let hasEnded = false
  let complaint = ''
  let placed = ''
  const place = async (extra: (string | number)[][] = []): Promise<void> => {
    const size = await tabSize($)
    const next = `${size.columns}x${size.rows}`
    if (isStopped || (next === placed && extra.length === 0)) return
    placed = next
    await ipc($, sock, [placeCommandOf(size.columns, size.rows), ...extra])
  }
  const running: Fullscreen = {
    sock,
    playlist,
    stop: () => void (isStopped = true),
    // The tab resized, or Pepper's window went full screen (⌘↩): the box follows.
    refit: () => void (placed ? place() : undefined),
  }
  fullscreen = running
  void (async () => {
    try {
      // Stopped between the check and here cannot happen (nothing waits), but a stopped start never spawns.
      if (isStopped) return
      for await (const piece of $.process.spawn({ argv })) {
        if (piece.stream === 'stderr') complaint = (complaint + piece.text).slice(-600)
        if (isStopped) break
      }
    } catch (error) {
      complaint ||= error instanceof Error ? error.message : String(error)
    } finally {
      const wasStopped = isStopped
      isStopped = true
      hasEnded = true
      if (fullscreen === running) {
        fullscreen = null
        await editGallery($, x => ({ ...x, fullscreen: 'off' })).catch(() => undefined)
        if (complaint && !wasStopped) $.ui.toast(`pepper-play stopped: ${lastLine(complaint)}`)
        // It ended by itself, not by the person: the pane takes the video back.
        if (!wasStopped) await backToPane($).catch(() => undefined)
      }
    }
  })()
  let isUp = false
  for (let tries = 0; tries < 80 && !isUp && !isStopped; tries++) {
    isUp = await $.fs.exists(sock)
    if (!isUp) await $.clock.sleep(50)
  }
  if (isStopped || !isUp) {
    // Left while it started, it ended by itself, or it never answered: no player stays behind the tab.
    const isLeft = !hasEnded && fullscreen !== running
    const hasTimedOut = !hasEnded && !isLeft
    if (fullscreen === running) await leaveFullscreen($)
    await killPlayer($, sock)
    if (hasTimedOut && !complaint) $.ui.toast('pepper-play did not start: it needs mpv (brew install mpv).')
    // One that ended by itself went back to the pane as it ended; one that never answered goes back now.
    if (hasTimedOut) await backToPane($)
    return true
  }
  await place([osdOf(shown, startAt)])
  await editGallery($, x => (fullscreen === running ? { ...x, fullscreen: 'on' } : x))
  return true
}

/** Fullscreen moves, one after another. */
let fullscreenMoves: Promise<void> = Promise.resolve()
/** The tag of the question where in its list mpv is. */
const POS_ASKED = 8

/** One h or l in fullscreen, worked out from where mpv is, so the pane and the player cannot drift apart. */
async function moveFullscreen($: EngineInterface, running: Fullscreen, set: MediaSet, direction: 'left' | 'right'): Promise<void> {
  const answer = await ipcAnswer($, running.sock, [ipcLine(['get_property', 'playlist-pos'], POS_ASKED)])
  const pos = answer === null ? null : answerOf(answer, POS_ASKED)
  // Where mpv is, as an item of the set; the pane's own item when mpv does not say.
  const playing = pos === null ? undefined : running.playlist[pos]
  let from = 0
  const moved = await editGallery($, x => {
    from = playing ?? x.index
    const index = stepInPlaylist(running.playlist, from, direction)
    return index === x.index ? x : { ...x, index }
  })
  if (moved.index === from || fullscreen !== running) return
  await ipc($, running.sock, [['playlist-play-index', running.playlist.indexOf(moved.index)], osdOf(set, moved.index)])
}

// Keys ----------------------------------------------------------------------------

async function act($: EngineInterface, action: KeyAction): Promise<void> {
  const g = await read($, gallery)
  const set = (await read($, sets))[g.setId]
  if (!set || set.items.length === 0) return
  const count = set.items.length
  switch (action) {
    case 'close':
      await $.ui.close({ id: PANE })
      return
    case 'fullscreen':
      await toggleFullscreen($)
      return
    case 'play':
      if (g.fullscreen === 'starting') return
      await togglePlay($)
      return
    case 'back':
    case 'forward':
      await toPlayer($, [['seek', action === 'back' ? -10 : 10]])
      return
    case 'open':
      await enterView($, g.index)
      return
    case 'grid':
      viewPending = null
      stopPlayer()
      await editGallery($, x => ({ ...x, mode: 'grid', frames: '', framesOf: '', isPaused: false }))
      focusOn($, tileKey(g.index))
      return
  }
  const direction: Direction = action
  // Each move is worked out from the gallery as it is when written, so presses
  // that overlap (a held key) each move once rather than all from the same place.
  let hasMoved = false
  const moveBy = (to: (index: number) => number) => (x: Gallery): Gallery => {
    const index = to(x.index)
    hasMoved = index !== x.index
    return hasMoved ? { ...x, index } : x
  }
  if (g.fullscreen !== 'off' || g.mode === 'view') {
    // Until the player answers, a move would leave the pane and the player on different items.
    if (direction === 'up' || direction === 'down' || g.fullscreen === 'starting') return
    if (g.fullscreen === 'on') {
      const running = fullscreen
      if (!running) return
      const move = fullscreenMoves.then(() => moveFullscreen($, running, set, direction))
      fullscreenMoves = move.catch(() => undefined)
      await move
      return
    }
    const moved = await editGallery($, moveBy(index => step(index, direction, count, 1)))
    if (hasMoved) await enterView($, moved.index)
    return
  }
  const moved = await editGallery($, moveBy(index => step(index, direction, count, perRow)))
  focusOn($, tileKey(moved.index))
}

// Drawing -------------------------------------------------------------------------

const labelOf = (item: MediaItem): string => (item.kind === 'video' ? `▶ ${item.seconds ? `${formatDuration(item.seconds)} ` : ''}${item.name}` : item.name)

/** One picture centered in a box of cells, or words in its place. */
async function pictureBox(
  $: EngineInterface,
  ui: Terminal,
  plan: ImagePlan | null,
  item: MediaItem,
  path: string,
  columns: number,
  rows: number,
  options: { key?: string; generation?: number; fallback?: string } = {},
): Promise<RenderElement> {
  const { Box, Text, Image } = ui
  // A picture the terminal cannot be sent (bytes past 2 MiB) shows its thumbnail instead.
  const fallback = options.fallback && options.fallback !== path ? options.fallback : ''
  const source = (await sourceOf($, plan, path, options.generation)) ?? (fallback ? await sourceOf($, plan, fallback) : null)
  const fit = fitBox(item.width, item.height, columns, rows)
  const words = item.error ? `✕ ${item.error}` : !plan ? (item.kind === 'video' ? '▶ video' : 'picture') : path ? '' : '…'
  return (
    <Box width={columns} height={rows} justifyContent="center" alignItems="center" overflow="hidden">
      {source ? (
        <Image key={options.key} source={source} columns={fit.columns} rows={fit.rows} alt={item.name} />
      ) : (
        <Text dimColor wrap="truncate-end">
          {words || '…'}
        </Text>
      )}
    </Box>
  )
}

/** A press's work, its failure told in a toast rather than lost. */
const pressing =
  ($: EngineInterface, work: () => Promise<unknown>) =>
  (): void => {
    void work().catch((error: unknown) => $.ui.toast(`media-gallery: ${error instanceof Error ? error.message : String(error)}`))
  }

/** The plan for one drawing: iTerm2 draws pictures only under the fullscreen renderer. */
const drawPlan = (plan: ImagePlan | null, e: { surface: string; viewport?: { isFullscreen?: boolean } }): ImagePlan | null =>
  e.surface === 'terminal' && plan && !(plan.needsFullscreen && e.viewport?.isFullscreen === false) ? plan : null

/** Thumbnails in a row under a transcript row, and a way into the gallery. */
async function stripOf($: EngineInterface, ui: Terminal, plan: ImagePlan | null, set: MediaSet, columns: number): Promise<RenderElement> {
  const { Box, Text, Button } = ui
  const room = Math.max(STRIP_WIDTH, columns - 2)
  const shown = set.items.slice(0, Math.max(1, Math.floor((room + 1) / (STRIP_WIDTH + 1))))
  const tiles = await Promise.all(
    shown.map(async (item, index) => (
      <Box key={`strip:${index}`} flexDirection="column" width={STRIP_WIDTH}>
        {await pictureBox($, ui, plan, item, item.thumb, STRIP_WIDTH, STRIP_ROWS)}
        <Button key={`strip:${set.id}:${index}`} plain dimColor onPress={pressing($, () => openGallery($, set.id, index, 'view'))}>
          {clipMiddle(labelOf(item), STRIP_WIDTH)}
        </Button>
      </Box>
    )),
  )
  const more = set.items.length - shown.length
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row" gap={1}>
        {tiles}
      </Box>
      <Box flexDirection="row" gap={2}>
        <Button key={`open:${set.id}`} plain onPress={pressing($, () => openGallery($, set.id, 0, 'grid'))}>
          {`▦ Open the gallery: ${countOf(set.items)}${more > 0 ? ` (${more} more)` : ''}`}
        </Button>
        <Text dimColor>h j k l move · ⏎ view · f fullscreen</Text>
      </Box>
    </Box>
  )
}

/** The line under a video in view: why it does not play, or how it plays. */
const videoStatusOf = (item: MediaItem, canDraw: boolean, isPlaying: boolean, isPaused: boolean): string => {
  if (!canDraw) return 'pictures do not show in this terminal'
  if (setupDone && !setupDone.ffmpeg) return 'needs ffmpeg to play'
  if (unplayable.has(item.path)) return 'ffmpeg could not play this one in the pane: p tries again, f plays it fullscreen'
  if (isPaused) return '❚❚ paused'
  return isPlaying ? '▶ playing, muted (f for sound)' : '▶ starting…'
}

/** A transcript row with its set's thumbnails under it. */
async function stripUnder(
  $: EngineInterface,
  ui: Terminal,
  row: RenderElement,
  set: MediaSet,
  e: { surface: string; viewport?: { columns: number; isFullscreen?: boolean } },
): Promise<RenderElement> {
  const { Box } = ui
  const plan = drawPlan((await surface($)).plan, e)
  return (
    <Box flexDirection="column">
      {row}
      {await stripOf($, ui, plan, set, e.viewport?.columns ?? 80)}
    </Box>
  )
}

/**
 * After a reload, which ended the work the code before it was doing: the
 * thumbnails a set still lacks are made, the shown set's first, and a video in
 * view plays again.
 */
async function resumeWork($: EngineInterface): Promise<void> {
  const g = await read($, gallery)
  const all = await read($, sets)
  const item = all[g.setId]?.items[g.index]
  // Only into a pane that is open and drawn: a closed one plays nothing.
  const isPaneUp = (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE && pane.isPlaced)
  if (isPaneUp && g.mode === 'view' && item?.kind === 'video' && !item.error) void startPlayer($, g, item, 0).catch(() => undefined)
  const canDraw = (await surface($)).plan !== null
  const lacking = Object.values(all)
    .filter(set => set.items.some(one => needsWork(one, canDraw)))
    .sort((a, b) => Number(b.id === g.setId) - Number(a.id === g.setId) || b.createdAt - a.createdAt)
  for (const set of lacking) await prepare($, set.id)
}

// The mod -------------------------------------------------------------------------

export const register: Register = (on, options) => {
  takesKeysOnShow = options.takeKeys === 'always'
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload ended any play and fullscreen of the code before it: the state says so too.
    await editGallery($, g => ({ ...g, fullscreen: 'off', frames: '', framesOf: '', isPaused: false })).catch(() => undefined)
    void setup($).catch(() => undefined)
    void resumeWork($).catch(() => undefined)
    await $.tool.register({
      name: 'show',
      description:
        'Show pictures or videos to the person inside the Claude Code chat. The call draws a strip of thumbnails in the chat and opens a gallery pane they browse with h j k l, open with Enter, and play fullscreen with f (sound included, in the Pepper terminal). ' +
        'Unless the person set the gallery to take the keys, the pane opens without the keyboard: they give it the keys with ctrl+x tab or a click. ' +
        'Use it when they ask to see, preview or compare images, screenshots, renders or videos, or when showing a file you made or found helps. ' +
        'Takes files, folders (their pictures and videos) and patterns with * in the file name. You do not see the pictures yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files, folders, or patterns like ~/shots/*.png. Absolute, ~/..., or relative to the working folder.',
          },
          title: { type: 'string', description: "The gallery's title. Defaults to the first path." },
          start: { type: 'integer', minimum: 0, description: 'Which item the gallery opens on, from 0.' },
          view: { type: 'boolean', description: 'Open on that item full size instead of the grid.' },
        },
        required: ['paths'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description: 'Show pictures and videos in a gallery: h j k l move, Enter views, f fullscreen',
      argumentHint: '[file | folder | pattern ...]',
    })
    return started
  })

  // A pattern, not the name: the types list this tool only once a load has registered it.
  on('tool.call', { tool: /^mcp__media-gallery__show$/ }, async ($, e) => {
    const input = e as unknown as { paths?: unknown; title?: unknown; start?: unknown; view?: unknown }
    const paths = (Array.isArray(input.paths) ? input.paths : typeof input.paths === 'string' ? [input.paths] : []).filter(
      (path): path is string => typeof path === 'string',
    )
    if (paths.length === 0) return { result: 'Nothing to show: give `paths`, a list of files, folders or patterns.' }
    const { home } = await surface($)
    const found = await collect($, paths, home)
    if (found.items.length === 0) return { result: `Nothing to show: ${found.skipped.join('; ')}.` }
    const named = basename(resolveInput(paths[0] ?? '.', await $.session.cwd(), home))
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : named || 'Gallery'
    const start = typeof input.start === 'number' ? Math.floor(input.start) : 0
    const set = await showSet($, e.tool_use_id, title, found, start)
    const placement = await openGallery($, set.id, start, input.view === true ? 'view' : 'grid', takesKeysOnShow).then(
      (isPlaced): PanePlacement => (isPlaced ? 'open' : 'waiting'),
      (): PanePlacement => 'failed',
    )
    return { result: summaryOf(set, found.skipped, placement, takesKeysOnShow) }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const { home } = await surface($)
    const words = splitArgs(e.args)
    if (words.length === 0) {
      // Back to the gallery the pane last showed, where it was; else the newest; else the working folder's pictures.
      const all = await read($, sets)
      const g = await read($, gallery)
      const last = all[g.setId] ?? Object.values(all).sort((a, b) => b.createdAt - a.createdAt)[0]
      if (last) {
        await openGallery($, last.id, last.id === g.setId ? g.index : 0, 'grid')
        // A /gallery's set is named, so this row draws it too; a tool's set is drawn under the tool's row.
        const tag = tagOfSetId(last.id)
        return { text: `Gallery${tag ? ` ${tag}` : ''}: ${last.title}, ${countOf(last.items)}.` }
      }
    }
    const inputs = words.length ? words : ['.']
    const found = await collect($, inputs, home)
    if (found.items.length === 0) return { text: `Nothing to show: ${found.skipped.join('; ')}.` }
    const title = inputs.length === 1 ? basename(resolveInput(inputs[0] ?? '.', await $.session.cwd(), home)) : `${inputs.length} places`
    // The same pictures as a /gallery set already kept: that set again, under its own name, rather than a copy.
    const paths = found.items.map(item => item.path).join('\n')
    const same = Object.values(await read($, sets)).find(one => tagOfSetId(one.id) && one.items.map(item => item.path).join('\n') === paths)
    let set: MediaSet
    if (same) {
      // Read anew under the same name where a file changed since (its stamp differs); the rest keep what was
      // made for them, so the strips and the pane do not blank and nothing unchanged is probed again.
      const before = new Map(same.items.map(item => [item.path, item]))
      const items = await Promise.all(
        found.items.map(async item => {
          const old = before.get(item.path)
          // An item that failed before is tried again, and so is one whose thumbnail has gone from the cache.
          if (!old?.stamp || old.error) return item
          if (old.thumb && !(await $.fs.exists(old.thumb))) return item
          return (await stampOf($, item.path))?.stamp === old.stamp ? old : item
        }),
      )
      set = { ...same, items, total: found.total, createdAt: await $.clock.now() }
      await keepSet($, set)
    } else {
      // Each new set is named in its line: its row draws that set and no later one.
      set = await showSet($, `cmd-${hashOf(`${await $.clock.now()}:${Math.random()}`).slice(0, 8)}`, title, found)
    }
    await openGallery($, set.id, 0, 'grid')
    const skipped = found.skipped.length ? ` Left out: ${found.skipped.join('; ')}.` : ''
    return { text: `Gallery ${tagOfSetId(set.id)}: ${set.title}, ${countOf(set.items)}.${skipped}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPlayer()
    viewPending = null
    // Not waited on: a wedged player's socket must not hold the pane open.
    void leaveFullscreen($).catch(() => undefined)
    // No frame is shown in a closed pane: every frames file goes.
    void dropAllFrames($).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopPlayer()
    await leaveFullscreen($).catch(() => undefined)
    await dropAllFrames($).catch(() => undefined)
    return next(e)
  })

  // Under the tool's row: the thumbnails it showed.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    const row = await next(e)
    const set = (await read($, sets))[e.props.tool_use_id]
    return e.surface === 'terminal' && set ? stripUnder($, $.ui.resolve(e), row, set, e) : row
  })

  // Under /gallery's line: the set its line names. A line that names none draws no strip.
  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) => {
    const row = await next(e)
    const tag = galleryTagOf(e.props.text)
    const set = tag ? (await read($, sets))[`cmd-${tag}`] : undefined
    return e.surface === 'terminal' && set && !e.props.isErrored ? stripUnder($, $.ui.resolve(e), row, set, e) : row
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    noteViewport(e.viewport)
    const g = await read($, gallery)
    // A view opened while the pane waited for room starts now that the pane is drawn: on a timer, as a drawing writes nothing.
    const pending = viewPending
    if (pending) {
      viewPending = null
      if (isInView(g, pending)) $.clock.after(0, () => void enterView($, pending.index).catch(() => undefined))
    }
    const set = (await read($, sets))[g.setId]
    if (!set || set.items.length === 0) return <Text dimColor>Nothing to show. Run /gallery with a folder, or ask Claude to show you pictures.</Text>
    const plan = drawPlan((await surface($)).plan, e)
    // What the player reads before it makes frames: a pane that draws no pictures gets none.
    paneCanDraw = plan !== null
    const terminal = e.surface === 'terminal' && 'Image' in ui ? (ui as Terminal) : null

    const columns = Math.max(16, e.props.bodyColumns)
    const rows = Math.max(8, e.props.scroll.bodyRows)
    const count = set.items.length
    const index = Math.max(0, Math.min(count - 1, g.index))
    const item = set.items[index] ?? set.items[0]
    if (!item) return <Text dimColor>Nothing to show.</Text>
    const isFullscreen = g.fullscreen !== 'off'
    const legend = legendOf(g.mode, isFullscreen, item.kind === 'video')

    const facts = [
      `${index + 1}/${count}`,
      item.seconds ? formatDuration(item.seconds) : '',
      item.bytes ? formatSize(item.bytes) : '',
    ].filter(Boolean)
    const header = (
      <Box flexDirection="row" gap={1} width={columns}>
        <Text bold wrap="truncate-middle">
          {item.name}
        </Text>
        <Text dimColor wrap="truncate-end">
          {facts.join(' · ')}
        </Text>
      </Box>
    )

    const footer = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} width={columns}>
        {legend.map(key => (
          <Button
            key={`key:${key.action}`}
            hotkey={key.hotkey}
            plain
            label={key.label}
            // In view mode Enter goes back to the grid: the ring starts there, as it starts on the selected tile in the grid.
            autoFocus={g.mode === 'view' && !isFullscreen && key.action === 'grid' ? true : undefined}
            onPress={pressing($, () => act($, key.action))}
          />
        ))}
        {g.mode === 'grid' && !isFullscreen && <Text dimColor>⏎ view</Text>}
        {g.mode === 'view' && !isFullscreen && <Text dimColor>⏎ grid</Text>}
        {!e.props.isFocused && <Text color="warning">ctrl+x tab to use the keys</Text>}
      </Box>
    )

    if (isFullscreen) {
      return (
        <Box flexDirection="column" width={columns}>
          {header}
          <Text dimColor>{g.fullscreen === 'starting' ? 'Starting fullscreen…' : 'Fullscreen in Pepper. The keys below still work.'}</Text>
          {footer}
        </Box>
      )
    }

    if (g.mode === 'view') {
      const pictureRows = Math.max(3, rows - 4)
      const isPlaying = g.frames !== '' && g.framesOf === item.path
      // A picture of unknown shape would be stretched to its box: words until its size is read.
      const hasShape = item.width > 0 && item.height > 0
      const path = !hasShape ? '' : isPlaying ? g.frames : g.pictureOf === item.path && g.picture ? g.picture : item.thumb
      const status = item.kind === 'video' ? videoStatusOf(item, plan !== null, isPlaying, g.isPaused) : ''
      const picture = terminal
        ? await pictureBox($, terminal, plan, item, path, columns, pictureRows, {
            key: 'view',
            generation: isPlaying && hasShape ? frame : undefined,
            fallback: hasShape ? item.thumb : undefined,
          })
        : (
            <Text dimColor>{item.path}</Text>
          )
      return (
        <Box flexDirection="column" width={columns}>
          {header}
          {picture}
          {status ? <Text dimColor>{status}</Text> : <Text dimColor wrap="truncate-start">{item.path}</Text>}
          {footer}
        </Box>
      )
    }

    // The grid.
    const tileWidth = Math.min(TILE_WIDTH, columns)
    perRow = Math.max(1, Math.floor((columns + 1) / (tileWidth + 1)))
    // The legend wraps when the pane is narrow: a page of tiles leaves it the rows it takes.
    const footerWords = [
      ...legend.map(key => `${key.hotkey}: ${key.label}`),
      '⏎ view',
      ...(e.props.isFocused ? [] : ['ctrl+x tab to use the keys']),
    ]
    const footerRows = wrappedRowsOf(footerWords, columns)
    const rowsShown = Math.max(1, Math.floor((rows - 2 - footerRows) / TILE_HEIGHT))
    const page = pageOf(index, count, perRow, rowsShown)
    const pageCount = Math.ceil(Math.ceil(count / perRow) / rowsShown)
    const pageNumber = Math.floor(Math.floor(page.first / perRow) / rowsShown) + 1
    const tiles = await Promise.all(
      set.items.slice(page.first, page.last).map(async (one, offset) => {
        const at = page.first + offset
        const isSelected = at === index
        return (
          <Box
            key={`box:${at}`}
            flexDirection="column"
            width={tileWidth}
            height={TILE_HEIGHT}
            borderStyle="round"
            borderColor={isSelected ? 'claude' : 'subtle'}
            borderDimColor={!isSelected}
          >
            {terminal ? (
              await pictureBox($, terminal, plan, one, one.thumb, tileWidth - 2, TILE_PICTURE_ROWS)
            ) : (
              <Box height={TILE_PICTURE_ROWS} />
            )}
            <Button
              key={tileKey(at)}
              plain
              dimColor={!isSelected}
              autoFocus={isSelected ? true : undefined}
              onPress={pressing($, () => enterView($, at))}
            >
              {clipMiddle(labelOf(one), tileWidth - 2)}
            </Button>
          </Box>
        )
      }),
    )
    return (
      <Box flexDirection="column" width={columns}>
        {header}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={columns}>
          {tiles}
        </Box>
        {pageCount > 1 && <Text dimColor>{`page ${pageNumber} of ${pageCount}`}</Text>}
        {footer}
      </Box>
    )
  })
}
