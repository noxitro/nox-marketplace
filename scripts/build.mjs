#!/usr/bin/env node
// Generate the per-harness distributions from shared/**.
//
//   node scripts/build.mjs           regenerate the owned output directories
//   node scripts/build.mjs --check   fail if the committed output is out of date
//
// Owned output (wiped and rewritten on every build):
//   plugins/<plugin>/{skills,commands,agents}          Claude Code plugin payload; <plugin> is
//                                                      toolkit.config.json claudePlugin unless the
//                                                      asset sets harness.claude.plugin
//   copilot-plugins/<plugin>/{skills,agents}           GitHub Copilot CLI plugin payload; same
//                                                      <plugin> as the Claude Code one
//   dist/opencode/{agent,command}                      OpenCode payload, read in place through
//                                                      OPENCODE_CONFIG_DIR

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT, emit, isDir, loadAssets, ownedDirs, validateAsset, walk } from './lib/toolkit.mjs'

const check = process.argv.includes('--check')

const assets = loadAssets()
const OWNED_DIRS = ownedDirs(assets)
const problems = assets.flatMap(validateAsset)
if (problems.length) {
  console.error('Cannot build - fix these first (see `npm run validate`):')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

/** path (posix, repo-relative) -> { contents } | { copyFrom } */
const planned = new Map()
for (const asset of assets) {
  for (const file of emit(asset)) {
    const key = file.path.split('\\').join('/')
    if (planned.has(key)) {
      console.error(`Output collision on ${key} (produced by more than one shared asset).`)
      process.exit(1)
    }
    planned.set(key, file)
  }
}

function currentFiles() {
  const found = new Map()
  for (const dir of OWNED_DIRS) {
    const abs = join(ROOT, dir)
    if (!isDir(abs)) continue
    for (const rel of walk(abs)) found.set(`${dir.split('\\').join('/')}/${rel}`, join(abs, rel))
  }
  return found
}

function bytesFor(file) {
  return file.copyFrom ? readFileSync(file.copyFrom) : Buffer.from(file.contents, 'utf8')
}

if (check) {
  const existing = currentFiles()
  const added = []
  const changed = []
  const removed = []

  for (const [path, file] of planned) {
    const abs = existing.get(path)
    if (!abs) added.push(path)
    else if (!readFileSync(abs).equals(bytesFor(file))) changed.push(path)
  }
  for (const path of existing.keys()) if (!planned.has(path)) removed.push(path)

  if (added.length || changed.length || removed.length) {
    console.error('Generated output is out of date. Run `npm run build` and commit the result.')
    for (const p of added) console.error(`  + missing   ${p}`)
    for (const p of changed) console.error(`  ~ stale     ${p}`)
    for (const p of removed) console.error(`  - orphaned  ${p}`)
    process.exit(1)
  }
  console.log(`Generated output is up to date (${planned.size} files from ${assets.length} shared assets).`)
  process.exit(0)
}

for (const dir of OWNED_DIRS) rmSync(join(ROOT, dir), { recursive: true, force: true })
for (const [path, file] of planned) {
  const abs = join(ROOT, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytesFor(file))
}

console.log(`Built ${planned.size} files from ${assets.length} shared assets:`)
for (const path of [...planned.keys()].sort()) console.log(`  ${path}`)
