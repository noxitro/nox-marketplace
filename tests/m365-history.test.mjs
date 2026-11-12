// What /m365 tells Microsoft 365 Copilot about the conversation: tool digests, the Copilot CLI
// compaction summary, and older turns picked by the question. Event shapes follow the ones in
// Copilot CLI session logs.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeTools } from '../shared/extensions/m365/lib/activity.mjs'
import { createCommands } from '../shared/extensions/m365/lib/command.mjs'
import { ASK_PREFIX, REPLY_PREFIX, buildContext, extractTurns, planContext, squeezeSummary } from '../shared/extensions/m365/lib/history.mjs'
import { loadConfig } from '../shared/extensions/m365/lib/options.mjs'
import { topMatches, words } from '../shared/extensions/m365/lib/relevance.mjs'

const user = (id, content) => ({ id, type: 'user.message', data: { content } })
const assistant = (id, content) => ({ id, type: 'assistant.message', data: { content } })
const info = (id, message) => ({ id, type: 'session.info', data: { infoType: 'notification', message } })
const toolStart = (id, callId, toolName, args, extra = {}) => ({ id, type: 'tool.execution_start', data: { toolCallId: callId, toolName, arguments: args, ...extra } })
const toolDone = (id, callId, data) => ({ id, type: 'tool.execution_complete', data: { toolCallId: callId, success: true, ...data } })
const compaction = (id, summaryContent, data = {}) => ({ id, type: 'session.compaction_complete', data: { success: true, summaryContent, ...data } })

test('the tools used in an exchange become one digest after its messages', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.mjs\n@@\n-x\n+y\n*** Add File: src/b.mjs\n+new\n*** End Patch'
  const turns = extractTurns([
    user('1', 'テストを直して'),
    assistant('2', ''),
    toolStart('3', 'c1', 'report_intent', { intent: '調べる' }),
    toolStart('4', 'c2', 'view', { path: 'docs/c.md' }),
    toolDone('5', 'c2', { result: { content: '...' } }),
    toolStart('6', 'c3', 'apply_patch', patch),
    toolDone('7', 'c3', { result: { content: 'Done' } }),
    toolStart('8', 'c4', 'powershell', { command: 'npm test\n# second line', description: 'tests' }),
    toolDone('9', 'c4', { result: { content: 'running\nError: expected 2\n<exited with exit code 1>' } }),
    toolStart('10', 'c5', 'powershell', { command: 'git status' }),
    toolDone('11', 'c5', { result: { content: 'clean\n<shellId: 3 completed with exit code 0>' } }),
    toolStart('12', 'c6', 'edit', { path: 'sub.txt' }, { parentToolCallId: 'c9' }),
    toolStart('13', 'c7', 'edit', { path: 'src/c.mjs' }),
    toolDone('14', 'c7', { success: false, error: { code: 'x', message: 'old_str not found' } }),
    assistant('15', '直しました'),
    user('16', '次'),
  ])
  assert.deepEqual(
    turns.map((t) => [t.id, t.role]),
    [
      ['1', 'user'],
      ['15', 'assistant'],
      ['14', 'tool'],
      ['16', 'user'],
    ]
  )
  const digest = turns[2].text
  assert.ok(digest.includes('編集: src/a.mjs') && digest.includes('作成: src/b.mjs'), digest)
  assert.ok(digest.includes('`npm test` → 失敗(終了コード 1: Error: expected 2)') && digest.includes('`git status`'), digest)
  assert.ok(!digest.includes('second line') && !digest.includes('`git status` → 失敗'), digest)
  assert.ok(digest.includes('src/c.mjs の編集に失敗(old_str not found)'), digest)
  assert.ok(digest.includes('参照: docs/c.md'), digest)
  assert.ok(!digest.includes('sub.txt') && !digest.includes('調べる'), 'sub-agent calls and bookkeeping are left out')
  // Nothing worth passing on gives no turn at all.
  assert.equal(describeTools([{ name: 'report_intent', args: { intent: 'x' } }]), '')
})

test('a fresh chat gets the CLI summary in place of the conversation it replaced', () => {
  const summary = '<overview>\nm365 の改善\n</overview>\n<next_steps>\nテストを足す\n</next_steps>\n<checkpoint_title>題</checkpoint_title>'
  const turns = extractTurns([
    user('1', '圧縮前の質問'),
    assistant('2', '圧縮前の答え'),
    info('3', `${ASK_PREFIX} 圧縮前の M365 への質問`),
    info('4', `${REPLY_PREFIX}\n\n圧縮前の M365 の答え`),
    compaction('5', summary),
    compaction('5x', 'failed', { success: false }),
    user('6', '圧縮後の質問'),
    assistant('7', '圧縮後の答え'),
  ])
  const full = planContext(turns, { mode: 'full', budget: 30000 })
  assert.ok(full.summarized)
  assert.ok(full.context.includes('GitHub Copilot CLI が自動で作ったもの') && full.context.includes('<next_steps>\nテストを足す'), full.context)
  assert.ok(!full.context.includes('圧縮前の質問') && !full.context.includes('圧縮前の答え'), 'the summarised messages are not repeated')
  assert.ok(full.context.includes('圧縮前の M365 の答え'), 'earlier /m365 exchanges are not in the CLI summary, so they stay')
  assert.ok(!full.context.includes('checkpoint_title') && !full.context.includes('failed'))
  const order = ['圧縮前の M365 への質問', 'これより前の会話の要約', '圧縮後の質問', '圧縮後の答え'].map((s) => full.context.indexOf(s))
  assert.ok(order.every((at) => at >= 0))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'oldest first')

  // A chat that already has the earlier part gets only what is new, not the summary.
  const delta = planContext(turns, { mode: 'delta', lastSentId: '2', budget: 30000 })
  assert.equal(delta.mode, 'delta')
  assert.ok(!delta.summarized && delta.context.includes('圧縮後の質問') && !delta.context.includes('<overview>'), delta.context)
})

test('a long CLI summary shrinks by section, keeping where things stand and what comes next', () => {
  const body = (word) => Array.from({ length: 400 }, (_, i) => `${word}${i}`).join(' ')
  const summary = ['overview', 'history', 'work_done', 'technical_details', 'important_files', 'next_steps']
    .map((tag) => `<${tag}>\n${body(tag)}\n</${tag}>`)
    .concat('<checkpoint_title>title</checkpoint_title>')
    .join('\n')
  const out = squeezeSummary(summary, 6000)
  assert.ok([...out].length <= 6000, `length ${[...out].length}`)
  const section = (tag) => out.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? ''
  assert.ok(section('overview').length > section('history').length * 2, 'overview outweighs history')
  assert.ok(section('next_steps').includes('next_steps399'), 'each section keeps its end too')
  assert.ok(!out.includes('checkpoint_title'))
  assert.equal(squeezeSummary('<overview>\n短い\n</overview>', 6000), '<overview>\n短い\n</overview>')
  // Text without sections is shortened as a whole.
  assert.ok([...squeezeSummary('あ'.repeat(5000), 500)].length <= 500)
})

test('a summary that would not fit gets room set aside, and the newest turns still come through', () => {
  const huge = `<overview>\n${'要約'.repeat(20000)}\n</overview>\n<next_steps>\n${'次'.repeat(20000)}\n</next_steps>`
  const turns = [{ id: 's', role: 'summary', text: huge }].concat(
    Array.from({ length: 40 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: `発言${i} ${'x'.repeat(3000)}` }))
  )
  const built = buildContext(turns, 30000)
  assert.ok(built.text.length <= 30000, `length ${built.text.length}`)
  assert.ok(built.summarized && built.text.includes('発言39') && built.text.includes('<next_steps>'))
  const start = built.text.indexOf('これより前の会話の要約')
  const end = built.text.indexOf('件は省略')
  assert.ok(start >= 0 && start < end, 'the summary comes before the note on what was dropped')
  assert.ok(end - start >= 30000 * 0.4 - 100, `summary got ${end - start}`)
})

test('words: identifiers, path parts and Japanese pairs, without particles', () => {
  const w = words('lib/history.mjs の parseArgs を直す。会話の圧縮')
  for (const expected of ['lib/history.mjs', 'history', 'mjs', 'parseargs', '会話', '圧縮']) assert.ok(w.includes(expected), expected)
  assert.ok(!w.some((x) => /^[ぁ-ん]+$/.test(x)), `no hiragana-only pairs: ${w.join(' ')}`)
  assert.deepEqual(topMatches(['猫の話', 'parseArgs の不具合', '天気'], 'parseArgs を直して', 3), [1])
  assert.deepEqual(topMatches(['a', 'b'], '', 3), [])
})

test('an older turn the question is about is kept longer than its age allows', () => {
  const filler = 'ふつうの話題です。'.repeat(200)
  const turns = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    role: i % 2 ? 'assistant' : 'user',
    text: i === 3 ? `squeezeSummary の配分について。${'詳しい説明。'.repeat(300)}` : `発言${i} ${filler}`,
  }))
  const line = (built) => built.text.split('\n').find((l) => l.includes('squeezeSummary の配分')) ?? ''
  const plain = buildContext(turns, 200000)
  const asked = buildContext(turns, 200000, { question: 'squeezeSummary の配分を見直したい' })
  assert.ok([...line(plain)].length < 400, `without the question ${[...line(plain)].length}`)
  assert.ok([...line(asked)].length > 1100, `with the question ${[...line(asked)].length}`)
  // The newest turns are not cut to make room for it.
  assert.equal(asked.text.split('\n').at(-1), plain.text.split('\n').at(-1))
})

test('/m365-raw sends the CLI summary to a new chat, and the work done since to the same chat', async () => {
  const events = [user('1', '前提の話'), assistant('2', '前提への答え'), compaction('c', '<overview>\n要約された前提\n</overview>'), user('u', '圧縮後の依頼'), assistant('a', '対応します')]
  const sent = []
  const logs = []
  const call = async (request) => {
    if (request.action === 'send') sent.push(request.prompt)
    if (request.action === 'snapshot') return { ok: true, text: sent.map((p, i) => `${p}\n答え${i + 1}`).join('\n'), generating: false }
    return { ok: true, newChat: true }
  }
  let now = 0
  const session = {
    getEvents: async () => events,
    log: async (message, options = {}) => {
      logs.push({ message, ...options })
      if (!options.ephemeral) events.push(info(`L${logs.length}`, message))
    },
  }
  const { raw } = createCommands({ session, call, config: loadConfig({}), env: { COPILOT_HOME: '/nowhere-home' }, cwd: '/nowhere', clock: { now: () => now, sleep: async (ms) => void (now += ms) } })
  const shown = () => logs.filter((l) => !l.ephemeral).map((l) => l.message)

  await raw({ args: '--dry どう?' })
  assert.ok(shown().at(-1).includes('CLI の要約を使用'), shown().at(-1))
  events.pop() // the dry run is not part of the conversation
  await raw({ args: '最初の質問' })
  assert.ok(sent[0].includes('要約された前提') && sent[0].includes('圧縮後の依頼'), sent[0])
  assert.ok(!sent[0].includes('前提への答え'), 'the summarised messages are not sent')

  events.push(
    user('u2', 'テストを足して'),
    toolStart('t1', 'k1', 'create', { path: 'tests/new.test.mjs' }),
    toolDone('t2', 'k1', { result: { content: 'Created' } }),
    assistant('a2', '足しました')
  )
  await raw({ args: '次の質問' })
  assert.ok(sent[1].includes('GitHub Copilot の作業: 作成: tests/new.test.mjs'), sent[1])
  assert.ok(!sent[1].includes('要約された前提'), 'the chat already has the summary')
  assert.ok(logs.every((l) => l.level !== 'error'), JSON.stringify(logs.filter((l) => l.level === 'error')))
})
