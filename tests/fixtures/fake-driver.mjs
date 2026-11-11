// Stand-in for m365-uia.ps1: a pretend chat window kept in a JSON file, so /m365 can be run
// end to end where there is no Windows desktop. Point M365_COPILOT_DRIVER at this file.
//
// The default export takes a driver request and returns the result.
//
// State lives in M365_FAKE_STATE (default: m365-fake-window.json in the temp directory).
// The reply appears two snapshots after a send, in two steps, like a streamed answer.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEADER = ['Microsoft 365 Copilot', 'チャット']
const FOOTER = ['Copilot へのメッセージ', 'AI で生成されたコンテンツは誤りを含む可能性があります']

function answerTo(state, prompt) {
  const question = prompt.split('質問:\n').pop().trim()
  const context = prompt.includes('質問:\n') ? prompt.slice(0, prompt.lastIndexOf('質問:\n')) : ''
  return [`「${question}」への回答です。`, `受け取った会話の要約は ${context.split('\n').filter((l) => l.startsWith('- ')).length} 件でした。`, `このチャットで ${state.messages.filter((m) => m.role === 'user').length} 回目の質問です。`]
}

export default async function fakeDriver(request) {
  const stateFile = process.env.M365_FAKE_STATE || join(tmpdir(), 'm365-fake-window.json')
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { chats: 0, messages: [], pending: null }
  let result
  if (request.action === 'inspect') {
    result = { ok: true, window: HEADER[0], windows: [HEADER[0], 'Terminal'], elements: [{ type: 'Edit', name: FOOTER[0], enabled: true }, { type: 'Button', name: '送信', enabled: true }] }
  } else if (request.action === 'newchat') {
    state.chats++
    state.messages = []
    state.pending = null
    result = { ok: true, newChat: true }
  } else if (request.action === 'send') {
    state.messages.push({ role: 'user', text: request.prompt })
    state.pending = { lines: answerTo(state, request.prompt), shown: -1 }
    result = { ok: true, submit: 'button' }
  } else if (request.action === 'release') {
    result = { ok: true }
  } else if (request.action === 'snapshot') {
    let generating = false
    if (state.pending) {
      state.pending.shown++
      generating = state.pending.shown < state.pending.lines.length
      const partial = state.pending.lines.slice(0, Math.max(0, state.pending.shown))
      const last = state.messages[state.messages.length - 1]
      if (last.role === 'copilot') last.text = partial.join('\n')
      else if (partial.length) state.messages.push({ role: 'copilot', text: partial.join('\n') })
      if (!generating) state.pending = null
    }
    const body = state.messages.flatMap((m) => [m.role === 'user' ? 'あなた' : 'Copilot', m.text])
    result = { ok: true, window: HEADER[0], text: [...HEADER, ...body, ...FOOTER].join('\n'), generating }
  } else {
    result = { ok: false, error: 'unknown_action', message: `Unknown action: ${request.action}` }
  }
  writeFileSync(stateFile, JSON.stringify(state), 'utf8')
  return result
}
