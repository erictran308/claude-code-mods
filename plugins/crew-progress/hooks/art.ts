// Cell-grid drawing for the terminal's Raster element. The techniques come from
// ratatui (MIT, github.com/ratatui/ratatui), whose Buffer is this same grid of
// symbol, foreground and background: Gauge lays a label over a fill in its own
// colors, LineGauge draws a thin bar from line symbols, HalfBlockGrid packs two
// pixels into one cell, and the braille marker packs eight dots into one.

import type { AgentStatus } from '../types'

type Cell = readonly [codePoint: number, foreground: number, background: number]

export type Tone = 'active' | 'done' | 'failed'

const RESET = 0x01000000

export const BOT_COLUMNS = 7
export const BOT_ROWS = 3

const SPACE = 0x20
const MIDDLE_DOT = 0xb7
const BRAILLE_BASE = 0x2800
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const FULL_BLOCK = 0x2588

const TRACK = 0x26263a
const PILL_TEXT = 0xffffff
const TICK = 0x6a6a80
const EYE = 0x14141c
const GREY = 0x8a8a96
const RED = 0xe06c75

const PILL_COLORS: Record<Tone, number> = { active: 0x7f7bf0, done: 0x3fa776, failed: 0xc2505a }

const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export const GLYPHS = {
  nerd: {
    capLeft: 0xe0b6,
    capRight: 0xe0b4,
    done: '',
    failed: '',
    stopped: '',
    active: '',
    pending: '',
    robot: '\u{f06a9}',
    cost: '\u{f0115}',
    tokens: '\u{f061a}',
    time: '\u{f0954}',
  },
  plain: {
    capLeft: 0x2590,
    capRight: 0x258c,
    done: '✓',
    failed: '✗',
    stopped: '■',
    active: '●',
    pending: '○',
    robot: '▣',
    cost: '$',
    tokens: '#',
    time: '◷',
  },
} as const

export type Glyphs = (typeof GLYPHS)[keyof typeof GLYPHS]

const TYPE_COLORS: Record<string, number> = {
  Explore: 0x56c2d6,
  'general-purpose': 0x8f8cf4,
  Plan: 0xe5a13b,
  fork: 0xd97fa8,
}

const OTHER_COLORS = [0x56c2d6, 0x8f8cf4, 0xe5a13b, 0x5fbf8f, 0xd97fa8, 0x6ca6f0]

const ANTENNAS: Record<string, string> = {
  Explore: '..A.A..',
  Plan: '.A...A.',
  fork: 'A..A..A',
}

const clampRatio = (ratio: number): number => Math.min(1, Math.max(0, ratio))

export const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

// The same number for the same place on every redraw, so the dither holds still.
const noise = (x: number, y: number): number => {
  const seed = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  const mixed = Math.imul(seed ^ (seed >>> 13), 1274126177)
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4294967296
}

const mix = (from: number, to: number, amount: number): number => {
  const channel = (shift: number): number => {
    const start = (from >> shift) & 0xff
    return Math.round(start + (((to >> shift) & 0xff) - start) * amount) << shift
  }
  return channel(16) | channel(8) | channel(0)
}

export const colorOfType = (type: string): number => {
  const known = TYPE_COLORS[type]
  if (known !== undefined) return known
  const sum = [...type].reduce((total, ch) => total + (ch.codePointAt(0) ?? 0), 0)
  return OTHER_COLORS[sum % OTHER_COLORS.length] ?? GREY
}

const encodeCells = (cells: readonly Cell[]): string => {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((cell, i) => words.set(cell, i * 3))
  // The module's environment has toBase64; the TypeScript lib it is checked against does not yet.
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}

const dither = (x: number, density: number): number => {
  let dots = 0
  for (let dot = 0; dot < 8; dot++) {
    if (noise(x, dot) < density) dots |= 1 << dot
  }
  return dots ? BRAILLE_BASE + dots : SPACE
}

export type PillBar = {
  width: number
  ratio: number
  /** Done plus in flight: the faint trail ahead of the pill reaches here. */
  runRatio: number
  label: string
  shortLabel: string
  steps: number
  isComplete: boolean
  tone: Tone
  frame: number
  glyphs: Glyphs
}

export const drawPillBar = (bar: PillBar): string => {
  const { width, glyphs, isComplete, frame } = bar
  const color = PILL_COLORS[bar.tone]
  const grid: Cell[] = Array.from({ length: width }, (): Cell => [SPACE, RESET, TRACK])
  grid[0] = [glyphs.capLeft, TRACK, RESET]
  grid[width - 1] = [glyphs.capRight, TRACK, RESET]

  const label = [bar.label, bar.shortLabel].find(text => text.length + 2 <= width) ?? ''
  const padding = label.length + 4 <= width ? 1 : 0
  const pillWidth = isComplete ? width : label.length + 2 + padding * 2
  const pillEnd = isComplete ? width : Math.min(width, Math.max(pillWidth, Math.round(clampRatio(bar.ratio) * width)))
  const pillStart = pillEnd - pillWidth
  const runEnd = Math.min(width - 1, Math.round(clampRatio(bar.runRatio) * width))

  // Behind the pill: sparse dots that thicken toward it and twinkle.
  for (let x = 1; x < pillStart; x++) {
    const density = 0.18 + 0.72 * (x / pillStart) ** 1.4
    grid[x] = [dither(x, density), mix(color, TRACK, 0.15 + 0.5 * noise(x, frame)), TRACK]
  }
  // Ahead of it: work handed out and not finished yet.
  for (let x = pillEnd; x < runEnd; x++) {
    grid[x] = [dither(x + 40, 0.22), mix(color, TRACK, 0.5 + 0.25 * noise(x, frame)), TRACK]
  }
  for (let step = 1; step < bar.steps && bar.steps * 3 <= width; step++) {
    const x = Math.round((width * step) / bar.steps)
    if (x >= Math.max(pillEnd, runEnd) && x < width - 1) grid[x] = [MIDDLE_DOT, TICK, TRACK]
  }

  // The pill. As in ratatui's Gauge, the label sits on the fill in its own colors.
  for (let x = pillStart; x < pillEnd; x++) grid[x] = [SPACE, PILL_TEXT, color]
  grid[pillStart] = [glyphs.capLeft, color, pillStart === 0 ? RESET : TRACK]
  grid[pillEnd - 1] = [glyphs.capRight, color, pillEnd === width ? RESET : TRACK]
  const labelStart = pillStart + Math.floor((pillWidth - label.length) / 2)
  ;[...label].forEach((ch, i) => {
    grid[labelStart + i] = [ch.codePointAt(0) ?? SPACE, PILL_TEXT, color]
  })

  return encodeCells(grid)
}

// ratatui's HalfBlockGrid: two pixels stacked in each cell, 1 by 2 per cell.
type Pixel = number | null

const pixelsToCells = (pixels: readonly (readonly Pixel[])[]): Cell[] => {
  const cells: Cell[] = []
  for (let y = 0; y + 1 < pixels.length; y += 2) {
    const upperRow = pixels[y] ?? []
    const lowerRow = pixels[y + 1] ?? []
    upperRow.forEach((upper, x) => {
      const lower = lowerRow[x] ?? null
      if (upper === null && lower === null) cells.push([SPACE, RESET, RESET])
      else if (upper === null && lower !== null) cells.push([LOWER_HALF, lower, RESET])
      else if (upper !== null && lower === null) cells.push([UPPER_HALF, upper, RESET])
      else if (upper === lower && upper !== null) cells.push([FULL_BLOCK, upper, upper])
      else cells.push([UPPER_HALF, upper ?? RESET, lower ?? RESET])
    })
  }
  return cells
}

// Every picture is one of a few, and redraws come twice a second while anything runs.
const botCache = new Map<string, string>()

export const drawBot = (type: string, state: AgentStatus, frame: number): string => {
  const isRunning = state === 'running'
  // Arms swing every 2 frames and eyes blink every 7, so 14 frames cover them all.
  const phase = isRunning ? frame % 14 : 0
  const cacheKey = `${type}|${state}|${phase}`
  const cached = botCache.get(cacheKey)
  if (cached !== undefined) return cached

  const body = state === 'failed' ? RED : state === 'stopped' ? GREY : colorOfType(type)
  const isArmUp = isRunning && phase % 2 === 1
  const isBlink = isRunning && phase % 7 === 6
  const rows = [
    ANTENNAS[type] ?? '...A...',
    '.BBBBB.',
    isArmUp ? 'ABEBEBA' : '.BEBEB.',
    isArmUp ? '.BBBBB.' : 'ABBBBBA',
    '.BBBBB.',
    isArmUp ? '..L.L..' : '.L...L.',
  ]
  const palette: Record<string, number> = {
    B: body,
    A: mix(body, 0xffffff, 0.35),
    L: mix(body, 0x000000, 0.3),
    E: isBlink ? body : EYE,
  }
  const cells = encodeCells(pixelsToCells(rows.map(row => [...row].map(ch => palette[ch] ?? null))))
  botCache.set(cacheKey, cells)
  return cells
}

// ratatui's Gauge with use_unicode: whole cells, then an eighth-block head.
export const drawBar = (ratio: number, width: number): [filled: string, empty: string] => {
  const eighths = Math.round(clampRatio(ratio) * width * 8)
  const full = Math.floor(eighths / 8)
  const partial = PARTIAL_BLOCKS[eighths % 8] ?? ''
  return ['█'.repeat(full) + partial, '░'.repeat(Math.max(0, width - full - (partial ? 1 : 0)))]
}

// ratatui's LineGauge, with a half-cell head for finer steps.
export const drawLineGauge = (ratio: number, width: number): [filled: string, rest: string] => {
  const exact = clampRatio(ratio) * width
  const full = Math.floor(exact)
  const head = exact - full >= 0.5 ? '╸' : ''
  return ['━'.repeat(full) + head, '━'.repeat(Math.max(0, width - full - (head ? 1 : 0)))]
}
