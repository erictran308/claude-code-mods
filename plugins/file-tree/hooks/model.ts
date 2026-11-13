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

// A tool is known by the words of its name, split at `_`, `-` and a change of case: `download_assets`
// is a download, not a `load`. Whole words, with their compounds and plurals listed, not letters
// inside words: `credit` is no `edit`, `thread` no `read`, `target` no `get`. A name of one run-on
// word falls back to the old reading by its letters.
const SEARCH_WORDS = new Set(['search', 'grep', 'glob', 'find', 'list'])
const READ_WORDS = new Set([
  'read', 'view', 'overview', 'preview', 'open', 'cat', 'head', 'tail', 'load', 'upload', 'get', 'show', 'fetch',
])
const WRITE_WORDS = new Set([
  'edit', 'write', 'rewrite', 'overwrite', 'replace', 'create', 'patch', 'update', 'apply', 'insert', 'append', 'delete',
  'remove', 'move', 'rename', 'download', 'save', 'export', 'put',
])
const SEARCH_TOOL = /search|grep|glob|find|list/i
const READ_TOOL = /read|view|open|cat|head|tail|load/i
const WRITE_TOOL = /edit|write|replace|create|patch|update|apply|insert|append|delete|remove|move|rename|download|save|export/i

export const nameWords = (name: string): string[] =>
  name
    .split(/[_\-\s.]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map(word => word.toLowerCase())
    .filter(Boolean)

/** Whether a name word is one of `words`, or its plural (`edits`, `patches`). */
const isOneOf = (words: ReadonlySet<string>, word: string): boolean =>
  words.has(word) || (word.endsWith('s') && words.has(word.slice(0, -1))) || (word.endsWith('es') && words.has(word.slice(0, -2)))

/** What a tool's name says it does, by its words first, else by the letters of one run-on word. */
export const toolVerb = (name: string): 'write' | 'search' | 'read' | 'other' => {
  const words = nameWords(name)
  if (words.some(word => isOneOf(WRITE_WORDS, word))) return 'write'
  if (words.some(word => isOneOf(SEARCH_WORDS, word))) return 'search'
  if (words.some(word => isOneOf(READ_WORDS, word))) return 'read'
  if (words.length > 1) return 'other'
  if (WRITE_TOOL.test(name)) return 'write'
  if (SEARCH_TOOL.test(name)) return 'search'
  return READ_TOOL.test(name) ? 'read' : 'other'
}

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

// A script of fastwrite's MCP edit tool names its files on its `@`, `>`, `rm` and `mv` lines,
// and on an `m` or `c` line that moves or copies lines into another file: `m 12的 14一 > b.ts $`.
// The text of a `=`, `+` or `>` op (up to its lone `.`) and of a SEARCH/REPLACE block is text:
// a Makefile line `rm build/x.o` or a line of code `c = a > b` there names no file.
const scriptFiles = (script: unknown): string[] => {
  if (typeof script !== 'string') return []
  const files: string[] = []
  let isInText = false
  let isInBlock = false
  for (const line of script.split('\n')) {
    if (isInBlock) {
      if (/^>{7} REPLACE\s*$/.test(line)) isInBlock = false
      continue
    }
    if (isInText) {
      if (line.trimEnd() === '.') isInText = false
      continue
    }
    if (/^<{7} SEARCH\s*$/.test(line)) {
      isInBlock = true
      continue
    }
    const file = /^(?:[@>]|rm) +(\S.*?) *$/.exec(line)?.[1] ?? /^mv +\S+ +(\S+) *$/.exec(line)?.[1] ?? moveTarget(line)
    if (file) files.push(file)
    // Replacing lines, inserting lines and creating a file each take text up to a lone `.`.
    if (/^[=+>] +\S/.test(line)) isInText = true
  }
  return files
}

/** A fastwrite line tag: the line's number and the one character after it, which is never plain ASCII (`12的`). */
const isLineTag = (word: string): boolean => {
  const tagged = /^\d+(.)$/u.exec(word)
  return tagged !== null && (tagged[1]?.codePointAt(0) ?? 0) > 127
}

// After `>` comes a line of the same file (a tag such as `30中`, or `0` or `$`), or another
// file with where in it the lines go, or a new file alone: `> 2024` and `> 10a` are files.
const isPlace = (word: string): boolean => word === '0' || word === '$' || isLineTag(word)

const moveTarget = (line: string): string | undefined => {
  const after = /^[mc] +\S+(?: +\S+)? +> +(\S.*?) *$/.exec(line)?.[1]
  if (!after) return undefined
  const words = after.split(/ +/)
  if (words.length === 1) return isPlace(after) ? undefined : after
  const last = words[words.length - 1] ?? ''
  return isPlace(last) ? words.slice(0, -1).join(' ') : after
}

// A heredoc's body is text, not commands.
const dropHeredocs = (command: string): string => splitHeredocs(command).kept

const HEREDOC_MARK = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g

/**
 * The command without its heredocs' bodies, and the bodies, in the order of their markers;
 * `marks[i]` is where body i's marker stands in `kept`.
 */
const splitHeredocs = (command: string): { kept: string; bodies: string[]; marks: number[] } => {
  const kept: string[] = []
  const bodies: string[] = []
  const marks: number[] = []
  let keptLength = 0
  let endings: string[] = []
  let body: string[] = []
  for (const line of command.split('\n')) {
    if (endings.length > 0) {
      if (line.trim() === endings[0]) {
        endings = endings.slice(1)
        bodies.push(body.join('\n'))
        body = []
      } else body.push(line)
      continue
    }
    const offset = keptLength + (kept.length > 0 ? 1 : 0)
    kept.push(line)
    keptLength = offset + line.length
    for (const match of line.matchAll(HEREDOC_MARK)) {
      if (!match[2]) continue
      endings.push(match[2])
      marks.push(offset + (match.index ?? 0))
    }
  }
  // A body left open at the end still ran.
  if (endings.length > 0) bodies.push(body.join('\n'))
  return { kept: kept.join('\n'), bodies, marks }
}

/** A `fw apply` on its line, up to the line's end, where its heredoc's marker stands. */
const FW_APPLY = /\bfw\s+apply\b[^\n]*/g

/**
 * One word of a shell command. `isPlain` when no part of it was quoted; `redirect` is
 * what follows an unquoted `>` inside it (`"x">out.ts` writes `out.ts`), when it has one.
 */
type Word = { text: string; isPlain: boolean; redirect?: string }

const splitShell = (command: string): Word[][] => {
  const segments: Word[][] = []
  let words: Word[] = []
  let text = ''
  let quote = ''
  let hasWord = false
  let isPlain = true
  let redirectAt = -1
  const endWord = (): void => {
    if (hasWord) words.push(redirectAt >= 0 ? { text, isPlain, redirect: text.slice(redirectAt) } : { text, isPlain })
    text = ''
    hasWord = false
    isPlain = true
    redirectAt = -1
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
    } else if (ch === '#' && !hasWord) {
      // A comment runs to the end of its line.
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
    } else if (ch === ' ' || ch === '\t') endWord()
    else if (ch === '\n' || ch === ';' || ch === '|' || ch === '(' || ch === ')' || (ch === '&' && command[i - 1] !== '>' && command[i + 1] !== '>')) endSegment()
    else {
      text += ch
      hasWord = true
      if (ch === '>') redirectAt = text.length
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

/** Where the shell stands after a `cd`: a bare one goes home; `cd -` goes somewhere this cannot know (null). */
const afterCd = (here: string | null, args: readonly Word[], home: string): string | null => {
  const target = args[0]?.text
  if (target === undefined) return home || here
  if (target === '-') return null
  if (target.startsWith('-')) return here
  return here === null && !isAbsolute(target) && !target.startsWith('~') ? null : resolvePath(here ?? '/', target, home)
}

/** A path as the shell at `here` reads it; null where `here` is unknown and the path is relative. */
const shellPath = (here: string | null, path: string, home: string): string | null =>
  here === null && !isAbsolute(path) && !path.startsWith('~') ? null : resolvePath(here ?? '/', path, home)

/** The files a shell command plainly reads: searches and globs do not count. */
export const shellReads = (command: string, cwd: string, home = ''): string[] => {
  let here: string | null = cwd
  const found = new Set<string>()
  for (const segment of splitShell(dropHeredocs(command))) {
    const invocation = commandWords(segment)
    const first = basename(invocation[0]?.text ?? '')
    const rest = invocation.slice(1)
    if (first === 'cd') {
      here = afterCd(here, rest, home)
      continue
    }
    const isFw = first === 'fw' && rest[0]?.text === 'read'
    const isSed = first === 'sed' && !rest.some(isInPlaceFlag)
    if (!isFw && !isSed && !SHELL_READERS.has(first)) continue
    let words = isFw ? rest.slice(1) : rest
    if (isSed) words = words.filter(word => !word.text.startsWith('-')).slice(1)
    /** A word's path if it reads as a file argument as written; null for a flag, a pattern, a marker or a value. */
    const argument = (text: string, isPlain: boolean): string | null => {
      if (text.startsWith('-') || (isPlain && /[*?$<>|`]/.test(text))) return null
      // A heredoc's marker, and a word the shell would expand, are no file names as written.
      if (text.startsWith('<<') || text.includes('$')) return null
      // The value of a flag such as `-n 20`, `-l 10-50` or tail's `-n +5`.
      if (isPlain && /^\+?\d[\d,-]*$/.test(text)) return null
      return shellPath(here, text, home)
    }
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (!word) continue
      // A file descriptor's redirection (`2>/dev/null`, `2>&1`, `&>log`) is no argument: skip it,
      // and its target too when that stands apart (`2> log`).
      const fd = word.isPlain ? /^(?:\d+|&)>{1,2}(.*)$/.exec(word.text) : null
      if (fd) {
        if (fd[1] === '') i++
        continue
      }
      // The output's redirection ends the arguments: what follows it is written to, not read.
      // A file name stuck before it (`a.ts>out`) is still read.
      if (word.redirect !== undefined || (word.isPlain && word.text.startsWith('>'))) {
        const head = word.text.slice(0, word.text.indexOf('>'))
        const path = head ? argument(head, word.isPlain) : null
        if (path) found.add(path)
        break
      }
      const path = argument(word.text, word.isPlain)
      if (path) found.add(path)
    }
  }
  return [...found].slice(0, MAX_NAMED_PATHS)
}

/**
 * The files `fw apply` scripts in a shell command name, from their heredoc bodies: written,
 * or only read for a dry run (`-n`). Relative paths go by where the shell stands then.
 */
export const shellScripts = (command: string, cwd: string, home = ''): { reads: string[]; writes: string[] } => {
  const { kept, bodies, marks } = splitHeredocs(command)
  // Each `fw apply` takes the body of the marker on its own line, by where that marker stands: a
  // heredoc inside a quoted `"$(cat <<'EOF' ...)"` before it cannot shift which body is its.
  const applyBodies = [...kept.matchAll(FW_APPLY)].map(match => {
    const at = match[0].search(/(?<!<)<<(?!<)/)
    return at < 0 ? undefined : bodies[marks.indexOf((match.index ?? 0) + at)]
  })
  const reads = new Set<string>()
  const writes = new Set<string>()
  let here: string | null = cwd
  let applies = 0
  for (const segment of splitShell(kept)) {
    const invocation = commandWords(segment)
    const first = basename(invocation[0]?.text ?? '')
    const rest = invocation.slice(1)
    if (first === 'cd') here = afterCd(here, rest, home)
    if (first !== 'fw' || rest[0]?.text !== 'apply') continue
    const body = applyBodies[applies++]
    if (body === undefined) continue
    const isDryRun = rest.some(word => word.text === '-n' || word.text === '--dry-run')
    for (const file of scriptFiles(body)) {
      const path = shellPath(here, file, home)
      if (path) (isDryRun ? reads : writes).add(path)
    }
  }
  return { reads: [...reads].slice(0, MAX_NAMED_PATHS), writes: [...writes].slice(0, MAX_NAMED_PATHS) }
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
// fd runs a command for its matches with these.
const FD_WRITES = /^(-x|-X|--exec|--exec-batch)(=|$)/

const writesByRedirect = (words: readonly Word[]): boolean =>
  words.some((word, i) => {
    const after = word.isPlain && word.text.includes('>') ? word.text.slice(word.text.lastIndexOf('>') + 1) : word.redirect
    if (after === undefined) return false
    const target = after || words[i + 1]?.text || ''
    return target !== '/dev/null' && !/^&\d$/.test(target)
  })

/** Commands that only look, unless told to write: yq -i, sort -o, uniq's output file, awk -i inplace. */
const writesByFlag = (first: string, rest: readonly Word[]): boolean => {
  const texts = rest.map(word => word.text)
  if (first === 'yq') return rest.some(word => /^-[^-]*i/.test(word.text) || /^--inplace(=|$)/.test(word.text))
  if (first === 'sort') return texts.some(text => /^-[^-]*o/.test(text) || /^--output(=|$)/.test(text))
  if (first === 'awk' || first === 'gawk') {
    return texts.some(
      (text, i) => text === '-iinplace' || text === '--include=inplace' || ((text === '-i' || text === '--include') && /^inplace(\.awk)?$/.test(texts[i + 1] ?? '')),
    )
  }
  if (first === 'uniq') {
    // uniq IN OUT writes OUT. Flags, the values of -f, -s and -w (and their long forms) and
    // redirections are no file names.
    let names = 0
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]
      if (!word) continue
      const text = word.text
      if (word.redirect !== undefined || (word.isPlain && /^(?:\d+|&)?>/.test(text))) {
        if (word.isPlain && /^(?:\d+|&)?>{1,2}$/.test(text)) i++
        continue
      }
      if (/^-[fsw]$/.test(text) || /^--(?:skip-fields|skip-chars|check-chars)$/.test(text)) i++
      else if (!text.startsWith('-') || text === '-') names++
    }
    return names >= 2
  }
  return false
}

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
    // A dry run of fastwrite (`fw apply -n`) only shows what it would do.
    if (first === 'fw') return !READ_ONLY_FW.has(rest[0]?.text ?? '') && !(rest[0]?.text === 'apply' && rest.some(word => word.text === '-n' || word.text === '--dry-run'))
    if (first === 'sed') return rest.some(isInPlaceFlag)
    if (first === 'find') return rest.some(word => FIND_WRITES.test(word.text))
    if (first === 'fd') return rest.some(word => FIND_WRITES.test(word.text) || FD_WRITES.test(word.text))
    if (writesByFlag(first, rest)) return true
    return !READ_ONLY_SHELL.has(first)
  })

/**
 * `cwd` is where a built-in tool or the shell resolves a relative path; `mcpRoot` is
 * where an MCP server does: fastwrite's resolves against the folder Claude Code started in.
 */
export const planOfTool = (tool: string, input: Record<string, unknown>, cwd: string, home = '', mcpRoot = cwd): Planned => {
  const absolute = (paths: readonly string[], base = cwd): string[] =>
    [...new Set(paths.filter(Boolean).map(path => resolvePath(base, path, home)))].slice(0, MAX_NAMED_PATHS)

  if (input.dry_run === true || input.dryRun === true) return NOTHING
  if (tool === 'Read') return { ...NOTHING, reads: absolute(stringsOf(input.file_path)) }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return { ...NOTHING, writes: absolute(stringsOf(input.file_path)) }
  if (tool === 'NotebookEdit') return { ...NOTHING, writes: absolute(stringsOf(input.notebook_path)) }
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (typeof input.command !== 'string') return { ...NOTHING, mayWrite: true }
    // A fastwrite script sent through the shell names its files as the MCP tool's does.
    const scripted = shellScripts(input.command, cwd, home)
    const reads = [...new Set([...shellReads(input.command, cwd, home), ...scripted.reads])].slice(0, MAX_NAMED_PATHS)
    return { reads, writes: scripted.writes, mayWrite: shellMayWrite(input.command) }
  }
  if (!tool.startsWith('mcp__')) return NOTHING

  const name = tool.slice(tool.lastIndexOf('__') + 2)
  const named = absolute(
    [
      ...PATH_KEYS.flatMap(key => stringsOf(input[key])),
      ...LOOSE_PATH_KEYS.flatMap(key => stringsOf(input[key]).filter(looksLikePath)),
      ...scriptFiles(input.script),
    ],
    mcpRoot,
  )
  if (named.length === 0) return NOTHING
  // A write first: `find_and_replace` is a write that also says find.
  const verb = toolVerb(name)
  if (verb === 'write') return { reads: [], writes: named, mayWrite: true }
  if (verb === 'search') return NOTHING
  if (verb === 'read') return { ...NOTHING, reads: named }
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

export const plural = (count: number): string => `${count} file${count === 1 ? '' : 's'}`

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
  isHeadKnown: false,
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

/**
 * The commits made since `before`: a checkout, pull, reset or rebase moves HEAD and is none.
 * With no `before` (a repository with no commit yet), only a branch's first commits are new,
 * back to its initial one. Where `before` is not in the entries (HEAD moved more often than
 * the reflog read shows, or no initial commit is in sight), where HEAD stood is unknown: none count.
 */
export const commitsSince = (entries: readonly ReflogEntry[], before: string): string[] => {
  const found: string[] = []
  for (const entry of entries) {
    if (before && entry.sha.startsWith(before)) return found
    if (/^commit( \(|:)/.test(entry.action)) found.push(entry.sha)
    if (!before && /^commit \(initial\)/.test(entry.action)) return found
  }
  return []
}

const GIT_SCALARS = [
  'root', 'isRepo', 'top', 'prefix', 'gitDir', 'stamp', 'branch', 'ahead', 'behind', 'head', 'isHeadKnown', 'changedTotal', 'added', 'removed',
  'isCountPartial',
] as const

/** `git log` in a repository with no commit yet: the one failure that means there is no head. */
const NO_COMMITS_YET = /does not have any commits yet|bad default revision/i

type LogAnswer = { exitCode: number; stdout: string; stderr: string }

/**
 * Where HEAD stands after a `git log -1`. No commit yet is a known empty head. Any other
 * failure keeps the head the last look knew for this folder, and with none to keep, says
 * the head is unknown: an empty head must never stand for "not known".
 */
export const headAfter = (log: LogAnswer, last: Pick<GitView, 'head' | 'isHeadKnown'> | null): Pick<GitView, 'head' | 'isHeadKnown'> => {
  if (log.exitCode === 0) return { head: log.stdout.trim(), isHeadKnown: true }
  if (NO_COMMITS_YET.test(log.stderr)) return { head: '', isHeadKnown: true }
  return last?.isHeadKnown ? { head: last.head, isHeadKnown: true } : { head: '', isHeadKnown: false }
}

/** A `-z` stream git cut at its size limit, less its last, partial record. */
export const wholeRecords = (stdout: string, isTruncated: boolean): string =>
  isTruncated ? stdout.slice(0, stdout.lastIndexOf('\0') + 1) : stdout

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

export type TouchedFolder = { folders: Map<string, TouchedFolder>; files: string[] }

/**
 * The touched files of `root` as nested folders: the one shape both the rows and their
 * count are read from. A touch of `root` itself, or of a path outside it, has no place.
 */
export const touchedTreeOf = (root: string, paths: Iterable<string>): TouchedFolder => {
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
  return top
}

/** How many file rows the touched tree holds with nothing folded: a file replaced by a folder of its name is none. */
export const touchedFilesIn = (folder: TouchedFolder): number =>
  folder.files.filter(name => !folder.folders.has(name)).length +
  [...folder.folders.values()].reduce((sum, child) => sum + touchedFilesIn(child), 0)

/**
 * The touched tree as rows, so a long session still fits on a screen. Folders stand
 * open unless folded by hand, and one holding nothing but a single folder shares that
 * folder's row.
 */
export const touchedRowsOf = (
  top: TouchedFolder,
  root: string,
  folded: ReadonlySet<string>,
  ignored: ReadonlySet<string>,
): TreeRow[] => {
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

/** How many folds of the touched tree are kept: one bound for a single fold and for Collapse all. */
export const MAX_FOLDS = 2000

/** Collapse all folds every folder row; past the bound it keeps the first, top-down, so the top of the tree folds. */
export const foldsOfAll = (folders: readonly string[]): string[] => folders.slice(0, MAX_FOLDS)

/** The touched tree's folds after the person folds or unfolds `path`: only this tree's, the newest kept. */
export const toggleFold = (closed: readonly string[], path: string, root: string): string[] =>
  (closed.includes(path) ? closed.filter(dir => dir !== path) : [...closed, path]).filter(dir => isInside(root, dir)).slice(-MAX_FOLDS)

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

/**
 * `compute`, remembering its last answer by the identity of its arguments: a drawing
 * redrawn every 160 ms asks the same question until its inputs change.
 */
export const rememberLast = <A extends readonly unknown[], R>(compute: (...args: A) => R): ((...args: A) => R) => {
  let last: { args: A; result: R } | null = null
  return (...args: A): R => {
    if (last && last.args.length === args.length && last.args.every((arg, i) => Object.is(arg, args[i]))) return last.result
    const result = compute(...args)
    last = { args, result }
    return result
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
  // A format prints a choice option as its number: off 0, on 1, all 2.
  const isAll = passthrough === 'all' || passthrough === '2'
  if ((!isOn && !isAll) || focusEvents !== '1') return null
  const kitty = /^kitty\((\d+)\.(\d+)/.exec(termtype)
  if (/^(ghostty|kitty)( |$)/.test(termtype) || (kitty && isAtLeast(kitty, 0, 28))) return { via: 'bytes', needsFullscreen: false }
  const iterm = /^iTerm2\s+(\d+)\.(\d+)/.exec(termtype)
  return isOn && iterm && isAtLeast(iterm, 3, 5) ? { via: 'bytes', needsFullscreen: true } : null
}

/** The values of CLAUDE_CODE_FORCE_TERMINAL_IMAGES that turn it on. */
const FORCE_ON = /^(1|true|yes|on)$/i

/** Told to try pictures regardless: by the setting, or by the engine's own override. */
const isPictureForced = (setting: unknown, env: Readonly<Record<string, string | undefined>>): boolean =>
  setting === 'images' || FORCE_ON.test(env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES ?? '')

/**
 * Whether tmux's answer decides if pictures get through: inside tmux alone, with
 * pictures neither turned off nor forced. Anywhere else asking it is wasted time.
 */
export const needsTmuxAnswer = (setting: unknown, env: Readonly<Record<string, string | undefined>>): boolean =>
  setting !== 'chips' && !isPictureForced(setting, env) && Boolean(env.TMUX) && !env.ZELLIJ && !env.STY

/** Whether this terminal can draw pictures, and how. Null means the chips. */
export const imagePlanOf = (
  setting: unknown,
  env: Readonly<Record<string, string | undefined>>,
  tmuxAnswer?: string,
): ImagePlan | null => {
  if (setting === 'chips') return null
  // herdr lands on this too: it answers the engine as `libghostty`, which the engine
  // does not count as able to draw, so pictures there wait for the engine's own override.
  const forced: ImagePlan | null = isPictureForced(setting, env) ? { via: 'bytes', needsFullscreen: false } : null
  // Told to try regardless, tmux's answer has no say; and it cannot speak for a multiplexer around it.
  if (needsTmuxAnswer(setting, env) && tmuxAnswer !== undefined) return tmuxPlanOf(tmuxAnswer)
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
