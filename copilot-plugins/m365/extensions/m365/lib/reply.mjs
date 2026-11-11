// Finds the reply inside two text snapshots of the Microsoft 365 Copilot window: one taken
// before the prompt was sent and one after. The window text is whatever UI Automation
// exposes, so the reply is located by comparison, not by element names that change between
// versions and display languages.

const squash = (s) => s.replace(/\s+/g, '')

function toLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    // U+FFFC stands for embedded objects (icons, images) in UI Automation text.
    .map((line) => line.replace(/[\u200b\ufeff\ufffc]/g, '').trimEnd())
    .filter((line) => line.trim())
}

/**
 * Lines that are new in `after`: the common head (navigation, earlier messages) and the
 * common tail (input box, footer) are dropped, then the echo of the prompt itself.
 */
export function extractReply(before, after, prompt) {
  const a = toLines(before)
  const b = toLines(after)

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const fresh = b.slice(head, b.length - tail)

  // The chat shows the sent prompt before the answer, after whatever else changed (header
  // buttons, a sender label). The echo is the run of lines that repeats the prompt from its
  // first characters on, in the prompt's own order; the reply is what follows it. Matching
  // in order keeps a short answer line from being mistaken for a word used in the prompt.
  // The echo may stop short of the prompt's end (a long prompt is shown folded), but it has
  // to be there: without it, whatever changed (a sign-in page, a dialog) is no answer.
  const sent = squash(prompt ?? '')
  let skip = -1
  let most = 0
  for (let start = 0; start < fresh.length && sent; start++) {
    if (!sent.startsWith(squash(fresh[start]))) continue
    let at = 0
    let i = start
    for (; i < fresh.length; i++) {
      const line = squash(fresh[i])
      const found = sent.indexOf(line, at)
      if (found === -1) break
      at = found + line.length
    }
    if (at > most) {
      most = at
      skip = i
    }
  }
  if (skip === -1) return ''
  // While only the echo is on screen this is empty, which the caller reads as "not yet".
  return fresh.slice(skip).join('\n').trim()
}

/**
 * Tracks whether the reply has finished: it has, once it is non-empty, the window no longer
 * shows a stop button, and the text stayed the same for `stableMs`.
 */
export function createStabilityTracker(stableMs) {
  let last = null
  let since = 0
  return function done(reply, generating, now) {
    if (reply !== last) {
      last = reply
      since = now
      return false
    }
    return Boolean(reply) && !generating && now - since >= stableMs
  }
}

/** Text of one reply element, tidied the same way as the window text. */
export function cleanReply(text) {
  return toLines(text).join('\n').trim()
}

/**
 * The reply to the prompt just sent, from two snapshots.
 *
 * The driver reports the newest reply element of the chat and the ids of all the reply
 * elements it sees. When the newest one after the send is not among those seen before, its text
 * is the reply. The count alone cannot tell: a long chat keeps only its last few messages in the
 * tree, and the answer can be word for word the previous one. When the window has no element the
 * reply pattern matches, the reply is found by comparing the window text instead.
 *
 * The comparison is the weaker method: before the reply is on screen it finds labels and
 * buttons. The caller turns it off with `structured` (this window has shown reply elements,
 * so none now means "not yet") or `fallback: false` (too early after the send to tell).
 */
export function pickReply(before, after, prompt, { structured = false, fallback = true } = {}) {
  if (Number.isInteger(after?.replies) && after.replies > 0) {
    const seen = new Set(Array.isArray(before?.replyIds) ? before.replyIds : [before?.replyId].filter(Boolean))
    return after.replyId && !seen.has(after.replyId) ? cleanReply(after.reply) : ''
  }
  if (structured || !fallback) return ''
  return extractReply(before?.text, after?.text, prompt)
}
