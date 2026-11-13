import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Activity, GitView, Layout, Listing, Touch } from '../types'
import { GLYPHS, chipOf } from './art'
import {
  AUTO_CLOSE_MS,
  FLASH_MS,
  MAX_ATTRIBUTED,
  MAX_CHANGES,
  MAX_FOLDS,
  NO_GIT,
  applyTouches,
  buildRows,
  clip,
  commitsSince,
  countLines,
  dirname,
  findFiles,
  foldersToClose,
  foldersToOpen,
  foldsOfAll,
  formatSize,
  headAfter,
  iconOf,
  imagePlanOf,
  needsTmuxAnswer,
  toggleFold,
  touchedFilesIn,
  touchedRowsOf,
  touchedTreeOf,
  isTopFolder,
  listingOf,
  mentionPath,
  parseIconMap,
  parseNumstat,
  parseReflog,
  parseStatus,
  pathMapper,
  pickChanged,
  planOfTool,
  rememberLast,
  resolvePath,
  sameGitView,
  sameListing,
  shellMayWrite,
  shellReads,
  toolVerb,
  shownPath,
  summaryOf,
  visibleFolders,
  tmuxPlanOf,
  withPinned,
  wholeRecords,
  withTreeSetting,
} from './model'

const ROOT = '/work/app'
const touchedRows = (root: string, paths: Iterable<string>, folded: ReadonlySet<string>, ignored: ReadonlySet<string>) =>
  touchedRowsOf(touchedTreeOf(root, paths), root, folded, ignored)
const touchedCount = (root: string, paths: Iterable<string>) => touchedFilesIn(touchedTreeOf(root, paths))
const T0 = Date.parse('2026-11-09T10:00:00Z')

const emptyLayout = (over: Partial<Layout> = {}): Layout => ({
  project: ROOT,
  root: ROOT,
  expanded: [],
  autoOpened: {},
  treeView: 'all',
  touchedOnly: false,
  touchedClosed: [],
  query: '',
  showHidden: true,
  showSizes: false,
  showAllTouched: false,
  hasAutoOpened: false,
  ...over,
})

// Most of the panel's behaviour is the whole tree's; the default shows only what Claude touched.
const ALL_FILES = { options: { treeView: 'all' } }

const idle = (over: Partial<Activity> = {}): Activity => ({
  turn: 1,
  isWorking: false,
  working: [],
  trail: [],
  trailTurn: 1,
  commitSha: '',
  ...over,
})

const touch = (path: string, kind: Touch['kind'], over: Partial<Touch> = {}): Touch => ({
  path,
  kind,
  lastAction: kind,
  turnAction: kind,
  lastAt: T0,
  turn: 1,
  liveUntil: 0,
  ...over,
})

test('paths resolve against the working folder and home', () => {
  expect(resolvePath(ROOT, 'src/a.ts')).toBe('/work/app/src/a.ts')
  expect(resolvePath(ROOT, '../other/./b.ts')).toBe('/work/other/b.ts')
  expect(resolvePath(ROOT, '/etc/hosts')).toBe('/etc/hosts')
  expect(resolvePath(ROOT, '~/notes.md', '/home/me')).toBe('/home/me/notes.md')
  expect(shownPath(ROOT, '/work/app/src/a.ts')).toBe('src/a.ts')
  expect(shownPath(ROOT, '/home/me/x', '/home/me')).toBe('~/x')
})

test('built-in tools name their files', () => {
  expect(planOfTool('Read', { file_path: 'a.ts' }, ROOT)).toEqual({ reads: ['/work/app/a.ts'], writes: [], mayWrite: false })
  expect(planOfTool('Edit', { file_path: '/x/a.ts' }, ROOT).writes).toEqual(['/x/a.ts'])
  expect(planOfTool('NotebookEdit', { notebook_path: 'n.ipynb' }, ROOT).writes).toEqual(['/work/app/n.ipynb'])
  expect(planOfTool('Grep', { pattern: 'x' }, ROOT)).toEqual({ reads: [], writes: [], mayWrite: false })
})

test('MCP tools are read by what they are called and what they name', () => {
  expect(planOfTool('mcp__fw__read', { paths: ['a.ts', 'b.ts'] }, ROOT).reads).toEqual(['/work/app/a.ts', '/work/app/b.ts'])
  expect(planOfTool('mcp__fw__search', { pattern: 'x', path: 'src' }, ROOT).reads).toEqual([])
  expect(planOfTool('mcp__fs__write_file', { path: 'c.ts' }, ROOT)).toEqual({ reads: [], writes: ['/work/app/c.ts'], mayWrite: true })
  expect(planOfTool('mcp__notion__update_page', { page_id: '1' }, ROOT)).toEqual({ reads: [], writes: [], mayWrite: false })
})

test("fastwrite's script names the files it edits, moves and removes", () => {
  const script = '@ src/a.ts\ns/old/new/\n> src/new.ts\nbody\n.\nmv src/old.ts src/moved.ts\nrm src/gone.ts\n>> 12的 14一\n'
  expect(planOfTool('mcp__fw__edit', { script }, ROOT).writes).toEqual([
    '/work/app/src/a.ts',
    '/work/app/src/new.ts',
    '/work/app/src/moved.ts',
    '/work/app/src/gone.ts',
  ])
})

test("fastwrite's moves and copies into another file name that file, and moves within one name none", () => {
  const script = [
    '@ src/a.ts',
    'm 12的 14一 > src/b.ts $',
    'c 3a 5b > src/c.ts 0',
    'c 3a > src/d.ts 30中',
    'm 12的 14一 > src/e.ts',
    'm 12的 14一 > 30中',
    'c 3a 5b > $',
    '',
  ].join('\n')
  expect(planOfTool('mcp__fw__edit', { script }, ROOT).writes).toEqual([
    '/work/app/src/a.ts',
    '/work/app/src/b.ts',
    '/work/app/src/c.ts',
    '/work/app/src/d.ts',
    '/work/app/src/e.ts',
  ])
})

test("fastwrite's text bodies are text: lines in them that read like ops name no file", () => {
  const script = [
    '@ Makefile',
    '+ 3a',
    'rm build/x.o',
    '.',
    '@ src/app.js',
    '= 5b 6c',
    'c = a > b',
    '> quoted',
    '.',
    '> src/notes.md',
    'm 1 > out.ts',
    '.',
    '<<<<<<< SEARCH',
    'm 1 > out.ts',
    '=======',
    'rm build/y.o',
    '>>>>>>> REPLACE',
    'rm src/old.js',
    '',
  ].join('\n')
  expect(planOfTool('mcp__fw__edit', { script }, ROOT).writes).toEqual([
    '/work/app/Makefile',
    '/work/app/src/app.js',
    '/work/app/src/notes.md',
    '/work/app/src/old.js',
  ])
})

test('after `>`, a name of digits is a file; a line tag is digits and one character past ASCII', () => {
  const script = '@ a.ts\nc 3a 5b > 2024\nm 1x > 10a\nm 1x > 30中\n'
  expect(planOfTool('mcp__fw__edit', { script }, ROOT).writes).toEqual(['/work/app/a.ts', '/work/app/2024', '/work/app/10a'])
})

test('an MCP tool reads a relative path from where Claude Code started; a built-in one from the shell folder', () => {
  const shell = `${ROOT}/sub`
  expect(planOfTool('mcp__fw__edit', { script: '@ src/a.ts\n' }, shell, '', ROOT).writes).toEqual(['/work/app/src/a.ts'])
  expect(planOfTool('mcp__fw__read', { path: 'b.ts' }, shell, '', ROOT).reads).toEqual(['/work/app/b.ts'])
  expect(planOfTool('Read', { file_path: 'b.ts' }, shell, '', ROOT).reads).toEqual(['/work/app/sub/b.ts'])
})

test('folds share one bound, so a fold after Collapse all keeps the earlier ones', () => {
  const closed = Array.from({ length: 250 }, (_, i) => `${ROOT}/d${i}`)
  const after = toggleFold(closed, `${ROOT}/d0`, ROOT)
  expect(after).toHaveLength(249)
  expect(after[0]).toBe(`${ROOT}/d1`)
  expect(toggleFold([...closed, `/elsewhere/x`], `${ROOT}/new`, ROOT)).toHaveLength(251)
  expect(toggleFold(Array.from({ length: MAX_FOLDS }, (_, i) => `${ROOT}/f${i}`), `${ROOT}/g`, ROOT)).toHaveLength(MAX_FOLDS)
})

test('Collapse all past the bound keeps the top of the tree folded', () => {
  const rows = Array.from({ length: MAX_FOLDS + 5 }, (_, i) => `${ROOT}/d${i}`)
  const folds = foldsOfAll(rows)
  expect(folds).toHaveLength(MAX_FOLDS)
  expect(folds[0]).toBe(`${ROOT}/d0`)
  expect(folds.at(-1)).toBe(`${ROOT}/d${MAX_FOLDS - 1}`)
})

test('a dry run changes nothing, so it marks nothing', () => {
  const plan = { reads: [], writes: [], mayWrite: false }
  expect(planOfTool('mcp__fw__edit', { script: '@ a.ts\n', dry_run: true }, ROOT)).toEqual(plan)
  expect(planOfTool('mcp__fs__edit_file', { path: 'a.ts', dryRun: true }, ROOT)).toEqual(plan)
})

test('a write that also says find is a write, and paths go by many names', () => {
  expect(planOfTool('mcp__fs__find_and_replace', { path: 'a.ts' }, ROOT).writes).toEqual(['/work/app/a.ts'])
  expect(planOfTool('mcp__fs__search_replace', { relative_path: 'b.ts' }, ROOT).writes).toEqual(['/work/app/b.ts'])
  expect(planOfTool('mcp__fs__move_file', { source: 'a/old.ts', destination: 'a/new.ts' }, ROOT).writes).toEqual([
    '/work/app/a/old.ts',
    '/work/app/a/new.ts',
  ])
})

test('loose words such as from and to must look like paths', () => {
  expect(planOfTool('mcp__cal__create_event', { from: '2026-11-09', to: 'me@x.com' }, ROOT).writes).toEqual([])
  expect(planOfTool('mcp__web__update', { target: 'https://x.com/a/b' }, ROOT).writes).toEqual([])
})

test('a shell command reads the files it plainly reads', () => {
  expect(shellReads('cat a.ts && cd sub && head -n 5 b.txt | wc -l', ROOT)).toEqual(['/work/app/a.ts', '/work/app/sub/b.txt'])
  expect(shellReads('cat a.ts > copy.ts', ROOT)).toEqual(['/work/app/a.ts'])
  expect(shellReads("sed -n '1,2p' c.ts", ROOT)).toEqual(['/work/app/c.ts'])
  expect(shellReads("sed -i 's/a/b/' c.ts", ROOT)).toEqual([])
  expect(shellReads('fw read d.ts -l 1-5', ROOT)).toEqual(['/work/app/d.ts'])
  expect(shellReads('rg foo src && cat *.ts', ROOT)).toEqual([])
  expect(shellReads('cat "with space.ts"', ROOT)).toEqual(['/work/app/with space.ts'])
})

test('a heredoc is text, a subshell is commands, and in-place sed is no read', () => {
  expect(shellReads("python3 - <<'EOF'\ncat README.md\nEOF\ncat real.ts", ROOT)).toEqual(['/work/app/real.ts'])
  expect(shellReads('(cd sub && cat a.ts)', ROOT)).toEqual(['/work/app/sub/a.ts'])
  expect(shellReads("if cat a.ts; then head b.ts; fi", ROOT)).toEqual(['/work/app/a.ts', '/work/app/b.ts'])
  expect(shellReads("sed -Ei 's/a/b/' f.ts", ROOT)).toEqual([])
  expect(shellReads("sed --in-place 's/a/b/' f.ts", ROOT)).toEqual([])
  expect(shellReads("FOO=1 cat a.ts", ROOT)).toEqual(['/work/app/a.ts'])
})

test('a shell command known only to look cannot have written anything', () => {
  for (const command of [
    'ls -la',
    'sleep 60',
    'git status --short',
    'git -C sub log -3',
    'cat a 2>/dev/null',
    'rg foo src 2>&1 | head -5',
    "sed -n '1,2p' a",
    'find . -name x',
    'fw read a.ts',
    'if test -f a; then echo yes; fi',
  ]) {
    expect([command, shellMayWrite(command)]).toEqual([command, false])
  }
})

test('anything else may have', () => {
  for (const command of [
    'python3 fix.py',
    'git commit -am x',
    'git -C sub checkout main',
    'echo hi > a.txt',
    'cat a >> b',
    "sed -i 's/a/b/' f",
    'find . -delete',
    "fw apply <<'EOF'\n@ a.ts\nEOF",
    'ls && make',
    'FOO=1 npm run build',
  ]) {
    expect([command, shellMayWrite(command)]).toEqual([command, true])
  }
})

test('commands that look unless told to write: fd, yq, sort, uniq and awk', () => {
  const writes = [
    'fd -e orig -x rm',
    'fd -e ts -X prettier --write',
    'fd --exec-batch rm',
    'fd --exec=rm x',
    "yq -i '.version = \"2\"' chart.yaml",
    "yq --inplace '.a = 1' c.yaml",
    'sort -o list.txt list.txt',
    'sort -uo out.txt in.txt',
    'sort --output=x.txt y.txt',
    'uniq a.txt b.txt',
    "awk -i inplace '{print}' f.txt",
    "gawk -i inplace '{print}' f.txt",
    "awk -iinplace '{print}' f.txt",
  ]
  for (const command of writes) expect([command, shellMayWrite(command)]).toEqual([command, true])
  const looks = [
    'fd -e ts',
    "yq '.a' c.yaml",
    'sort -u list.txt',
    'uniq -c a.txt',
    'uniq -f 2 a.txt',
    "awk '{print}' f.txt",
    // A redirection, and the value of a long flag, are no output file.
    'uniq -c a.txt 2>/dev/null',
    'uniq -c a.txt 2>&1',
    'uniq --skip-fields 2 a.txt',
    'uniq --skip-fields=2 a.txt',
  ]
  for (const command of looks) expect([command, shellMayWrite(command)]).toEqual([command, false])
})

test('a redirect stuck to a quoted word still writes, and a comment is no command', () => {
  expect(shellMayWrite('echo "export const x = 1">src/x.ts')).toBe(true)
  expect(shellMayWrite("echo 'a'>>log.txt")).toBe(true)
  expect(shellMayWrite('echo "quiet">/dev/null')).toBe(false)
  expect(shellMayWrite('ls # rm -rf build')).toBe(false)
  expect(shellMayWrite('ls\n# make clean\nls')).toBe(false)
})

test('a shell read names no bogus paths: heredoc markers, unexpanded words, comments and +N', () => {
  expect(shellReads("cat <<'EOF' > out.txt\nhello\nEOF", ROOT)).toEqual([])
  expect(shellReads('cat "$HOME/.zshrc"', ROOT)).toEqual([])
  expect(shellReads('cat a.ts # note b.ts', ROOT)).toEqual(['/work/app/a.ts'])
  expect(shellReads('tail -n +5 f.ts', ROOT)).toEqual(['/work/app/f.ts'])
})

test("a file descriptor's redirection is skipped, and only the output's ends the arguments", () => {
  expect(shellReads('cat 2>/dev/null a.ts', ROOT)).toEqual(['/work/app/a.ts'])
  expect(shellReads('head -n 5 2>&1 a.ts', ROOT)).toEqual(['/work/app/a.ts'])
  expect(shellReads('cat a.ts 2> err.log b.ts', ROOT)).toEqual(['/work/app/a.ts', '/work/app/b.ts'])
  expect(shellReads('cat &>all.log a.ts', ROOT)).toEqual(['/work/app/a.ts'])
  // The output's redirection: what follows is written; a name stuck before it is read.
  expect(shellReads('cat a.ts > out.txt b.ts', ROOT)).toEqual(['/work/app/a.ts'])
  expect(shellReads('cat a.ts>out.txt', ROOT)).toEqual(['/work/app/a.ts'])
})

test('a bare cd goes home, and after cd - only absolute paths are known', () => {
  expect(shellReads('cd && cat .zshrc', ROOT, '/home/me')).toEqual(['/home/me/.zshrc'])
  expect(shellReads('cd - && cat a.ts && cat /etc/hosts && cat ~/x.md', ROOT, '/home/me')).toEqual(['/etc/hosts', '/home/me/x.md'])
})

test('fw apply through the shell names the files of its heredoc script', () => {
  const plan = planOfTool('Bash', { command: "fw apply <<'EOF'\n@ src/a.ts\ns/x/y/\n> b.ts\nrm c.ts\n.\nEOF" }, ROOT)
  expect(plan).toEqual({ reads: [], writes: ['/work/app/src/a.ts', '/work/app/b.ts'], mayWrite: true })
  // Where the shell stands then, and a path outside the project as it is written.
  expect(planOfTool('Bash', { command: "cd sub && fw apply <<'EOF'\n@ a.ts\n@ /home/me/.claude/x.md\nEOF" }, ROOT, '/home/me').writes).toEqual([
    '/work/app/sub/a.ts',
    '/home/me/.claude/x.md',
  ])
  // A dry run only reads.
  expect(planOfTool('Bash', { command: "fw apply -n <<'EOF'\n@ a.ts\nEOF" }, ROOT)).toEqual({ reads: ['/work/app/a.ts'], writes: [], mayWrite: false })
  // Each heredoc feeds its own command: only fw's body is a script.
  expect(planOfTool('Bash', { command: "cat <<'A'\n@ no.ts\nA\nfw apply <<'B'\n@ yes.ts\nB" }, ROOT).writes).toEqual(['/work/app/yes.ts'])
  // A heredoc inside a quoted command substitution on an earlier line does not shift which body is fw's.
  const commit = 'git commit -m "$(cat <<\'EOF\'\n@ msg.ts\nEOF\n)" && fw apply <<\'EOF\'\n@ yes.ts\nEOF'
  expect(planOfTool('Bash', { command: commit }, ROOT).writes).toEqual(['/work/app/yes.ts'])
})

test('an MCP tool is known by the words of its name, so a download is no read', () => {
  expect(planOfTool('mcp__figma__download_assets', { path: 'assets/logo.png' }, ROOT)).toEqual({ reads: [], writes: ['/work/app/assets/logo.png'], mayWrite: true })
  expect(planOfTool('mcp__notes__save_note', { path: 'n.md' }, ROOT).writes).toEqual(['/work/app/n.md'])
  expect(planOfTool('mcp__fs__readFile', { path: 'a.ts' }, ROOT).reads).toEqual(['/work/app/a.ts'])
  // One run-on word is still read by its letters.
  expect(planOfTool('mcp__fs__readfile', { path: 'a.ts' }, ROOT).reads).toEqual(['/work/app/a.ts'])
  expect(planOfTool('mcp__web__preview_page', { path: 'p.html' }, ROOT).reads).toEqual(['/work/app/p.html'])
  // Compounds and plurals of the listed words.
  expect(planOfTool('mcp__serena__get_symbols_overview', { relative_path: 'a.ts' }, ROOT).reads).toEqual(['/work/app/a.ts'])
  expect(planOfTool('mcp__drive__upload_file', { path: 'up.pdf' }, ROOT).reads).toEqual(['/work/app/up.pdf'])
  expect(planOfTool('mcp__fs__rewrite_file', { path: 'r.ts' }, ROOT).writes).toEqual(['/work/app/r.ts'])
  expect(planOfTool('mcp__fs__batch_edits', { path: 'b.ts' }, ROOT).writes).toEqual(['/work/app/b.ts'])
  // Letters inside a word do not count: a credit is no edit, a thread no read.
  expect(toolVerb('credit_report')).toBe('other')
  expect(toolVerb('thread_summary')).toBe('other')
})

test('a Bash call plans a look at the folder only if it may have written', () => {
  expect(planOfTool('Bash', { command: 'ls' }, ROOT).mayWrite).toBe(false)
  expect(planOfTool('Bash', { command: 'make' }, ROOT).mayWrite).toBe(true)
})

test('reading a changed file leaves it changed, and changing a committed one reopens it', () => {
  let list = applyTouches([], ['/a'], 'edited', T0, 1)
  list = applyTouches(list, ['/a'], 'read', T0 + 1, 1)
  expect(list[0]).toMatchObject({ kind: 'edited', lastAction: 'read', liveUntil: T0 + 1 + FLASH_MS })

  list = applyTouches(list, ['/a'], 'committed', T0 + 2, 1)
  expect(list[0]?.kind).toBe('committed')
  expect(applyTouches(list, ['/a'], 'read', T0 + 3, 1)[0]?.kind).toBe('committed')
  expect(applyTouches(list, ['/a'], 'edited', T0 + 3, 1)[0]?.kind).toBe('edited')
})

test('a later turn that only reads an edited file is a turn that read it', () => {
  const edited = applyTouches([], ['/a'], 'edited', T0, 1)
  expect(summaryOf(edited, idle())).toMatchObject({ title: 'Claude edited 1 file' })

  const rereadSameTurn = applyTouches(edited, ['/a'], 'read', T0 + 1, 1)
  expect(summaryOf(rereadSameTurn, idle())).toMatchObject({ title: 'Claude edited 1 file' })

  const readLater = applyTouches(edited, ['/a'], 'read', T0 + 1, 2)
  expect(readLater[0]?.kind).toBe('edited')
  expect(summaryOf(readLater, idle({ turn: 2 }))).toMatchObject({ title: 'Claude read 1 file', barLabel: '1 read' })
})

test('of several files at once, the last named is the newest', () => {
  expect(applyTouches([], ['/old', '/new'], 'edited', T0, 1).map(t => t.path)).toEqual(['/new', '/old'])
})

test('the newest touch comes first', () => {
  const list = applyTouches(applyTouches([], ['/a'], 'read', T0, 1), ['/b'], 'read', T0 + 1, 1)
  expect(list.map(t => t.path)).toEqual(['/b', '/a'])
})

test('git status: branch, codes, renames, untracked and ignored', () => {
  const toPath = pathMapper(ROOT, ROOT, '')
  const out = ['## main...origin/main [ahead 2, behind 1]', ' M src/a b.ts', 'R  new.ts', 'old.ts', '?? fresh.ts', '!! node_modules/', '?? nested/', ''].join('\0')
  const parsed = parseStatus(out, toPath)
  expect(parsed).toMatchObject({ branch: 'main', ahead: 2, behind: 1, ignored: ['/work/app/node_modules'] })
  expect(Object.keys(parsed.changes).sort()).toEqual(['/work/app/fresh.ts', '/work/app/new.ts', '/work/app/src/a b.ts'])
  expect(parsed.changes['/work/app/new.ts']?.code).toBe('R')
  expect(parsed.changes['/work/app/fresh.ts']?.code).toBe('?')
})

test('a huge number of changed files is cut, and the count stays true', () => {
  const lines = Array.from({ length: MAX_CHANGES + 5 }, (_, i) => `?? f${i}`)
  const parsed = parseStatus(['## main', ...lines, ''].join('\0'), p => p)
  expect(Object.keys(parsed.changes)).toHaveLength(MAX_CHANGES)
  expect(parsed.changedTotal).toBe(MAX_CHANGES + 5)
})

test('only real commits count, back to where HEAD last stood', () => {
  const entries = parseReflog(
    [
      'ccc3\0commit: third',
      'bbb2\0checkout: moving from a to b',
      'bbb1\0commit (amend): second',
      'aaa1\0commit (initial): first',
      'zzz0\0commit: older',
      '',
    ].join('\n'),
  )
  expect(commitsSince(entries, 'aaa')).toEqual(['ccc3', 'bbb1'])
  // No head before: only the branch's first commits are new, back to its initial one.
  expect(commitsSince(entries, '')).toEqual(['ccc3', 'bbb1', 'aaa1'])
  // No head before and no initial commit in sight (git log failed): none count.
  expect(commitsSince(parseReflog('ccc3\0commit: third\nbbb1\0commit: second\n'), '')).toEqual([])
  expect(commitsSince(parseReflog('ddd\0reset: moving to HEAD~1\neee\0pull: Fast-forward\n'), 'fff')).toEqual([])
  // A head before that the window no longer holds: where HEAD stood is unknown, so none count.
  expect(commitsSince(entries, 'nothere')).toEqual([])
})

test('where HEAD stands: no commits yet is known, any other failure keeps the last head or knows none', () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  const failed = (stderr: string) => ({ exitCode: 128, stdout: '', stderr })
  expect(headAfter(ok('abc1234\n'), null)).toEqual({ head: 'abc1234', isHeadKnown: true })
  expect(headAfter(failed("fatal: your current branch 'main' does not have any commits yet"), null)).toEqual({ head: '', isHeadKnown: true })
  expect(headAfter(failed('error: something broke'), { head: 'abc1234', isHeadKnown: true })).toEqual({ head: 'abc1234', isHeadKnown: true })
  // The first look at a folder fails: nothing is known, which is not "no commits yet".
  expect(headAfter(failed('error: something broke'), null)).toEqual({ head: '', isHeadKnown: false })
  expect(headAfter(failed('error: something broke'), { head: '', isHeadKnown: false })).toEqual({ head: '', isHeadKnown: false })
})

test('a status cut at its size limit loses its partial last record', () => {
  expect(wholeRecords('## main\0 M a.ts\0?? b.t', true)).toBe('## main\0 M a.ts\0')
  expect(wholeRecords('## main\0 M a.ts\0', false)).toBe('## main\0 M a.ts\0')
  const parsed = parseStatus(wholeRecords('## main\0 M a.ts\0?? half-a-na', true), path => `/r/${path}`)
  expect(Object.keys(parsed.changes)).toEqual(['/r/a.ts'])
})

test('two git views are compared by what they say', () => {
  const view: GitView = { ...NO_GIT, isRepo: true, changes: { '/a': { code: 'M', added: 1, removed: 0 } }, ignored: ['/x'] }
  expect(sameGitView(view, structuredClone(view))).toBe(true)
  expect(sameGitView(view, { ...view, head: 'abc' })).toBe(false)
  expect(sameGitView(view, { ...view, changes: { '/a': { code: 'M', added: 2, removed: 0 } } })).toBe(false)
  expect(sameGitView(view, { ...view, ignored: ['/y'] })).toBe(false)
})

test('two listings are compared by what they hold', () => {
  const listing: Listing = { entries: [{ name: 'a', isDir: false, isLink: false, size: 1, mtimeMs: T0 }], total: 1 }
  expect(sameListing(listing, structuredClone(listing))).toBe(true)
  expect(sameListing(listing, undefined)).toBe(false)
  expect(sameListing(undefined, undefined)).toBe(true)
  expect(sameListing(listing, { entries: [{ name: 'a', isDir: false, isLink: false, size: 1, mtimeMs: T0 + 1 }], total: 1 })).toBe(false)
})

test('a repository with no commits still has a branch', () => {
  expect(parseStatus('## No commits yet on trunk\0', p => p).branch).toBe('trunk')
  expect(parseStatus('## HEAD (no branch)\0', p => p).branch).toBe('detached')
})

test('numstat reads counts, and a binary file counts as nothing', () => {
  const counts = parseNumstat('3\t1\ta.ts\0-\t-\tb.png\0', p => `/r/${p}`)
  expect(counts.get('/r/a.ts')).toEqual([3, 1])
  expect(counts.get('/r/b.png')).toEqual([0, 0])
})

test("from a subfolder, git's paths land on the tree's spelling", () => {
  const toPath = pathMapper('/link/sub', '/real/repo', 'sub/')
  expect(toPath('sub/a.ts')).toBe('/link/sub/a.ts')
  expect(toPath('other/b.ts')).toBe('/real/repo/other/b.ts')
})

test('rows: folders first, opened folders nested, numbers in order', () => {
  const entry = (name: string, isDir = false) => ({ name, isDir, isLink: false, size: 1, mtimeMs: T0 })
  const lists = {
    [ROOT]: listingOf([entry('b10.ts'), entry('b2.ts'), entry('src', true), entry('.env')]),
    [`${ROOT}/src`]: listingOf([entry('x.ts')]),
  }
  const rows = buildRows(emptyLayout({ expanded: [`${ROOT}/src`] }), lists, new Set())
  expect(rows.map(r => `${r.depth}:${r.name}`)).toEqual(['0:src', '1:x.ts', '0:.env', '0:b2.ts', '0:b10.ts'])
  expect(buildRows(emptyLayout({ showHidden: false }), lists, new Set()).map(r => r.name)).toEqual(['src', 'b2.ts', 'b10.ts'])
})

test('only open folders whose parents are open need reading', () => {
  const layout = emptyLayout({ expanded: [`${ROOT}/a`, `${ROOT}/a/b`, `${ROOT}/x/y`, '/elsewhere'] })
  expect(visibleFolders(layout)).toEqual([`${ROOT}/a`, `${ROOT}/a/b`])
})

test('a folder open with nothing read yet draws closed, not open and empty', () => {
  const entry = { name: 'src', isDir: true, isLink: false, size: 0, mtimeMs: 0 }
  const rows = buildRows(emptyLayout({ expanded: [`${ROOT}/src`] }), { [ROOT]: listingOf([entry]) }, new Set())
  expect(rows[0]?.isOpen).toBe(false)
})

test('rows: an ignored folder passes that on, and a long folder says how much is cut', () => {
  const entry = (name: string, isDir = false) => ({ name, isDir, isLink: false, size: 1, mtimeMs: T0 })
  const lists = {
    [ROOT]: { entries: [entry('dist', true)], total: 5 },
    [`${ROOT}/dist`]: listingOf([entry('a.js')]),
  }
  const rows = buildRows(emptyLayout({ expanded: [`${ROOT}/dist`] }), lists, new Set([`${ROOT}/dist`]))
  expect(rows.map(r => r.isIgnored)).toEqual([true, true, false])
  expect(rows[2]?.more).toBe(4)
})

test('opening for Claude leaves .git, node_modules and ignored folders shut', () => {
  const layout = emptyLayout({ expanded: [`${ROOT}/src`] })
  expect(foldersToOpen(layout, [`${ROOT}/src/deep/a.ts`], new Set())).toEqual([`${ROOT}/src/deep`])
  expect(foldersToOpen(layout, [`${ROOT}/.git/config`], new Set())).toEqual([])
  expect(foldersToOpen(layout, [`${ROOT}/node_modules/x/a.js`], new Set())).toEqual([])
  expect(foldersToOpen(layout, [`${ROOT}/dist/a.js`], new Set([`${ROOT}/dist`]))).toEqual([])
  expect(foldersToOpen(layout, ['/elsewhere/a.ts'], new Set())).toEqual([])
})

test('when the person asks, even those open', () => {
  const layout = emptyLayout()
  expect(foldersToOpen(layout, [`${ROOT}/node_modules/x/a.js`], new Set(), true)).toEqual([`${ROOT}/node_modules`, `${ROOT}/node_modules/x`])
  expect(foldersToOpen(layout, [`${ROOT}/dist/a.js`], new Set([`${ROOT}/dist`]), true)).toEqual([`${ROOT}/dist`])
})

test('using a file pins the folders above it, and no others', () => {
  const layout = emptyLayout({ autoOpened: { [`${ROOT}/a`]: T0, [`${ROOT}/a/b`]: T0, [`${ROOT}/z`]: T0 } })
  expect(Object.keys(withPinned(layout, `${ROOT}/a/b/file.ts`).autoOpened)).toEqual([`${ROOT}/z`])
})

test('a mention is relative to the session, not to the tree', () => {
  expect(mentionPath(ROOT, `${ROOT}/src/a.ts`)).toBe('src/a.ts')
  expect(mentionPath(ROOT, '/work/other/a.ts')).toBe('/work/other/a.ts')
})

test('Windows paths have tops of their own', () => {
  expect(dirname('C:/work')).toBe('C:/')
  expect(dirname('C:/work/a')).toBe('C:/work')
  expect(dirname('C:/')).toBe('C:/')
  expect(resolvePath('C:/work', '..')).toBe('C:/')
  expect(isTopFolder('C:/')).toBe(true)
  expect(isTopFolder('/')).toBe(true)
  expect(isTopFolder('/work')).toBe(false)
})

test('a folder opened for reads closes once quiet; one holding an edit stays', () => {
  const dir = `${ROOT}/src`
  const layout = emptyLayout({ expanded: [dir], autoOpened: { [dir]: T0 } })
  const read = [touch(`${dir}/a.ts`, 'read')]
  expect(foldersToClose(layout, read, T0 + AUTO_CLOSE_MS - 1)).toEqual([])
  expect(foldersToClose(layout, read, T0 + AUTO_CLOSE_MS)).toEqual([dir])
  expect(foldersToClose(layout, [touch(`${dir}/a.ts`, 'edited')], T0 + AUTO_CLOSE_MS * 9)).toEqual([])
})

test('only what changed during the call is put down to Claude', () => {
  const since = T0
  const candidates = [
    { path: '/old', mtimeMs: T0 - 5000 },
    { path: '/new', mtimeMs: T0 + 100 },
    { path: '/known', mtimeMs: T0 + 100 },
  ]
  expect(pickChanged(candidates, since, [touch('/known', 'edited', { lastAt: T0 })])).toEqual(['/new'])
  const many = Array.from({ length: 80 }, (_, i) => ({ path: `/f${i}`, mtimeMs: T0 + i }))
  const newest = pickChanged(many, since, [])
  expect(newest).toHaveLength(MAX_ATTRIBUTED)
  expect(newest[newest.length - 1]).toBe('/f79')
})

test('the card says what is happening, then what happened', () => {
  expect(summaryOf([], idle({ turn: 0 })).status).toBe('READY')
  expect(summaryOf([], idle({ isWorking: true })).title).toBe('Claude is working')

  const working = idle({ isWorking: true, working: [{ id: '1', kind: 'edited', paths: ['/a/client.js', '/a/b.js'] }] })
  expect(summaryOf([], working)).toMatchObject({ status: 'EDITING', title: 'Claude is editing client.js +1', tone: 'edited' })

  const done = [touch('/a', 'edited'), touch('/b', 'read')]
  expect(summaryOf(done, idle())).toMatchObject({ status: 'DONE', title: 'Claude edited 1 file', path: '/a', barLabel: '1 edited · 1 read' })
  expect(summaryOf([touch('/a', 'committed'), touch('/c', 'committed')], idle()).title).toBe('Claude committed 2 files')
})

test('a remembered answer is computed again only when an input changes', () => {
  let calls = 0
  const double = rememberLast((list: readonly number[], factor: number) => {
    calls++
    return list.map(n => n * factor)
  })
  const list = [1, 2]
  expect(double(list, 2)).toEqual([2, 4])
  expect(double(list, 2)).toEqual([2, 4])
  expect(calls).toBe(1)
  expect(double(list, 3)).toEqual([3, 6])
  expect(double([1, 2], 3)).toEqual([3, 6])
  expect(calls).toBe(3)
})

test('find ranks the name over the path', () => {
  const paths = ['/r/zclient/a.ts', '/r/src/client.ts', '/r/src/my-client.ts', '/r/c-l-i.ts']
  expect(findFiles(paths, 'client')).toEqual(['/r/src/client.ts', '/r/src/my-client.ts', '/r/zclient/a.ts'])
  expect(findFiles(paths, 'cli')).toContain('/r/c-l-i.ts')
  expect(findFiles(paths, '  ')).toEqual([])
})

test('small words', () => {
  expect(countLines('')).toBe(0)
  expect(countLines('a\nb\n')).toBe(2)
  expect(countLines('a\nb')).toBe(2)
  expect(formatSize(512)).toBe('512 B')
  expect(formatSize(2048)).toBe('2.0 K')
  expect(formatSize(1_048_575)).toBe('1.0 M')
  expect(formatSize(1023 * 1024)).toBe('1023 K')
  expect(clip('abcdef', 4)).toBe('abc…')
  expect(clip('abcdef', 1)).toBe('…')
  expect(clip('abcdef', 0)).toBe('')
  expect(clip('abcdef', -3)).toBe('')
})

test('a file named after an object method gets the default chip', () => {
  for (const name of ['constructor', 'constructor.ts', 'foo.constructor', '__proto__', 'toString', 'hasOwnProperty.js']) {
    expect(chipOf(name, GLYPHS.plain).label.length).toBeGreaterThan(0)
  }
  expect(chipOf('constructor', GLYPHS.plain).label).toBe('··')
  expect(chipOf('constructor.ts', GLYPHS.plain).label).toBe('TS')
})

const ICONS = JSON.stringify({
  file: 'file',
  folder: 'folder',
  folderOpen: 'folder-open',
  fileNames: { 'readme.md': 'readme', '.gitignore': 'git', 'CLAUDE.md': 'claude', '.config/graphqlrc': 'graphql' },
  extensions: { 'test.ts': 'test-ts', ts: 'typescript', js: 'javascript' },
  folderNames: { src: 'folder-src', '.git': 'folder-git', 'META-INF': 'folder-config', '.github/workflows': 'folder-gh-workflows' },
})

test('a name finds its icon: whole name, longest extension, then the default', () => {
  const map = parseIconMap(ICONS)
  if (!map) throw new Error('the map should parse')
  expect(iconOf(map, 'README.md', false, false)).toBe('readme')
  expect(iconOf(map, '.gitignore', false, false)).toBe('git')
  expect(iconOf(map, 'client.test.ts', false, false)).toBe('test-ts')
  expect(iconOf(map, 'client.ts', false, false)).toBe('typescript')
  expect(iconOf(map, 'notes.xyz', false, false)).toBe('file')
  expect(iconOf(map, 'Makefile', false, false)).toBe('file')
  expect(iconOf(map, 'constructor', false, false)).toBe('file')
  expect(iconOf(map, 'a.constructor', false, false)).toBe('file')
})

test('names of any case match, and some names go by their folder too', () => {
  const map = parseIconMap(ICONS)
  if (!map) throw new Error('the map should parse')
  expect(iconOf(map, '/r/CLAUDE.md', false, false)).toBe('claude')
  expect(iconOf(map, '/r/claude.MD', false, false)).toBe('claude')
  expect(iconOf(map, '/r/META-INF', true, false)).toBe('folder-config')
  expect(iconOf(map, '/r/.config/graphqlrc', false, false)).toBe('graphql')
  expect(iconOf(map, '/r/graphqlrc', false, false)).toBe('file')
  expect(iconOf(map, '/r/.github/workflows', true, false)).toBe('folder-gh-workflows')
  expect(iconOf(map, '/r/workflows', true, false)).toBe('folder')
})

test('a folder finds its icon, open or closed', () => {
  const map = parseIconMap(ICONS)
  if (!map) throw new Error('the map should parse')
  expect(iconOf(map, 'SRC', true, false)).toBe('folder-src')
  expect(iconOf(map, 'src', true, true)).toBe('folder-src-open')
  expect(iconOf(map, 'anything', true, false)).toBe('folder')
  expect(iconOf(map, 'anything', true, true)).toBe('folder-open')
  expect(iconOf(map, '__proto__', true, false)).toBe('folder')
})

test('a broken icon map is refused', () => {
  expect(parseIconMap('not json')).toBeNull()
  expect(parseIconMap('{"file":1}')).toBeNull()
  expect(parseIconMap('null')).toBeNull()
})

test('pictures are used where the terminal can draw them', () => {
  const file = { via: 'file', needsFullscreen: false }
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color' })).toEqual(file)
  expect(imagePlanOf('auto', { TERM: 'xterm-ghostty' })).toEqual(file)
  expect(imagePlanOf('auto', { TERM: 'xterm-kitty' })).toEqual(file)
  expect(imagePlanOf('auto', { KITTY_WINDOW_ID: '1', TERM: 'xterm-256color' })).toEqual(file)
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.2' })).toEqual({ via: 'bytes', needsFullscreen: true })
  expect(imagePlanOf(undefined, { TERM_PROGRAM: 'ghostty' })).toEqual(file)
})

test('anywhere else, or when told not to, the chips stay', () => {
  expect(imagePlanOf('chips', { TERM_PROGRAM: 'ghostty' })).toBeNull()
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'Apple_Terminal' })).toBeNull()
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'vscode', KITTY_WINDOW_ID: '1' })).toBeNull()
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4.9' })).toBeNull()
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux' })).toBeNull()
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'ghostty', SSH_CONNECTION: '1 2 3 4' })).toBeNull()
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'ghostty', ZELLIJ: '0' })).toBeNull()
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'ghostty', STY: '1.pts' })).toBeNull()
})

test('images forces pictures, as bytes, where auto would not try', () => {
  const bytes = { via: 'bytes', needsFullscreen: false }
  expect(imagePlanOf('images', { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux' })).toEqual(bytes)
  expect(imagePlanOf('images', { TERM_PROGRAM: 'WezTerm' })).toEqual(bytes)
})

test('in herdr, pictures wait for the override the engine needs', () => {
  const bytes = { via: 'bytes', needsFullscreen: false }
  const herdr = { TERM_PROGRAM: 'herdr', TERM: 'xterm-256color' }
  expect(imagePlanOf('auto', herdr)).toBeNull()
  expect(imagePlanOf('auto', { ...herdr, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toEqual(bytes)
  expect(imagePlanOf('auto', { ...herdr, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '0' })).toBeNull()
  expect(imagePlanOf('chips', { ...herdr, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toBeNull()
  // Straight in Ghostty the override changes nothing: files still work there.
  expect(imagePlanOf('auto', { TERM_PROGRAM: 'ghostty', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toEqual({ via: 'file', needsFullscreen: false })
})

test('in tmux, pictures follow what tmux says it lets through', () => {
  const bytes = { via: 'bytes', needsFullscreen: false }
  const env = { TMUX: '/tmp/tmux', TERM_PROGRAM: 'tmux' }
  expect(imagePlanOf('auto', env, 'ghostty 1.2.0\ton\t1\n')).toEqual(bytes)
  expect(imagePlanOf('auto', env, 'kitty(0.35.2)\tall\t1\n')).toEqual(bytes)
  // A format prints `allow-passthrough all` as its number.
  expect(imagePlanOf('auto', env, 'ghostty 1.2.0\t2\t1\n')).toEqual(bytes)
  expect(imagePlanOf('auto', env, 'iTerm2 3.5.2\ton\t1\n')).toEqual({ via: 'bytes', needsFullscreen: true })
  expect(imagePlanOf('auto', env)).toBeNull()
  expect(imagePlanOf('images', env, 'ghostty 1.2.0\toff\t1\n')).toEqual(bytes)
  expect(imagePlanOf('images', env, 'iTerm2 3.5.2\ton\t1\n')).toEqual(bytes)
  expect(imagePlanOf('auto', { ...env, ZELLIJ: '0' }, 'ghostty 1.2.0\ton\t1\n')).toBeNull()
  expect(imagePlanOf('auto', { ...env, STY: '1.pts' }, 'ghostty 1.2.0\ton\t1\n')).toBeNull()
  expect(tmuxPlanOf('ghostty 1.2.0\toff\t1\n')).toBeNull()
  expect(tmuxPlanOf('ghostty 1.2.0\ton\t0\n')).toBeNull()
  expect(tmuxPlanOf('kitty(0.27.1)\ton\t1\n')).toBeNull()
  expect(tmuxPlanOf('iTerm2 3.5.2\tall\t1\n')).toBeNull()
  expect(tmuxPlanOf('iTerm2 3.4.9\ton\t1\n')).toBeNull()
  expect(tmuxPlanOf('\ton\t1\n')).toBeNull()
})

test('tmux is asked only when its answer decides whether pictures get through', () => {
  const tmux = { TMUX: '/tmp/tmux', TERM_PROGRAM: 'tmux' }
  expect(needsTmuxAnswer('auto', tmux)).toBe(true)
  expect(needsTmuxAnswer('chips', tmux)).toBe(false)
  expect(needsTmuxAnswer('images', tmux)).toBe(false)
  expect(needsTmuxAnswer('auto', { ...tmux, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: 'yes' })).toBe(false)
  expect(needsTmuxAnswer('auto', { ...tmux, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '0' })).toBe(true)
  expect(needsTmuxAnswer('auto', { ...tmux, ZELLIJ: '0' })).toBe(false)
  expect(needsTmuxAnswer('auto', { ...tmux, STY: '1.pts' })).toBe(false)
  expect(needsTmuxAnswer('auto', { TERM_PROGRAM: 'ghostty' })).toBe(false)
})

test('the touched tree counts its file rows without being built', () => {
  const paths = [`${ROOT}/README.md`, `${ROOT}/src/lib/deep/b.ts`, `${ROOT}/src/lib/deep/a.ts`, `${ROOT}/docs/x.md`, '/elsewhere/a.ts', `${ROOT}/README.md`]
  expect(touchedCount(ROOT, paths)).toBe(4)
  // The folder itself, and a path that turned out a folder, are no file rows.
  expect(touchedCount(ROOT, [ROOT, `${ROOT}/thing`, `${ROOT}/thing/a.ts`])).toBe(1)
  const all = [...paths, ROOT, `${ROOT}/thing`, `${ROOT}/thing/a.ts`]
  expect(touchedCount(ROOT, all)).toBe(touchedRows(ROOT, all, new Set(), new Set()).filter(row => !row.isDir).length)
})

test('the touched tree holds only those files, folders first, with lone folders on one row', () => {
  const paths = [`${ROOT}/README.md`, `${ROOT}/src/lib/deep/b.ts`, `${ROOT}/src/lib/deep/a.ts`, `${ROOT}/docs/x.md`, '/elsewhere/a.ts', `${ROOT}/README.md`]
  const rows = touchedRows(ROOT, paths, new Set(), new Set())
  expect(rows.map(row => [row.depth, row.name])).toEqual([
    [0, 'docs'],
    [1, 'x.md'],
    [0, 'src/lib/deep'],
    [1, 'a.ts'],
    [1, 'b.ts'],
    [0, 'README.md'],
  ])
  expect(rows[2]).toMatchObject({ path: `${ROOT}/src/lib/deep`, isDir: true, isOpen: true })
})

test('a folded folder hides its files, and a chain breaks where a second file lands', () => {
  const deep = `${ROOT}/src/lib/deep`
  const folded = touchedRows(ROOT, [`${deep}/a.ts`], new Set([deep]), new Set())
  expect(folded.map(row => [row.name, row.isOpen])).toEqual([['src/lib/deep', false]])
  const split = touchedRows(ROOT, [`${deep}/a.ts`, `${ROOT}/src/b.ts`], new Set([deep]), new Set())
  expect(split.map(row => [row.depth, row.name])).toEqual([
    [0, 'src'],
    [1, 'lib/deep'],
    [1, 'b.ts'],
  ])
})

test('a file since replaced by a folder of its name draws one row', () => {
  const rows = touchedRows(ROOT, [`${ROOT}/thing`, `${ROOT}/thing/a.ts`], new Set(), new Set())
  expect(rows.map(row => [row.name, row.isDir])).toEqual([
    ['thing', true],
    ['a.ts', false],
  ])
})

test('a changed Tree shows setting sets the view, and an unchanged one leaves it', () => {
  const chosen = emptyLayout({ treeView: 'touched', touchedOnly: false })
  expect(withTreeSetting(chosen, 'touched')).toBe(chosen)
  expect(withTreeSetting(chosen, 'all')).toMatchObject({ treeView: 'all', touchedOnly: false })
  expect(withTreeSetting(emptyLayout({ treeView: 'all', touchedOnly: false }), 'touched')).toMatchObject({ treeView: 'touched', touchedOnly: true })
})

test('the touched tree keeps ignored folders marked', () => {
  const rows = touchedRows(ROOT, [`${ROOT}/dist/app/x.js`, `${ROOT}/a.ts`], new Set(), new Set([`${ROOT}/dist`]))
  expect(rows.map(row => [row.name, row.isIgnored])).toEqual([
    ['dist/app', true],
    ['x.js', true],
    ['a.ts', false],
  ])
})

// The engine, standing in for the machine: one small project on a fake disk.

type Disk = Record<string, { size?: number; mtimeMs?: number } | 'dir'>
type Git = {
  status: string
  numstat: string
  head: string
  shown: string
  reflog: string
  /** Set to make `rev-parse` fail. */
  revParse?: { stderr: string }
  /** Set to make `log -1` fail with this error, as a timeout or a broken repository does. */
  logFails?: string
  /** The git subcommands run, in order, and the arguments of `show`. */
  runs: string[]
  showArgs: string[]
}

const DISK: Disk = {
  [ROOT]: 'dir',
  [`${ROOT}/src`]: 'dir',
  [`${ROOT}/src/client.js`]: { size: 40, mtimeMs: T0 - 60_000 },
  [`${ROOT}/README.md`]: { size: 90, mtimeMs: T0 - 60_000 },
}

const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: { title: 'Files', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BAND = {
  plugin: 'file-tree',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const shown = () => ({ count: 0, isOpen: true })
const closed = () => ({ count: 0, isOpen: false })

type Standing = {
  answer?: (id: string) => unknown
  env?: Record<string, string>
  /** The text of the icon map; left out, it cannot be read. */
  icons?: string
  /** What an icon's file holds, in base64. */
  png?: string
  /** Where the session is: change `cwd` to move it. */
  where?: { cwd: string }
  fills?: string[]
  toasts?: string[]
  /** What `tmux display-message` answers. */
  tmux?: string
  /** Paths whose stat and listing fail with this error, as a permission problem does. */
  statErrors?: Record<string, string>
  /** What `git ls-files` answers, the find index of a repository. */
  lsFiles?: string
  /** Every file read as bytes, in order. */
  byteReads?: string[]
}

// One transparent pixel: the engine reads the header of whatever it is handed.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const stand = (on: On, disk: Disk, git: Git, opens: { count: number; isOpen?: boolean }, standing: Standing = {}) => {
  const {
    answer = () => ({ result: {} }),
    env = {},
    icons,
    png = PNG,
    where = { cwd: ROOT },
    fills = [],
    toasts = [],
    tmux = '',
    statErrors = {},
    lsFiles = 'src/client.js\0README.md\0',
    byteReads = [],
  } = standing
  const clock = mock.clock(on, { now: T0 })
  on('command.register', () => ({ value: { command: 'tree' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: where.cwd }))
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : env[e.name] }))
  on('fs.list', (_, e) => {
    // Refused as the engine refuses a path it cannot list: the caller's call rejects with these words.
    if (statErrors[e.path]) return { deny: statErrors[e.path] } as never
    if (disk[e.path] !== 'dir') return { deny: `ENOENT: no such file or directory, scandir '${e.path}'` } as never
    const prefix = `${e.path}/`
    const value = Object.entries(disk)
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, node]) => ({
        name: path.slice(prefix.length),
        kind: node === 'dir' ? ('dir' as const) : ('file' as const),
        size: node === 'dir' ? 0 : (node.size ?? 0),
        mtimeMs: node === 'dir' ? 0 : (node.mtimeMs ?? 0),
        isLink: false,
      }))
    return { value }
  })
  on('fs.stat', (_, e) => {
    if (statErrors[e.path]) return { deny: statErrors[e.path] } as never
    const node = disk[e.path]
    if (!node) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` } as never
    return {
      value: {
        kind: node === 'dir' ? ('dir' as const) : ('file' as const),
        size: node === 'dir' ? 0 : (node.size ?? 0),
        mtimeMs: node === 'dir' ? 0 : (node.mtimeMs ?? 0),
        isLink: false,
      },
    }
  })
  on('fs.exists', (_, e) => ({ value: disk[e.path] !== undefined }) as never)
  on('fs.read', (_, e) => {
    if (e.as === 'bytes') {
      byteReads.push(e.path)
      return { value: { base64: png } }
    }
    if (!e.path.endsWith('map.json')) return { value: 'one\ntwo\n' }
    if (icons === undefined) throw new Error('ENOENT')
    return { value: icons }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'tmux') return { value: { exitCode: 0, stdout: tmux, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const args = e.argv.slice(4)
    const done = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    git.runs.push(args[0] ?? '')
    if (args[0] === 'rev-parse') {
      if (git.revParse) return { value: { exitCode: 128, stdout: '', stderr: git.revParse.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
      return done(`${ROOT}\n\n${ROOT}/.git\n`)
    }
    if (args[0] === 'status') return done(git.status)
    if (args[0] === 'diff') return done(git.numstat)
    if (args[0] === 'log') {
      if (git.logFails !== undefined) return { value: { exitCode: 128, stdout: '', stderr: git.logFails, isStdoutTruncated: false, isStderrTruncated: false } }
      return done(git.head)
    }
    if (args[0] === 'reflog') return done(git.reflog)
    if (args[0] === 'show') {
      git.showArgs = args
      return done(git.shown)
    }
    if (args[0] === 'ls-files') return done(lsFiles)
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => {
    opens.count++
    opens.isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    opens.isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: opens.isOpen ? [{ id: 'file-tree', title: 'Files', isPlaced: true }] : [] }) as never)
  on('ui.scroll', () => ({}) as never)
  on('tool.call', (_, e) => answer(e.tool_use_id) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  return clock
}

const cleanGit = (): Git => ({ status: '## main\0', numstat: '', head: 'aaa1111', shown: '', reflog: '', runs: [], showArgs: [] })

const boot = async ($: Engine, isInteractive = true) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive } as never)
}

/** Draws the band, which is how the mod learns whether a pane would dock. */
const seat = async ($: Engine, isFullscreen: boolean) => {
  const band = await $.ui.mount({ ...BAND, surface: 'terminal', viewport: { columns: 160, rows: 50, isFullscreen } })
  await band.unmount()
}

const runTree = ($: Engine) => ($.command.run as (e: unknown) => Promise<unknown>)({ command: 'tree', args: '' })

const callTool = ($: Engine, tool: string, input: Record<string, unknown>, id = 'tool-1') =>
  ($.tool.call as (e: unknown) => Promise<unknown>)({ tool, tool_use_id: id, ...input })

test('an edit lights the file, opens its folder and takes the pill', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/src/client.js`, old_string: 'a', new_string: 'b' })
  await clock.advance(400)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/src/client.js` } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CLAUDE TOUCHED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude edited 1 file/ })).toBeDefined()
  await ui.unmount()
})

test('a read is purple and says read', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: 'README.md' })
  await clock.advance(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^read$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude read 1 file/ })).toBeDefined()
  await ui.unmount()
})

test('a denied or failed call leaves no mark', ALL_FILES, async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown(), { answer: id => (id === 'denied' ? { deny: 'no' } : { result: 'bad', isError: true }) })
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'denied')
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'failed')
  await clock.advance(400)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /CLAUDE TOUCHED/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing touched yet/ })).toBeDefined()
  await ui.unmount()
})

test('a file a shell command changed is found by git and its date', async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/README.md`]: { size: 90, mtimeMs: T0 + 50 } }
  const git = cleanGit()
  const clock = stand(on, disk, git, shown())
  await boot($)
  await clock.advance(400)
  git.status = '## main\0 M README.md\0'
  git.numstat = '4\t2\tREADME.md\0'
  await callTool($, 'Bash', { command: 'python3 fix.py' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+4$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 changed/ })).toBeDefined()
  await ui.unmount()
})

test('a commit turns edited files committed and names itself', async ($, on) => {
  const git = cleanGit()
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  git.head = 'bbb2222'
  // A reflog holds where HEAD stood before, the head the last look found.
  git.reflog = 'bbb2222fff\0commit: Raise retries\naaa1111fff\0commit: base\n'
  git.shown = 'README.md\0src/client.js\0'
  await callTool($, 'Bash', { command: 'git commit -am x' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /bbb2222/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude committed 1 file/ })).toBeDefined()
  await ui.unmount()
})

test('a file a shell call writes and commits in one go turns committed', async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/src/new.ts`]: { size: 5, mtimeMs: T0 + 300 } }
  const git = cleanGit()
  const clock = stand(on, disk, git, shown())
  await boot($)
  await clock.advance(400)
  git.head = 'bbb2222'
  git.reflog = 'bbb2222fff\0commit: Add new\naaa1111fff\0commit: base\n'
  // README.md is in the commit too, but older than the call: the person's, not Claude's.
  git.shown = 'src/new.ts\0README.md\0'
  await callTool($, 'Bash', { command: 'make release' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude committed 1 file/ })).toBeDefined()
  await ui.unmount()
})

test('a folder git calls no repository knows it has no commits, so git init and a first commit count', async ($, on) => {
  const git: Git = { ...cleanGit(), revParse: { stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  delete git.revParse
  git.head = 'aaa1111'
  git.reflog = 'aaa1111fff\0commit (initial): init\n'
  git.shown = 'README.md\0'
  await callTool($, 'Bash', { command: 'git init && git add . && git commit -m init' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeDefined()
  await ui.unmount()
})

test('a commit made outside Claude is seen at the next poll, by the log of HEAD', async ($, on) => {
  const log = `${ROOT}/.git/logs/HEAD`
  const disk: Disk = { ...DISK, [log]: { size: 1, mtimeMs: T0 - 1000 } }
  const git = cleanGit()
  const clock = stand(on, disk, git, shown())
  await boot($)
  await clock.advance(400)
  const looks = () => git.runs.filter(run => run === 'status').length
  const before = looks()
  // Only the branch moved: the index and HEAD itself are as they were.
  disk[log] = { size: 2, mtimeMs: T0 + 3000 }
  for (let i = 0; i < 33; i++) await clock.advance(160)
  expect(looks()).toBeGreaterThan(before)
})

test('someone else committing what Claude never touched changes nothing', async ($, on) => {
  const git = cleanGit()
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  git.head = 'ccc3333'
  git.reflog = 'ccc3333fff\0commit: theirs\n'
  git.shown = 'README.md\0'
  await callTool($, 'Bash', { command: 'make' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ccc3333/ })).toBeUndefined()
  await ui.unmount()
})

test('a checkout moves HEAD but commits nothing', async ($, on) => {
  const git = cleanGit()
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  git.head = 'ddd4444'
  git.reflog = 'ddd4444fff\0checkout: moving from main to other\n'
  git.shown = 'README.md\0'
  await callTool($, 'Bash', { command: 'git checkout other' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  expect(git.showArgs).toEqual([])
  await ui.unmount()
})

test('the first commit of a new repository counts', async ($, on) => {
  const git = { ...cleanGit(), head: '' }
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  git.head = 'eee5555'
  git.reflog = 'eee5555fff\0commit (initial): first\n'
  git.shown = 'README.md\0'
  await callTool($, 'Bash', { command: 'git commit -m first' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeDefined()
  await ui.unmount()
})

test('a git log that fails keeps the head it knew, so old commits never count as new', async ($, on) => {
  const git = cleanGit()
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  // One look's `git log` times out; the next answers the same head as before.
  git.logFails = 'error: timed out'
  git.reflog = 'aaa1111fff\0commit: base\nzzz0000fff\0commit (initial): first\n'
  git.shown = 'README.md\0'
  await callTool($, 'Bash', { command: 'make' }, 'a')
  await clock.advance(500)
  git.logFails = undefined
  await callTool($, 'Bash', { command: 'make' }, 'b')
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  expect(git.showArgs).toEqual([])
  await ui.unmount()
})

test('a first look whose git log fails knows no head, so old commits never count as new', async ($, on) => {
  const git: Git = { ...cleanGit(), logFails: 'error: something broke' }
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  // The next look answers: a young repository whose whole history is in the reflog.
  git.logFails = undefined
  git.head = 'ccc3333'
  git.reflog = 'ccc3333fff\0commit: second\nbbb2222fff\0commit (initial): first\n'
  git.shown = 'README.md\0'
  await callTool($, 'Bash', { command: 'make' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  expect(git.showArgs).toEqual([])
  await ui.unmount()
})

test("a repository git says has no commits yet counts its first commit", async ($, on) => {
  const git: Git = { ...cleanGit(), logFails: "fatal: your current branch 'main' does not have any commits yet" }
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  git.logFails = undefined
  git.head = 'eee5555'
  git.reflog = 'eee5555fff\0commit (initial): first\n'
  git.shown = 'README.md\0'
  await callTool($, 'Bash', { command: 'git commit -m first' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeDefined()
  await ui.unmount()
})

test("an MCP tool's relative path is read from the project, wherever a shell cd went", async ($, on) => {
  const where = { cwd: ROOT }
  const clock = stand(on, DISK, cleanGit(), shown(), { where })
  await boot($)
  await clock.advance(400)
  // Claude went into src; fastwrite still reads `README.md` from the folder Claude Code started in.
  where.cwd = `${ROOT}/src`
  await callTool($, 'mcp__fw__edit', { script: '@ README.md\ns/a/b/\n' })
  await clock.advance(400)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /README\.md/ })).toBeDefined()
  await ui.unmount()
})

test('a layout kept from before it knew the start folder takes the session root, not where a cd went', async ($, on) => {
  // The shell had gone into src before the reload; the session's root is still the project.
  const where = { cwd: `${ROOT}/src` }
  const clock = stand(on, DISK, cleanGit(), shown(), { where })
  on('session.root', () => ({ value: ROOT }) as never)
  // The layout as an earlier version kept it, with no start folder; the other keys go to the kit's own store.
  const kept = emptyLayout({ treeView: 'touched', touchedOnly: true })
  const layoutStore = { value: { shape: 'layout-3', value: kept } as unknown, version: 1 }
  on('state.get', (_, e, next) => (e.key === 'layout' ? { value: { value: layoutStore.value, version: layoutStore.version } } : next(e)) as never)
  on('state.set', (_, e, next) => {
    if (e.key !== 'layout') return next(e) as never
    if (e.ifVersion !== undefined && e.ifVersion !== layoutStore.version) return { value: { isSet: false, version: layoutStore.version } } as never
    layoutStore.value = e.value
    layoutStore.version++
    return { value: { isSet: true, version: layoutStore.version } } as never
  })
  await boot($)
  await clock.advance(400)
  await callTool($, 'mcp__fw__edit', { script: '@ README.md\ns/a/b/\n' })
  await clock.advance(400)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /README\.md/ })).toBeDefined()
  await ui.unmount()
})

test('several commits between looks are all read', async ($, on) => {
  const git = cleanGit()
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'a')
  await callTool($, 'Edit', { file_path: `${ROOT}/src/client.js` }, 'b')
  await clock.advance(400)
  git.head = 'ggg7777'
  git.reflog = 'ggg7777fff\0commit: b\nfff6666fff\0commit: a\naaa1111fff\0commit: base\n'
  git.shown = 'README.md\0src/client.js\0'
  await callTool($, 'Bash', { command: 'git commit a && git commit b' })
  await clock.advance(500)

  expect(git.showArgs.slice(-2)).toEqual(['ggg7777fff', 'fff6666fff'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Claude committed 2 files/ })).toBeDefined()
  await ui.unmount()
})

test('a git hiccup keeps what was known, and only "not a repository" clears it', async ($, on) => {
  const git = { ...cleanGit(), status: '## main\0 M README.md\0' }
  const clock = stand(on, DISK, git, shown())
  await boot($)
  await clock.advance(400)

  git.revParse = { stderr: 'fatal: unable to read something' }
  await callTool($, 'Bash', { command: 'make' })
  await clock.advance(500)
  const during = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await during.find({ type: 'Text', text: /1 changed/ })).toBeDefined()
  await during.unmount()

  git.revParse = { stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
  await callTool($, 'Bash', { command: 'make' })
  await clock.advance(500)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /1 changed/ })).toBeUndefined()
  await after.unmount()
})

test("a folder git cannot read this time shows no other folder's branch or changes", ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, '/work': 'dir' }
  const git = { ...cleanGit(), status: '## main\0 M README.md\0' }
  const clock = stand(on, disk, git, shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 changed/ })).toBeDefined()

  // Up a folder, where git fails for a reason other than "not a repository".
  git.revParse = { stderr: 'fatal: detected dubious ownership in repository' }
  await ui.press({ key: 'up' })
  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: /1 changed/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /main/ })).toBeUndefined()
  await ui.unmount()
})

test('after a failed look at a folder, git is not asked again at every poll', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, '/work': 'dir' }
  const git = cleanGit()
  const clock = stand(on, disk, git, shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  git.revParse = { stderr: 'fatal: detected dubious ownership in repository' }
  await ui.press({ key: 'up' })
  await clock.advance(500)
  const looks = git.runs.filter(run => run === 'rev-parse').length
  // Four polls with nothing changed and no full sync due: none of them looks again.
  for (let i = 0; i < 4; i++) await clock.advance(5_000)
  expect(git.runs.filter(run => run === 'rev-parse').length).toBe(looks)
  await ui.unmount()
})

test('with no panel to draw, git is left alone, and opening picks up what happened', async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/README.md`]: { size: 90, mtimeMs: T0 + 900 } }
  const git = cleanGit()
  const opens = closed()
  const clock = stand(on, disk, git, opens)
  await boot($)
  await clock.advance(400)
  git.status = '## main\0 M README.md\0'
  await callTool($, 'Bash', { command: 'python3 fix.py' })
  await clock.advance(500)
  expect(git.runs).toEqual([])

  await runTree($)
  await clock.advance(500)
  expect(git.runs).toContain('status')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
  await ui.unmount()
})

test('without a person watching, nothing is tracked', async ($, on) => {
  const git = cleanGit()
  const clock = stand(on, DISK, git, shown())
  await boot($, false)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await callTool($, 'Bash', { command: 'make' })
  await clock.advance(500)
  expect(git.runs).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeUndefined()
  await ui.unmount()
})

test('a command known only to look credits nothing to Claude, and looks at nothing', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/README.md`]: { size: 90, mtimeMs: T0 + 900 } }
  const git = { ...cleanGit(), status: '## main\0 M README.md\0' }
  const clock = stand(on, disk, git, shown())
  await boot($)
  await clock.advance(400)
  const before = git.runs.length
  await callTool($, 'Bash', { command: 'sleep 1 && ls' })
  await clock.advance(500)
  expect(git.runs.length).toBe(before)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /CLAUDE TOUCHED/ })).toBeUndefined()
  await ui.unmount()
})


test('a cd inside the project leaves the tree as it was', ALL_FILES, async ($, on) => {
  const where = { cwd: ROOT }
  const clock = stand(on, DISK, cleanGit(), shown(), { where })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${ROOT}/src` })
  where.cwd = `${ROOT}/src`
  await callTool($, 'Bash', { command: 'make' })
  await clock.advance(500)
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/src/client.js` } as never)).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' } as never)).toBeUndefined()
  await ui.unmount()
})

test('moving out of the project moves the tree', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, '/work/other': 'dir', '/work/other/x.ts': { size: 1, mtimeMs: T0 } }
  const where = { cwd: ROOT }
  const clock = stand(on, disk, cleanGit(), shown(), { where })
  await boot($)
  await clock.advance(400)
  where.cwd = '/work/other'
  await callTool($, 'Bash', { command: 'make' })
  await clock.advance(500)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'open:/work/other/x.ts' } as never)).toBeDefined()
  await ui.unmount()
})

test('a file clicked after Up a folder is mentioned from the session, not the tree', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, '/work': 'dir' }
  const fills: string[] = []
  const clock = stand(on, disk, cleanGit(), shown(), { fills })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'up' })
  await ui.press({ key: `open:${ROOT}` })
  await ui.press({ key: `open:${ROOT}/README.md` })
  expect(fills).toEqual(['@README.md '])
  await ui.unmount()
})

test('a hidden-only folder says so when hidden files are off', ALL_FILES, async ($, on) => {
  const disk: Disk = { [ROOT]: 'dir', [`${ROOT}/.env`]: { size: 1, mtimeMs: T0 } }
  const clock = stand(on, disk, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'hidden' })
  expect(await ui.find({ type: 'Text', text: /Only hidden files here/ })).toBeDefined()
  await ui.unmount()
})

test('clicking a touched file inside an ignored folder still finds it', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/dist`]: 'dir', [`${ROOT}/dist/x.js`]: { size: 1, mtimeMs: T0 } }
  const git = { ...cleanGit(), status: '## main\0!! dist/\0' }
  const clock = stand(on, disk, git, shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: `${ROOT}/dist/x.js` })
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/dist/x.js` } as never)).toBeUndefined()
  await ui.press({ key: `show:touched:${ROOT}/dist/x.js` })
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/dist/x.js` } as never)).toBeDefined()
  await ui.unmount()
})

test('clicking a touched file outside the tree says why nothing moved', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, '/elsewhere': 'dir', '/elsewhere/a.ts': { size: 1, mtimeMs: T0 } }
  const toasts: string[] = []
  const clock = stand(on, disk, cleanGit(), shown(), { toasts })
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: '/elsewhere/a.ts' })
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'show:touched:/elsewhere/a.ts' })
  expect(toasts.join()).toContain('outside this tree')
  await ui.unmount()
})

test('a folder opened for a read closes by itself, but not under someone using the panel', ALL_FILES, async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const inside = { type: 'Button', key: `open:${ROOT}/src/client.js` } as never

  const focused = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, isFocused: true } })
  await callTool($, 'Read', { file_path: `${ROOT}/src/client.js` })
  await clock.advance(AUTO_CLOSE_MS + 3000)
  expect(await focused.find(inside)).toBeDefined()
  await focused.unmount()

  const away = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(3000)
  expect(await away.find(inside)).toBeUndefined()
  await away.unmount()
})

test('the totals say when they are only a floor', async ($, on) => {
  const many = Array.from({ length: 35 }, (_, i) => `?? new${i}.ts`).join('\0')
  const clock = stand(on, DISK, { ...cleanGit(), status: `## main\0${many}\0` }, shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /≥/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /35 changed/ })).toBeDefined()
  await ui.unmount()
})

test('on Ghostty the rows draw picture icons, and an opened folder changes its own', ALL_FILES, async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown(), { env: { TERM_PROGRAM: 'ghostty' }, icons: ICONS })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const sources = async (): Promise<string[]> =>
    (await ui.findAll({ type: 'Image' })).map(found => (found.props.source as { file: string }).file.split('/').pop() ?? '')

  expect(await sources()).toEqual(['folder-src.png', 'readme.png'])
  expect(await ui.find({ type: 'Text', text: /^MD$/ })).toBeUndefined()

  await ui.press({ key: `open:${ROOT}/src` })
  expect(await sources()).toEqual(['folder-src-open.png', 'javascript.png', 'readme.png'])
  await ui.unmount()
})

test('where only bytes can reach the terminal, the picture carries them', ALL_FILES, async ($, on) => {
  const env = { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.2' }
  const clock = stand(on, DISK, cleanGit(), shown(), { env, icons: ICONS })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  await ui.unmount()
})

test('a damaged icon file costs only its row, which keeps a chip', ALL_FILES, async ($, on) => {
  const env = { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.2' }
  const clock = stand(on, DISK, cleanGit(), shown(), { env, icons: ICONS, png: 'bm90IGEgcG5n' })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /README/ })).toBeDefined()
  await ui.unmount()
})

test('a damaged icon file is read once, not at every frame', ALL_FILES, async ($, on) => {
  const env = { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.2' }
  const byteReads: string[] = []
  const clock = stand(on, DISK, cleanGit(), shown(), { env, icons: ICONS, png: 'bm90IGEgcG5n', byteReads })
  await boot($)
  await clock.advance(400)
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await first.unmount()
  const afterFirst = byteReads.length
  expect(afterFirst).toBeGreaterThan(0)
  const second = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await second.find({ type: 'Text', text: /README/ })).toBeDefined()
  await second.unmount()
  expect(byteReads.length).toBe(afterFirst)
})

test('without a capable terminal, or without the icon map, rows keep their chips', ALL_FILES, async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown(), { env: { TERM_PROGRAM: 'Apple_Terminal' }, icons: ICONS })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /MD/ })).toBeDefined()
  await ui.unmount()
})

test('an icon map that cannot be read leaves the chips', ALL_FILES, async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown(), { env: { TERM_PROGRAM: 'ghostty' } })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /README/ })).toBeDefined()
  await ui.unmount()
})

test('the pane draws on every surface', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /CLAUDE TOUCHED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
    await ui.press({ key: 'scope' })
    expect(await ui.find({ type: 'Text', text: /ALL FILES/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^edited$/ })).toBeDefined()
    await ui.press({ key: 'scope' })
    await ui.unmount()
  }
})

test('pressing a folder opens it, and Collapse all closes it', ALL_FILES, async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const inside = { type: 'Button', key: `open:${ROOT}/src/client.js` } as never

  expect(await ui.find(inside)).toBeUndefined()
  await ui.press({ key: `open:${ROOT}/src` })
  expect(await ui.find(inside)).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find(inside)).toBeUndefined()
  await ui.unmount()
})

test('a folder that is gone takes its rows with it', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK }
  const clock = stand(on, disk, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const readme = { type: 'Button', key: `open:${ROOT}/README.md` } as never
  expect(await ui.find(readme)).toBeDefined()

  // The whole folder goes: its listing cannot be read, and it is not there.
  for (const path of Object.keys(disk)) delete disk[path]
  await ui.press({ key: 'refresh' })
  await clock.advance(400)
  expect(await ui.find(readme)).toBeUndefined()
  await ui.unmount()
})

test('a folder replaced by a file of its name takes its rows with it, and a tree whose folder is gone says so', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK }
  const clock = stand(on, disk, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${ROOT}/src` })
  await clock.advance(400)
  const inside = { type: 'Button', key: `open:${ROOT}/src/client.js` } as never
  expect(await ui.find(inside)).toBeDefined()

  // `src` is now a file: it still exists, but it is no folder to list.
  delete disk[`${ROOT}/src/client.js`]
  disk[`${ROOT}/src`] = { size: 3 }
  await ui.press({ key: 'refresh' })
  await clock.advance(400)
  expect(await ui.find(inside)).toBeUndefined()

  // Then the tree's own folder goes.
  for (const path of Object.keys(disk)) delete disk[path]
  await ui.press({ key: 'refresh' })
  await clock.advance(400)
  expect(await ui.find({ type: 'Text', text: /This folder is gone\./ })).toBeDefined()
  await ui.unmount()
})

test('a tree whose folder is gone from the start says so on a pane already open', ALL_FILES, async ($, on) => {
  const clock = stand(on, {}, cleanGit(), shown())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await boot($)
  await clock.advance(400)
  expect(await ui.find({ type: 'Text', text: /This folder is gone\./ })).toBeDefined()
  await ui.unmount()
})

test('a folder that cannot be read for want of permission keeps its rows', ALL_FILES, async ($, on) => {
  const statErrors: Record<string, string> = {}
  const clock = stand(on, { ...DISK }, cleanGit(), shown(), { statErrors })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${ROOT}/src` })
  await clock.advance(400)
  const inside = { type: 'Button', key: `open:${ROOT}/src/client.js` } as never
  expect(await ui.find(inside)).toBeDefined()

  statErrors[`${ROOT}/src`] = "EACCES: permission denied, scandir '/work/app/src'"
  await ui.press({ key: 'refresh' })
  await clock.advance(400)
  expect(await ui.find(inside)).toBeDefined()
  await ui.unmount()
})

test("a click lands on the row's click area, and no Button holds its name on the terminal", ALL_FILES, async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const inside = { type: 'Button', key: `open:${ROOT}/src/client.js` } as never

  expect(await ui.find({ type: 'Button', text: /README/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /README/ })).toBeDefined()

  await ui.pointer({ type: 'down', x: 3, y: 0, in: `hit:open:${ROOT}/src` })
  expect(await ui.find(inside)).toBeDefined()
  // The right button does nothing: the folder stays open.
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'right', in: `hit:open:${ROOT}/src` })
  expect(await ui.find(inside)).toBeDefined()
  await ui.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Button', key: `open:${ROOT}/README.md` } as never)).toBeDefined()
  await desktop.unmount()
})

test('the toolbar hides dotfiles and offers the way back', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/.env`]: { size: 1, mtimeMs: T0 }, '/work': 'dir' }
  const clock = stand(on, disk, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/.env` } as never)).toBeDefined()
  await ui.press({ key: 'hidden' })
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/.env` } as never)).toBeUndefined()

  expect(await ui.find({ type: 'Button', key: 'back' } as never)).toBeUndefined()
  await ui.press({ key: 'up' })
  expect(await ui.find({ type: 'Button', key: 'back' } as never)).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'back' } as never)).toBeUndefined()
  await ui.unmount()
})

test('find lists matches in place of the tree, and Enter shows the file', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'find', text: 'client', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /FOUND 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `show:found:${ROOT}/src/client.js` } as never)).toBeDefined()

  await ui.input({ key: 'find', text: 'client', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /ALL FILES/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/src/client.js` } as never)).toBeDefined()
  await ui.unmount()
})

test('the first edit opens the pane once, and /tree toggles it', async ($, on) => {
  const opens = closed()
  const clock = stand(on, DISK, cleanGit(), opens)
  await boot($)
  await seat($, true)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: `${ROOT}/README.md` })
  await clock.advance(1)
  expect(opens.count).toBe(0)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'a')
  await clock.advance(1)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'b')
  await clock.advance(1)
  expect(opens.count).toBe(1)

  expect(await runTree($)).toMatchObject({ text: 'File tree closed.' })
  expect(await runTree($)).toMatchObject({ text: 'File tree opened.' })
})

test('unasked, the panel only opens where it docks', async ($, on) => {
  const opens = closed()
  const clock = stand(on, DISK, cleanGit(), opens)
  await boot($)
  await seat($, false)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'a')
  await clock.advance(1)
  expect(opens.count).toBe(0)

  await seat($, true)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'b')
  await clock.advance(1)
  expect(opens.count).toBe(1)
})

test('having used /tree, the panel no longer opens by itself', async ($, on) => {
  const opens = closed()
  const clock = stand(on, DISK, cleanGit(), opens)
  await boot($)
  await seat($, true)
  await clock.advance(400)
  await runTree($)
  await runTree($)
  expect(opens.count).toBe(1)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(1)
  expect(opens.count).toBe(1)
})

test('the first edit leaves a panel that is already open alone, even above the prompt', ALL_FILES, async ($, on) => {
  const opens = shown()
  const clock = stand(on, DISK, cleanGit(), opens)
  await boot($)
  await seat($, true)
  await clock.advance(400)
  const inline = { ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } } as const
  const ui = await $.ui.mount(inline)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  expect(opens).toMatchObject({ count: 0, isOpen: true })
  expect(await ui.find({ type: 'Text', text: /ALL FILES/ })).toBeDefined()
  await ui.unmount()
})

test('a lit row outside the window is still drawn', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK }
  for (let i = 0; i < 300; i++) disk[`${ROOT}/file${String(i).padStart(3, '0')}.ts`] = { size: 1, mtimeMs: T0 }
  const clock = stand(on, disk, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/file250.ts` })
  await clock.advance(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/file250.ts` } as never)).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/file200.ts` } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/file001.ts` } as never)).toBeDefined()
  await ui.unmount()
})

test('a file Find reveals far down a long tree is drawn, so the scroll can find it', ALL_FILES, async ($, on) => {
  const disk: Disk = { ...DISK }
  for (let i = 0; i < 300; i++) disk[`${ROOT}/file${String(i).padStart(3, '0')}.ts`] = { size: 1, mtimeMs: T0 }
  const clock = stand(on, disk, cleanGit(), shown(), { lsFiles: 'file250.ts\0' })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/file250.ts` } as never)).toBeUndefined()

  await ui.input({ key: 'find', text: 'file250', kind: 'change' })
  await ui.input({ key: 'find', text: 'file250', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /ALL FILES/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/file250.ts` } as never)).toBeDefined()
  // Rows far from it stay out.
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/file200.ts` } as never)).toBeUndefined()
  await ui.unmount()
})

test('by default the tree holds only what Claude touched, and the toggle shows the rest', async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/other.ts`]: { size: 1, mtimeMs: T0 } }
  const clock = stand(on, disk, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` }, 'a')
  await callTool($, 'Read', { file_path: `${ROOT}/src/client.js` }, 'b')
  await clock.advance(400)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const other = { type: 'Button', key: `open:${ROOT}/other.ts` } as never
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/README.md` } as never)).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/src/client.js` } as never)).toBeDefined()
  expect(await ui.find(other)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /2 FILES/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `show:touched:${ROOT}/README.md` } as never)).toBeUndefined()

  await ui.press({ key: 'scope' })
  expect(await ui.find(other)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ALL FILES/ })).toBeDefined()
  await ui.press({ key: 'scope' })
  expect(await ui.find(other)).toBeUndefined()
  await ui.unmount()
})

test('with nothing touched, the tree says so', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /has not touched a file/ })).toBeDefined()
  await ui.unmount()
})

test('a touched folder folds by hand, and Expand all opens it', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: `${ROOT}/src/client.js` })
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const inside = { type: 'Button', key: `open:${ROOT}/src/client.js` } as never

  await ui.press({ key: `open:${ROOT}/src` })
  expect(await ui.find(inside)).toBeUndefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find(inside)).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find(inside)).toBeUndefined()
  await ui.unmount()
})

test('a folder folded by hand does not reopen by itself', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: `${ROOT}/src/client.js` })
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${ROOT}/src` })
  await callTool($, 'Edit', { file_path: `${ROOT}/src/client.js` }, 'again')
  await clock.advance(400)
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/src/client.js` } as never)).toBeUndefined()
  await ui.unmount()
})

test('a file touched outside this folder stays in a card of its own', async ($, on) => {
  const disk: Disk = { ...DISK, '/elsewhere': 'dir', '/elsewhere/a.ts': { size: 1, mtimeMs: T0 } }
  const fills: string[] = []
  const clock = stand(on, disk, cleanGit(), shown(), { fills })
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: '/elsewhere/a.ts' }, 'a')
  await callTool($, 'Read', { file_path: `${ROOT}/README.md` }, 'b')
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /OUTSIDE THIS FOLDER/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'show:touched:/elsewhere/a.ts' } as never)).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `show:touched:${ROOT}/README.md` } as never)).toBeUndefined()
  await ui.press({ key: 'show:touched:/elsewhere/a.ts' })
  expect(fills).toEqual(['@/elsewhere/a.ts '])
  await ui.unmount()
})

test('finding a touched file stays in the touched tree and unfolds it', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: `${ROOT}/src/client.js` })
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${ROOT}/src` })
  await ui.input({ key: 'find', text: 'client', kind: 'change' })
  await ui.input({ key: 'find', text: 'client', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /ALL FILES/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/src/client.js` } as never)).toBeDefined()
  await ui.unmount()
})

test('in herdr with the override the rows draw pictures, and without it they keep chips', ALL_FILES, async ($, on) => {
  const env: Record<string, string> = { TERM_PROGRAM: 'herdr', TERM: 'xterm-256color', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }
  const clock = stand(on, DISK, cleanGit(), shown(), { env, icons: ICONS })
  await boot($)
  await clock.advance(400)
  const pictured = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pictured.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  await pictured.unmount()

  delete env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES
  await boot($)
  await clock.advance(400)
  const chipped = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await chipped.find({ type: 'Image' })).toBeUndefined()
  await chipped.unmount()
})

test('in tmux the panel asks tmux, and draws pictures only if tmux lets them through', ALL_FILES, async ($, on) => {
  const env = { TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux', TMUX_PANE: '%1' }
  const clock = stand(on, DISK, cleanGit(), shown(), { env, icons: ICONS, tmux: 'ghostty 1.2.0\ton\t1\n' })
  await boot($)
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  await ui.unmount()
})

test('a file joins the touched tree only once its tool has run', async ($, on) => {
  let release = (): void => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const clock = stand(on, DISK, cleanGit(), shown(), { answer: () => held.then(() => ({ result: {} })) })
  await boot($)
  await clock.advance(400)
  const running = callTool($, 'Read', { file_path: `${ROOT}/README.md` })
  await clock.advance(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = { type: 'Button', key: `open:${ROOT}/README.md` } as never
  expect(await ui.find(row)).toBeUndefined()
  release()
  await running
  await clock.advance(400)
  expect(await ui.find(row)).toBeDefined()
  await ui.unmount()
})

test('a denied call leaves no row in the touched tree', async ($, on) => {
  const clock = stand(on, DISK, cleanGit(), shown(), { answer: () => ({ deny: 'no' }) })
  await boot($)
  await clock.advance(400)
  await callTool($, 'Edit', { file_path: `${ROOT}/README.md` })
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: `open:${ROOT}/README.md` } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /has not touched a file/ })).toBeDefined()
  await ui.unmount()
})

test('with one folder folded, c folds the rest, and only then expands them all', async ($, on) => {
  const disk: Disk = { ...DISK, [`${ROOT}/lib`]: 'dir', [`${ROOT}/lib/x.ts`]: { size: 1, mtimeMs: T0 } }
  const clock = stand(on, disk, cleanGit(), shown())
  await boot($)
  await clock.advance(400)
  await callTool($, 'Read', { file_path: `${ROOT}/src/client.js` }, 'a')
  await callTool($, 'Read', { file_path: `${ROOT}/lib/x.ts` }, 'b')
  await clock.advance(400)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const client = { type: 'Button', key: `open:${ROOT}/src/client.js` } as never
  const lib = { type: 'Button', key: `open:${ROOT}/lib/x.ts` } as never

  await ui.press({ key: `open:${ROOT}/src` })
  expect(await ui.find(client)).toBeUndefined()
  expect(await ui.find(lib)).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find(client)).toBeUndefined()
  expect(await ui.find(lib)).toBeUndefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find(client)).toBeDefined()
  expect(await ui.find(lib)).toBeDefined()
  await ui.unmount()
})

test('a file written and committed in one call turns committed even when a poll sees the commit first', async ($, on) => {
  const log = `${ROOT}/.git/logs/HEAD`
  const disk: Disk = { ...DISK, [log]: { size: 1, mtimeMs: T0 - 1000 } }
  const git = cleanGit()
  let advance: (ms: number) => Promise<unknown> = async () => undefined
  const clock = stand(on, disk, git, shown(), {
    answer: async () => {
      const at = T0 + 500
      disk[`${ROOT}/src/new.ts`] = { size: 5, mtimeMs: at }
      git.head = 'bbb2222'
      git.reflog = 'bbb2222fff\0commit: Add new\naaa1111fff\0commit: base\n'
      git.shown = 'src/new.ts\0'
      disk[log] = { size: 2, mtimeMs: at }
      // The command goes on after its commit (a push): the panel polls meanwhile and sees the commit first.
      for (let i = 0; i < 33; i++) await advance(160)
      return { result: {} }
    },
  })
  advance = ms => clock.advance(ms)
  await boot($)
  await clock.advance(400)
  await callTool($, 'Bash', { command: 'make release' })
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeDefined()
  await ui.unmount()
})

test("with the pane closed, the person's own later commit is not credited to Claude", async ($, on) => {
  const disk: Disk = { ...DISK }
  const git = cleanGit()
  const opens = shown()
  const clock = stand(on, disk, git, opens)
  await boot($)
  await clock.advance(400)
  await runTree($)
  await clock.advance(400)
  expect(opens.isOpen).toBe(false)
  await callTool($, 'Bash', { command: 'npm test' })
  for (let i = 0; i < 12; i++) await clock.advance(5_000)
  // A while later the person edits README.md themselves and commits it.
  disk[`${ROOT}/README.md`] = { size: 91, mtimeMs: T0 + 100_000 }
  for (let i = 0; i < 12; i++) await clock.advance(5_000)
  git.head = 'ccc3333'
  git.reflog = 'ccc3333fff\0commit: my own work\naaa1111fff\0commit: base\n'
  git.shown = 'README.md\0'
  await runTree($)
  await clock.advance(500)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^committed$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Claude committed/ })).toBeUndefined()
  await ui.unmount()
})
