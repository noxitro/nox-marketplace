import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createCommand } from '../shared/extensions/m365/lib/command.mjs'
import { createDriver } from '../shared/extensions/m365/lib/driver.mjs'
import { ASK_PREFIX, REPLY_PREFIX, buildContext, composePrompt, extractTurns, planContext, squeeze } from '../shared/extensions/m365/lib/history.mjs'
import { loadConfig, parseArgs } from '../shared/extensions/m365/lib/options.mjs'
import { createStabilityTracker, extractReply } from '../shared/extensions/m365/lib/reply.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const user = (id, content) => ({ id, type: 'user.message', data: { content } })
const assistant = (id, content) => ({ id, type: 'assistant.message', data: { content } })
const info = (id, message) => ({ id, type: 'session.info', data: { infoType: 'notification', message } })

test('extractTurns keeps the conversation and earlier /m365 exchanges, drops the rest', () => {
  const turns = extractTurns([
    user('1', 'ログの読み方を教えて'),
    assistant('2', ''),
    { id: '3', type: 'tool.execution_start', data: { toolName: 'view' } },
    assistant('4', 'こう読みます'),
    info('5', `${ASK_PREFIX} 別の見方は?`),
    info('6', `${REPLY_PREFIX}\n\nこういう見方もあります`),
    info('7', 'MCP Servers reloaded'),
  ])
  assert.deepEqual(
    turns.map((t) => [t.id, t.role, t.text]),
    [
      ['1', 'user', 'ログの読み方を教えて'],
      ['4', 'assistant', 'こう読みます'],
      ['5', 'ask', '別の見方は?'],
      ['6', 'reply', 'こういう見方もあります'],
    ]
  )
})

test('squeeze keeps head and tail within the cap and shortens long code blocks', () => {
  const long = 'あ'.repeat(500) + 'い'.repeat(500)
  const out = squeeze(long, 100)
  assert.ok([...out].length <= 100, `length ${[...out].length}`)
  assert.ok(out.startsWith('あ') && out.endsWith('い') && out.includes('…'))

  const code = '前置き\n```js\n' + Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n```\n後書き'
  const short = squeeze(code, 5000)
  assert.ok(short.includes('line7') && !short.includes('line8'))
  assert.ok(short.includes('コード 32 行省略') && short.includes('後書き'))
})

test('buildContext stays inside the budget and drops the oldest turns first', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: `発言${i} ` + 'x'.repeat(300) }))
  const built = buildContext(turns, 2000)
  assert.ok(built.text.length <= 2000 + 40, `length ${built.text.length}`)
  assert.ok(built.text.includes('発言29') && !built.text.includes('発言0 '))
  assert.equal(built.kept + built.omitted, 30)
  assert.ok(built.omitted > 0 && built.text.startsWith(`- (これより前の ${built.omitted} 件は省略)`))
})

test('planContext: full sends everything, delta only the new Copilot CLI turns', () => {
  const turns = extractTurns([
    user('1', '最初の質問'),
    assistant('2', '最初の答え'),
    info('3', `${ASK_PREFIX} M365 への質問`),
    info('4', `${REPLY_PREFIX}\n\nM365 の答え`),
    user('5', '次の質問'),
    assistant('6', '次の答え'),
  ])
  const full = planContext(turns, { mode: 'full', budget: 6000 })
  assert.equal(full.kept, 6)
  assert.ok(full.context.includes('M365 の答え'))

  const delta = planContext(turns, { mode: 'delta', lastSentId: '2', budget: 6000 })
  assert.equal(delta.mode, 'delta')
  assert.ok(delta.context.includes('次の質問') && delta.context.includes('次の答え'))
  assert.ok(!delta.context.includes('最初の') && !delta.context.includes('M365'))

  assert.equal(planContext(turns, { mode: 'delta', lastSentId: 'gone', budget: 6000 }).mode, 'full')
  assert.equal(planContext(turns, { mode: 'delta', lastSentId: '6', budget: 6000 }).context, '')
  assert.equal(composePrompt('質問だけ', planContext(turns, { mode: 'raw', budget: 6000 })), '質問だけ')
  assert.ok(composePrompt('最後の質問', full).endsWith('質問:\n最後の質問'))
})

test('extractReply returns what is new between two snapshots, without the echoed prompt', () => {
  const before = 'ナビ\n以前の質問\n以前の答え\n入力欄\nフッター'
  const prompt = '要約です\n\n- ユーザー: あれこれ\n\n質問:\n今日の予定は?'
  const echoed = 'ナビ\n以前の質問\n以前の答え\nあなた\n要約です\n- ユーザー: あれこれ\n質問:\n今日の予定は?\n入力欄\nフッター'
  assert.equal(extractReply(before, echoed, prompt), '')
  assert.equal(extractReply(before, echoed.replace('あなた\n', ''), prompt), '')
  const after = echoed.replace('今日の予定は?\n', '今日の予定は?\nCopilot\n会議が 2 件あります。\n\n- 10 時\n- 15 時\n')
  assert.equal(extractReply(before, after, prompt), 'Copilot\n会議が 2 件あります。\n- 10 時\n- 15 時')
})

test('the stability tracker waits for unchanged text and the end of generation', () => {
  const done = createStabilityTracker(3000)
  assert.equal(done('', false, 0), false)
  assert.equal(done('', false, 5000), false)
  assert.equal(done('こ', true, 6000), false)
  assert.equal(done('こたえ', true, 7000), false)
  assert.equal(done('こたえ', true, 11000), false)
  assert.equal(done('こたえ', false, 11500), true)
})

test('parseArgs separates leading options from the question', () => {
  assert.deepEqual(parseArgs('--new --dry  これは --raw ではない'), { flags: { new: true, dry: true }, question: 'これは --raw ではない' })
  assert.deepEqual(parseArgs('  ただの質問 '), { flags: {}, question: 'ただの質問' })
  assert.ok(parseArgs('--bogus x').error)
  assert.ok(parseArgs('--new --raw x').error)
  assert.equal(loadConfig({ M365_COPILOT_MAX_CHARS: 'abc' }).budget, 6000)
  assert.equal(loadConfig({ M365_COPILOT_MAX_CHARS: '900' }).budget, 900)
})

test('the driver refuses to run off Windows unless a replacement is given', async () => {
  await assert.rejects(createDriver({ driver: '', platform: 'linux' })({ action: 'snapshot' }), { code: 'unsupported_platform' })
})

test('the UI Automation script is ASCII-only', () => {
  const bytes = readFileSync(join(here, '..', 'shared', 'extensions', 'm365', 'm365-uia.ps1'))
  assert.equal(bytes.findIndex((b) => b > 0x7f), -1)
})

test('/m365 end to end against the fake window: full context first, then only the delta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm365-test-'))
  process.env.M365_FAKE_STATE = join(dir, 'window.json')
  try {
    const events = [user('1', 'テストの書き方を教えて'), assistant('2', 'node:test を使います')]
    const logs = []
    let seq = 100
    const session = {
      getEvents: async () => events,
      log: async (message, options = {}) => {
        logs.push({ message, ...options })
        if (!options.ephemeral) events.push(info(String(seq++), message))
      },
    }
    let now = 0
    const clock = { now: () => now, sleep: async (ms) => void (now += ms) }
    const config = { ...loadConfig({}), driver: join(here, 'fixtures', 'fake-driver.mjs') }
    const handler = createCommand({ session, call: createDriver({ driver: config.driver }), config, clock })
    const shown = () => logs.filter((l) => !l.ephemeral).map((l) => l.message)

    await handler({ args: '--dry 送らない質問' })
    assert.ok(shown().at(-1).includes('送らない質問') && shown().at(-1).includes('node:test を使います'))
    events.pop() // a dry run is not part of the conversation worth keeping in this test

    await handler({ args: 'モックはどうする?' })
    assert.equal(shown().at(-2), `${ASK_PREFIX} モックはどうする?`)
    assert.equal(
      shown().at(-1),
      `${REPLY_PREFIX}\n\nCopilot\n「モックはどうする?」への回答です。\n受け取った会話の要約は 2 件でした。\nこのチャットで 1 回目の質問です。`
    )

    events.push(user('3', 'では実装して'), assistant('4', '実装しました'))
    await handler({ args: 'レビューして' })
    assert.ok(shown().at(-1).includes('受け取った会話の要約は 2 件でした。'), shown().at(-1))
    assert.ok(shown().at(-1).includes('このチャットで 2 回目の質問です。'))

    await handler({ args: '--new 最初から' })
    assert.ok(shown().at(-1).includes('このチャットで 1 回目の質問です。'))
    assert.ok(shown().at(-1).includes('受け取った会話の要約は 8 件でした。'), shown().at(-1))

    await handler({ args: '' })
    assert.ok(shown().at(-1).includes('/m365 --new'))
    assert.ok(logs.every((l) => l.level !== 'error'), JSON.stringify(logs.filter((l) => l.level === 'error')))
  } finally {
    delete process.env.M365_FAKE_STATE
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractReply is not thrown off by a sender label that also occurs in the prompt', () => {
  const prompt = 'あなた (M365 Copilot) への要約です\n- 項目\n\n質問:\nこれは何?'
  const after = 'ナビ\nあなた\nあなた (M365 Copilot) への要約です\n- 項目\n質問:\nこれは何?\nCopilot\nあなた\n入力欄'
  assert.equal(extractReply('ナビ\n入力欄', after, prompt), 'Copilot\nあなた')
})
