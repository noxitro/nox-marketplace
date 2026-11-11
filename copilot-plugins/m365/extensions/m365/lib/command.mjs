// The /m365 command. It never sends anything to the Copilot CLI model: it reads the session
// history, drives the Microsoft 365 Copilot window, and writes the reply to the timeline.

import { ASK_PREFIX, REPLY_PREFIX, composePrompt, extractTurns, planContext } from './history.mjs'
import { USAGE, parseArgs } from './options.mjs'
import { createStabilityTracker, extractReply } from './reply.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param session  the joined Copilot CLI session (`log`, `getEvents`)
 * @param call     driver function from createDriver()
 * @param config   loadConfig() result
 * @param clock    injectable for tests
 */
export function createCommand({ session, call, config, clock = { now: () => Date.now(), sleep } }) {
  // What the open M365 chat already knows: the newest turn covered by a send.
  // Kept in memory only. After a restart the next send starts a new chat with the full
  // summary, which is the safe choice when nobody knows what the M365 window shows.
  let lastSentId
  let chatStarted = false
  let busy = false

  const info = (message) => session.log(message, { level: 'info' })
  const progress = (message) => session.log(message, { level: 'info', ephemeral: true })
  const fail = (message) => session.log(message, { level: 'error' })

  async function inspect() {
    const result = await call({ action: 'inspect', patterns: config.patterns })
    const windows = (result.windows ?? []).map((w) => `- ${w}`).join('\n') || '- (なし)'
    const elements =
      (result.elements ?? []).map((e) => `- ${e.type}${e.enabled === false ? ' (無効)' : ''}: ${e.name || '(名前なし)'}`).join('\n') ||
      '- (対象のウィンドウが見つからないか、要素がありません)'
    await info(`**M365 Copilot の UI 要素**\n\n対象ウィンドウ: ${result.window || '(見つかりません)'}\n\n開いているウィンドウ:\n${windows}\n\n入力欄・ボタン:\n${elements}`)
  }

  async function ask(flags, question) {
    const events = await session.getEvents()
    const turns = extractTurns(events)
    const fresh = flags.new || !chatStarted
    const mode = flags.raw ? 'raw' : fresh || flags.full ? 'full' : 'delta'
    const plan = planContext(turns, { mode, lastSentId, budget: config.budget })
    const prompt = composePrompt(question, plan)

    if (flags.dry) {
      await info(`**/m365 --dry** 送信する文面(${[...prompt].length} 文字、${fresh ? '新しいチャット' : 'いまのチャット'}):\n\n${prompt}`)
      return
    }

    await info(`${ASK_PREFIX} ${question}`)
    const newestId = turns.length ? turns[turns.length - 1].id : undefined

    let note = ''
    if (fresh) {
      await progress('M365 Copilot: 新しいチャットを開いています…')
      const opened = await call({ action: 'newchat', patterns: config.patterns })
      if (!opened.newChat) note = '\n\n_(新しいチャットのボタンが見つからなかったため、開いていたチャットに続けて送りました)_'
    }
    const before = await call({ action: 'snapshot', patterns: config.patterns })
    await progress('M365 Copilot: 送信しています…')
    await call({ action: 'send', patterns: config.patterns, prompt })
    chatStarted = true
    lastSentId = newestId

    const done = createStabilityTracker(config.stableMs)
    const deadline = clock.now() + config.timeoutMs
    let reply = ''
    let finished = false
    let announced = ''
    while (clock.now() < deadline) {
      await clock.sleep(config.pollMs)
      const shot = await call({ action: 'snapshot', patterns: config.patterns })
      reply = extractReply(before.text, shot.text, prompt)
      if (done(reply, shot.generating, clock.now())) {
        finished = true
        break
      }
      // The timeline keeps every line, so each stage is announced once, not once per poll.
      const stage = reply ? 'M365 Copilot: 返答を受信しています…' : 'M365 Copilot: 返答を待っています…'
      if (stage !== announced) await progress((announced = stage))
    }

    if (!reply) {
      await fail('M365 Copilot から返答を読み取れませんでした。ウィンドウを確認してください(`/m365 --inspect` で見えている要素を確認できます)。')
      return
    }
    if (!finished) note += `\n\n_(${Math.round(config.timeoutMs / 1000)} 秒で打ち切りました。返答は途中までの可能性があります)_`
    await info(`${REPLY_PREFIX}\n\n${reply}${note}`)
  }

  return async function handler(context) {
    const parsed = parseArgs(context?.args)
    if (parsed.error) return fail(`${parsed.error}\n\n${USAGE}`)
    const { flags, question } = parsed
    if (flags.help || (!question && !flags.inspect)) return info(USAGE)
    if (busy) return fail('前の /m365 がまだ返答を待っています。終わってから実行してください。')

    busy = true
    try {
      if (flags.inspect) await inspect()
      else await ask(flags, question)
    } catch (error) {
      await fail(`/m365 に失敗しました: ${error?.message ?? error}`)
    } finally {
      busy = false
    }
  }
}
