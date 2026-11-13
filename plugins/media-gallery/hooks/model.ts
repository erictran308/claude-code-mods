// What media-gallery works out without `$`: paths, shapes, grid moves, labels.
// Everything here is plain functions, so the tests reach all of it.

import type { Gallery, GalleryMode, MediaItem, MediaKind, MediaSet } from '../types'

// Kinds ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'jxl'])
// A GIF moves, so it plays as a video does.
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'gif', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'ogv', 'm2ts', 'mts'])

export const extensionOf = (name: string): string => {
  const base = basename(name)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export const kindOf = (name: string): MediaKind | null => {
  const extension = extensionOf(name)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return null
}

/** HEIF holds its picture as tiles, which ffmpeg reads one at a time: macOS's sips reads it whole. */
export const needsSips = (name: string): boolean => ['heic', 'heif'].includes(extensionOf(name))

export const newItem = (path: string, kind: MediaKind): MediaItem => ({
  path,
  name: basename(path),
  kind,
  stamp: '',
  thumb: '',
  width: 0,
  height: 0,
  seconds: 0,
  bytes: 0,
  error: '',
})

// Paths ---------------------------------------------------------------------------

export const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export const dirname = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

export const joinPath = (folder: string, name: string): string => `${folder.replace(/\/+$/, '')}/${name}`

/** Folds `.`, `..` and doubled slashes out of an absolute path. */
export const normalizePath = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** An absolute path from what a person or the model typed: `~`, a `file:` URL, or relative to the session's folder. */
export const resolveInput = (input: string, cwd: string, home: string): string => {
  let path = input.trim()
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      // A file on this machine: no host, or `localhost`.
      if (url.host === '' || url.host === 'localhost') path = decodeURIComponent(url.pathname)
    } catch {
      path = path.replace(/^file:\/\//i, '')
    }
  }
  if (path === '~') path = home
  else if (path.startsWith('~/')) path = home + path.slice(1)
  if (!path.startsWith('/')) path = joinPath(cwd, path)
  return normalizePath(path)
}

/** Only the last part of a path may hold `*` or `?`: `~/shots/*.png`. */
export const hasWildcard = (path: string): boolean => /[*?]/.test(basename(path))

export const wildcardOf = (pattern: string): RegExp =>
  new RegExp(`^${[...pattern].map(ch => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegExp(ch))).join('')}$`, 'i')

/** `shot 2` before `shot 10`. */
export const naturalCompare = (a: string, b: string): number => {
  const parts = /(\d+)|(\D+)/g
  const left = a.toLowerCase().match(parts) ?? []
  const right = b.toLowerCase().match(parts) ?? []
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i] ?? ''
    const y = right[i] ?? ''
    if (x === y) continue
    if (/^\d/.test(x) && /^\d/.test(y)) return Number(x) - Number(y) || x.length - y.length
    return x < y ? -1 : 1
  }
  return left.length - right.length || (a < b ? -1 : a > b ? 1 : 0)
}

/** A command's arguments as a shell would split them: quotes and backslashes keep spaces. */
export const splitArgs = (text: string): string[] => {
  const words: string[] = []
  let word = ''
  let hasWord = false
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (quote) {
      // Inside double quotes a backslash keeps the next `"`, `\`, `$` or backtick, as a shell does.
      const next = text[i + 1] ?? ''
      if (quote === '"' && ch === '\\' && '"\\$`'.includes(next) && next) word += text[++i] ?? ''
      else if (ch === quote) quote = ''
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text[++i] ?? ''
      hasWord = true
    } else if (/\s/.test(ch)) {
      if (hasWord) words.push(word)
      word = ''
      hasWord = false
    } else {
      word += ch
      hasWord = true
    }
  }
  if (hasWord) words.push(word)
  return words
}

// Cache names ---------------------------------------------------------------------

/** 16 hex digits: two FNV-1a style rounds, enough to name cached pictures apart. */
export const hashOf = (text: string): string => {
  let a = 0x811c9dc5
  let b = 0x9747b28c
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 13)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

// Pictures ------------------------------------------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const decodeBase64 = (text: string): number[] => {
  const bytes: number[] = []
  let bits = 0
  let held = 0
  for (const ch of text) {
    const value = BASE64.indexOf(ch)
    if (value < 0) break
    bits = (bits << 6) | value
    held += 6
    if (held >= 8) {
      held -= 8
      bytes.push((bits >> held) & 0xff)
    }
  }
  return bytes
}

/** A PNG's width and height, from its header in base64. */
export const pngSizeOf = (base64: string): { width: number; height: number } | null => {
  const head = decodeBase64(base64.slice(0, 32))
  if (head.length < 24 || head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return null
  const word = (at: number): number =>
    (((head[at] ?? 0) << 24) | ((head[at + 1] ?? 0) << 16) | ((head[at + 2] ?? 0) << 8) | (head[at + 3] ?? 0)) >>> 0
  const width = word(16)
  const height = word(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** A video's length in seconds from ffprobe's `format=duration` in JSON; 0 when it does not say. */
export const parseDuration = (json: string): number => {
  try {
    const data: unknown = JSON.parse(json)
    const format = typeof data === 'object' && data !== null ? (data as { format?: { duration?: unknown } }).format : undefined
    const seconds = Number(format?.duration)
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  } catch {
    return 0
  }
}

/** How tall a terminal cell is for its width, in most monospace fonts. */
export const CELL_ASPECT = 2

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))

/**
 * The cells a picture of this shape takes inside a box, keeping its shape: an
 * `Image` stretches to the cells it is given.
 */
export const fitBox = (width: number, height: number, maxColumns: number, maxRows: number): { columns: number; rows: number } => {
  const columns = clamp(Math.floor(maxColumns), 1, 255)
  const rows = clamp(Math.floor(maxRows), 1, 255)
  if (!(width > 0 && height > 0)) return { columns, rows }
  const rowsAtFullWidth = (columns * height) / width / CELL_ASPECT
  if (rowsAtFullWidth <= rows) return { columns, rows: clamp(Math.round(rowsAtFullWidth), 1, rows) }
  return { columns: clamp(Math.round((rows * CELL_ASPECT * width) / height), 1, columns), rows }
}

// The grid ------------------------------------------------------------------------

export type Direction = 'left' | 'down' | 'up' | 'right'

/** Where h, j, k or l lands from `index` in a grid `perRow` wide. */
export const step = (index: number, direction: Direction, count: number, perRow: number): number => {
  if (count <= 0) return 0
  const per = Math.max(1, perRow)
  const at = clamp(index, 0, count - 1)
  if (direction === 'left') return Math.max(0, at - 1)
  if (direction === 'right') return Math.min(count - 1, at + 1)
  if (direction === 'up') return at - per >= 0 ? at - per : at
  if (at + per < count) return at + per
  // Above a short last row, down lands on its last tile rather than nowhere.
  return Math.floor(at / per) < Math.floor((count - 1) / per) ? count - 1 : at
}

/** The rows of tiles on screen: whole pages, so a page holds still while the selection moves in it. */
export const pageOf = (index: number, count: number, perRow: number, rowsShown: number): { first: number; last: number } => {
  const per = Math.max(1, perRow)
  const shown = Math.max(1, rowsShown)
  const firstRow = Math.floor(Math.floor(clamp(index, 0, Math.max(0, count - 1)) / per) / shown) * shown
  return { first: firstRow * per, last: Math.min(count, (firstRow + shown) * per) }
}

/**
 * How many rows a wrapping row of words takes in `columns`, with `gap` cells
 * between them: what the pane's legend costs, so a page of tiles leaves it room.
 */
export const wrappedRowsOf = (words: readonly string[], columns: number, gap = 2): number => {
  let rows = 1
  let used = 0
  for (const word of words) {
    const width = [...word].length
    if (used > 0 && used + gap + width > columns) {
      rows++
      used = width
    } else {
      used += (used > 0 ? gap : 0) + width
    }
  }
  return rows
}

/** The items fullscreen can play, by their place in the set: one that cannot be read is left out of mpv's list. */
export const playableOf = (items: readonly MediaItem[]): number[] => items.flatMap((item, index) => (item.error ? [] : [index]))

/** The item of `playlist` nearest `index` (the later one on a tie), or `index` when the list is empty. */
export const nearestIn = (playlist: readonly number[], index: number): number =>
  playlist.reduce((best, one) => (Math.abs(one - index) < Math.abs(best - index) || (Math.abs(one - index) === Math.abs(best - index) && one > best) ? one : best), playlist[0] ?? index)

/** A set's indexes nearest `from` first, going outward (the later one first on a tie): the page in view fills first. */
export const outwardFrom = (count: number, from: number): number[] => {
  const start = Math.max(0, Math.min(count - 1, from))
  const order: number[] = []
  for (let distance = 0; order.length < count; distance++) {
    if (start + distance < count) order.push(start + distance)
    if (distance > 0 && start - distance >= 0) order.push(start - distance)
  }
  return order
}

/** The width and height ffprobe printed as `W,H` (`-of csv=p=0`); null when it did not. */
export const probeSizeOf = (output: string): { width: number; height: number } | null => {
  const [, width = '0', height = '0'] = /(\d+),(\d+)/.exec(output) ?? []
  return Number(width) > 0 && Number(height) > 0 ? { width: Number(width), height: Number(height) } : null
}

export const NO_GALLERY: Gallery = {
  setId: '',
  index: 0,
  mode: 'grid',
  picture: '',
  pictureOf: '',
  frames: '',
  framesOf: '',
  isPaused: false,
  fullscreen: 'off',
}

/** Opens a set at an item: everything made for the last one is dropped. */
export const galleryAt = (setId: string, index: number, mode: GalleryMode): Gallery => ({ ...NO_GALLERY, setId, index, mode })

/** One item's news, if the set still holds that item where it was. */
export const patchItem = (
  all: Readonly<Record<string, MediaSet>>,
  setId: string,
  index: number,
  path: string,
  patch: Partial<MediaItem>,
): Readonly<Record<string, MediaSet>> => {
  const set = all[setId]
  // Nothing to change: the same value back, so nothing is written or drawn again.
  if (!set || set.items[index]?.path !== path) return all
  const items = set.items.map((item, at) => (at === index ? { ...item, ...patch } : item))
  return { ...all, [setId]: { ...set, items } }
}

/** Adds a set, keeping the newest `keep` and, whatever its age, the one `pinned` names (the pane's). */
export const withSet = (
  all: Readonly<Record<string, MediaSet>>,
  set: MediaSet,
  keep: number,
  pinned = '',
): Record<string, MediaSet> => {
  const others = Object.values(all)
    .filter(one => one.id !== set.id)
    .sort((a, b) => b.createdAt - a.createdAt)
  const kept = others.slice(0, Math.max(0, keep - 1))
  const pin = others.find(one => one.id === pinned)
  if (pin && !kept.includes(pin)) kept.push(pin)
  return Object.fromEntries([...kept, set].map(one => [one.id, one]))
}

// Words ---------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0')

export const formatDuration = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  return hours ? `${hours}:${pad2(minutes)}:${pad2(whole % 60)}` : `${minutes}:${pad2(whole % 60)}`
}

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['K', 'M', 'G', 'T']
  let value = bytes
  let unit = -1
  while (value >= 1023.5 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Cuts the middle out of a long name, so its start and its extension both show. */
export const clipMiddle = (text: string, width: number): string => {
  const chars = [...text]
  if (chars.length <= width) return text
  if (width <= 1) return '…'.slice(0, Math.max(0, width))
  const keep = width - 1
  const head = Math.ceil(keep / 2)
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`
}

/** Control and text-direction characters, by code: the source then holds none of them itself. */
const isUnprintable = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)

/** Control and direction characters out, for a name drawn in mpv's on-screen text. */
export const printable = (text: string): string => [...text].map(ch => (isUnprintable(ch.codePointAt(0) ?? 0) ? '?' : ch)).join('')

/** Text matched as itself in a regular expression: `pkill -f` reads its pattern as one. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const countOf = (items: readonly MediaItem[]): string => {
  const pictures = items.filter(item => item.kind === 'image').length
  const videos = items.length - pictures
  const parts = [
    pictures ? `${pictures} picture${pictures === 1 ? '' : 's'}` : '',
    videos ? `${videos} video${videos === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.join(', ') || 'nothing'
}

/** What became of the gallery pane: drawn, waiting for room, or failed to open. */
export type PanePlacement = 'open' | 'waiting' | 'failed'

/** The line the model reads back from the tool. `takesKeys`: whether the pane took the keyboard as it opened. */
export const summaryOf = (set: MediaSet, skipped: readonly string[], placement: PanePlacement, takesKeys = true): string => {
  const names = set.items.slice(0, 8).map(item => item.name)
  const more = set.items.length > names.length ? `, and ${set.items.length - names.length} more` : ''
  const pane = {
    open: takesKeys
      ? 'The gallery pane is open: the person moves with h j k l, opens one with Enter, and f plays it fullscreen.'
      : 'The gallery pane is open beside the chat, without the keyboard: the person gives it the keys with ctrl+x tab or a click, then moves with h j k l, opens one with Enter, and f plays it fullscreen.',
    waiting: 'The gallery pane waits for a wider terminal; the person can open it with /gallery or the button under the thumbnails.',
    failed: 'The gallery pane did not open; the person can try /gallery or the button under the thumbnails.',
  }[placement]
  const lines = [
    `Shown in the chat as thumbnails: ${countOf(set.items)} (${names.join(', ')}${more}).`,
    pane,
    'You do not see the pictures: describe them only from what you already know about the files.',
  ]
  if (set.total > set.items.length) lines.push(`Only the first ${set.items.length} of ${set.total} are kept.`)
  if (skipped.length) lines.push(`Left out: ${skipped.join('; ')}.`)
  return lines.join('\n')
}

// Keys ----------------------------------------------------------------------------

export type KeyAction = 'left' | 'down' | 'up' | 'right' | 'open' | 'grid' | 'play' | 'fullscreen' | 'back' | 'forward' | 'close'

export type LegendKey = { action: KeyAction; hotkey: string; label: string }

/** The keys the pane draws as its legend: a Button's hotkey only works while the Button is drawn. */
export const legendOf = (mode: GalleryMode, isFullscreen: boolean, isVideo: boolean): LegendKey[] => {
  const close: LegendKey = { action: 'close', hotkey: 'q', label: 'close' }
  if (isFullscreen) {
    const seek: LegendKey[] = isVideo
      ? [
          { action: 'back', hotkey: 'j', label: '-10s' },
          { action: 'forward', hotkey: 'k', label: '+10s' },
          { action: 'play', hotkey: 'p', label: 'pause' },
        ]
      : []
    return [
      { action: 'left', hotkey: 'h', label: 'prev' },
      { action: 'right', hotkey: 'l', label: 'next' },
      ...seek,
      { action: 'fullscreen', hotkey: 'f', label: 'leave fullscreen' },
      close,
    ]
  }
  if (mode === 'view') {
    const play: LegendKey[] = isVideo ? [{ action: 'play', hotkey: 'p', label: 'play/pause' }] : []
    return [
      { action: 'left', hotkey: 'h', label: 'prev' },
      { action: 'right', hotkey: 'l', label: 'next' },
      { action: 'grid', hotkey: 'g', label: 'grid' },
      ...play,
      { action: 'fullscreen', hotkey: 'f', label: 'fullscreen' },
      close,
    ]
  }
  return [
    { action: 'left', hotkey: 'h', label: '←' },
    { action: 'down', hotkey: 'j', label: '↓' },
    { action: 'up', hotkey: 'k', label: '↑' },
    { action: 'right', hotkey: 'l', label: '→' },
    { action: 'open', hotkey: 'o', label: 'view' },
    { action: 'fullscreen', hotkey: 'f', label: 'fullscreen' },
    close,
  ]
}

// Terminals -----------------------------------------------------------------------

export type Env = Readonly<Record<string, string | undefined>>

/**
 * A file the terminal opens itself, or the picture's bytes sent through. iTerm2
 * draws pictures only under the fullscreen renderer.
 */
export type ImagePlan = { via: 'file' | 'bytes'; needsFullscreen?: true }

const isOn = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? '')

/** What tmux is asked, for `tmuxPlanOf` to read. */
export const TMUX_IMAGE_QUESTION = '#{client_termtype}\t#{allow-passthrough}\t#{focus-events}'

const isAtLeast = (version: RegExpExecArray, major: number, minor: number): boolean => {
  const [, first = '0', second = '0'] = version
  return Number(first) > major || (Number(first) === major && Number(second) >= minor)
}

/** Reads tmux's answer on the terms the engine draws pictures there: passthrough and focus events on. */
export const tmuxPlanOf = (answer: string): ImagePlan | null => {
  const [termtype = '', passthrough = '', focusEvents = ''] = answer.replace(/\r?\n$/, '').split('\t')
  const isPassing = passthrough === 'on' || passthrough === '1'
  // A format prints a choice option as its number: off 0, on 1, all 2.
  const isAll = passthrough === 'all' || passthrough === '2'
  if ((!isPassing && !isAll) || focusEvents !== '1') return null
  const kitty = /^kitty\((\d+)\.(\d+)/.exec(termtype)
  if (/^(ghostty|kitty)( |$)/.test(termtype) || (kitty && isAtLeast(kitty, 0, 28))) return { via: 'bytes' }
  const iterm = /^iTerm2\s+(\d+)\.(\d+)/.exec(termtype)
  return isPassing && iterm && isAtLeast(iterm, 3, 5) ? { via: 'bytes', needsFullscreen: true } : null
}

/**
 * Whether tmux's answer decides if pictures get through it: inside tmux, unless
 * told to try regardless or inside another multiplexer, whose own rules win.
 * Asking it also needs the pane, which the caller holds.
 */
export const needsTmuxAnswer = (env: Env): boolean =>
  Boolean(env.TMUX) && !isOn(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES) && !env.ZELLIJ && !env.STY

/** Whether the terminal draws pictures, and how; null: names only. */
export const imagePlanOf = (env: Env, tmuxAnswer?: string): ImagePlan | null => {
  // herdr answers the engine as `libghostty`, which it does not count as able to
  // draw: pictures there wait for the engine's own override, and go as bytes.
  const forced: ImagePlan | null = isOn(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES) ? { via: 'bytes' } : null
  if (tmuxAnswer !== undefined && needsTmuxAnswer(env)) return tmuxPlanOf(tmuxAnswer)
  // Between here and the terminal, only bytes can pass, and only if it was set up to let them.
  if (env.SSH_CONNECTION || env.SSH_TTY || env.TMUX || env.ZELLIJ || env.STY) return forced
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  const term = env.TERM ?? ''
  if (program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || (program === '' && env.KITTY_WINDOW_ID)) {
    return { via: 'file' }
  }
  if (program === 'iterm.app') {
    const [major = 0, minor = 0] = (env.TERM_PROGRAM_VERSION ?? '').split('.').map(Number)
    return major > 3 || (major === 3 && minor >= 5) ? { via: 'bytes', needsFullscreen: true } : forced
  }
  return forced
}

/** Pepper's pepper-play, when its video box can reach the terminal from here; else why not. */
export type FullscreenPlan = { player: string } | { reason: string }

export const fullscreenPlanOf = (env: Env): FullscreenPlan => {
  if (!env.PEPPER_PLAY) return { reason: "fullscreen plays through Pepper's pepper-play, and this terminal is not Pepper" }
  if (env.TMUX) return { reason: "tmux keeps Pepper's video box from the terminal" }
  if (env.ZELLIJ) return { reason: "zellij keeps Pepper's video box from the terminal" }
  if (env.STY) return { reason: "GNU screen keeps Pepper's video box from the terminal" }
  if (env.SSH_CONNECTION || env.SSH_TTY) return { reason: "Pepper's video box cannot cross ssh" }
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  if (program !== 'ghostty') {
    return { reason: `${env.TERM_PROGRAM || 'a multiplexer'} sits between Claude Code and Pepper and keeps its video box out: run Claude Code straight in a Pepper tab` }
  }
  return { player: env.PEPPER_PLAY }
}

/**
 * The item fullscreen moves to from `index`, toward `direction`, among the
 * items in its own list (`playlist`, the set's indexes it was started with):
 * an item added or failed since has no place in mpv's list, so it is passed by.
 */
export const stepInPlaylist = (playlist: readonly number[], index: number, direction: 'left' | 'right'): number => {
  const at = playlist.indexOf(index)
  if (at >= 0) return playlist[direction === 'left' ? at - 1 : at + 1] ?? index
  // Not in the list: the nearest one that is, that way.
  const near = direction === 'left' ? [...playlist].reverse().find(one => one < index) : playlist.find(one => one > index)
  return near ?? index
}

/** The extensions ffmpeg's image2 demuxer reads, the one that takes `%` in a name for a numbered sequence. */
const IMAGE2_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'jxl'])

/** The width and height `sips -g pixelWidth -g pixelHeight` printed; null when it did not. */
export const sipsSizeOf = (output: string): { width: number; height: number } | null => {
  const width = Number(/pixelWidth:\s*(\d+)/.exec(output)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(output)?.[1] ?? 0)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * Options that tell ffmpeg how to read a file whose name could pass for
 * something else: a `%` in a picture's name reads as a numbered sequence, so a
 * GIF is named its own format and a picture image2 reads is read as the one
 * file. Other formats have demuxers of their own that take no such option.
 */
export const inputOptionsOf = (path: string): string[] => {
  const extension = extensionOf(path)
  if (extension === 'gif') return ['-f', 'gif']
  return path.includes('%') && IMAGE2_EXTENSIONS.has(extension) ? ['-pattern_type', 'none'] : []
}

/** The tag a /gallery run puts in its line, so its row finds the set it showed: `Gallery 1a2b3c4d: ...`. */
export const galleryTagOf = (text: string): string | null => /^Gallery ([0-9a-f]{8}):/.exec(text)?.[1] ?? null

/** The tag of a set a /gallery made (`cmd-1a2b3c4d`), or '' for any other set, such as a tool call's. */
export const tagOfSetId = (id: string): string => /^cmd-([0-9a-f]{8})$/.exec(id)?.[1] ?? ''

/** One mpv JSON IPC line; a `requestId` tags its answer. */
export const ipcLine = (command: readonly (string | number)[], requestId?: number): string =>
  JSON.stringify(requestId === undefined ? { command } : { command, request_id: requestId })

/** The number mpv answered to the request tagged `requestId`, among its answers and events, one a line. */
export const answerOf = (output: string, requestId: number): number | null => {
  for (const line of output.split('\n')) {
    try {
      const answer: unknown = JSON.parse(line)
      if (typeof answer !== 'object' || answer === null) continue
      const { request_id: id, data } = answer as { request_id?: unknown; data?: unknown }
      if (id === requestId && typeof data === 'number' && Number.isFinite(data)) return data
    } catch {
      // Not a line of JSON.
    }
  }
  return null
}

/** Asks pepper-play to place its box over the whole tab: it writes Pepper's escape sequence to /dev/tty. */
export const placeCommandOf = (columns: number, rows: number): string[] => [
  'script-message-to',
  'main',
  'pepper-place',
  '0',
  '0',
  String(Math.max(1, Math.floor(columns))),
  String(Math.max(1, Math.floor(rows))),
]

/**
 * Hands mpv's JSON IPC a few lines over its Unix socket and prints what it
 * answers: macOS ships Perl, and a mod has no socket of its own.
 */
export const PERL_IPC =
  'use IO::Socket::UNIX; my $s = IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 2; local $/; my $in = <STDIN>; print $s $in; shutdown($s, 1); alarm 2; print while <$s>; exit 0'
