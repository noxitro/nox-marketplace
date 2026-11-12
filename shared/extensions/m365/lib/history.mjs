// Turns the Copilot CLI session history into a compact text block that fits in one
// Microsoft 365 Copilot prompt. Everything here is plain string work: no model is called,
// so building the context costs no tokens.

/** Timeline prefixes this extension writes. They are how its own exchanges are found again. */
export const ASK_PREFIX = '**/m365**'
export const RAW_ASK_PREFIX = '**/m365-raw**'
export const REPLY_PREFIX = '**M365 Copilot**'

const LABELS = {
  user: 'ユーザー → GitHub Copilot',
  assistant: 'GitHub Copilot',
  ask: 'ユーザー → あなた (M365 Copilot)',
  reply: 'あなた (M365 Copilot)',
}

/**
 * Session events -> conversation turns, oldest first.
 * `user` / `assistant` are the Copilot CLI conversation; `ask` / `reply` are earlier /m365
 * exchanges, recovered from the timeline entries this extension logged.
 */
export function extractTurns(events) {
  const turns = []
  for (const event of events ?? []) {
    const data = event?.data ?? {}
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
    turns.push({ id: event.id, role, text: text.trim() })
  }
  // A question that got no reply here (refused, failed, timed out) is left out: a later
  // summary must not tell Microsoft 365 Copilot that it was asked something it may never
  // have seen.
  return turns.filter((turn, i) => {
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
export function squeeze(text, cap, { firstLineOnly = false } = {}) {
  let out = shortenCode(text, firstLineOnly ? 0 : 8)
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

// The newer a turn is, the more of it survives. Index 0 is the newest turn.
const TIERS = [
  { upTo: 4, cap: 1200 },
  { upTo: 10, cap: 400 },
  { upTo: Infinity, cap: 120, firstLineOnly: true },
]

/**
 * Render turns (oldest first) into at most `budget` characters. Works backwards from the
 * newest turn so that what gets dropped is always the oldest part of the conversation.
 */
export function buildContext(turns, budget) {
  const lines = []
  let used = 0
  let kept = 0
  for (let age = 0; age < turns.length; age++) {
    const turn = turns[turns.length - 1 - age]
    const tier = TIERS.find((t) => age < t.upTo)
    const line = `- ${LABELS[turn.role]}: ${squeeze(turn.text, tier.cap, tier)}`
    if (used + line.length + 1 > budget) break
    lines.unshift(line)
    used += line.length + 1
    kept++
  }
  const omitted = turns.length - kept
  if (omitted > 0 && kept > 0) lines.unshift(`- (これより前の ${omitted} 件は省略)`)
  return { text: lines.join('\n'), kept, omitted }
}

/**
 * Decide what to send.
 *
 *   full   everything so far, compressed. Used for a fresh M365 chat, which knows nothing.
 *   delta  only the Copilot CLI turns since the last send. The M365 chat already holds what
 *          was sent before and its own replies, so repeating them would only spend budget.
 *   raw    the question alone.
 *
 * `lastSentId` is the id of the newest turn covered by the previous send. When it can no
 * longer be found (history was rewound or compacted) the plan falls back to `full`.
 */
export function planContext(turns, { mode, lastSentId, budget }) {
  if (mode === 'raw') return { mode, context: '', kept: 0, omitted: 0 }
  let chosen = turns
  let actual = 'full'
  if (mode === 'delta') {
    // No id means the previous send happened before the conversation had any turn.
    const at = lastSentId === undefined ? -1 : turns.findIndex((t) => t.id === lastSentId)
    if (at !== -1 || lastSentId === undefined) {
      chosen = turns.slice(at + 1).filter((t) => t.role === 'user' || t.role === 'assistant')
      actual = 'delta'
    }
  }
  const built = buildContext(chosen, budget)
  return { mode: actual, context: built.text, kept: built.kept, omitted: built.omitted }
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
