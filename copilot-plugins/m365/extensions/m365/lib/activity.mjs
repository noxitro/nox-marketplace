// What GitHub Copilot did with its tools (files changed, commands run, what failed), as a few
// short lines. The Copilot CLI model sees every tool call and its output; Microsoft 365
// Copilot gets this digest instead, so that it knows the work behind the messages.
//
// Shapes observed in Copilot CLI session logs:
//   tool.execution_start     { toolCallId, toolName, arguments, parentToolCallId? }
//   tool.execution_complete  { toolCallId, success, result: { content }, error: { message } }
// apply_patch takes the patch as a string with `*** Update File: <path>` style headers. A
// shell command that ran but failed reports success with `<exited with exit code N>` (or
// `<shellId: N completed with exit code N>`) at the end of its output.

const SHELLS = new Set(['powershell', 'bash', 'shell', 'pwsh', 'cmd'])
const READS = new Set(['view', 'read', 'read_file'])
const SEARCHES = new Set(['rg', 'grep', 'glob', 'search', 'find'])
// Bookkeeping that says nothing about the work itself.
const SKIP = new Set([
  'report_intent',
  'think',
  'read_powershell',
  'read_bash',
  'write_powershell',
  'write_bash',
  'stop_powershell',
  'stop_bash',
  'list_powershell',
  'list_bash',
  'read_agent',
  'list_agents',
  'tool_search_tool',
  'rename_session',
  'store_memory',
  'update_todo',
  'sql',
])

const oneLine = (text, max) => {
  const line = String(text ?? '').split('\n').find((l) => l.trim()) ?? ''
  const chars = [...line.trim()]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** Files named in an apply_patch patch, by what happens to them. */
function patchFiles(patch) {
  const out = { edit: [], create: [], remove: [] }
  for (const m of String(patch ?? '').matchAll(/^\*\*\* (Update File|Add File|Delete File|Move to): *(.+)$/gm)) {
    const path = m[2].trim()
    if (m[1] === 'Add File') out.create.push(path)
    else if (m[1] === 'Delete File') out.remove.push(path)
    else out.edit.push(path)
  }
  return out
}

/** Why a finished call failed, or '' when it did not. */
function failure(done) {
  if (!done) return ''
  if (done.success === false) return oneLine(done.error?.message ?? done.result?.content ?? 'エラー', 160) || 'エラー'
  const content = String(done.result?.content ?? '')
  // Only the CLI's own marker on the last line (`<exited with exit code 1>`,
  // `<shellId: 3 completed with exit code 1>`), not a program that printed "exit code".
  const exit = content.match(/<[^<>\n]*\bexit code (-?\d+)>\s*$/i)
  if (exit && exit[1] !== '0') {
    // The line before the exit marker is usually the error itself.
    const lines = content.trim().split('\n').filter((l) => l.trim())
    const reason = lines.length > 1 ? oneLine(lines[lines.length - 2], 160) : ''
    return `終了コード ${exit[1]}${reason ? `: ${reason}` : ''}`
  }
  return ''
}

const list = (paths, max) => {
  const unique = [...new Set(paths)]
  const shown = unique.slice(0, max).join(', ')
  return unique.length > max ? `${shown} ほか ${unique.length - max} 件` : shown
}

/**
 * One block of text for a run of tool calls, or '' when none of them says anything worth
 * passing on. `calls` are { name, args, done } in the order they started.
 */
export function describeTools(calls) {
  const edited = []
  const created = []
  const removed = []
  const commands = []
  const read = []
  const searched = []
  const other = []
  for (const { name, args, done } of calls) {
    if (!name || SKIP.has(name)) continue
    const a = args && typeof args === 'object' ? args : {}
    const failed = failure(done)
    if (SHELLS.has(name)) {
      if (a.command) commands.push(`\`${oneLine(a.command, 160)}\`${failed ? ` → 失敗(${failed})` : ''}`)
    } else if (name === 'apply_patch') {
      const files = patchFiles(typeof args === 'string' ? args : a.input ?? a.patch)
      edited.push(...files.edit)
      created.push(...files.create)
      removed.push(...files.remove)
      if (failed) other.push(`パッチの適用に失敗(${failed})`)
    } else if (name === 'edit' || name === 'str_replace' || name === 'str_replace_editor') {
      if (a.path) failed ? other.push(`${a.path} の編集に失敗(${failed})`) : edited.push(a.path)
    } else if (name === 'create' || name === 'write') {
      if (a.path) failed ? other.push(`${a.path} の作成に失敗(${failed})`) : created.push(a.path)
    } else if (READS.has(name)) {
      if (a.path) read.push(a.path)
    } else if (SEARCHES.has(name)) {
      if (a.pattern) searched.push(oneLine(a.pattern, 60))
    } else if (name === 'web_fetch') {
      if (a.url) read.push(oneLine(a.url, 120))
    } else if (name === 'task') {
      other.push(`サブエージェント: ${oneLine(a.description ?? a.prompt ?? '', 120)}`)
    } else if (name === 'ask_user') {
      if (a.question) other.push(`ユーザーに確認: ${oneLine(a.question, 160)}${done?.result?.content ? ` → ${oneLine(done.result.content, 120)}` : ''}`)
    } else if (name === 'task_complete') {
      if (a.summary) other.push(`完了の報告: ${oneLine(a.summary, 300)}`)
    } else {
      other.push(`ツール ${name}${failed ? ` → 失敗(${failed})` : ''}`)
    }
  }
  const lines = []
  if (edited.length) lines.push(`編集: ${list(edited, 12)}`)
  if (created.length) lines.push(`作成: ${list(created, 12)}`)
  if (removed.length) lines.push(`削除: ${list(removed, 12)}`)
  // Recent commands matter most: the last ones are kept when there are many.
  if (commands.length > 8) lines.push(`実行(${commands.length} 件、最後の 8 件): ${commands.slice(-8).join(' / ')}`)
  else if (commands.length) lines.push(`実行: ${commands.join(' / ')}`)
  // Repeated helpers (the same tool many times) are listed once with a count.
  const counted = new Map()
  for (const line of other) counted.set(line, (counted.get(line) ?? 0) + 1)
  for (const [line, n] of counted) lines.push(n > 1 ? `${line}(${n} 回)` : line)
  if (read.length) lines.push(`参照: ${list(read, 8)}`)
  if (searched.length) lines.push(`検索: ${list(searched, 5)}`)
  return lines.join('\n')
}
