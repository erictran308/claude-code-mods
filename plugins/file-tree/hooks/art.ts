// Cell-grid drawing for the terminal's Raster element, in the same style as
// crew-progress: ratatui's Gauge laying a label over a fill (github.com/ratatui/ratatui,
// MIT), its HalfBlockGrid for pixel art and its braille marker for dither.
// Each mod installs on its own, so these helpers are not shared between them.

import type { TouchKind } from '../types'

type Cell = readonly [codePoint: number, foreground: number, background: number]

const RESET = 0x01000000

export const BOT_COLUMNS = 7
export const BOT_ROWS = 3

const SPACE = 0x20
const BRAILLE_BASE = 0x2800
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const FULL_BLOCK = 0x2588

const TRACK = 0x26263a
const PILL_TEXT = 0xffffff
const EYE = 0x14141c
const WHITE = 0xffffff
const BLACK = 0x000000
const GREY = 0x8a8a96
const BASE = 0x15151d

export const KIND_COLORS: Record<TouchKind, number> = { read: 0xa78bfa, edited: 0xe5a13b, committed: 0x5fbf8f }

export const GLYPHS = {
  nerd: {
    capLeft: 0xe0b6,
    capRight: 0xe0b4,
    chipLeft: '',
    chipRight: '',
    folder: '',
    folderOpen: '',
    branch: '',
    gitChip: ' ',
    search: '',
    link: '',
  },
  plain: {
    capLeft: 0x2590,
    capRight: 0x258c,
    chipLeft: ' ',
    chipRight: ' ',
    folder: '■',
    folderOpen: '□',
    branch: '⎇',
    gitChip: 'GI',
    search: '⌕',
    link: '→',
  },
} as const

export type Glyphs = (typeof GLYPHS)[keyof typeof GLYPHS]

type Chip = readonly [label: string, color: number]

const YELLOW = 0xe5c07b
const BLUE = 0x61afef
const GREEN = 0x98c379
const CYAN = 0x56c2d6
const RED = 0xe06c75
const PURPLE = 0xc678dd
const ORANGE = 0xe5a13b

// In Maps, as these are looked up by file name: `constructor` must find nothing.
const BY_EXTENSION = new Map<string, Chip>(Object.entries<Chip>({
  js: ['JS', YELLOW],
  mjs: ['JS', YELLOW],
  cjs: ['JS', YELLOW],
  jsx: ['JS', YELLOW],
  ts: ['TS', BLUE],
  tsx: ['TS', BLUE],
  mts: ['TS', BLUE],
  cts: ['TS', BLUE],
  json: ['{}', GREEN],
  jsonc: ['{}', GREEN],
  md: ['MD', CYAN],
  mdx: ['MD', CYAN],
  txt: ['TX', GREY],
  py: ['PY', BLUE],
  go: ['GO', CYAN],
  rs: ['RS', RED],
  rb: ['RB', RED],
  php: ['PH', PURPLE],
  java: ['JV', ORANGE],
  kt: ['KT', PURPLE],
  swift: ['SW', ORANGE],
  c: ['C ', BLUE],
  h: ['H ', BLUE],
  cpp: ['C+', BLUE],
  cs: ['C#', PURPLE],
  sh: ['SH', GREEN],
  bash: ['SH', GREEN],
  zsh: ['SH', GREEN],
  html: ['<>', ORANGE],
  css: ['CS', BLUE],
  scss: ['CS', PURPLE],
  vue: ['VU', GREEN],
  svelte: ['SV', ORANGE],
  yml: ['YM', PURPLE],
  yaml: ['YM', PURPLE],
  toml: ['TM', ORANGE],
  xml: ['<>', ORANGE],
  sql: ['SQ', CYAN],
  lock: ['LK', GREY],
  png: ['IM', PURPLE],
  jpg: ['IM', PURPLE],
  jpeg: ['IM', PURPLE],
  gif: ['IM', PURPLE],
  svg: ['IM', PURPLE],
  webp: ['IM', PURPLE],
  pdf: ['PD', RED],
  env: ['EV', YELLOW],
}))

const BY_NAME = new Map<string, Chip>(Object.entries<Chip>({
  dockerfile: ['DK', BLUE],
  makefile: ['MK', ORANGE],
  license: ['LI', YELLOW],
  readme: ['MD', CYAN],
  '.env': ['EV', YELLOW],
}))

const GIT_NAME = /^\.git(ignore|attributes|modules|keep)$/

export type ChipLook = { label: string; color: string; background: string }

export const chipOf = (name: string, glyphs: Glyphs): ChipLook => {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const extension = dot >= 0 ? lower.slice(dot + 1) : ''
  const isGit = GIT_NAME.test(lower)
  const [label, color] = isGit
    ? ([glyphs.gitChip, GREY] as const)
    : (BY_NAME.get(lower) ?? BY_NAME.get(lower.split('.')[0] ?? '') ?? BY_EXTENSION.get(extension) ?? (['··', GREY] as const))
  return { label, color: hex(color), background: hex(mix(BASE, color, 0.24)) }
}

const clampRatio = (ratio: number): number => Math.min(1, Math.max(0, ratio))

export const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

// The same number for the same place on every redraw, so a dither holds still.
const noise = (x: number, y: number): number => {
  const seed = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  const mixed = Math.imul(seed ^ (seed >>> 13), 1274126177)
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4294967296
}

export const mix = (from: number, to: number, amount: number): number => {
  const channel = (shift: number): number => {
    const start = (from >> shift) & 0xff
    return Math.round(start + (((to >> shift) & 0xff) - start) * amount) << shift
  }
  return channel(16) | channel(8) | channel(0)
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

/** A row's background: the kind's color let into the panel's dark. */
export const tintOf = (color: number, strength: number): string => hex(mix(BASE, color, clampRatio(strength)))

/** How strongly a lit row glows on this frame: a slow breath. */
export const pulse = (frame: number): number => 0.2 + 0.08 * Math.sin(frame / 2.4)

/** A bright band sweeping across a name, one color per character. */
export const shimmerColors = (length: number, frame: number, color: number): string[] => {
  const band = ((frame * 1.6) % (length + 8)) - 4
  const shades = [color, mix(color, WHITE, 0.3), mix(color, WHITE, 0.6), mix(color, WHITE, 0.88)]
  return Array.from({ length }, (_, i) => {
    const distance = Math.abs(i - band)
    return hex(shades[distance < 0.8 ? 3 : distance < 1.8 ? 2 : distance < 2.8 ? 1 : 0] ?? color)
  })
}

/** Braille dots thickening to the right and twinkling: the bar's trail, on a row. */
export const trailText = (width: number, frame: number): string => {
  let text = ''
  for (let x = 0; x < width; x++) {
    const density = 0.12 + 0.62 * ((x + 1) / width) ** 1.4
    let dots = 0
    for (let dot = 0; dot < 8; dot++) {
      if (noise(x + 7, dot + (frame % 24) * 11) < density) dots |= 1 << dot
    }
    text += String.fromCodePoint(BRAILLE_BASE + dots)
  }
  return text
}

export type ActivityBar = {
  width: number
  /** One mark per action, oldest first. */
  kinds: readonly TouchKind[]
  /** ASCII and the middle dot only: a Raster cell is one column. */
  label: string
  isActive: boolean
  frame: number
  glyphs: Glyphs
}

/** The turn as a strip: each stretch colored by what Claude did then, ending in a pill. */
export const drawActivityBar = (bar: ActivityBar): string => {
  const { width, kinds, glyphs, isActive, frame } = bar
  const grid: Cell[] = Array.from({ length: width }, (): Cell => [SPACE, RESET, TRACK])
  grid[0] = [glyphs.capLeft, TRACK, RESET]
  grid[width - 1] = [glyphs.capRight, TRACK, RESET]

  const latest = kinds[kinds.length - 1]
  const color = latest ? KIND_COLORS[latest] : GREY
  const label = bar.label.length + 4 <= width ? bar.label : ''
  const pillWidth = label ? label.length + 4 : Math.min(width, 4)
  const pillStart = width - pillWidth

  for (let x = 1; x < pillStart; x++) {
    const place = x / pillStart
    const kind = kinds[Math.min(kinds.length - 1, Math.floor(place * kinds.length))]
    if (!kind) continue
    const density = 0.18 + 0.72 * place ** 1.4
    const shade = isActive ? 0.15 + 0.5 * noise(x, frame) : 0.3
    grid[x] = [dither(x, density), mix(KIND_COLORS[kind], TRACK, shade), TRACK]
  }

  for (let x = pillStart; x < width; x++) grid[x] = [SPACE, PILL_TEXT, color]
  grid[pillStart] = [glyphs.capLeft, color, pillStart === 0 ? RESET : TRACK]
  grid[width - 1] = [glyphs.capRight, color, RESET]
  ;[...label].forEach((ch, i) => {
    grid[pillStart + 2 + i] = [ch.codePointAt(0) ?? SPACE, PILL_TEXT, color]
  })
  return encodeCells(grid)
}

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

const botCache = new Map<string, string>()

/** The crew-progress bot, colored by what Claude is doing to files. */
export const drawBot = (kind: TouchKind | null, isRunning: boolean, frame: number): string => {
  // Arms swing every 2 frames and eyes blink every 7, so 14 frames cover them all.
  const phase = isRunning ? frame % 14 : 0
  const cacheKey = `${kind}|${isRunning}|${phase}`
  const cached = botCache.get(cacheKey)
  if (cached !== undefined) return cached

  const body = kind ? KIND_COLORS[kind] : GREY
  const isArmUp = isRunning && phase % 2 === 1
  const isBlink = isRunning && phase % 7 === 6
  const rows = [
    kind === 'read' ? '..A.A..' : kind === 'edited' ? '.A...A.' : '...A...',
    '.BBBBB.',
    isArmUp ? 'ABEBEBA' : '.BEBEB.',
    isArmUp ? '.BBBBB.' : 'ABBBBBA',
    '.BBBBB.',
    isArmUp ? '..L.L..' : '.L...L.',
  ]
  const palette: Record<string, number> = {
    B: body,
    A: mix(body, WHITE, 0.35),
    L: mix(body, BLACK, 0.3),
    E: isBlink ? body : EYE,
  }
  const cells = encodeCells(pixelsToCells(rows.map(row => [...row].map(ch => palette[ch] ?? null))))
  botCache.set(cacheKey, cells)
  return cells
}
