// Finds the reply inside two text snapshots of the Microsoft 365 Copilot window: one taken
// before the prompt was sent and one after. The window text is whatever UI Automation
// exposes, so the reply is located by comparison, not by element names that change between
// versions and display languages.

const squash = (s) => s.replace(/\s+/g, '')

function toLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[​﻿]/g, '').trimEnd())
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

  // The chat shows the sent prompt before the answer, usually under a sender label. Skip
  // up to two label lines, then the lines that repeat the prompt in its own order. Matching
  // in order keeps a short answer line from being mistaken for a word used in the prompt.
  const sent = squash(prompt ?? '')
  const echoEnd = (start) => {
    let at = 0
    let i = start
    for (; i < fresh.length; i++) {
      const line = squash(fresh[i])
      const found = sent.indexOf(line, at)
      if (found === -1) break
      at = found + line.length
    }
    return i
  }
  let skip = 0
  let longest = 0
  for (let labels = 0; labels <= 2 && sent; labels++) {
    const end = echoEnd(labels)
    if (end - labels > longest) {
      longest = end - labels
      skip = end
    }
  }
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
