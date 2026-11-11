// The /m365 command. It never sends anything to the Copilot CLI model: it reads the session
// history, drives the Microsoft 365 Copilot window, and writes the reply to the timeline.

import { ASK_PREFIX, REPLY_PREFIX, composePrompt, extractTurns, planContext } from './history.mjs'
import { USAGE, parseArgs } from './options.mjs'
import { createStabilityTracker, pickReply } from './reply.mjs'

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
  // Whether the window has ever shown reply elements. From then on the text comparison is
  // never used: before the new element appears it would pass off labels and buttons as the
  // reply, and a new chat starts with no element at all.
  let structured = false
  // The window the current command acts on. The first driver call of a command chooses it;
  // the later ones are told to use the same one, so that a command never spreads over two
  // windows with the same title.
  let pinned = 0

  const info = (message) => session.log(message, { level: 'info' })
  const progress = (message) => session.log(message, { level: 'info', ephemeral: true })
  const fail = (message) => session.log(message, { level: 'error' })

  // Every request carries every field: the driver script runs in strict mode and may not
  // read a property that is absent.
  const drive = async (action, extra = {}) => {
    const result = await call({
      action,
      patterns: config.patterns,
      prompt: '',
      wait: false,
      keepVisible: Boolean(config.keepVisible),
      release: false,
      restore: true,
      target: pinned,
      ...extra,
    })
    if (!pinned && Number.isInteger(result?.hwnd)) pinned = result.hwnd
    return result
  }

  async function inspect() {
    const result = await drive('inspect')
    const windows = (result.windows ?? []).map((w) => `- ${w}`).join('\n') || '- (なし)'
    const elements =
      (result.elements ?? []).map((e) => `- ${e.type}${e.enabled === false ? ' (無効)' : ''}: ${e.name || '(名前なし)'}`).join('\n') ||
      '- (対象のウィンドウが見つからないか、要素がありません)'
    const facts = []
    if (result.window) {
      facts.push(`返答の要素(\`M365_COPILOT_REPLY\` に合うもの): ${result.replies ?? 0} 件`)
      // With a dialog open the page behind it cannot be judged.
      if (result.signature !== undefined && !result.dialog) {
        facts.push(`M365 Copilot の目印(\`M365_COPILOT_APP_ID\` に合う要素): ${result.signature ? 'あり' : 'なし(このままでは送信しません)'}`)
      }
      if (result.dialog) facts.push(`開いているダイアログ: ${result.dialog}(アプリで答えるまで送信できません)`)
      if ((result.candidates ?? []).length > 1) {
        facts.push(`タイトルの合うウィンドウが複数あります(このままでは送信しません): ${result.candidates.join('、')}`)
      }
    }
    const detail = facts.length ? `\n\n${facts.map((f) => `- ${f}`).join('\n')}` : ''
    await info(`**M365 Copilot の UI 要素**\n\n対象ウィンドウ: ${result.window || '(見つかりません)'}${detail}\n\n開いているウィンドウ:\n${windows}\n\n入力欄・ボタン:\n${elements}`)
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
      const opened = await drive('newchat', { wait: true })
      if (!opened.newChat) note = '\n\n_(新しいチャットのボタンが見つからなかったため、開いていたチャットに続けて送りました)_'
    }
    // `release`: undo a "keep on top" left by a run that ended while waiting (the CLI quit).
    // Asked for whatever the setting is now: only what the driver itself raised comes down.
    const before = await drive('snapshot', { wait: true, release: true })
    if (before.generating) {
      // The reply that is still being written would show up as the reply to this question.
      await fail('M365 Copilot が前の返答をまだ生成しています。終わってから実行してください(何も送っていません)。')
      return
    }
    await progress('M365 Copilot: 送信しています…')
    try {
      const sent = await drive('send', { prompt })
      chatStarted = true
      // A --raw send carried no context, so it must not mark the conversation as delivered.
      if (plan.mode !== 'raw') lastSentId = newestId
      if (sent.focusRestored === false) {
        note += '\n\n_(送信後、元のウィンドウを前面に戻せませんでした。M365 Copilot のウィンドウが前面に残っています)_'
      }
      await receive(before, prompt, note)
    } finally {
      // The send keeps the window on top so that it goes on rendering; put it back, also
      // when the send itself failed part way.
      if (config.keepVisible) await drive('release').catch(() => {})
    }
  }

  async function receive(before, prompt, note) {
    const done = createStabilityTracker(config.stableMs)
    const deadline = clock.now() + config.timeoutMs
    let reply = ''
    let finished = false
    let announced = ''
    let misses = 0
    let generating = false
    let sawGenerating = false
    const sentAt = clock.now()
    structured ||= before.replies > 0
    while (clock.now() < deadline) {
      await clock.sleep(config.pollMs)
      // The page is rebuilt while the reply streams, so a single look can fail. Give up
      // only when several in a row do.
      let shot
      try {
        // `restore: false`: a window the user minimised meanwhile is left minimised.
        shot = await drive('snapshot', { restore: false })
        misses = 0
      } catch (error) {
        if (++misses >= 3) throw error
        continue
      }
      if (shot.minimized) {
        await fail('M365 Copilot のウィンドウが最小化されたので、返答の読み取りをやめました(最小化したままでは読めません)。返答は M365 Copilot のウィンドウで確認してください。')
        return
      }
      structured ||= shot.replies > 0
      generating = Boolean(shot.generating)
      sawGenerating ||= generating
      // Right after a send the window can show neither a reply element nor a stop button;
      // the text comparison would take a label for the reply. It is used once generation
      // was seen, or after a while (a version without either).
      const fallback = sawGenerating || clock.now() - sentAt >= config.fallbackGraceMs
      reply = pickReply(before, shot, prompt, { structured, fallback })
      if (done(reply, shot.generating, clock.now())) {
        finished = true
        break
      }
      // The timeline keeps every line, so each stage is announced once, not once per poll.
      const stage = reply ? 'M365 Copilot: 返答を受信しています…' : 'M365 Copilot: 返答を待っています…'
      if (stage !== announced) await progress((announced = stage))
    }

    const seconds = Math.round(config.timeoutMs / 1000)
    if (!reply && generating) {
      // The app shows a long answer only once it is complete, so a short limit ends here.
      await fail(`${seconds} 秒待っても M365 Copilot の返答が終わりませんでした。M365 Copilot のウィンドウでは生成が続いています(待つ上限は \`M365_COPILOT_TIMEOUT_SEC\` で変えられます)。`)
      return
    }
    if (!reply) {
      await fail('M365 Copilot から返答を読み取れませんでした。ウィンドウを確認してください(`/m365 --inspect` で見えている要素を確認できます)。')
      return
    }
    if (!finished) note += `\n\n_(${seconds} 秒で打ち切りました。返答は途中までの可能性があります)_`
    await info(`${REPLY_PREFIX}\n\n${reply}${note}`)
  }

  return async function handler(context) {
    const parsed = parseArgs(context?.args)
    if (parsed.error) return fail(`${parsed.error}\n\n${USAGE}`)
    const { flags, question } = parsed
    if (flags.help || (!question && !flags.inspect)) return info(USAGE)
    if (busy) return fail('前の /m365 がまだ返答を待っています。終わってから実行してください。')

    busy = true
    pinned = 0
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
