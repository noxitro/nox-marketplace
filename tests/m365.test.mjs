import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { attachmentBlock, readAttachments } from '../shared/extensions/m365/lib/attachments.mjs'
import { createCommands, sessionDirs } from '../shared/extensions/m365/lib/command.mjs'
import { createDriver } from '../shared/extensions/m365/lib/driver.mjs'
import { ASK_PREFIX, RAW_ASK_PREFIX, REPLY_PREFIX, buildContext, composePrompt, extractTurns, planContext, squeeze } from '../shared/extensions/m365/lib/history.mjs'
import { OPTIONS, loadConfig, parseArgs } from '../shared/extensions/m365/lib/options.mjs'
import { configPaths, instructionBlock, loadProfiles, parseJsonReply } from '../shared/extensions/m365/lib/profiles.mjs'
import { cleanReply, createStabilityTracker, extractReply, pickReply } from '../shared/extensions/m365/lib/reply.mjs'

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
    info('5a', `${REPLY_PREFIX}

プロファイル付きの答え`),
    info('5r', `${RAW_ASK_PREFIX} 素の質問`),
    info('6', `${REPLY_PREFIX}\n\nこういう見方もあります`),
    info('7', 'MCP Servers reloaded'),
  ])
  assert.deepEqual(
    turns.map((t) => [t.id, t.role, t.text]),
    [
      ['1', 'user', 'ログの読み方を教えて'],
      ['4', 'assistant', 'こう読みます'],
      ['5', 'ask', '別の見方は?'],
      ['5a', 'reply', 'プロファイル付きの答え'],
      ['5r', 'ask', '素の質問'],
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

test('/m365-raw end to end against the fake window: full context first, then only the delta', async () => {
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
    const handler = createCommands({ session, call: createDriver({ driver: config.driver }), config, clock, env: {} }).raw
    const shown = () => logs.filter((l) => !l.ephemeral).map((l) => l.message)

    await handler({ args: '--dry 送らない質問' })
    assert.ok(shown().at(-1).includes('送らない質問') && shown().at(-1).includes('node:test を使います'))
    events.pop() // a dry run is not part of the conversation worth keeping in this test

    await handler({ args: 'モックはどうする?' })
    assert.equal(shown().at(-2), `${RAW_ASK_PREFIX} モックはどうする?`)
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
    assert.ok(shown().at(-1).includes('/m365-raw --new'))
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

test('a --raw send does not count as having delivered the conversation', async () => {
  const events = [user('1', '前提の話'), assistant('2', '前提への答え')]
  const prompts = []
  const call = async (request) => {
    for (const key of ['action', 'patterns', 'prompt', 'wait', 'keepVisible']) assert.ok(key in request, `request lacks ${key}`)
    if (request.action === 'send') prompts.push(request.prompt)
    if (request.action === 'snapshot') return { ok: true, text: prompts.length ? `${prompts.at(-1)}\n答え${prompts.length}` : '', generating: false }
    return { ok: true, newChat: true }
  }
  let now = 0
  const session = { getEvents: async () => events, log: async () => {} }
  const handler = createCommands({ session, call, config: loadConfig({}), env: {}, clock: { now: () => now, sleep: async (ms) => void (now += ms) } }).raw
  await handler({ args: '--raw 質問だけ' })
  await handler({ args: '続きの質問' })
  assert.equal(prompts[0], '質問だけ')
  assert.ok(prompts[1].includes('前提の話') && prompts[1].endsWith('続きの質問'), prompts[1])
})

test('one failed look at the window does not lose the reply; three in a row do', async () => {
  const run = async (failures) => {
    let sent = false
    let polls = 0
    const call = async (request) => {
      if (request.action === 'send') sent = true
      if (request.action === 'snapshot' && sent && polls++ < failures) throw new Error('element gone')
      if (request.action === 'snapshot') return { ok: true, text: sent ? 'q\nこたえ' : '', generating: false }
      return { ok: true, newChat: true }
    }
    const logs = []
    let now = 0
    const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
    await createCommands({ session, call, config: loadConfig({}), env: {}, clock: { now: () => now, sleep: async (ms) => void (now += ms) } }).raw({ args: '--raw q' })
    return logs.filter((l) => !l.ephemeral).at(-1)
  }
  assert.equal((await run(2)).message, `${REPLY_PREFIX}\n\nこたえ`)
  assert.equal((await run(3)).level, 'error')
})

test('the default window pattern picks the desktop app, not GitHub Copilot or a browser tab', () => {
  const window = new RegExp(loadConfig({}).patterns.window)
  for (const title of ['Copilot', 'Microsoft 365 Copilot', 'M365 Copilot']) assert.ok(window.test(title), title)
  for (const title of ['GitHub Copilot', 'Copilot - Google Chrome', 'Microsoft 365 Copilot - Microsoft Edge', 'C:\\Windows\\system32\\cmd.exe']) {
    assert.ok(!window.test(title), title)
  }
})

test('pickReply reads the newest reply element and ignores the one that was already there', () => {
  const before = { text: 'ナビ\n入力欄', replies: 1, replyId: 'copilot-message-_r_1_', reply: '前の答え' }
  // Only the prompt is on screen yet.
  assert.equal(pickReply(before, { ...before, text: 'ナビ\nYou said:\n質問\n入力欄' }, '質問'), '')
  // A new reply element: its own text, without the buttons and labels around it.
  const after = { text: 'ナビ\nYou said:\n質問\nCopilot said:\n赤\n応答のコピー\n\ufffc\n入力欄', replies: 2, replyId: 'copilot-message-_r_2_', reply: '赤\n\ufffc\n' }
  assert.equal(pickReply(before, after, '質問'), '赤')
  // Older messages dropped out of a long chat: the count stays, the newest element changes.
  assert.equal(pickReply(before, { ...after, replies: 1 }, '質問'), '赤')
  // The same element re-read is not a new reply.
  assert.equal(pickReply(before, { ...before }, '質問'), '')
  // Seen on the real app: the chat shows its last three replies, and the same question asked
  // again gets the same answer. Neither the count nor the text changes; the new id does.
  const three = { replies: 3, replyIds: ['a', 'b', 'c'], replyId: 'c', reply: 'ZEBRA-42' }
  assert.equal(pickReply(three, { replies: 3, replyIds: ['b', 'c', 'd'], replyId: 'd', reply: 'ZEBRA-42' }, '質問'), 'ZEBRA-42')
  assert.equal(pickReply(three, { ...three }, '質問'), '')
  // No element matches the reply pattern: compare the window text instead.
  assert.equal(pickReply({ text: 'ナビ\n入力欄' }, { text: 'ナビ\n質問\n答え\n\ufffc\n入力欄', replies: 0 }, '質問'), '答え')
})

test('cleanReply drops object placeholders and blank lines', () => {
  assert.equal(cleanReply('\ufffc\n春\n\n夏\u200b\n\ufffc'), '春\n夏')
})

test('/m365-raw shows only the reply element when the window exposes one', async () => {
  // Shapes taken from the Microsoft 365 Copilot desktop app: the window text carries the
  // header buttons, the echoed prompt, the reply toolbar and suggestions around the answer.
  let sent = false
  let polls = 0
  const call = async (request) => {
    if (request.action === 'newchat') return { ok: true, newChat: true }
    if (request.action === 'send') {
      sent = true
      return { ok: true, submit: 'button' }
    }
    if (!sent) return { ok: true, text: '新しいチャット\nこんにちは\nCopilot にメッセージを送信する', generating: false, replies: 0, replyId: '', reply: '' }
    polls++
    const reply = polls < 2 ? '' : '赤色'
    return {
      ok: true,
      text: `新しいチャット\nチャットを共有する\n\ufffc\nYou said:\nMore actions\n${request.prompt}\nCopilot said:\n${reply}\n応答のコピー\n気に入った点がある\nCopilot にメッセージを送信する\nCopilot is an AI and may make mistakes.`,
      generating: polls < 3,
      replies: polls < 2 ? 0 : 1,
      replyId: polls < 2 ? '' : 'copilot-message-_r_128_',
      reply,
    }
  }
  const logs = []
  let now = 0
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  await createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: 'りんごの色は?' })
  assert.equal(logs.filter((l) => !l.ephemeral).at(-1).message, `${REPLY_PREFIX}\n\n赤色`)
})

test('a reply still being generated at the time limit is reported as such', async () => {
  let sent = false
  const call = async (request) => {
    if (request.action === 'send') sent = true
    if (request.action === 'snapshot') return { ok: true, text: '', generating: sent, replies: 1, replyId: 'copilot-message-_r_1_', reply: '￼' }
    return { ok: true, newChat: true }
  }
  const logs = []
  let now = 0
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  const config = { ...loadConfig({ M365_COPILOT_TIMEOUT_SEC: '10' }) }
  await createCommands({ session, call, config, clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: '--raw q' })
  const last = logs.filter((l) => !l.ephemeral).at(-1)
  assert.equal(last.level, 'error')
  assert.ok(last.message.startsWith('10 秒待っても'), last.message)
})

test('a new reply element that holds only a placeholder is not a reply yet', () => {
  const before = { text: '', replies: 0, replyIds: [], replyId: '', reply: '' }
  assert.equal(pickReply(before, { text: 'x', replies: 1, replyIds: ['n'], replyId: 'n', reply: '￼' }, 'q'), '')
})

test('once reply elements were seen, the text comparison is not used', () => {
  const before = { text: 'ナビ\n入力欄', replies: 0 }
  const after = { text: 'ナビ\nYou said:\nq\nMore actions\n入力欄', replies: 0 }
  // Without the flag, the comparison takes the leftover label for a reply.
  assert.equal(pickReply(before, after, 'q'), 'More actions')
  assert.equal(pickReply(before, after, 'q', { structured: true }), '')
})

test('the process pattern is off unless set', () => {
  assert.equal(loadConfig({}).patterns.process, '')
  assert.equal(loadConfig({ M365_COPILOT_PROCESS: '^copilotapp$' }).patterns.process, '^copilotapp$')
})

test('the text comparison finds nothing when the prompt never showed up', () => {
  // Seen on the real app: the session expired and a sign-in page replaced the chat.
  const before = 'ナビ\nこんにちは\n入力欄'
  const after = 'ナビ\nこんにちは\n入力欄\nサインイン\nメール、電話、Skype を入力します。\n次へ'
  assert.equal(extractReply(before, after, 'りんごの色は?'), '')
})

test('after a send the window is released, also when reading the reply fails', async () => {
  for (const failing of [false, true]) {
    const actions = []
    let sent = false
    const call = async (request) => {
      actions.push(request.action)
      if (request.action === 'send') sent = true
      if (request.action === 'snapshot' && sent && failing) throw new Error('gone')
      if (request.action === 'snapshot') return { ok: true, text: sent ? 'q\nこたえ' : '', generating: false }
      return { ok: true, newChat: true }
    }
    let now = 0
    const session = { getEvents: async () => [], log: async () => {} }
    await createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: '--raw q' })
    assert.equal(actions.at(-1), 'release', `${failing}: ${actions.join(',')}`)
  }
  assert.equal(loadConfig({ M365_COPILOT_KEEP_VISIBLE: '0' }).keepVisible, false)
})

test('a failed send also releases the window', async () => {
  const actions = []
  const call = async (request) => {
    actions.push(request.action)
    if (request.action === 'send') throw new Error('focus_failed')
    return { ok: true, newChat: true, text: '' }
  }
  const logs = []
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  await createCommands({ session, call, config: loadConfig({}), clock: { now: () => 0, sleep: async () => {} }, env: {} }).raw({ args: '--raw q' })
  assert.equal(actions.at(-1), 'release', actions.join(','))
  assert.equal(logs.at(-1).level, 'error')
})

test('with M365_COPILOT_KEEP_VISIBLE=0 the window is never released', async () => {
  const actions = []
  const call = async (request) => {
    actions.push(`${request.action}:${request.keepVisible}:${request.release}`)
    if (request.action === 'snapshot') return { ok: true, text: 'q\nこたえ', generating: false }
    return { ok: true, newChat: true }
  }
  let now = 0
  const session = { getEvents: async () => [], log: async () => {} }
  await createCommands({ session, call, config: loadConfig({ M365_COPILOT_KEEP_VISIBLE: '0' }), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: '--raw q' })
  assert.ok(!actions.some((a) => a.startsWith('release')), actions.join(','))
  assert.ok(actions.every((a) => a.split(':')[1] === 'false'), actions.join(','))
  // A window left on top by an earlier run is still put back, whatever the setting is now.
  assert.equal(actions.find((a) => a.startsWith('snapshot')), 'snapshot:false:true')
})

test('the snapshot before a send asks to undo a "keep on top" left behind', async () => {
  const requests = []
  const call = async (request) => {
    requests.push(request)
    if (request.action === 'snapshot') return { ok: true, text: 'q\nこたえ', generating: false }
    return { ok: true, newChat: true }
  }
  let now = 0
  const session = { getEvents: async () => [], log: async () => {} }
  await createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: '--raw q' })
  const snapshots = requests.filter((r) => r.action === 'snapshot')
  assert.equal(snapshots[0].release, true)
  assert.ok(snapshots.slice(1).every((r) => r.release === false))
})

test('driver errors such as a dialog in the app reach the timeline as they are', async () => {
  const call = async (request) => {
    if (request.action === 'send') throw Object.assign(new Error('A dialog is open in the Microsoft 365 Copilot window (広告の設定). Answer it in the app, then try again. Nothing was sent.'), { code: 'dialog_open' })
    return { ok: true, newChat: true, text: '' }
  }
  const logs = []
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  await createCommands({ session, call, config: loadConfig({}), clock: { now: () => 0, sleep: async () => {} }, env: {} }).raw({ args: '--raw q' })
  assert.ok(logs.at(-1).message.includes('広告の設定') && logs.at(-1).level === 'error', logs.at(-1).message)
})

test('extractReply finds the echo after the lines that changed above it (shape of the real app)', () => {
  const before = 'ナビ\nAuto\n一時的なチャット\n設定など\nこんにちは、何かお手伝いできることはありますか?\nCopilot にメッセージを送信する\n探す'
  const after =
    'ナビ\nAuto\nチャットを共有する\n設定など\nYou said:\nMore actions\nりんごの色は?\nCopilot said:\n赤色\n応答のコピー\nCopilot にメッセージを送信する\nCopilot is an AI and may make mistakes.'
  assert.equal(extractReply(before, after, 'りんごの色は?'), 'Copilot said:\n赤色\n応答のコピー\nCopilot にメッセージを送信する\nCopilot is an AI and may make mistakes.')
  // A long prompt shown folded: the echo stops short of the prompt's end.
  const long = '要約です\n- 一行目\n- 二行目\n\n質問:\nこれは何?'
  assert.equal(extractReply('ナビ\n入力欄', 'ナビ\nYou said:\n要約です\n- 一行目\nSee more\nCopilot said:\n答え\n入力欄', long), 'See more\nCopilot said:\n答え')
})

test('right after a send the window text is not taken for a reply', async () => {
  // First send of a session: no reply element yet, no stop button yet, and the echoed prompt
  // is followed by a button label. Then the reply element appears.
  let sent = false
  let polls = 0
  const call = async (request) => {
    if (request.action === 'send') sent = true
    if (request.action !== 'snapshot') return { ok: true, newChat: true }
    if (!sent) return { ok: true, text: 'ナビ\n入力欄', generating: false, replies: 0, replyIds: [], replyId: '', reply: '' }
    polls++
    if (polls < 5) return { ok: true, text: 'ナビ\nYou said:\nq\nMore actions\n入力欄', generating: false, replies: 0, replyIds: [], replyId: '', reply: '' }
    return { ok: true, text: 'ナビ\nYou said:\nq\nMore actions\nCopilot said:\n赤\n入力欄', generating: false, replies: 1, replyIds: ['n'], replyId: 'n', reply: '赤' }
  }
  const logs = []
  let now = 0
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  await createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: '--raw q' })
  assert.equal(logs.filter((l) => !l.ephemeral).at(-1).message, `${REPLY_PREFIX}\n\n赤`)
  assert.equal(pickReply({ text: 'a' }, { text: 'a\nq\nb', replies: 0 }, 'q', { fallback: false }), '')
})

test('nothing is sent while the chat is still generating the previous reply', async () => {
  const actions = []
  const call = async (request) => {
    actions.push(request.action)
    if (request.action === 'snapshot') return { ok: true, text: '', generating: true, replies: 1, replyIds: ['a'], replyId: 'a', reply: '' }
    return { ok: true, newChat: true }
  }
  const logs = []
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  await createCommands({ session, call, config: loadConfig({}), clock: { now: () => 0, sleep: async () => {} }, env: {} }).raw({ args: '--raw q' })
  assert.ok(!actions.includes('send'), actions.join(','))
  assert.ok(logs.at(-1).level === 'error' && logs.at(-1).message.includes('生成しています'), logs.at(-1).message)
})

test('a window minimised while waiting ends the wait and is not restored', async () => {
  const requests = []
  let sent = false
  const call = async (request) => {
    requests.push(request)
    if (request.action === 'send') sent = true
    if (request.action === 'snapshot') return sent ? { ok: true, minimized: true, text: '', generating: false, replies: 0 } : { ok: true, text: '', generating: false, replies: 0 }
    return { ok: true, newChat: true }
  }
  const logs = []
  let now = 0
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  await createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: '--raw q' })
  const snapshots = requests.filter((r) => r.action === 'snapshot')
  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map((r) => r.restore), [true, false])
  assert.ok(logs.at(-1).level === 'error' && logs.at(-1).message.includes('最小化'), logs.at(-1).message)
  assert.equal(requests.at(-1).action, 'release')
})

test('every step of a command is sent to the window the first step chose', async () => {
  const targets = []
  let hwnd = 111
  const call = async (request) => {
    targets.push(`${request.action}:${request.target}`)
    if (request.action === 'snapshot') return { ok: true, hwnd, text: 'q\nこたえ', generating: false }
    return { ok: true, hwnd, newChat: true }
  }
  let now = 0
  const session = { getEvents: async () => [], log: async () => {} }
  const handler = createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw
  await handler({ args: 'q' })
  assert.equal(targets[0], 'newchat:0')
  assert.ok(targets.slice(1).every((t) => t.endsWith(':111')), targets.join(','))
  // The next command chooses again.
  hwnd = 222
  targets.length = 0
  await handler({ args: 'q2' })
  assert.equal(targets[0], 'snapshot:0')
  assert.ok(targets.slice(1).every((t) => t.endsWith(':222')), targets.join(','))
})

test('the app id pattern has a default and can be replaced', () => {
  assert.ok(new RegExp(loadConfig({}).patterns.app).test('m365-chat-editor-target-element'))
  assert.equal(loadConfig({ M365_COPILOT_APP_ID: '.' }).patterns.app, '.')
})

test('extractReply does not hand back the rest of the prompt when the chat shows a line differently', () => {
  // The chat renders markup, so one echoed line does not match what was sent.
  const prompt = '要約です\n- **重要** な点\n- 次の点\n\n質問:\nこれは何?'
  const after = 'ナビ\nYou said:\n要約です\n重要 な点\n次の点\n質問:\nこれは何?\nCopilot said:\n答え\n入力欄'
  assert.equal(extractReply('ナビ\n入力欄', after, prompt), 'Copilot said:\n答え')
})

test('a foreground that opening the new chat could not give back is handed to the send, or reported', async () => {
  const run = async ({ previous, sendRestores }) => {
    const requests = []
    let sent = false
    const call = async (request) => {
      requests.push(request)
      if (request.action === 'newchat') return { ok: true, newChat: true, focusRestored: false, previous }
      if (request.action === 'send') {
        sent = true
        return { ok: true, focusRestored: sendRestores }
      }
      if (request.action === 'snapshot') return { ok: true, text: sent ? 'q\nこたえ' : '', generating: false }
      return { ok: true }
    }
    const logs = []
    let now = 0
    const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
    await createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw({ args: 'q' })
    return { restoreTo: requests.find((r) => r.action === 'send').restoreTo, last: logs.filter((l) => !l.ephemeral).at(-1).message }
  }
  // The send is told where to go back to, and does: no note.
  const handed = await run({ previous: 4242, sendRestores: true })
  assert.equal(handed.restoreTo, 4242)
  assert.ok(!handed.last.includes('前面'), handed.last)
  // The send could not either, or was not told where to: the user is told.
  assert.ok((await run({ previous: 4242, sendRestores: false })).last.includes('前面に残っています'))
  assert.ok((await run({ previous: undefined, sendRestores: true })).last.includes('前面に残っています'))
})

test('what one window showed does not decide how another is read', async () => {
  // First window has reply elements; the second (another version) has none.
  let hwnd = 1
  let sent = false
  const call = async (request) => {
    if (request.action === 'send') sent = true
    if (request.action !== 'snapshot') return { ok: true, hwnd, newChat: true }
    if (hwnd === 1) return sent ? { ok: true, hwnd, text: '', generating: false, replies: 1, replyIds: ['n'], replyId: 'n', reply: '一つ目' } : { ok: true, hwnd, text: '', generating: false, replies: 0, replyIds: [] }
    return { ok: true, hwnd, text: sent ? 'q\n二つ目' : '', generating: false, replies: 0, replyIds: [] }
  }
  const logs = []
  let now = 0
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  const handler = createCommands({ session, call, config: loadConfig({}), clock: { now: () => now, sleep: async (ms) => void (now += ms) }, env: {} }).raw
  await handler({ args: '--raw q' })
  assert.equal(logs.filter((l) => !l.ephemeral).at(-1).message, `${REPLY_PREFIX}\n\n一つ目`)
  hwnd = 2
  sent = false
  // The first send to another window is refused (it was written as a continuation); the
  // next one starts a new chat there.
  await handler({ args: '--raw q' })
  assert.ok(logs.at(-1).message.includes('別のものに替わっています'), logs.at(-1).message)
  await handler({ args: '--raw q' })
  assert.equal(logs.filter((l) => !l.ephemeral).at(-1).message, `${REPLY_PREFIX}\n\n二つ目`)
})

test('--inspect reports the checks a send would make', async () => {
  const logs = []
  const session = { getEvents: async () => [], log: async (message, options) => void logs.push({ message, ...options }) }
  const show = async (result) => {
    await createCommands({ session, call: async () => ({ ok: true, windows: [], elements: [], ...result }), config: loadConfig({}), env: {} }).raw({ args: '--inspect' })
    return logs.at(-1).message
  }
  const plain = await show({ window: 'Copilot', replies: 2, signature: true, dialog: '', candidates: ['Copilot (a)'] })
  assert.ok(plain.includes('2 件') && plain.includes('あり') && !plain.includes('複数'), plain)
  const two = await show({ window: 'Copilot', replies: 0, signature: false, dialog: '', candidates: ['Copilot (a)', 'Copilot (b)'] })
  assert.ok(two.includes('なし') && two.includes('Copilot (a)、Copilot (b)'), two)
  // With a dialog open the page behind it cannot be judged, so only the dialog is reported.
  const dialog = await show({ window: 'Copilot', replies: 0, signature: false, dialog: '同意の確認', candidates: ['Copilot (a)'] })
  assert.ok(dialog.includes('同意の確認') && !dialog.includes('目印'), dialog)
})

test('M365_COPILOT_APP_ID=off turns the app check off', () => {
  assert.equal(loadConfig({ M365_COPILOT_APP_ID: 'off' }).patterns.app, '')
})

// ---------------------------------------------------------------- /m365 (profiles, files)

const PROFILES = {
  defaultProfile: 'plain',
  profiles: {
    plain: { instructions: '日本語で簡潔に答える' },
    review: {
      description: 'レビュー',
      instructions: ['指摘を重大度順に並べる', '根拠の行を示す'],
      response: { format: 'json', schema: { summary: '一行の要約', findings: ['指摘'] } },
      context: { mode: 'full', maxChars: 3000 },
    },
  },
}

test('loadProfiles merges files in order and rejects a broken one as a whole', () => {
  const files = {
    user: JSON.stringify({ defaultProfile: 'a', profiles: { a: { instructions: 'A' }, b: { instructions: 'B1' } } }),
    project: JSON.stringify({ profiles: { b: { instructions: 'B2', newChat: true } } }),
    broken: JSON.stringify({ profiles: { c: { instructions: 1, extra: true, response: { format: 'xml' } } } }),
  }
  const ok = loadProfiles(['user', 'project', 'missing'], (p) => files[p] ?? null)
  assert.deepEqual(Object.keys(ok.profiles), ['a', 'b'])
  assert.equal(ok.profiles.b.instructions, 'B2')
  assert.equal(ok.defaultProfile, 'a')
  assert.deepEqual(ok.sources, ['user', 'project'])
  assert.deepEqual(ok.problems, [])

  const bad = loadProfiles(['user', 'broken'], (p) => files[p])
  assert.equal(bad.profiles.c, undefined)
  assert.equal(bad.problems.length, 3, bad.problems.join('\n'))
  assert.match(loadProfiles(['x'], () => '{oops').problems[0], /JSON として読めません/)

  // The repository's file comes first, so the user's own file wins on a name clash.
  assert.deepEqual(
    configPaths({ env: { COPILOT_HOME: '/h', M365_COPILOT_CONFIG: '/x.json' }, root: '/r' }).map((p) => p.path),
    [join('/r', '.github', 'm365.json'), join('/h', 'm365.json'), '/x.json']
  )
  assert.match(loadProfiles([{ path: '/x.json', required: true }], () => null).problems[0], /ありません/)
  assert.equal(loadProfiles(['user'], (p) => files[p]).profiles.toString, undefined)
})

test('instructionBlock gives the full instructions once and a reminder after', () => {
  const p = PROFILES.profiles.review
  const full = instructionBlock('review', p, { full: true })
  assert.ok(full.includes('指摘を重大度順に並べる') && full.includes('根拠の行を示す') && full.includes('"findings"'))
  const again = instructionBlock('review', p, { full: false })
  assert.ok(again.includes('review') && again.includes('JSON') && !again.includes('根拠の行'))
  assert.equal(instructionBlock(undefined, undefined, { full: true }), '')
})

test('parseJsonReply finds the JSON in fenced, labelled and bare replies', () => {
  const schema = { summary: '', findings: [] }
  assert.deepEqual(parseJsonReply('```json\n{"summary":"s","findings":[]}\n```', schema), { value: { summary: 's', findings: [] }, missing: [] })
  assert.deepEqual(parseJsonReply('Copilot\njson\n{"summary":"s"}\nコピー', schema).missing, ['findings'])
  assert.deepEqual(parseJsonReply('はい。{"summary":"x","findings":["a"]} 以上です', schema).value.findings, ['a'])
  assert.equal(parseJsonReply('JSON ではない返答', schema), null)
})

test('readAttachments embeds text files and refuses binaries, missing files and oversize', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm365-files-'))
  try {
    writeFileSync(join(dir, 'a.md'), '\ufeff一行目\r\n二行目\r\n')
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01]))
    writeFileSync(join(dir, 'c.txt'), Buffer.from([0xff, 0xfe, 0x41]))
    const ok = readAttachments(['a.md'], { base: dir, maxChars: 100 })
    assert.deepEqual(ok, { files: [{ path: 'a.md', text: '一行目\n二行目', lines: 2 }], problems: [] })
    assert.ok(attachmentBlock(ok.files).includes('----- a.md(2 行)-----\n一行目\n二行目\n----- a.md ここまで -----'))
    const bad = readAttachments(['b.bin', 'c.txt', 'nope.md'], { base: dir, maxChars: 100 })
    assert.equal(bad.problems.length, 3, bad.problems.join('\n'))
    assert.match(readAttachments(['a.md'], { base: dir, maxChars: 3 }).problems[0], /上限/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionDirs takes the newest working directory the session reported', () => {
  const events = [
    { type: 'session.start', data: { context: { cwd: '/a', gitRoot: '/a' } } },
    { type: 'session.context_changed', data: { cwd: '/b/sub', gitRoot: '/b' } },
    user('1', 'x'),
  ]
  assert.deepEqual(sessionDirs(events, '/fallback'), { cwd: '/b/sub', root: '/b' })
  assert.deepEqual(sessionDirs([], '/fallback'), { cwd: '/fallback', root: '/fallback' })
})

test('parseArgs takes values for --profile and --file', () => {
  assert.deepEqual(parseArgs('--profile review --file "a b.md" --file c.txt 質問', OPTIONS), {
    flags: { profile: 'review', file: ['a b.md', 'c.txt'] },
    question: '質問',
  })
  assert.ok(parseArgs('--file --dry q', OPTIONS).error)
  assert.ok(parseArgs('--profile x', { new: true }).error)
})

/** A project with m365.json and files, a session that reports it, and a scripted window. */
function setup({ config = PROFILES, replies = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm365-project-'))
  mkdirSync(join(dir, '.github'))
  if (config) writeFileSync(join(dir, '.github', 'm365.json'), typeof config === 'string' ? config : JSON.stringify(config))
  writeFileSync(join(dir, 'notes.md'), '# メモ\n手順は 3 つ')
  const events = [{ id: 's', type: 'session.start', data: { context: { cwd: dir, gitRoot: dir } } }, user('1', '前提の話'), assistant('2', '前提への答え')]
  const sent = []
  const actions = []
  const logs = []
  const call = async (request) => {
    actions.push(request.action)
    if (request.action === 'send') sent.push(request.prompt)
    // Like the real window: earlier exchanges stay on screen above the newest one.
    if (request.action === 'snapshot') return { ok: true, text: sent.map((p, i) => `${p}\n${replies[i] ?? `答え${i + 1}`}`).join('\n'), generating: false }
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
  const handlers = createCommands({ session, call, config: loadConfig({}), env: { COPILOT_HOME: '/nowhere-home' }, cwd: '/nowhere', clock: { now: () => now, sleep: async (ms) => void (now += ms) } })
  const shown = () => logs.filter((l) => !l.ephemeral).map((l) => l.message)
  return { dir, events, sent, actions, logs, shown, handlers, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('/m365 sends the profile instructions in full once, then a reminder; /m365-raw shares the chat', async () => {
  const t = setup()
  try {
    await t.handlers.m365({ args: '最初の質問' })
    assert.ok(t.sent[0].includes('指示(plain):\n日本語で簡潔に答える'), t.sent[0])
    assert.ok(t.sent[0].includes('前提の話') && t.sent[0].endsWith('質問:\n最初の質問'))
    assert.equal(t.actions.filter((a) => a === 'newchat').length, 1)

    await t.handlers.m365({ args: '二つ目' })
    assert.ok(t.sent[1].includes('引き続き従って') && !t.sent[1].includes('日本語で簡潔に'), t.sent[1])

    await t.handlers.raw({ args: '素の質問' })
    assert.ok(!t.sent[2].includes('指示') && t.sent[2].endsWith('素の質問'), t.sent[2])
    assert.equal(t.actions.filter((a) => a === 'newchat').length, 1, 'raw continues the same chat')

    await t.handlers.m365({ args: '--new やり直し' })
    assert.ok(t.sent[3].includes('日本語で簡潔に答える'), 'a new chat gets the full instructions again')
    assert.ok(t.logs.every((l) => l.level !== 'error'), JSON.stringify(t.logs.filter((l) => l.level === 'error')))
  } finally {
    t.done()
  }
})

test('/m365 with a JSON profile shows the parsed JSON, and says so when it cannot parse', async () => {
  const t = setup({ replies: ['Copilot\njson\n{"summary":"問題なし","findings":[]}\nコピー', 'うまく答えられません'] })
  try {
    await t.handlers.m365({ args: '--profile review 見て' })
    assert.ok(t.sent[0].includes('"findings"') && t.sent[0].includes('根拠の行を示す'))
    assert.equal(t.shown().at(-1), `${REPLY_PREFIX}\n\n\`\`\`json\n{\n  "summary": "問題なし",\n  "findings": []\n}\n\`\`\``)
    await t.handlers.m365({ args: '--profile review もう一度' })
    assert.ok(t.shown().at(-1).includes('うまく答えられません') && t.shown().at(-1).includes('JSON として読み取れなかった'))
  } finally {
    t.done()
  }
})

test('/m365 embeds --file and @path text files, and refuses to send when a file is wrong', async () => {
  const t = setup()
  try {
    await t.handlers.m365({ args: '--dry @notes.md を要約して' })
    const dry = t.shown().at(-1)
    assert.ok(dry.includes('添付 notes.md') && dry.includes('----- notes.md(2 行)-----\n# メモ\n手順は 3 つ'), dry)
    assert.ok(dry.endsWith('質問:\nnotes.md を要約して'), dry)
    assert.equal(t.sent.length, 0, 'a dry run sends nothing')

    await t.handlers.m365({ args: '--file missing.md 読んで' })
    assert.equal(t.logs.at(-1).level, 'error')
    assert.ok(t.logs.at(-1).message.includes('missing.md'))
    assert.equal(t.sent.length, 0)

    await t.handlers.m365({ args: '--file notes.md 読んで' })
    assert.ok(t.sent[0].includes('手順は 3 つ'))
  } finally {
    t.done()
  }
})

test('/m365 stops on a broken m365.json and lists profiles with --profiles', async () => {
  const broken = setup({ config: '{"profiles": {"x": {"instructions": 1}}}' })
  try {
    await broken.handlers.m365({ args: '質問' })
    assert.equal(broken.logs.at(-1).level, 'error')
    assert.equal(broken.sent.length, 0)
    await broken.handlers.raw({ args: '質問' })
    assert.equal(broken.sent.length, 1, '/m365-raw does not read m365.json')
  } finally {
    broken.done()
  }
  const t = setup()
  try {
    await t.handlers.m365({ args: '--profiles' })
    const list = t.shown().at(-1)
    assert.ok(list.includes('`plain`(既定)(リポジトリ)') && list.includes('`review`(JSON)(リポジトリ): レビュー') && list.includes('m365.json'), list)
    await t.handlers.m365({ args: '--profile nope 質問' })
    assert.ok(t.logs.at(-1).level === 'error' && t.logs.at(-1).message.includes('nope'))
  } finally {
    t.done()
  }
})

test('parseJsonReply prefers the last block and never takes the echoed schema', () => {
  const schema = { summary: '一行の要約', findings: ['指摘'] }
  const echo = `形は次のとおりです(値は説明):\n${JSON.stringify(schema, null, 2)}\n申し訳ありませんが答えられません`
  assert.equal(parseJsonReply(echo, schema), null)
  const two = '例:\n```json\n{"summary":"例","findings":[]}\n```\n答え:\n```json\n{"summary":"本物","findings":[]}\n```'
  assert.equal(parseJsonReply(two, schema).value.summary, '本物')
})

test('options and profile names never resolve to object built-ins', () => {
  assert.ok(parseArgs('--constructor x q', OPTIONS).error)
  // Not an option name at all (options are lower case), so it stays in the question.
  assert.deepEqual(parseArgs('--toString q'), { flags: {}, question: '--toString q' })
  const loaded = loadProfiles(['f'], () => '{"profiles": {"__proto__": {"instructions": "p"}}}')
  assert.equal(Object.getPrototypeOf(loaded.profiles), null)
  assert.ok(Object.hasOwn(loaded.profiles, '__proto__'), 'a profile named __proto__ is just a name')
})

test('/m365 handles @path next to Japanese text and punctuation, and refuses unknown paths', async () => {
  const t = setup()
  try {
    await t.handlers.m365({ args: '--dry @notes.mdを要約して' })
    assert.ok(t.shown().at(-1).includes('添付 notes.md') && t.shown().at(-1).endsWith('notes.mdを要約して'), t.shown().at(-1))
    await t.handlers.m365({ args: '--dry (@notes.md)と、メールは a@example.com まで' })
    assert.ok(t.shown().at(-1).includes('添付 notes.md') && t.shown().at(-1).includes('a@example.com'), t.shown().at(-1))
    await t.handlers.m365({ args: '--dry --file notes.md @./notes.md 一度だけ' })
    assert.equal(t.shown().at(-1).split('----- notes.md ここまで').length, 2, 'attached once')
    await t.handlers.m365({ args: '@docs/none.md を読んで' })
    assert.ok(t.logs.at(-1).level === 'error' && t.logs.at(-1).message.includes('@docs/none.md'))
    await t.handlers.m365({ args: '--dry @someone に聞いて' })
    assert.notEqual(t.logs.at(-1).level, 'error', 'a plain @word is not a path')
    await t.handlers.m365({ args: `--file ${t.dir} フォルダ` })
    assert.ok(t.logs.at(-1).message.includes('普通のファイルではありません'))
    assert.equal(t.sent.length, 0)
  } finally {
    t.done()
  }
})

test('/m365 cancels earlier instructions on a profile switch, and a new chat resets even if sending fails', async () => {
  const t = setup()
  try {
    await t.handlers.m365({ args: '--profile review 一つ目' })
    await t.handlers.m365({ args: '--profile plain 二つ目' })
    assert.ok(t.sent[1].includes('取り消します') && t.sent[1].includes('日本語で簡潔に答える'), t.sent[1])
    await t.handlers.m365({ args: '三つ目' })
    assert.ok(!t.sent[2].includes('取り消します') && t.sent[2].includes('引き続き従って'), t.sent[2])
  } finally {
    t.done()
  }

  // The new chat opens, then the send fails: the next send must treat the chat as empty.
  const events = [user('1', '前提')]
  const sent = []
  let failSend = true
  const call = async (r) => {
    if (r.action === 'send') {
      if (failSend) {
        failSend = false
        return Promise.reject(new Error('入力欄が見つかりません'))
      }
      sent.push(r.prompt)
    }
    if (r.action === 'snapshot') return { ok: true, text: sent.map((p, i) => `${p}\n答え${i}`).join('\n'), generating: false }
    return { ok: true, newChat: true }
  }
  let now = 0
  const session = { getEvents: async () => events, log: async () => {} }
  const h = createCommands({ session, call, config: loadConfig({}), env: { COPILOT_HOME: '/nowhere-home' }, cwd: '/nowhere', clock: { now: () => now, sleep: async (ms) => void (now += ms) } })
  await h.raw({ args: '--new 失敗する' })
  await h.raw({ args: '次' })
  assert.ok(sent[0].includes('前提') && sent[0].includes('古い順'), 'full context into the empty chat')
})

// ------------------------------------------------------------ the entry point and the driver

test('extension.mjs registers /m365 and /m365-raw, in the source and in the shipped plugin', () => {
  const loader = pathToFileURL(join(here, 'fixtures', 'sdk-loader.mjs')).href
  for (const entry of [
    join(here, '..', 'shared', 'extensions', 'm365', 'extension.mjs'),
    join(here, '..', 'copilot-plugins', 'm365', 'extensions', 'm365', 'extension.mjs'),
  ]) {
    const out = JSON.parse(execFileSync(process.execPath, ['--import', loader, entry], { encoding: 'utf8', timeout: 30_000 }))
    assert.deepEqual(out.commands.map((c) => c.name), ['m365', 'm365-raw'], entry)
    assert.ok(out.commands.every((c) => c.description), entry)
    assert.ok(out.help.m365.startsWith('**/m365**') && out.help['m365-raw'].startsWith('**/m365-raw**'), JSON.stringify(out.help))
  }
})

// The UI Automation driver only exists on Windows. These run there (CI has a Windows job)
// and are skipped elsewhere.
const onWindows = { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }
const UIA_SCRIPT = join(here, '..', 'shared', 'extensions', 'm365', 'm365-uia.ps1')

test('m365-uia.ps1 parses under Windows PowerShell 5.1', onWindows, () => {
  const command = [
    '$errors = $null',
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${UIA_SCRIPT.replaceAll("'", "''")}', [ref]$null, [ref]$errors)`,
    '$errors | ForEach-Object { "ERROR: " + $_.ToString() }',
    '"VERSION: " + $PSVersionTable.PSVersion.Major',
  ].join('; ')
  const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  assert.ok(!out.includes('ERROR:'), out)
  assert.match(out, /VERSION: 5\b/)
})

test('m365-uia.ps1 runs, and reports a missing window without sending anything', onWindows, async () => {
  const call = createDriver({ driver: '' })
  // A title no window has, so the result does not depend on what the machine has open.
  const patterns = { ...loadConfig({}).patterns, window: '^m365-ci-no-such-window$' }
  const request = (action, extra = {}) => ({ action, patterns, prompt: '', wait: false, ...extra })

  const inspected = await call(request('inspect'), 120_000)
  assert.equal(inspected.window, '')
  assert.ok(Array.isArray(inspected.windows), JSON.stringify(inspected))
  assert.ok(Array.isArray(inspected.elements), JSON.stringify(inspected))

  await assert.rejects(call(request('snapshot'), 120_000), { code: 'window_not_found' })
  await assert.rejects(call(request('send', { prompt: '送らない' }), 120_000), { code: 'window_not_found' })
})

// ------------------------------------------------- both commands, on the real window's shape

/** A window like the real one: reply elements with ids, a handle, an echo of each prompt. */
function realWindow({ hwnd = 500 } = {}) {
  const w = { hwnd, sent: [], requests: [], generating: false }
  w.call = async (request) => {
    w.requests.push(request)
    const ids = w.sent.map((_, i) => `copilot-message-_r_${i}_`)
    if (request.action === 'newchat') {
      if (w.generating) return { ok: true, hwnd: w.hwnd, newChat: false, generating: true, focusRestored: true }
      w.sent.length = 0
      return { ok: true, hwnd: w.hwnd, newChat: true, focusRestored: true }
    }
    if (request.action === 'send') {
      w.sent.push(request.prompt)
      return { ok: true, hwnd: w.hwnd, submit: 'button', raised: true, focusRestored: true }
    }
    if (request.action === 'snapshot') {
      return { ok: true, hwnd: w.hwnd, minimized: false, text: '', generating: w.generating, replies: ids.length, replyIds: ids, replyId: ids.at(-1) ?? '', reply: ids.length ? `答え${ids.length}` : '' }
    }
    return { ok: true, hwnd: w.hwnd }
  }
  return w
}

function onWindow(w) {
  const logs = []
  const events = [user('1', '前提の話'), assistant('2', '前提への答え')]
  let now = 0
  const session = {
    getEvents: async () => events,
    log: async (message, options = {}) => {
      logs.push({ message, ...options })
      if (!options.ephemeral) events.push(info(`L${logs.length}`, message))
    },
  }
  const handlers = createCommands({ session, call: (r) => w.call(r), config: loadConfig({}), env: { COPILOT_HOME: '/nowhere-home' }, cwd: '/nowhere', clock: { now: () => now, sleep: async (ms) => void (now += ms) } })
  return { handlers, logs, events, last: () => logs.filter((l) => !l.ephemeral).at(-1) }
}

test('/m365 reads the reply element too, and keeps to one window for the whole command', async () => {
  const w = realWindow()
  const t = onWindow(w)
  await t.handlers.m365({ args: '最初の質問' })
  assert.equal(t.last().message, `${REPLY_PREFIX}\n\n答え1`)
  assert.equal(w.requests[0].target, 0)
  assert.ok(w.requests.slice(1).every((r) => r.target === 500), JSON.stringify(w.requests.map((r) => [r.action, r.target])))
  assert.equal(w.requests.at(-1).action, 'release')
})

test('a window that changed since the last send is not treated as the same chat', async () => {
  const w = realWindow()
  const t = onWindow(w)
  await t.handlers.raw({ args: '一つ目' })
  // The app was restarted: another window, an empty chat.
  w.hwnd = 900
  w.sent.length = 0
  await t.handlers.raw({ args: '二つ目' })
  assert.equal(w.sent.length, 0)
  assert.ok(t.last().level === 'error' && t.last().message.includes('別のものに替わっています'), t.last().message)
  // The next one starts over: a new chat with the whole conversation.
  await t.handlers.raw({ args: '三つ目' })
  assert.ok(w.sent[0].includes('前提の話') && w.sent[0].endsWith('三つ目'), w.sent[0])
  assert.ok(w.sent[0].includes('一つ目') && !w.sent[0].includes('二つ目'), w.sent[0])
})

test('while a reply is being generated, no new chat is opened and nothing is sent', async () => {
  const w = realWindow()
  w.generating = true
  const t = onWindow(w)
  await t.handlers.raw({ args: 'q' })
  assert.deepEqual(w.requests.map((r) => r.action), ['newchat'])
  assert.ok(t.last().message.includes('生成しています'), t.last().message)
  w.generating = false
  await t.handlers.m365({ args: '--new q2' })
  assert.equal(w.sent.length, 1)
})

test('a question that got no reply is left out of later summaries', () => {
  const turns = extractTurns([
    user('1', '相談'),
    info('2', `${RAW_ASK_PREFIX} 送られなかった質問`),
    { id: '3', type: 'session.error', data: { message: '失敗' } },
    info('4', `${ASK_PREFIX} 答えのあった質問`),
    info('5', `${REPLY_PREFIX}\n\n答え`),
    info('6', `${ASK_PREFIX} 最後の、まだ答えのない質問`),
  ])
  assert.deepEqual(turns.map((t) => t.id), ['1', '4', '5'])
})

test('a reply counts only when it comes after the question just sent', () => {
  const before = { replies: 2, replyIds: ['r1', 'r2'], replyId: 'r2', userIds: ['u1', 'u2'], replyAfterUser: true, reply: '前の答え' }
  // Seen on the real app: an old reply's element got a new id. It is not after the new question.
  const rerendered = { replies: 2, replyIds: ['r1', 'r9'], replyId: 'r9', userIds: ['u1', 'u2', 'u3'], replyAfterUser: false, reply: '前の答え' }
  assert.equal(pickReply(before, rerendered, 'q'), '')
  // The same, with the question not on screen yet.
  assert.equal(pickReply(before, { ...rerendered, userIds: ['u1', 'u2'], replyAfterUser: true }, 'q'), '')
  // The new reply, after the new question.
  const answered = { replies: 3, replyIds: ['r1', 'r2', 'r3'], replyId: 'r3', userIds: ['u1', 'u2', 'u3'], replyAfterUser: true, reply: '新しい答え' }
  assert.equal(pickReply(before, answered, 'q'), '新しい答え')
  // A long chat shows only its last few messages: the old ones drop out of both lists.
  assert.equal(pickReply(before, { ...answered, replyIds: ['r2', 'r3'], userIds: ['u2', 'u3'] }, 'q'), '新しい答え')
  // A version without user message elements: the reply ids alone decide, as before.
  assert.equal(pickReply({ replyIds: ['r1'] }, { replies: 1, replyIds: ['r2'], replyId: 'r2', reply: '答え' }, 'q'), '答え')
})

test('the user message pattern has a default and can be replaced', () => {
  assert.ok(new RegExp(loadConfig({}).patterns.user).test('user-message-_r_124_'))
  assert.ok(!new RegExp(loadConfig({}).patterns.user).test('user-message-_r_124_-title'))
  assert.equal(loadConfig({ M365_COPILOT_USER: '^u-' }).patterns.user, '^u-')
})
