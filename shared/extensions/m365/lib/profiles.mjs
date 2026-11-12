// Response profiles for /m365: fixed instructions and an optional JSON answer format, read
// from m365.json. Everything here is local string and file work; no model is called.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const PROFILE_KEYS = new Set(['description', 'instructions', 'response', 'context', 'newChat'])
const CONTEXT_MODES = new Set(['delta', 'full', 'none'])

/**
 * Where m365.json is looked for, lowest priority first. A later file adds profiles and
 * replaces those with the same name, and its defaultProfile wins.
 *
 *   project  <git root or working directory>/.github/m365.json
 *   user     $COPILOT_HOME/m365.json (default ~/.copilot/m365.json)
 *   explicit M365_COPILOT_CONFIG (must exist)
 *
 * The project file comes first so that a cloned repository can add profiles but never
 * replace the user's own ones or their default.
 */
export function configPaths({ env, root, home = homedir() }) {
  const paths = []
  if (root) paths.push({ path: join(root, '.github', 'm365.json'), origin: 'project' })
  paths.push({ path: join(env.COPILOT_HOME || join(home, '.copilot'), 'm365.json'), origin: 'user' })
  if (env.M365_COPILOT_CONFIG) paths.push({ path: env.M365_COPILOT_CONFIG, origin: 'explicit', required: true })
  return paths
}

/** Problems with one profile, as readable strings. */
function checkProfile(name, p) {
  const at = `プロファイル ${name}`
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return [`${at}: オブジェクトで書いてください`]
  const problems = []
  for (const key of Object.keys(p)) if (!PROFILE_KEYS.has(key)) problems.push(`${at}: 不明なキー ${key}`)
  const ins = p.instructions
  if (ins !== undefined && typeof ins !== 'string' && !(Array.isArray(ins) && ins.every((s) => typeof s === 'string')))
    problems.push(`${at}: instructions は文字列か文字列の配列`)
  if (p.response !== undefined) {
    const r = p.response
    if (typeof r !== 'object' || r === null || Array.isArray(r)) problems.push(`${at}: response はオブジェクト`)
    else {
      for (const key of Object.keys(r)) if (!['format', 'schema'].includes(key)) problems.push(`${at}: response の不明なキー ${key}`)
      if (r.format !== undefined && !['text', 'json'].includes(r.format)) problems.push(`${at}: response.format は text か json`)
      if (r.schema !== undefined && r.format !== 'json') problems.push(`${at}: response.schema は format: json のときだけ使えます`)
    }
  }
  if (p.context !== undefined) {
    const c = p.context
    if (typeof c !== 'object' || c === null || Array.isArray(c)) problems.push(`${at}: context はオブジェクト`)
    else {
      for (const key of Object.keys(c)) if (!['mode', 'maxChars'].includes(key)) problems.push(`${at}: context の不明なキー ${key}`)
      if (c.mode !== undefined && !CONTEXT_MODES.has(c.mode)) problems.push(`${at}: context.mode は delta・full・none のどれか`)
      if (c.maxChars !== undefined && !(Number.isInteger(c.maxChars) && c.maxChars > 0)) problems.push(`${at}: context.maxChars は正の整数`)
    }
  }
  if (p.newChat !== undefined && typeof p.newChat !== 'boolean') problems.push(`${at}: newChat は true か false`)
  return problems
}

/**
 * Read and merge every m365.json that exists. Returns { profiles, defaultProfile, sources,
 * problems }; a file with problems contributes nothing, so a typo never half-applies.
 */
export function loadProfiles(paths, read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)) {
  // No prototype: a profile called "toString" or "__proto__" is just a name here.
  const profiles = Object.create(null)
  const origins = Object.create(null)
  let defaultProfile
  const sources = []
  const problems = []
  for (const entry of paths) {
    const { path, origin = 'user', required = false } = typeof entry === 'string' ? { path: entry } : entry
    let text
    try {
      text = read(path)
    } catch (error) {
      problems.push(`${path}: 読めません (${error.message})`)
      continue
    }
    if (text == null) {
      if (required) problems.push(`${path}: ありません`)
      continue
    }
    let data
    try {
      data = JSON.parse(text.replace(/^﻿/, ''))
    } catch (error) {
      problems.push(`${path}: JSON として読めません (${error.message})`)
      continue
    }
    const found = []
    if (typeof data !== 'object' || data === null || Array.isArray(data)) found.push('最上位はオブジェクトで書いてください')
    else {
      for (const key of Object.keys(data)) if (!['defaultProfile', 'profiles'].includes(key)) found.push(`不明なキー ${key}`)
      if (data.profiles !== undefined && (typeof data.profiles !== 'object' || data.profiles === null || Array.isArray(data.profiles)))
        found.push('profiles はオブジェクト(名前 → 設定)')
      else for (const [name, p] of Object.entries(data.profiles ?? {})) found.push(...checkProfile(name, p))
      if (data.defaultProfile !== undefined && typeof data.defaultProfile !== 'string') found.push('defaultProfile は文字列')
    }
    if (found.length) {
      problems.push(...found.map((f) => `${path}: ${f}`))
      continue
    }
    for (const [name, p] of Object.entries(data.profiles ?? {})) {
      profiles[name] = p
      origins[name] = { path, origin }
    }
    if (data.defaultProfile) defaultProfile = data.defaultProfile
    sources.push(path)
  }
  if (defaultProfile && !Object.hasOwn(profiles, defaultProfile)) {
    problems.push(`defaultProfile の ${defaultProfile} がどのファイルにもありません`)
    defaultProfile = undefined
  }
  return { profiles, origins, defaultProfile, sources, problems }
}

/** Instruction text for the prompt. `full` the first time in a chat, a short reminder after. */
export function instructionBlock(name, profile, { full, replaces = false }) {
  // The chat keeps earlier instructions; switching profile must say they no longer hold.
  const drop = replaces ? 'これまでに伝えた指示と返答の形は取り消します。' : ''
  if (!profile) return drop
  const json = profile.response?.format === 'json'
  if (!full) {
    const lines = [`(最初に伝えた指示「${name}」に引き続き従ってください。)`]
    if (json) lines.push('返答は指定した形の JSON だけにしてください。')
    return lines.join('\n')
  }
  const lines = [drop, `指示(${name}):`].filter(Boolean)
  const ins = [profile.instructions ?? []].flat().filter((s) => s.trim())
  for (const line of ins) lines.push(line.trim())
  if (json) {
    lines.push('返答は JSON だけにしてください。前後に説明文を付けないでください。')
    if (profile.response.schema !== undefined) lines.push(`形は次のとおりです(値は説明):\n${JSON.stringify(profile.response.schema, null, 2)}`)
  }
  return lines.length > (drop ? 2 : 1) ? lines.join('\n') : drop
}

/**
 * Text candidates that may hold the JSON, best first: the last fenced block (an answer may
 * show an example before the real one), the text under a "json" label, the outermost brackets.
 */
function candidates(text) {
  const out = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]).reverse()
  // The window text of a rendered code block often starts with its language label.
  const labelled = [...text.matchAll(/(?:^|\n)\s*json\s*\n/gi)].at(-1)
  if (labelled) out.push(text.slice(labelled.index + labelled[0].length))
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = text.indexOf(open)
    const end = text.lastIndexOf(close)
    if (start !== -1 && end > start) out.push(text.slice(start, end + 1))
  }
  out.push(text)
  return out
}

/**
 * Pull a JSON value out of the reply text. Returns { value, missing } or null.
 * `missing` lists top-level keys of an object-shaped schema that the reply lacks. A value
 * equal to the schema is the echoed request, not an answer, and is skipped.
 */
export function parseJsonReply(text, schema) {
  // The prompt shows the schema; if any of that echo is left in the reply, its brackets
  // would be found first. Take it out before searching.
  if (schema !== undefined)
    for (const shown of [JSON.stringify(schema, null, 2), JSON.stringify(schema)]) text = text.split(shown).join('')
  for (const candidate of candidates(text)) {
    let value
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    if (schema !== undefined && isDeepStrictEqual(value, schema)) continue
    const missing =
      schema && typeof schema === 'object' && !Array.isArray(schema) && value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(schema).filter((key) => !Object.hasOwn(value, key))
        : []
    return { value, missing }
  }
  return null
}
