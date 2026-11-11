// Shared helpers for the build / validate scripts.
// Single source of truth: shared/**. Everything under plugins/*/{skills,commands,agents},
// copilot-plugins/*/{skills,agents,extensions} and dist/** is generated from it by scripts/build.mjs.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'

// Resolved from the invocation directory rather than this file's location, so the same
// toolchain can be run from a sibling repository that reuses this build.
export const ROOT = process.env.TOOLKIT_ROOT ? resolve(process.env.TOOLKIT_ROOT) : process.cwd()
export const SHARED = join(ROOT, 'shared')

// Per-repository settings, so this file stays byte-identical across the repositories that
// share the toolchain. Keeping it identical is what makes moving an asset between them a
// plain file move.
const config = existsSync(join(ROOT, 'toolkit.config.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'toolkit.config.json'), 'utf8'))
  : {}

/** Claude Code plugin that receives every `claude` target asset that does not name one. */
export const CLAUDE_PLUGIN = config.claudePlugin ?? 'toolkit-core'

/**
 * Plugin an asset is emitted into: `harness.claude.plugin` when set, otherwise the repository
 * default. Lets one repository ship several plugins with unrelated triggers. The Copilot
 * plugin of an asset has the same name, so one asset belongs to one plugin in both
 * marketplaces.
 */
export function claudePluginFor(asset) {
  return asset.data.harness?.claude?.plugin ?? asset.data.harness?.copilot?.plugin ?? CLAUDE_PLUGIN
}

/** Copilot CLI plugins live apart from the Claude Code ones: their payload differs per harness. */
export const COPILOT_PLUGINS_DIR = 'copilot-plugins'
/**
 * Kinds a Copilot CLI plugin can carry. Its command format is not documented, so none ship;
 * a slash command that must not reach the model is registered by an extension instead.
 */
export const COPILOT_KINDS = ['skills', 'agents', 'extensions']

/** Entry file names Copilot CLI accepts for an extension, in its lookup order. */
export const EXTENSION_ENTRIES = ['extension.mjs', 'extension.cjs', 'extension.js']
/** Source-only description of an extension. Carries the frontmatter; never emitted. */
export const EXTENSION_DOC = 'EXTENSION.md'

function targetsOf(asset) {
  const harness = asset.data.harness ?? {}
  return (asset.data.targets ?? []).filter((t) => !harness[t]?.skip)
}

/** Copilot CLI plugins this build writes into, by name. */
export function copilotPlugins(assets) {
  return [...new Set(assets.filter((a) => targetsOf(a).includes('copilot')).map(claudePluginFor))].sort()
}

/** Output roots this build owns. Anything here is wiped and regenerated. */
export function ownedDirs(assets) {
  const plugins = new Set([CLAUDE_PLUGIN, ...assets.filter((a) => targetsOf(a).includes('claude')).map(claudePluginFor)])
  const dirs = []
  for (const plugin of [...plugins].sort()) for (const kind of KINDS) dirs.push(join('plugins', plugin, kind))
  for (const plugin of copilotPlugins(assets))
    for (const kind of COPILOT_KINDS) dirs.push(join(COPILOT_PLUGINS_DIR, plugin, kind))
  dirs.push('dist')
  return dirs
}

export const KINDS = ['skills', 'commands', 'agents']
export const TARGETS = ['claude', 'opencode', 'copilot']

// agentskills.io constraints, also enforced by Claude Code and Copilot (VS 2026 18.5+).
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const NAME_MAX = 64
export const DESC_MAX = 1024

/** `{{ARGS}}` in a shared body becomes the harness-native argument placeholder. */
const PLACEHOLDERS = {
  claude: { ARGS: '$ARGUMENTS' },
  opencode: { ARGS: '$ARGUMENTS' },
  copilot: { ARGS: '${input:args}' },
}

// The path is deliberately described as not-local: an agent reading a bare relative path in
// its own instructions will try to open it, waste a tool call, and get a permission error.
const BANNER = (src) =>
  `<!-- Generated file - do not edit this copy; the next build overwrites it. It is generated from ${src} in its source marketplace repository, which is not present alongside this file and must not be opened. -->`

export function splitFrontmatter(text, file) {
  if (!text.startsWith('---')) throw new Error(`${file}: missing YAML frontmatter`)
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error(`${file}: unterminated YAML frontmatter`)
  const raw = text.slice(4, end)
  const body = text.slice(text.indexOf('\n', end + 1) + 1)
  let data
  try {
    data = YAML.parse(raw) ?? {}
  } catch (e) {
    throw new Error(`${file}: invalid YAML frontmatter - ${e.message}`)
  }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: frontmatter must be a mapping`)
  return { data, body }
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

function listFiles(dir, ext) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => e.name)
  } catch {
    return []
  }
}

export function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

export function relPath(abs) {
  return relative(ROOT, abs).split(sep).join('/')
}

/**
 * Discover every asset under shared/. Returns a list of
 * { kind, name, sourceFile, sourceDir, extraFiles, data, body }.
 */
export function loadAssets() {
  const assets = []

  for (const name of listDirs(join(SHARED, 'skills'))) {
    const dir = join(SHARED, 'skills', name)
    const file = join(dir, 'SKILL.md')
    const text = readFileSync(file, 'utf8')
    const { data, body } = splitFrontmatter(text, relPath(file))
    assets.push({
      kind: 'skills',
      name,
      sourceFile: relPath(file),
      sourceDir: dir,
      extraFiles: walk(dir).filter((f) => f !== 'SKILL.md'),
      data,
      body,
    })
  }

  // An extension is code, not a prompt: a folder that is copied verbatim into the Copilot CLI
  // plugin. EXTENSION.md holds the frontmatter and the notes for maintainers, and stays here.
  for (const name of listDirs(join(SHARED, 'extensions'))) {
    const dir = join(SHARED, 'extensions', name)
    const file = join(dir, EXTENSION_DOC)
    const text = readFileSync(file, 'utf8')
    const { data, body } = splitFrontmatter(text, relPath(file))
    assets.push({
      kind: 'extensions',
      name,
      sourceFile: relPath(file),
      sourceDir: dir,
      extraFiles: walk(dir).filter((f) => f !== EXTENSION_DOC),
      data,
      body,
    })
  }

  for (const kind of ['commands', 'agents']) {
    for (const fileName of listFiles(join(SHARED, kind), '.md')) {
      const file = join(SHARED, kind, fileName)
      const text = readFileSync(file, 'utf8')
      const { data, body } = splitFrontmatter(text, relPath(file))
      assets.push({
        kind,
        name: fileName.replace(/\.md$/, ''),
        sourceFile: relPath(file),
        sourceDir: null,
        extraFiles: [],
        data,
        body,
      })
    }
  }

  return assets.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name))
}

/** Canonical-schema validation. Returns an array of human-readable problem strings. */
export function validateAsset(asset) {
  const problems = []
  const at = asset.sourceFile
  const { name, description, targets, harness } = asset.data

  if (typeof name !== 'string' || !name) {
    problems.push(`${at}: \`name\` is required`)
  } else {
    if (name !== asset.name)
      problems.push(
        `${at}: \`name: ${name}\` must match the ${asset.sourceDir ? 'directory' : 'file'} name \`${asset.name}\``
      )
    if (name.length > NAME_MAX) problems.push(`${at}: \`name\` is ${name.length} chars (max ${NAME_MAX})`)
    if (!NAME_RE.test(name)) problems.push(`${at}: \`name\` must be lowercase alphanumeric words joined by single hyphens`)
  }

  if (typeof description !== 'string' || !description.trim()) problems.push(`${at}: \`description\` is required`)
  else if (description.length > DESC_MAX) problems.push(`${at}: \`description\` is ${description.length} chars (max ${DESC_MAX})`)

  if (!Array.isArray(targets) || targets.length === 0) problems.push(`${at}: \`targets\` must be a non-empty list`)
  else
    for (const t of targets)
      if (!TARGETS.includes(t)) problems.push(`${at}: unknown target \`${t}\` (allowed: ${TARGETS.join(', ')})`)

  if (harness !== undefined) {
    if (typeof harness !== 'object' || harness === null || Array.isArray(harness)) {
      problems.push(`${at}: \`harness\` must be a mapping`)
    } else {
      for (const [t, cfg] of Object.entries(harness)) {
        if (!TARGETS.includes(t)) problems.push(`${at}: \`harness.${t}\` is not a known target`)
        if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
          problems.push(`${at}: \`harness.${t}\` must be a mapping`)
          continue
        }
        for (const key of Object.keys(cfg))
          if (!['frontmatter', 'emit', 'skip', 'plugin'].includes(key)) problems.push(`${at}: unknown key \`harness.${t}.${key}\``)
        if ('plugin' in cfg) {
          // A misspelled plugin name would silently create a new plugin directory on build, so
          // the manifest has to exist first.
          // One asset belongs to one plugin in both marketplaces, named by the claude target.
          // Only an asset that Claude Code never sees may name its plugin under copilot.
          const claudeTarget = Array.isArray(targets) && targets.includes('claude')
          if (t === 'opencode' || (t === 'copilot' && claudeTarget))
            problems.push(`${at}: \`harness.${t}.plugin\` only applies to the claude target`)
          else if (typeof cfg.plugin !== 'string' || !NAME_RE.test(cfg.plugin))
            problems.push(`${at}: \`harness.${t}.plugin\` must be lowercase alphanumeric words joined by single hyphens`)
          else if (t === 'claude' && !existsSync(join(ROOT, 'plugins', cfg.plugin, '.claude-plugin', 'plugin.json')))
            problems.push(`${at}: \`harness.claude.plugin: ${cfg.plugin}\` has no manifest at plugins/${cfg.plugin}/.claude-plugin/plugin.json`)
        }
      }
    }
  }

  const copilot = Array.isArray(targets) && targets.includes('copilot') && !harness?.copilot?.skip
  if (copilot) {
    const emitAs = harness?.copilot?.emit ?? defaultEmit(asset.kind, 'copilot')
    if (emitAs === 'command')
      problems.push(`${at}: Copilot CLI plugins have no documented command format - emit it as a skill or drop the copilot target`)
    const plugin = claudePluginFor(asset)
    if (NAME_RE.test(plugin) && !existsSync(join(ROOT, COPILOT_PLUGINS_DIR, plugin, 'plugin.json')))
      problems.push(`${at}: targets copilot, but plugin \`${plugin}\` has no manifest at ${COPILOT_PLUGINS_DIR}/${plugin}/plugin.json`)
  }

  if (asset.kind === 'extensions') {
    if (Array.isArray(targets) && targets.some((t) => t !== 'copilot'))
      problems.push(`${at}: an extension only exists in Copilot CLI - \`targets\` must be [copilot]`)
    if (!EXTENSION_ENTRIES.some((f) => asset.extraFiles.includes(f)))
      problems.push(`${at}: no entry file (${EXTENSION_ENTRIES.join(', ')}) next to ${EXTENSION_DOC}`)
    if (harness?.copilot?.frontmatter) problems.push(`${at}: an extension is copied verbatim - \`frontmatter\` does not apply`)
  }

  if (!asset.body.trim()) problems.push(`${at}: body is empty`)

  return problems
}

function renderBody(body, target) {
  let out = body
  for (const [token, value] of Object.entries(PLACEHOLDERS[target])) out = out.replaceAll(`{{${token}}}`, value)
  return out.trim() + '\n'
}

function render(frontmatter, body, target, sourceFile) {
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()
  return `---\n${yaml}\n---\n\n${BANNER(sourceFile)}\n\n${renderBody(body, target)}`
}

/**
 * A skill targeting opencode is emitted as a command: a command's frontmatter can pin the
 * agent it runs under (`agent:`), which a skill the model calls by itself cannot.
 * Everything else maps one-to-one.
 */
function defaultEmit(kind, target) {
  if (kind === 'skills') return target === 'opencode' ? 'command' : 'skill'
  if (kind === 'commands') return 'command'
  if (kind === 'extensions') return 'extension'
  return 'agent'
}

/**
 * Compute every generated file for one asset.
 * Returns [{ path, contents }] for rendered files and [{ path, copyFrom }] for verbatim copies.
 */
export function emit(asset) {
  const files = []
  const targets = asset.data.targets ?? []
  const harness = asset.data.harness ?? {}
  const { name, description } = asset.data

  for (const target of targets) {
    const cfg = harness[target] ?? {}
    if (cfg.skip) continue
    const extra = cfg.frontmatter ?? {}
    const emitAs = cfg.emit ?? defaultEmit(asset.kind, target)
    const outDir = {
      claude: join('plugins', claudePluginFor(asset)),
      opencode: join('dist', 'opencode'),
      copilot: join(COPILOT_PLUGINS_DIR, claudePluginFor(asset)),
    }[target]

    if (emitAs === 'skill') {
      const dir = join(outDir, 'skills', name)
      files.push({
        path: join(dir, 'SKILL.md'),
        contents: render({ name, description, ...extra }, asset.body, target, asset.sourceFile),
      })
      for (const f of asset.extraFiles) files.push({ path: join(dir, f), copyFrom: join(asset.sourceDir, f) })
    } else if (emitAs === 'command') {
      if (target === 'copilot') throw new Error(`${asset.sourceFile}: Copilot CLI plugins carry no commands`)
      const file = join(outDir, target === 'claude' ? 'commands' : 'command', `${name}.md`)
      files.push({ path: file, contents: render({ description, ...extra }, asset.body, target, asset.sourceFile) })
    } else if (emitAs === 'agent') {
      const file =
        target === 'copilot'
          ? join(outDir, 'agents', `${name}.agent.md`)
          : join(outDir, target === 'claude' ? 'agents' : 'agent', `${name}.md`)
      const fm = target === 'opencode' ? { description, ...extra } : { name, description, ...extra }
      files.push({ path: file, contents: render(fm, asset.body, target, asset.sourceFile) })
    } else if (emitAs === 'extension') {
      if (target !== 'copilot') throw new Error(`${asset.sourceFile}: only Copilot CLI plugins carry extensions`)
      const dir = join(outDir, 'extensions', name)
      for (const f of asset.extraFiles) files.push({ path: join(dir, f), copyFrom: join(asset.sourceDir, f) })
    } else {
      throw new Error(`${asset.sourceFile}: unknown emit kind \`${emitAs}\` for target \`${target}\``)
    }
  }

  return files
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
