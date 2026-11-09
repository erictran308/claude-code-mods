#!/usr/bin/env node
// Turns Material Icon Theme into what the file-tree mod ships: one PNG per icon,
// and a map from file and folder names to icons.
//
//   npm pack material-icon-theme && tar xzf material-icon-theme-*.tgz
//   node scripts/build-file-tree-icons.mjs package plugins/file-tree/assets/icons
//
// Needs ImageMagick's `magick`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PIXELS = 64
const REPORT_EVERY = 200

const [packageDir, outDir] = process.argv.slice(2)
if (!packageDir || !outDir) {
  console.error('usage: build-file-tree-icons.mjs <unpacked material-icon-theme> <output folder>')
  process.exit(1)
}

const theme = JSON.parse(readFileSync(join(packageDir, 'dist/material-icons.json'), 'utf8'))

// The theme keys the commonest languages by VS Code language id, not by extension.
const LANGUAGE_EXTENSIONS = {
  bat: ['bat', 'cmd'],
  c: ['c'],
  clojure: ['clj', 'cljs', 'cljc', 'edn'],
  coffeescript: ['coffee'],
  cpp: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx'],
  csharp: ['cs', 'csx'],
  css: ['css'],
  dart: ['dart'],
  dockerfile: ['dockerfile'],
  fsharp: ['fs', 'fsi', 'fsx'],
  go: ['go'],
  groovy: ['groovy', 'gradle'],
  handlebars: ['hbs', 'handlebars'],
  html: ['html', 'htm', 'xhtml'],
  ini: ['ini'],
  jade: ['jade', 'pug'],
  java: ['java'],
  javascript: ['js', 'mjs', 'cjs', 'es6'],
  javascriptreact: ['jsx'],
  json: ['json', 'webmanifest'],
  jsonc: ['jsonc'],
  latex: ['tex'],
  less: ['less'],
  lua: ['lua'],
  makefile: ['mk'],
  markdown: ['md', 'markdown', 'mdown', 'mkd'],
  'objective-c': ['m'],
  'objective-cpp': ['mm'],
  perl: ['pl', 'pm'],
  php: ['php'],
  powershell: ['ps1', 'psm1', 'psd1'],
  properties: ['properties'],
  python: ['py', 'pyi', 'pyw'],
  r: ['r'],
  razor: ['cshtml'],
  ruby: ['rb', 'erb'],
  rust: ['rs'],
  scss: ['scss', 'sass'],
  shellscript: ['sh', 'bash', 'zsh', 'ksh'],
  sql: ['sql'],
  swift: ['swift'],
  toml: ['toml'],
  typescript: ['ts', 'mts', 'cts'],
  typescriptreact: ['tsx'],
  vb: ['vb'],
  xml: ['xml', 'xsd', 'xsl'],
  yaml: ['yaml', 'yml'],
}

const extensions = { ...theme.fileExtensions }
for (const [language, names] of Object.entries(LANGUAGE_EXTENSIONS)) {
  const icon = theme.languageIds[language]
  if (!icon) continue
  for (const name of names) extensions[name] ??= icon
}

const folderNames = { ...theme.folderNames }

const needed = new Set([theme.file, theme.folder, theme.folderExpanded])
for (const icon of [...Object.values(theme.fileNames), ...Object.values(extensions)]) needed.add(icon)
for (const icon of Object.values(folderNames)) {
  needed.add(icon)
  needed.add(`${icon}-open`)
}

const sourceOf = icon => {
  const definition = theme.iconDefinitions[icon]
  return definition ? join(packageDir, 'dist', definition.iconPath) : undefined
}

const missing = [...needed].filter(icon => !sourceOf(icon) || !existsSync(sourceOf(icon)))
if (missing.length) {
  console.error(`the theme names icons it does not hold: ${missing.join(', ')}`)
  process.exit(1)
}

// Built beside the old set and swapped in at the end, so a failure leaves the old set whole.
const building = `${outDir}.building`
rmSync(building, { recursive: true, force: true })
mkdirSync(building, { recursive: true })

const icons = [...needed].sort()
icons.forEach((icon, index) => {
  execFileSync('magick', [
    '-background', 'none',
    '-density', '512',
    sourceOf(icon),
    '-resize', `${PIXELS}x${PIXELS}`,
    '-strip',
    '-define', 'png:compression-level=9',
    '-define', 'png:compression-filter=5',
    `PNG32:${join(building, `${icon}.png`)}`,
  ])
  if ((index + 1) % REPORT_EVERY === 0) console.log(`${index + 1}/${icons.length}`)
})

writeFileSync(
  join(building, 'map.json'),
  JSON.stringify({
    file: theme.file,
    folder: theme.folder,
    folderOpen: theme.folderExpanded,
    fileNames: theme.fileNames,
    extensions,
    folderNames,
  }),
)
rmSync(outDir, { recursive: true, force: true })
renameSync(building, outDir)
console.log(`${icons.length} icons in ${outDir}`)
