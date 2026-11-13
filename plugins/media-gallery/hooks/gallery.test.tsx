import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import type { MediaSet } from '../types'
import {
  answerOf,
  escapeRegExp,
  fitBox,
  fullscreenPlanOf,
  galleryTagOf,
  imagePlanOf,
  inputOptionsOf,
  kindOf,
  newItem,
  legendOf,
  naturalCompare,
  nearestIn,
  outwardFrom,
  probeSizeOf,
  ipcLine,
  pageOf,
  playableOf,
  placeCommandOf,
  patchItem,
  pngSizeOf,
  resolveInput,
  splitArgs,
  step,
  tmuxPlanOf,
  needsTmuxAnswer,
  sipsSizeOf,
  summaryOf,
  tagOfSetId,
  stepInPlaylist,
  wildcardOf,
  withSet,
  wrappedRowsOf,
} from './model'

const ROOT = '/work'
const newItemFor = (name: string) => newItem(`${ROOT}/${name}`, 'image')
const TOOL = 'mcp__media-gallery__show'
// A 1×1 PNG: what every made picture reads back as.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

type Node = 'dir' | { size: number }

const DISK: Record<string, Node> = {
  [ROOT]: 'dir',
  [`${ROOT}/shots`]: 'dir',
  [`${ROOT}/shots/b10.png`]: { size: 2048 },
  [`${ROOT}/shots/b2.png`]: { size: 1024 },
  [`${ROOT}/shots/clip.mp4`]: { size: 4096 },
  [`${ROOT}/shots/notes.txt`]: { size: 12 },
  [`${ROOT}/shots/.hidden.png`]: { size: 12 },
  [`${ROOT}/cat.jpg`]: { size: 500 },
}

type World = {
  env: Record<string, string>
  made: Set<string>
  runs: string[][]
  ipc: string[]
  spawned: string[][]
  toasts: string[]
  opens: number
  focus: string[]
  /** What each `$.ui.open` asked for. */
  openArgs: Record<string, unknown>[]
  /** A file's date where a test changes it; 5 otherwise. */
  mtimes: Record<string, number>
}

/** How the machine answers, where a test needs it otherwise. */
type Standing = { isPlaced?: boolean; ffmpegFails?: boolean; sipsSize?: string; isThumbUnreadable?: boolean }

const PEPPER = { TERM_PROGRAM: 'ghostty', PEPPER_PLAY: '/Apps/pepper-play', TMPDIR: '/tmp/t/', HOME: '/home/me' }

const stand = (on: On, env: Record<string, string> = PEPPER, standing: Standing = {}): World => {
  const world: World = { env, made: new Set(), runs: [], ipc: [], spawned: [], toasts: [], opens: 0, focus: [], openArgs: [], mtimes: {} }
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  clock = mock.clock(on, { now: 1_000_000 })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__media-gallery__${(e as { name: string }).name}` } }) as never)
  on('command.register', () => ({ value: { command: 'gallery' } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', (_, e) => ({ value: world.env[e.name] }))
  on('fs.list', (_, e) => {
    const prefix = `${e.path}/`
    if (DISK[e.path] !== 'dir') throw new Error('ENOENT')
    const value = Object.entries(DISK)
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, node]) => ({
        name: path.slice(prefix.length),
        kind: node === 'dir' ? ('dir' as const) : ('file' as const),
        size: node === 'dir' ? 0 : node.size,
        mtimeMs: world.mtimes[path] ?? 5,
        isLink: false,
      }))
    return { value }
  })
  on('fs.stat', (_, e) => {
    const node = DISK[e.path]
    if (!node) throw new Error('ENOENT')
    return { value: { kind: node === 'dir' ? ('dir' as const) : ('file' as const), size: node === 'dir' ? 0 : node.size, mtimeMs: world.mtimes[e.path] ?? 5, isLink: false } }
  })
  on('fs.exists', (_, e) => ({ value: world.made.has(e.path) || e.path.endsWith('.sock') }) as never)
  // A thumbnail whose bytes are no PNG: its shape is not known until the large picture is measured.
  on('fs.read', () => ({ value: { base64: standing.isThumbUnreadable ? 'bm90IGEgcG5n' : PNG } }) as never)
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    world.runs.push(argv)
    const [command = ''] = argv
    // ffprobe asked a picture's size answers 640 by 480; asked a video's length, 12.5 seconds.
    if (command.endsWith('ffprobe') && argv.includes('stream=width,height')) return ok('640,480\n')
    if (command.endsWith('ffprobe') && !argv.includes('-version')) return ok('{"format":{"duration":"12.5"}}')
    // A recent ffmpeg: its image2 muxer can write a file aside and rename it.
    if (argv.includes('muxer=image2')) return ok('  -atomic_writing    <boolean>    E.......... write files atomically')
    if (standing.ffmpegFails && command.endsWith('ffmpeg') && !argv.includes('-version')) return { value: { ...ok().value, exitCode: 1 } }
    if (command === 'sips' && argv.includes('-g')) return ok(standing.sipsSize ?? 'pixelWidth: 200\npixelHeight: 150')
    if ((command.endsWith('ffmpeg') || command === 'sips') && !argv.includes('-version')) world.made.add(argv[argv.length - 1] ?? '')
    // A picture is made under a part name, then moved into place.
    if (command === 'mv') world.made.add(argv[3] ?? '')
    if (command === '/usr/bin/perl') world.ipc.push(e.init?.stdin ?? '')
    return ok()
  })
  // Every child ends at once here: the kit reads a drawing only once its stand-in children have ended.
  on('process.spawn', async function* (_, e) {
    world.spawned.push([...e.argv])
    return { value: { code: 0, signal: null } } as never
  })
  on('ui.open', (_, e) => {
    world.opens++
    world.openArgs.push({ ...(e as Record<string, unknown>) })
    return { value: standing.isPlaced === false ? { isPlaced: false, reason: 'the terminal is too narrow' } : { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', (_, e) => {
    world.focus.push(e.element ?? '')
    return {} as never
  })
  on('ui.blit', () => ({ value: {} }) as never)
  on('ui.toast', (_, e) => {
    world.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return world
}

let clock: MockClock | null = null

/** Lets the work the mod left running (thumbnails, focus) finish: each step a turn of the clock. */
const settle = async (_: Engine): Promise<void> => {
  for (let i = 0; i < 40; i++) await clock?.advance(5)
}

const boot = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)

const show = ($: Engine, input: Record<string, unknown>, id = 'call-1') =>
  ($.tool.call as (e: unknown) => Promise<{ result?: unknown }>)({ tool: TOOL, tool_use_id: id, ...input })

const PANE = {
  plugin: 'media-gallery',
  component: 'Pane',
  requestId: 'media-gallery',
  surface: 'terminal',
  viewport: { columns: 160, rows: 50, isFullscreen: true },
  props: { title: 'shots', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const ROW = {
  plugin: 'media-gallery',
  component: 'ToolUse',
  requestId: 'call-1',
  surface: 'terminal',
  viewport: { columns: 120, rows: 50, isFullscreen: true },
  props: { tool_use_id: 'call-1', tool: TOOL, input: {}, isRunning: false, isErrored: false, isInterrupted: false },
} as const

describe('the plain parts', () => {
  test('kinds come from the extension', () => {
    expect(kindOf('/a/B.PNG')).toBe('image')
    expect(kindOf('clip.mov')).toBe('video')
    expect(kindOf('loop.gif')).toBe('video')
    expect(kindOf('notes.txt')).toBeNull()
    expect(kindOf('.png')).toBeNull()
  })

  test('paths resolve from ~, file:// and the working folder', () => {
    expect(resolveInput('~/x.png', ROOT, '/home/me')).toBe('/home/me/x.png')
    expect(resolveInput('file:///a%20b/c.png', ROOT, '/home/me')).toBe('/a b/c.png')
    expect(resolveInput('file://localhost/Users/me/a.png', ROOT, '/home/me')).toBe('/Users/me/a.png')
    expect(resolveInput('../up/./y.png', `${ROOT}/sub`, '/home/me')).toBe(`${ROOT}/up/y.png`)
    expect(splitArgs(`"my shots" b\\ c.png 'd e'`)).toEqual(['my shots', 'b c.png', 'd e'])
    expect(splitArgs(`"my \\"best\\" shot.png" 'it\\s'`)).toEqual(['my "best" shot.png', 'it\\s'])
    expect(wildcardOf('shot-*.PNG').test('shot-3.png')).toBe(true)
    expect(wildcardOf('a?.png').test('ab.png')).toBe(true)
    expect(wildcardOf('a.png').test('aXpng')).toBe(false)
    expect(['b10.png', 'b2.png', 'a.png'].sort(naturalCompare)).toEqual(['a.png', 'b2.png', 'b10.png'])
  })

  test("fullscreen starts on the nearest playable item, and thumbnails fill outward from the one in view", () => {
    expect(nearestIn([0, 3, 6], 4)).toBe(3)
    expect(nearestIn([0, 2, 4], 3)).toBe(4)
    expect(nearestIn([5], 0)).toBe(5)
    expect(nearestIn([], 2)).toBe(2)
    expect(outwardFrom(6, 3)).toEqual([3, 4, 2, 5, 1, 0])
    expect(outwardFrom(3, 0)).toEqual([0, 1, 2])
    expect(outwardFrom(3, 9)).toEqual([2, 1, 0])
    expect(outwardFrom(0, 0)).toEqual([])
    expect(probeSizeOf('640,480\n')).toEqual({ width: 640, height: 480 })
    expect(probeSizeOf('N/A')).toBeNull()
  })

  test('a picture keeps its shape in its box of cells', () => {
    // 16:9 in 40 columns: 40 * 9 / 16 / 2 = 11.25 rows.
    expect(fitBox(1600, 900, 40, 20)).toEqual({ columns: 40, rows: 11 })
    // Tall: limited by rows, narrower than the box.
    expect(fitBox(900, 1600, 40, 10)).toEqual({ columns: 11, rows: 10 })
    expect(fitBox(0, 0, 40, 10)).toEqual({ columns: 40, rows: 10 })
    expect(pngSizeOf(PNG)).toEqual({ width: 1, height: 1 })
    expect(pngSizeOf('bm90IGEgcG5n')).toBeNull()
  })

  test('the legend wraps into rows, and fullscreen walks only what it can play', () => {
    expect(wrappedRowsOf(['h: ←', 'j: ↓', 'k: ↑'], 80)).toBe(1)
    expect(wrappedRowsOf(['h: ←', 'j: ↓', 'k: ↑'], 10)).toBe(2)
    expect(wrappedRowsOf(['a long first word', 'b'], 5)).toBe(2)
    const item = (name: string, error = '') => ({ ...newItemFor(name), error })
    const items = [item('a.png'), item('gone.png', 'not found'), item('c.png')]
    expect(playableOf(items)).toEqual([0, 2])
  })

  test('h j k l move around a grid three wide', () => {
    expect(step(0, 'left', 8, 3)).toBe(0)
    expect(step(0, 'right', 8, 3)).toBe(1)
    expect(step(1, 'down', 8, 3)).toBe(4)
    expect(step(4, 'up', 8, 3)).toBe(1)
    expect(step(1, 'up', 8, 3)).toBe(1)
    // Row two over a last row of two: down from its third tile lands on the last.
    expect(step(5, 'down', 8, 3)).toBe(7)
    expect(step(7, 'down', 8, 3)).toBe(7)
    expect(pageOf(7, 20, 3, 2)).toEqual({ first: 6, last: 12 })
  })

  test('the legend names a key for each act, and the video keys only for a video', () => {
    expect(legendOf('grid', false, false).map(key => key.hotkey).join('')).toBe('hjklofq')
    expect(legendOf('view', false, true).map(key => key.hotkey).join('')).toBe('hlgpfq')
    expect(legendOf('view', true, false).map(key => key.hotkey).join('')).toBe('hlfq')
  })

  test('iTerm2 draws pictures only under the fullscreen renderer, and the plan says so', () => {
    expect(imagePlanOf({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.2' })).toEqual({ via: 'bytes', needsFullscreen: true })
    expect(imagePlanOf({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4.0' })).toBeNull()
  })

  test("mpv's answers and pkill's pattern", () => {
    const output = '{"event":"pause"}\n{"data":412.5,"request_id":7,"error":"success"}\n{"data":null,"request_id":0,"error":"success"}\n'
    expect(answerOf(output, 7)).toBe(412.5)
    expect(answerOf('not json\n', 7)).toBeNull()
    expect(ipcLine(['get_property', 'time-pos'], 7)).toBe('{"command":["get_property","time-pos"],"request_id":7}')
    expect(new RegExp(escapeRegExp('/Users/a+b/.cache/cmg/mpv-1.sock')).test('--input-ipc-server=/Users/a+b/.cache/cmg/mpv-1.sock')).toBe(true)
    expect(new RegExp(escapeRegExp('/Users/a+b/x')).test('/Users/aab/x')).toBe(false)
  })

  test('tmux draws pictures only when it passes them through', () => {
    expect(tmuxPlanOf('ghostty 1.2\ton\t1')).toEqual({ via: 'bytes' })
    expect(tmuxPlanOf('ghostty 1.2\toff\t1')).toBeNull()
    expect(tmuxPlanOf('ghostty 1.2\t2\t1')).toEqual({ via: 'bytes' })
    expect(tmuxPlanOf('ghostty 1.2\ton\t0')).toBeNull()
    expect(imagePlanOf({ TMUX: '/tmp/tmux', TERM_PROGRAM: 'tmux' }, 'kitty(0.30.1)\tall\t1')).toEqual({ via: 'bytes' })
    expect(imagePlanOf({ TMUX: '/tmp/tmux', TERM_PROGRAM: 'tmux' }, 'xterm-256color\ton\t1')).toBeNull()
    // Not asked (no pane): no pictures, unless forced.
    expect(imagePlanOf({ TMUX: '/tmp/tmux' })).toBeNull()
    expect(imagePlanOf({ TMUX: '/tmp/tmux', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toEqual({ via: 'bytes' })
  })

  test('old sets give way, but never the one the pane shows', () => {
    const setOf = (id: string, createdAt: number): MediaSet => ({ id, title: id, items: [], total: 0, createdAt })
    const all = { a: setOf('a', 1), b: setOf('b', 2), c: setOf('c', 3) }
    expect(Object.keys(withSet(all, setOf('d', 4), 2)).sort()).toEqual(['c', 'd'])
    expect(Object.keys(withSet(all, setOf('d', 4), 2, 'a')).sort()).toEqual(['a', 'c', 'd'])
    // A patch for an item the set no longer holds writes nothing.
    expect(patchItem(all, 'a', 0, '/x.png', { thumb: '/t.png' })).toBe(all)
  })

  test('fullscreen walks the list it started with, passing items added or failed since', () => {
    const playlist = [0, 2, 3]
    expect(stepInPlaylist(playlist, 0, 'right')).toBe(2)
    expect(stepInPlaylist(playlist, 2, 'right')).toBe(3)
    expect(stepInPlaylist(playlist, 3, 'right')).toBe(3)
    expect(stepInPlaylist(playlist, 2, 'left')).toBe(0)
    expect(stepInPlaylist(playlist, 0, 'left')).toBe(0)
    // On an item mpv's list does not hold: the nearest one that way.
    expect(stepInPlaylist(playlist, 1, 'right')).toBe(2)
    expect(stepInPlaylist(playlist, 1, 'left')).toBe(0)
  })

  test('a name with % is read as one file, and a GIF as a GIF', () => {
    expect(inputOptionsOf('/a/frame%03d.png')).toEqual(['-pattern_type', 'none'])
    expect(inputOptionsOf('/a/frame%03d.jpg')).toEqual(['-pattern_type', 'none'])
    expect(inputOptionsOf('/a/frame%03d.gif')).toEqual(['-f', 'gif'])
    expect(inputOptionsOf('/a/loop.gif')).toEqual(['-f', 'gif'])
    expect(inputOptionsOf('/a/plain.png')).toEqual([])
    expect(inputOptionsOf('/a/take%1.mp4')).toEqual([])
    // Every extension image2 reads by name, webp and jxl too.
    expect(inputOptionsOf('/a/progress 100%.webp')).toEqual(['-pattern_type', 'none'])
    expect(inputOptionsOf('/a/scan%1.jxl')).toEqual(['-pattern_type', 'none'])
    // AVIF is read by a demuxer of its own, which takes no pattern option.
    expect(inputOptionsOf('/a/shot%1.avif')).toEqual([])
  })

  test("sips's size, and the line the model reads when the pane did not take the keys", () => {
    expect(sipsSizeOf('/a/x.png\n  pixelWidth: 4032\n  pixelHeight: 3024\n')).toEqual({ width: 4032, height: 3024 })
    expect(sipsSizeOf('Error: unable to read')).toBeNull()
    const set: MediaSet = { id: 'call-1', title: 't', items: [newItemFor('a.png')], total: 1, createdAt: 1 }
    expect(summaryOf(set, [], 'open', false)).toMatch(/without the keyboard: the person gives it the keys with ctrl\+x tab/)
    expect(summaryOf(set, [], 'open')).toMatch(/the person moves with h j k l/)
  })

  test('tmux is asked only when its answer decides', () => {
    const tmux = { TMUX: '/tmp/tmux', TMUX_PANE: '%1' }
    expect(needsTmuxAnswer(tmux)).toBe(true)
    // The rule is tmux's alone; asking also needs a pane, which the caller checks.
    expect(needsTmuxAnswer({ TMUX: '/tmp/tmux' })).toBe(true)
    expect(needsTmuxAnswer({ ...tmux, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toBe(false)
    expect(needsTmuxAnswer({ ...tmux, ZELLIJ: '0' })).toBe(false)
    expect(needsTmuxAnswer({ ...tmux, STY: '1.pts' })).toBe(false)
    expect(needsTmuxAnswer({})).toBe(false)
    // imagePlanOf reads tmux's answer by the same rule.
    expect(imagePlanOf({ ...tmux, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }, 'ghostty 1.2\toff\t1')).toEqual({ via: 'bytes' })
  })

  test("a /gallery set's id carries its tag; a tool's carries none", () => {
    expect(tagOfSetId('cmd-1a2b3c4d')).toBe('1a2b3c4d')
    expect(tagOfSetId('call-1')).toBe('')
    expect(tagOfSetId('cmd-xyz')).toBe('')
  })

  test("a /gallery line's tag names its set", () => {
    expect(galleryTagOf('Gallery 1a2b3c4d: shots, 2 pictures.')).toBe('1a2b3c4d')
    expect(galleryTagOf('Gallery: shots, 2 pictures.')).toBeNull()
    expect(galleryTagOf('Nothing to show: nope (not found).')).toBeNull()
  })

  test('pictures and fullscreen follow the terminal', () => {
    expect(fullscreenPlanOf({ ...PEPPER, ZELLIJ: '0' })).toEqual({ reason: "zellij keeps Pepper's video box from the terminal" })
    expect(fullscreenPlanOf({ ...PEPPER, STY: '1.pts' })).toEqual({ reason: "GNU screen keeps Pepper's video box from the terminal" })
    expect(imagePlanOf({ TERM_PROGRAM: 'ghostty' })).toEqual({ via: 'file' })
    expect(imagePlanOf({ TERM_PROGRAM: 'herdr' })).toBeNull()
    expect(imagePlanOf({ TERM_PROGRAM: 'herdr', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toEqual({ via: 'bytes' })
    expect(fullscreenPlanOf(PEPPER)).toEqual({ player: '/Apps/pepper-play' })
    expect('reason' in fullscreenPlanOf({ ...PEPPER, TERM_PROGRAM: 'herdr' })).toBe(true)
    expect('reason' in fullscreenPlanOf({ ...PEPPER, TMUX: '/tmp/tmux' })).toBe(true)
    expect('reason' in fullscreenPlanOf({ TERM_PROGRAM: 'ghostty' })).toBe(true)
  })
})

test('show finds pictures and videos, leaves out the rest, and opens the gallery', async ($, on) => {
  const world = stand(on)
  await boot($)
  const ran = await show($, { paths: ['shots', 'cat.jpg', 'missing.png', 'shots/notes.txt'] })
  await settle($)

  const text = String(ran.result)
  expect(text).toMatch(/3 pictures, 1 video/)
  expect(text).toMatch(/b2\.png, b10\.png, clip\.mp4, cat\.jpg/)
  expect(text).toMatch(/missing\.png \(not found\)/)
  expect(text).toMatch(/notes\.txt \(not a picture or video\)/)
  expect(world.opens).toBe(1)
  // Thumbnails were made in the cache, from ffmpeg.
  expect([...world.made].filter(path => path.endsWith('-t.png'))).toHaveLength(4)
})

test('a pattern picks matching files, and nothing to show says why', async ($, on) => {
  stand(on)
  await boot($)
  expect(String((await show($, { paths: ['shots/b*.png'] })).result)).toMatch(/2 pictures \(b2\.png, b10\.png\)/)
  expect(String((await show($, { paths: ['nope/*.png'] }, 'call-2')).result)).toMatch(/Nothing to show: nope\/\*\.png \(no such folder\)/)
})

test('the chat row grows thumbnails and a way into the gallery', async ($, on) => {
  stand(on)
  await boot($)
  await show($, { paths: ['shots'] })
  await settle($)

  const row = await $.ui.mount(ROW)
  expect(await row.findAll({ type: 'Image' })).toHaveLength(3)
  expect((await row.find({ key: 'open:call-1' }))?.text).toMatch(/Open the gallery: 2 pictures, 1 video/)
  expect((await row.find({ key: 'strip:call-1:2' }))?.text).toMatch(/▶ 0:13 clip\.mp4/)
  await row.unmount()
})

test('l and j move the selection, Enter opens it, g goes back', async ($, on) => {
  const world = stand(on)
  await boot($)
  await show($, { paths: ['shots', 'cat.jpg'] })
  await settle($)

  const ui = await $.ui.mount(PANE)
  // 70 columns hold three tiles of 22 in a row.
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(4)
  expect((await ui.find({ key: 'tile:0' }))?.props.autoFocus).toBe(true)

  await ui.press({ key: 'key:right' })
  await settle($)
  expect((await ui.find({ key: 'tile:1' }))?.props.autoFocus).toBe(true)
  await ui.press({ key: 'key:down' })
  await settle($)
  expect((await ui.find({ key: 'tile:3' }))?.props.autoFocus).toBe(true)

  await ui.press({ key: 'tile:3' })
  await settle($)
  expect(await ui.find({ key: 'key:grid' })).toBeDefined()
  // Enter goes back to the grid: the ring starts on it in view mode.
  expect((await ui.find({ key: 'key:grid' }))?.props.autoFocus).toBe(true)
  const picture = await ui.find({ type: 'Image', key: 'view' })
  expect(String((picture?.props.source as { file?: unknown } | undefined)?.file)).toMatch(/-v1600\.png$/)

  await ui.press({ key: 'key:grid' })
  await settle($)
  expect(await ui.find({ key: 'key:down' })).toBeDefined()
  await ui.unmount()
})

test('a video in view plays into one file that ffmpeg rewrites', async ($, on) => {
  const world = stand(on)
  await boot($)
  await show($, { paths: ['shots/clip.mp4'], view: true })
  await settle($)

  const ffmpeg = world.spawned.find(argv => argv.includes('-update'))
  expect(ffmpeg).toBeDefined()
  expect(ffmpeg).toEqual(expect.arrayContaining(['-re', '-an', '-atomic_writing', '1']))
  expect(ffmpeg?.[ffmpeg.length - 1]).toMatch(/\/tmp\/t\/cmg\/play-.*\.png$/)
})

test('f hands the whole set to pepper-play, from the item in view, and the pane comes back when it ends', async ($, on) => {
  const world = stand(on)
  await boot($)
  await show($, { paths: ['shots'], start: 1 })
  await settle($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:fullscreen' })
  await settle($)
  const player = world.spawned.find(argv => argv[0] === PEPPER.PEPPER_PLAY)
  expect(player).toEqual(
    expect.arrayContaining(['--idle=yes', '--loop-file=inf', '--image-display-duration=inf', '--playlist-start=1', '--', `${ROOT}/shots/b2.png`, `${ROOT}/shots/b10.png`, `${ROOT}/shots/clip.mp4`]),
  )
  // A short socket: a Unix socket's path ends at 104 bytes on macOS.
  expect(player?.find(arg => arg.startsWith('--input-ipc-server='))).toMatch(/^--input-ipc-server=\/tmp\/t\/cmg\/mpv-[0-9a-f]{10}\.sock$/)
  // The stand-in ended at once, as a pepper-play that quits does: the grid is back.
  expect((await ui.find({ key: 'key:fullscreen' }))?.props.label).toBe('fullscreen')
  expect(await ui.find({ key: 'key:down' })).toBeDefined()
  await ui.unmount()
})

test("pepper-play's box covers the whole tab", () => {
  expect(ipcLine(placeCommandOf(160, 50))).toBe('{"command":["script-message-to","main","pepper-place","0","0","160","50"]}')
})

test('in herdr, f says why there is no fullscreen and starts nothing', async ($, on) => {
  const world = stand(on, { ...PEPPER, TERM_PROGRAM: 'herdr', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  await boot($)
  await show($, { paths: ['cat.jpg'] })
  await settle($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:fullscreen' })
  await settle($)
  expect(world.spawned.some(argv => argv[0] === PEPPER.PEPPER_PLAY)).toBe(false)
  expect(world.toasts.join('\n')).toMatch(/No fullscreen here: herdr sits between/)
  // Given up before a player started: the pane is out of 'starting'.
  expect((await ui.find({ key: 'key:fullscreen' }))?.props.label).toBe('fullscreen')
  // Pictures there go as bytes.
  const picture = await ui.find({ type: 'Image' })
  expect((picture?.props.source as { png?: unknown } | undefined)?.png).toBe(PNG)
  await ui.unmount()
})

test('/gallery with no arguments shows the working folder', async ($, on) => {
  const world = stand(on)
  await boot($)
  const ran = await ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args: '' })
  expect(ran.text).toMatch(/^Gallery [0-9a-f]{8}: work, 1 picture\.$/)
  expect(world.opens).toBe(1)
})

test('/gallery with no arguments reopens the last gallery where it was; a tool set is not copied, and its line draws no strip', async ($, on) => {
  stand(on)
  await boot($)
  await show($, { paths: ['shots'], start: 2 })
  await settle($)

  const ran = await ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args: '' })
  await settle($)
  expect(ran.text).toBe('Gallery: shots, 2 pictures, 1 video.')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'tile:2' }))?.props.autoFocus).toBe(true)
  await ui.unmount()

  const row = await $.ui.mount({
    plugin: 'media-gallery',
    component: 'CommandOutput',
    requestId: 'msg-1',
    surface: 'terminal',
    viewport: { columns: 120, rows: 50, isFullscreen: true },
    props: { command: 'gallery', args: '', text: ran.text ?? '', isErrored: false },
  })
  // The thumbnails are under the tool's row already.
  expect(await row.find({ type: 'Button', text: /Open the gallery/ })).toBeUndefined()
  await row.unmount()
})

test('a bare /gallery after a /gallery names that set again, and the same pictures again reuse their set', async ($, on) => {
  stand(on)
  await boot($)
  const run = ($: Engine, args: string) => ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args })
  const first = await run($, 'shots')
  await settle($)
  const again = await run($, 'shots')
  await settle($)
  const bare = await run($, '')
  await settle($)
  const tag = /^Gallery ([0-9a-f]{8}):/.exec(first.text ?? '')?.[1]
  expect(tag).toBeDefined()
  expect(again.text).toBe(first.text)
  expect(bare.text).toBe(`Gallery ${tag}: shots, 2 pictures, 1 video.`)
})

test('the home-folder cache is swept for week-old pictures, and a reused picture is marked as used', async ($, on) => {
  const world = stand(on, { TERM_PROGRAM: 'ghostty', HOME: '/home/me' })
  await boot($)
  await show($, { paths: ['cat.jpg'] })
  await settle($)
  expect(world.runs.some(argv => argv[0] === 'find' && argv[1] === '/home/me/.cache/cmg')).toBe(true)
  await show($, { paths: ['cat.jpg'] }, 'call-2')
  await settle($)
  expect(world.runs.some(argv => argv[0] === 'touch' && /-t\.png$/.test(argv[1] ?? ''))).toBe(true)
})

test('a show opens the pane without taking the keys; /gallery takes them', async ($, on) => {
  const world = stand(on)
  await boot($)
  const ran = await show($, { paths: ['cat.jpg'] })
  expect(world.openArgs[0]?.focus).toBeUndefined()
  expect(String(ran.result)).toMatch(/ctrl\+x tab/)
  await ($.command.run as (e: unknown) => Promise<unknown>)({ command: 'gallery', args: 'shots' })
  expect(world.openArgs[1]?.focus).toBe(true)
})

test('set to take the keys always, a show takes them too', { options: { takeKeys: 'always' } }, async ($, on) => {
  const world = stand(on)
  await boot($)
  const ran = await show($, { paths: ['cat.jpg'] })
  expect(world.openArgs[0]?.focus).toBe(true)
  expect(String(ran.result)).not.toMatch(/ctrl\+x tab/)
})

test('a pane still waiting for room plays nothing and makes no large picture', async ($, on) => {
  const world = stand(on, PEPPER, { isPlaced: false })
  await boot($)
  await show($, { paths: ['shots/clip.mp4'], view: true })
  await settle($)
  expect(world.spawned.some(argv => argv.includes('-update'))).toBe(false)
  expect([...world.made].some(path => /-v\d+\.png$/.test(path))).toBe(false)
})

test('each play writes a frames file of its own, and an ended one is removed', async ($, on) => {
  const world = stand(on)
  await boot($)
  await show($, { paths: ['shots/clip.mp4'], view: true })
  await settle($)
  const ui = await $.ui.mount(PANE)
  // The stand-in ffmpeg ends at once, as one that gives up does: p tries again.
  await ui.press({ key: 'key:play' })
  await settle($)
  const outs = world.spawned.filter(argv => argv.includes('-update')).map(argv => argv[argv.length - 1] ?? '')
  expect(outs).toHaveLength(2)
  expect(outs[0]).not.toBe(outs[1])
  expect(world.runs.some(argv => argv[0] === 'rm' && argv.includes(outs[0] ?? ''))).toBe(true)
  await ui.unmount()
})

test('sips makes a small picture no larger than it is', async ($, on) => {
  const world = stand(on, PEPPER, { ffmpegFails: true, sipsSize: 'pixelWidth: 200\npixelHeight: 150' })
  await boot($)
  await show($, { paths: ['cat.jpg'] })
  await settle($)
  const conversions = world.runs.filter(argv => argv[0] === 'sips' && argv.includes('format'))
  expect(conversions.length).toBeGreaterThan(0)
  expect(conversions.every(argv => !argv.includes('-Z'))).toBe(true)
})

test('/gallery on the same pictures again keeps what was made for unchanged files, and reads a changed one anew', async ($, on) => {
  const world = stand(on)
  await boot($)
  const run = ($ as Engine).command.run as (e: unknown) => Promise<{ text?: string }>
  const first = await run({ command: 'gallery', args: 'shots' })
  await settle($)
  const probes = () => world.runs.filter(argv => argv[0]?.endsWith('ffprobe') && !argv.includes('-version')).length
  const before = probes()
  const second = await run({ command: 'gallery', args: 'shots' })
  await settle($)
  expect(galleryTagOf(second.text ?? '')).toBe(galleryTagOf(first.text ?? ''))
  // Nothing changed: the video is not probed again.
  expect(probes()).toBe(before)
  world.mtimes[`${ROOT}/shots/clip.mp4`] = 9
  await run({ command: 'gallery', args: 'shots' })
  await settle($)
  expect(probes()).toBe(before + 1)
})

test('/gallery again tries an item that failed before, without its file changing', async ($, on) => {
  const standing: Standing = { ffmpegFails: true }
  stand(on, PEPPER, standing)
  await boot($)
  const run = ($ as Engine).command.run as (e: unknown) => Promise<{ text?: string }>
  await run({ command: 'gallery', args: 'shots/clip.mp4' })
  await settle($)
  const failed = await $.ui.mount(PANE)
  expect(await failed.find({ type: 'Text', text: /could not be read/ })).toBeDefined()
  await failed.unmount()
  // ffmpeg works now (installed, or the file finished downloading): the same /gallery makes it.
  standing.ffmpegFails = false
  await run({ command: 'gallery', args: 'shots/clip.mp4' })
  await settle($)
  const made = await $.ui.mount(PANE)
  expect(await made.find({ type: 'Text', text: /could not be read/ })).toBeUndefined()
  expect(await made.findAll({ type: 'Image' })).toHaveLength(1)
  await made.unmount()
})

test('the temp-folder cache is left to the OS, but for frames files an earlier session left', async ($, on) => {
  const world = stand(on)
  await boot($)
  await show($, { paths: ['cat.jpg'] })
  await settle($)
  expect(world.runs.some(argv => argv[0] === 'find' && argv.includes('-mtime'))).toBe(false)
  expect(world.runs.some(argv => argv[0] === 'find' && argv.includes('play-*.png') && argv.includes('-mmin'))).toBe(true)
})

test('a view opened while the pane waited for room starts once the pane is drawn', async ($, on) => {
  const world = stand(on, PEPPER, { isPlaced: false })
  await boot($)
  await show($, { paths: ['shots/clip.mp4'], view: true })
  await settle($)
  expect(world.spawned.some(argv => argv.includes('-update'))).toBe(false)
  const ui = await $.ui.mount(PANE)
  await settle($)
  expect(world.spawned.some(argv => argv.includes('-update'))).toBe(true)
  expect([...world.made].some(path => /-v\d+\.png$/.test(path))).toBe(true)
  await ui.unmount()
})

test('a picture whose shape is not known yet is measured from its large picture, never stretched to the box', async ($, on) => {
  stand(on, PEPPER, { isThumbUnreadable: true })
  await boot($)
  await show($, { paths: ['cat.jpg'], view: true })
  await settle($)
  const ui = await $.ui.mount(PANE)
  await settle($)
  const picture = await ui.find({ type: 'Image', key: 'view' })
  expect(String((picture?.props.source as { file?: unknown } | undefined)?.file)).toMatch(/-v1600\.png$/)
  // 640 by 480 in 70 columns: 70 * 480 / 640 / 2 = 26.25 rows, not the box's 36.
  expect(picture?.props.columns).toBe(70)
  expect(picture?.props.rows).toBe(26)
  await ui.unmount()
})

test('a reload plays the video in view again only into an open pane', async ($, on) => {
  const world = stand(on)
  let isPaneUp = false
  on('ui.panes', () => ({ value: isPaneUp ? [{ id: 'media-gallery', title: 'clip', isPlaced: true, isShown: true, isFocused: false }] : [] }) as never)
  const plays = () => world.spawned.filter(argv => argv.includes('-update')).length
  await boot($)
  await show($, { paths: ['shots/clip.mp4'] })
  await settle($)
  // A pane drawn where pictures do not show: the video put in view next is not played, so no
  // stand-in ffmpeg (which ends at once) marks it unplayable before the reloads below.
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desktop.unmount()
  await show($, { paths: ['shots/clip.mp4'], view: true }, 'call-2')
  await settle($)
  expect(plays()).toBe(0)
  const terminal = await $.ui.mount(PANE)
  await terminal.unmount()

  // Closed: a reload starts nothing.
  await boot($)
  await settle($)
  expect(plays()).toBe(0)

  isPaneUp = true
  await boot($)
  await settle($)
  expect(plays()).toBe(1)
})

test('each /gallery row keeps drawing the set it showed after later runs', async ($, on) => {
  stand(on)
  await boot($)
  const run = ($: Engine, args: string) => ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args })
  const first = await run($, 'shots')
  await settle($)
  const second = await run($, 'cat.jpg')
  await settle($)
  expect(first.text).not.toBe(second.text)

  const rowOf = (text: string, args: string) =>
    $.ui.mount({
      plugin: 'media-gallery',
      component: 'CommandOutput',
      requestId: `msg-${args}`,
      surface: 'terminal',
      viewport: { columns: 120, rows: 50, isFullscreen: true },
      props: { command: 'gallery', args, text, isErrored: false },
    })
  const firstRow = await rowOf(first.text ?? '', 'shots')
  expect((await firstRow.find({ type: 'Button', text: /Open the gallery: 2 pictures, 1 video/ }))?.text).toBeDefined()
  await firstRow.unmount()
  const secondRow = await rowOf(second.text ?? '', 'cat.jpg')
  expect((await secondRow.find({ type: 'Button', text: /Open the gallery: 1 picture$/ }))?.text).toBeDefined()
  await secondRow.unmount()
})

test('nothing to show says what each path was', async ($, on) => {
  stand(on)
  await boot($)
  const ran = await ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args: 'shots/notes.txt nope' })
  expect(ran.text).toBe('Nothing to show: shots/notes.txt (not a picture or video); nope (not found).')
  const wild = await ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args: 'sh*/b2.png' })
  expect(wild.text).toBe('Nothing to show: sh*/b2.png (a * or ? works in the file name only).')
  const deeper = await ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args: 'sh*/x/b2.png' })
  expect(deeper.text).toBe('Nothing to show: sh*/x/b2.png (a * or ? works in the file name only).')
  // Patterns in both the folder and the file name: the folder's is the one that cannot work.
  const both = await ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'gallery', args: 'sh*/b*.png' })
  expect(both.text).toBe('Nothing to show: sh*/b*.png (a * or ? works in the file name only).')
})
