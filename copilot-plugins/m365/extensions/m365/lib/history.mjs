// Turns the Copilot CLI session history into a compact text block that fits in one
// Microsoft 365 Copilot prompt. Everything here is plain string work: no model is called,
// so building the context costs no tokens.
//
// What goes in, newest first:
//   - the messages, the newer the longer;
//   - what GitHub Copilot did with its tools between them (lib/activity.mjs);
//   - older turns that share words with the question, kept longer than their age allows
//     (lib/relevance.mjs);
//   - for the part of the conversation the Copilot CLI has already compacted, the summary it
//     wrote then, in place of the messages it replaced (which is what the CLI model sees too).

import { describeTools } from './activity.mjs'
import { topMatches } from './relevance.mjs'

/** Timeline prefixes this extension writes. They are how its own exchanges are found again. */
export const ASK_PREFIX = '**/m365**'
export const RAW_ASK_PREFIX = '**/m365-raw**'
export const REPLY_PREFIX = '**M365 Copilot**'

const LABELS = {
  user: 'ユーザー → GitHub Copilot',
  assistant: 'GitHub Copilot',
  ask: 'ユーザー → あなた (M365 Copilot)',
  reply: 'あなた (M365 Copilot)',
  tool: 'GitHub Copilot の作業',
  summary: 'これより前の会話の要約 (GitHub Copilot CLI が自動で作ったもの)',
}

/** Roles of the Copilot CLI conversation, as opposed to earlier /m365 exchanges. */
const CONVERSATION = new Set(['user', 'assistant', 'tool'])

/**
 * Session events -> conversation turns, oldest first.
 * `user` / `assistant` are the Copilot CLI conversation and `tool` what GitHub Copilot did
 * between them; `ask` / `reply` are earlier /m365 exchanges, recovered from the timeline
 * entries this extension logged; `summary` is what the Copilot CLI wrote when it compacted the
 * conversation (the messages it replaced stay in the event log).
 */
export function extractTurns(events) {
  const turns = []
  // Tool calls since the last turn that was not the assistant's, reported as one turn after
  // the assistant's messages of that exchange. A sub-agent's own calls are left out.
  // The digest is written at the end, so that a call still running when a user message (or a
  // /m365 exchange) came in still reports how it ended. Its id is the id of the first call's
  // start event: it does not change when the calls end or more of them join, so a send made
  // while GitHub Copilot was still working is found again by the next one.
  let calls = []
  const pending = new Map()
  const flush = () => {
    if (calls.length) turns.push({ id: calls[0].id, role: 'tool', calls })
    calls = []
  }
  for (const event of events ?? []) {
    const data = event?.data ?? {}
    if (event?.type === 'tool.execution_start') {
      if (data.parentToolCallId) continue
      const call = { id: event.id, name: data.toolName, args: data.arguments, done: null }
      calls.push(call)
      if (data.toolCallId) pending.set(data.toolCallId, call)
      continue
    }
    if (event?.type === 'tool.execution_complete') {
      const call = pending.get(data.toolCallId)
      if (call) call.done = data
      pending.delete(data.toolCallId)
      continue
    }
    if (event?.type === 'session.compaction_complete') {
      if (data.success === false || typeof data.summaryContent !== 'string' || !data.summaryContent.trim()) continue
      flush()
      turns.push({ id: event.id, role: 'summary', text: data.summaryContent.trim() })
      continue
    }
    let role
    let text
    if (event?.type === 'user.message' && typeof data.content === 'string') {
      role = 'user'
      text = data.content
    } else if (event?.type === 'assistant.message' && typeof data.content === 'string') {
      role = 'assistant'
      text = data.content
    } else if (event?.type === 'session.info' && typeof data.message === 'string') {
      const ask = [ASK_PREFIX, RAW_ASK_PREFIX].find((p) => data.message.startsWith(`${p} `))
      if (ask) {
        role = 'ask'
        text = data.message.slice(ask.length)
      } else if (data.message.startsWith(REPLY_PREFIX)) {
        role = 'reply'
        text = data.message.slice(REPLY_PREFIX.length)
      }
    }
    if (!role || !text.trim()) continue
    if (role !== 'assistant') flush()
    turns.push({ id: event.id, role, text: text.trim() })
  }
  flush()
  const written = turns
    .map((turn) => (turn.role === 'tool' ? { id: turn.id, role: 'tool', text: describeTools(turn.calls) } : turn))
    .filter((turn) => turn.text)
  // A question that got no reply here (refused, failed, timed out) is left out: a later
  // summary must not tell Microsoft 365 Copilot that it was asked something it may never
  // have seen.
  return written.filter((turn, i, turns) => {
    if (turn.role !== 'ask') return true
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role === 'reply') return true
      if (turns[j].role === 'ask') return false
    }
    return false
  })
}

/** Long fenced code blocks keep their first lines; the rest becomes a one-line note. */
function shortenCode(text, keepLines) {
  return text.replace(/```[^\n]*\n([\s\S]*?)```/g, (block, code) => {
    const lines = code.replace(/\n$/, '').split('\n')
    if (lines.length <= keepLines + 2) return block
    const fence = block.slice(0, block.indexOf('\n') + 1)
    return `${fence}${lines.slice(0, keepLines).join('\n')}\n… (コード ${lines.length - keepLines} 行省略)\n\`\`\``
  })
}

/** Shrink one message to at most `cap` characters, keeping its start and its end. */
export function squeeze(text, cap, { firstLineOnly = false, codeLines = 8 } = {}) {
  let out = shortenCode(text, firstLineOnly ? 0 : codeLines)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (firstLineOnly) out = out.split('\n').find((line) => line.trim()) ?? ''
  const chars = [...out]
  if (chars.length <= cap) return out
  const head = Math.max(1, Math.floor(cap * 0.7))
  const tail = Math.max(0, cap - head - 3)
  return `${chars.slice(0, head).join('')} … ${tail ? chars.slice(-tail).join('') : ''}`.trim()
}

// The Copilot CLI writes its summary in tagged sections (<overview>, <history>, <work_done>,
// <technical_details>, <important_files>, <next_steps>, <checkpoint_title>). When it does not
// fit, each section gives up room by its weight: where things stand and what comes next are
// kept longest, the step-by-step history shortest.
const SECTION_WEIGHT = { overview: 3, next_steps: 3, work_done: 2, important_files: 2, technical_details: 1.5, history: 1 }
// A shortened section (or summary) smaller than this says too little to be worth its tags.
const MIN_PIECE = 20

/** The summary as tagged sections and the plain text between them, in order. */
function summaryParts(text) {
  const parts = []
  let at = 0
  const plain = (s) => {
    if (s.trim()) parts.push({ tag: null, body: s.trim() })
  }
  for (const m of text.matchAll(/<([a-z_]+)>\n?([\s\S]*?)\n?<\/\1>/g)) {
    plain(text.slice(at, m.index))
    parts.push({ tag: m[1], body: m[2].trim() })
    at = m.index + m[0].length
  }
  plain(text.slice(at))
  return parts
}

/** Shrink a Copilot CLI compaction summary to at most `cap` characters, or '' when it cannot say anything in that room. */
export function squeezeSummary(text, cap) {
  const clean = text.replace(/<checkpoint_title>[\s\S]*?<\/checkpoint_title>/g, '').trim()
  const length = (s) => [...s].length
  if (length(clean) <= cap) return clean
  if (cap < MIN_PIECE) return ''
  let parts = summaryParts(clean)
  if (!parts.some((p) => p.tag)) return squeeze(clean, cap, { codeLines: 4 })
  const weight = (p) => SECTION_WEIGHT[p.tag] ?? 1
  // Tags, and the newline that joins the parts.
  const frame = (p) => (p.tag ? length(`<${p.tag}>\n\n</${p.tag}>\n`) : 1)
  for (;;) {
    // Share out what is left after the tags, giving short parts all they need first.
    let room = cap - parts.reduce((sum, p) => sum + frame(p), 0)
    let weights = parts.reduce((sum, p) => sum + weight(p), 0)
    const caps = new Map()
    for (const p of [...parts].sort((a, b) => length(a.body) / weight(a) - length(b.body) / weight(b))) {
      const given = Math.min(length(p.body), Math.max(0, Math.floor((room * weight(p)) / weights)))
      caps.set(p, given)
      room -= given
      weights -= weight(p)
    }
    // A part cut below the minimum is dropped, and its room goes to the others: the one that
    // matters least goes first.
    const starved = parts.filter((p) => caps.get(p) < length(p.body) && caps.get(p) < MIN_PIECE)
    if (starved.length) {
      const drop = starved.reduce((a, b) => (weight(b) < weight(a) ? b : a))
      parts = parts.filter((p) => p !== drop)
      if (!parts.length) return ''
      continue
    }
    return parts
      .map((p) => {
        const body = caps.get(p) < length(p.body) ? squeeze(p.body, caps.get(p), { codeLines: 4 }) : p.body
        return p.tag ? `<${p.tag}>\n${body}\n</${p.tag}>` : body
      })
      .join('\n')
  }
}

// The newer a turn is, the more of it survives. Age 0 is the newest message. Measured on the
// Microsoft 365 Copilot app: a prompt of about 60,000 characters is accepted and answered, so
// the default budget (30,000) leaves room for attached files and instructions.
const TIERS = [
  { upTo: 6, cap: 4000, codeLines: 40 },
  { upTo: 16, cap: 1200, codeLines: 12 },
  { upTo: Infinity, cap: 300, codeLines: 0 },
]
// A digest of tool calls takes the tier of the messages around it, with its own sizes: it is
// a list of files and commands, and its first lines say the most.
const TOOL_CAPS = [1500, 400, 150]
// Older turns that share the most words with the question move up one tier.
const RELEVANT_LIMIT = 3
// The most of the budget a Copilot CLI summary may take when the recent turns need the rest.
const SUMMARY_SHARE = 0.4

function render(turn, tier) {
  const t = TIERS[tier]
  const text = turn.role === 'tool' ? squeeze(turn.text, TOOL_CAPS[tier], { codeLines: 0 }) : squeeze(turn.text, t.cap, t)
  return `- ${LABELS[turn.role]}: ${text}`
}

/**
 * Render turns (oldest first) into at most `budget` characters. Works backwards from the
 * newest turn so that what gets dropped is always the oldest part of the conversation. A
 * `summary` turn has room set aside for it, and gets whatever the other turns leave.
 * `question` picks the older turns to keep longer.
 */
export function buildContext(turns, budget, { question = '' } = {}) {
  const summaryAt = turns.findIndex((t) => t.role === 'summary')
  const summary = summaryAt === -1 ? null : turns[summaryAt]
  const summaryHead = summary ? `- ${LABELS.summary}:\n` : ''
  const rest = turns.map((turn, index) => ({ turn, index })).filter((x) => x.turn.role !== 'summary')
  const reserve = summary ? Math.min(summaryHead.length + [...summary.text].length, Math.floor(budget * SUMMARY_SHARE)) : 0

  // Age counts messages only; a tool digest shares the age of the messages around it.
  const ages = []
  for (let k = rest.length - 1, age = 0; k >= 0; k--) {
    ages[k] = age
    if (rest[k].turn.role !== 'tool') age++
  }
  const tierOf = (age) => TIERS.findIndex((t) => age < t.upTo)
  const older = rest.filter((_, k) => tierOf(ages[k]) > 0)
  const boosted = new Set(topMatches(older.map((x) => x.turn.text), question, RELEVANT_LIMIT).map((j) => older[j].index))

  const limit = budget - reserve
  const lines = []
  let used = 0
  for (let k = rest.length - 1; k >= 0; k--) {
    const { turn, index } = rest[k]
    const tier = tierOf(ages[k])
    // A boosted turn that does not fit at the higher tier still gets its usual size.
    const fits = (t) => {
      const l = render(turn, t)
      return used + l.length + 1 <= limit ? l : undefined
    }
    const line = (boosted.has(index) ? fits(tier - 1) : undefined) ?? fits(tier)
    if (line === undefined) break
    lines.push({ index, line })
    used += line.length + 1
  }

  // Notes on what was dropped. The kept turns are the newest ones, so everything dropped is
  // older than the oldest kept. With a summary in between, the drops on each side of it get
  // their own note, so that neither says the summary's side lost something it did not.
  const notes = (withSummary) => {
    const oldest = lines.at(-1)?.index
    if (oldest === undefined) return []
    const dropped = rest.filter((x) => x.index < oldest).length
    if (!dropped) return []
    if (!withSummary || summaryAt > oldest) return [{ index: oldest - 0.5, line: `- (これより前の ${dropped} 件は省略)` }]
    const before = rest.filter((x) => x.index < summaryAt).length
    const out = []
    if (before) out.push({ index: summaryAt - 0.5, line: `- (これより前の ${before} 件は省略)` })
    if (dropped > before) out.push({ index: oldest - 0.5, line: `- (要約のあとの ${dropped - before} 件は省略)` })
    return out
  }
  const size = (list) => list.reduce((sum, l) => sum + l.line.length + 1, 0)
  // The notes are part of the budget too: older turns give way to them.
  while (lines.length && used + size(notes(Boolean(summary))) > limit) used -= lines.pop().line.length + 1

  let summaryLine = null
  if (summary) {
    const text = squeezeSummary(summary.text, budget - used - size(notes(true)) - summaryHead.length - 1)
    if (text) summaryLine = { index: summaryAt, line: `${summaryHead}${text}` }
  }
  const kept = lines.length
  const omitted = rest.length - kept
  const all = [...lines, ...notes(Boolean(summaryLine)), ...(summaryLine ? [summaryLine] : [])].sort((a, b) => a.index - b.index)
  return { text: all.map((l) => l.line).join('\n'), kept: kept + (summaryLine ? 1 : 0), omitted, summarized: Boolean(summaryLine) }
}

/**
 * The turns a fresh chat should hear about: when the Copilot CLI compacted the conversation,
 * its latest summary stands in for the conversation before it. Earlier /m365 exchanges are
 * kept, since the CLI model never saw them and so its summary does not cover them.
 */
function sinceCompaction(turns) {
  const at = turns.findLastIndex((t) => t.role === 'summary')
  if (at === -1) return turns
  return turns.filter((t, i) => i === at || (i > at ? t.role !== 'summary' : t.role === 'ask' || t.role === 'reply'))
}

/**
 * Decide what to send.
 *
 *   full   everything so far, compressed. Used for a fresh M365 chat, which knows nothing.
 *   delta  only the Copilot CLI turns since the last send. The M365 chat already holds what
 *          was sent before and its own replies, so repeating them would only spend budget.
 *          A compaction since then changes nothing: the messages it summarised are still in
 *          the log, and only the new ones are sent.
 *   raw    the question alone.
 *
 * `lastSentId` is the id of the newest turn covered by the previous send. When it can no
 * longer be found (history was rewound) the plan falls back to `full`. `question` picks the
 * older turns that are kept longer.
 */
export function planContext(turns, { mode, lastSentId, budget, question = '' }) {
  if (mode === 'raw') return { mode, context: '', kept: 0, omitted: 0, summarized: false }
  let chosen = null
  let actual = 'full'
  if (mode === 'delta') {
    // No id means the previous send happened before the conversation had any turn.
    const at = lastSentId === undefined ? -1 : turns.findIndex((t) => t.id === lastSentId)
    if (at !== -1 || lastSentId === undefined) {
      chosen = turns.slice(at + 1).filter((t) => CONVERSATION.has(t.role))
      actual = 'delta'
    }
  }
  chosen ??= sinceCompaction(turns)
  const built = buildContext(chosen, budget, { question })
  return { mode: actual, context: built.text, kept: built.kept, omitted: built.omitted, summarized: built.summarized }
}

/**
 * The text that is pasted into Microsoft 365 Copilot. `sections` are extra blocks (fixed
 * instructions, attached files) placed between the conversation and the question.
 */
export function composePrompt(question, plan, sections = []) {
  const parts = []
  if (plan.context) {
    const heading =
      plan.mode === 'delta'
        ? '前回の質問のあとに、GitHub Copilot との間で進んだ会話の要約です。これまでの内容と合わせて踏まえてください。'
        : '別のアシスタント (GitHub Copilot) と進めてきた会話の要約です(古い順)。これを踏まえて、最後の質問に答えてください。'
    parts.push(`${heading}\n\n${plan.context}`)
  }
  parts.push(...sections.filter(Boolean))
  if (!parts.length) return question
  return `${parts.join('\n\n')}\n\n質問:\n${question}`
}
