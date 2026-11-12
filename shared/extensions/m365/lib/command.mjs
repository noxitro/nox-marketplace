// The /m365 and /m365-raw commands. Neither sends anything to the Copilot CLI model: they read
// the session history, drive the Microsoft 365 Copilot window, and write the reply to the
// timeline.
//
//   /m365-raw  the question and the compressed conversation, nothing else
//   /m365      the same, plus a response profile from m365.json (fixed instructions, an
//              optional JSON answer format) and text files embedded in the prompt

import { resolve } from 'node:path'
import { attachmentBlock, isFile, readAttachments } from './attachments.mjs'
import { ASK_PREFIX, RAW_ASK_PREFIX, REPLY_PREFIX, composePrompt, extractTurns, planContext } from './history.mjs'
import { OPTIONS, RAW_OPTIONS, RAW_USAGE, USAGE, parseArgs } from './options.mjs'
import { configPaths, instructionBlock, loadProfiles, parseJsonReply } from './profiles.mjs'
import { createStabilityTracker, pickReply } from './reply.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The session's working directory and git root, from the newest event that carries them.
 * Relative --file paths and the project m365.json are resolved against these.
 */
export function sessionDirs(events, fallback) {
  for (let i = (events ?? []).length - 1; i >= 0; i--) {
    const data = events[i]?.data ?? {}
    const ctx = data.context ?? data
    if (['session.start', 'session.resume', 'session.context_changed'].includes(events[i].type) && typeof ctx.cwd === 'string')
      return { cwd: ctx.cwd, root: ctx.gitRoot || ctx.cwd }
  }
  return { cwd: fallback, root: fallback }
}

// `@` that starts a word: after a space, the start, or an opening bracket. An e-mail address
// (`a@b.com`) has a letter before its `@`, so it is not taken.
const MENTION_RE = /(^|[\s(\[「『(【])@([^\s@]+)/g
const PATH_CHAR = /[\w./\\~-]/

/**
 * The file an `@word` names: the longest prefix of the word that is a file and ends where a
 * path character does not follow, so `@a.mdを見て` and `@a.md。` find a.md. Returns the
 * prefix, or null.
 */
function mentionTarget(word, base) {
  for (let end = word.length; end > 0; end--) {
    if (end < word.length && PATH_CHAR.test(word[end])) continue
    if (isFile(word.slice(0, end), base)) return word.slice(0, end)
  }
  return null
}

/** `@word` that looks like a path (has a slash or an extension) but names no file. */
const looksLikePath = (word) => /[/\\]|\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/.test(word)

/**
 * Files named by `@path` in the question. Returns { files, text, unknown }: `text` is the
 * question with those `@` removed, `unknown` the path-like words that name no file.
 */
function mentions(question, base) {
  const files = []
  const unknown = []
  const text = question.replace(MENTION_RE, (all, lead, word) => {
    const target = mentionTarget(word, base)
    if (target) {
      files.push(target)
      return `${lead}${word}`
    }
    if (looksLikePath(word)) unknown.push(`@${word}`)
    return all
  })
  return { files, text, unknown }
}

/**
 * @param session  the joined Copilot CLI session (`log`, `getEvents`)
 * @param call     driver function from createDriver()
 * @param config   loadConfig() result
 * @param env      environment, for where m365.json is looked for
 * @param clock    injectable for tests
 * @returns {{ m365: Function, raw: Function }} the two command handlers
 */
export function createCommands({ session, call, config, env = process.env, cwd = process.cwd(), clock = { now: () => Date.now(), sleep } }) {
  // Both commands talk to the same Microsoft 365 Copilot chat, so they share what it knows.
  // Kept in memory only: after a restart the next send starts a new chat with the full
  // summary, the safe choice when nobody knows what the window shows.
  const chat = {
    started: false,
    lastSentId: undefined, // newest conversation turn already sent
    instructed: null, // profile whose full instructions this chat has seen
    hwnd: 0, // the window that chat is in
  }
  let busy = false
  // Whether the window has ever shown reply elements. From then on the text comparison is
  // never used: before the new element appears it would pass off labels and buttons as the
  // reply, and a new chat starts with no element at all.
  let structured = false
  let structuredFor = 0
  // The window the current command acts on. The first driver call of a command chooses it;
  // the later ones are told to use the same one, so that a command never spreads over two
  // windows with the same title.
  let pinned = 0

  // The Copilot CLI shows session.log in its timeline. The GitHub Copilot app does not (it
  // renders no `session.info`), so there the output is also put in a dialog. The CLI passes
  // COPILOT_CLI_PATH to its extensions; the app does not.
  let useDialog = config.display === 'dialog' || (config.display === 'auto' && !env.COPILOT_CLI_PATH && !env.COPILOT_CLI_BINARY_VERSION)
  const dialog = (message) => {
    if (!useDialog || typeof session.ui?.elicitation !== 'function') return
    // Not awaited: the command finishes while the dialog stays open. A host without dialogs
    // rejects; then there is nothing more to try.
    Promise.resolve()
      .then(() => session.ui.elicitation({ message, requestedSchema: { type: 'object', properties: {} } }))
      .catch((error) => {
        // Only a host without dialogs ends them for the session; another failure (one already
        // open, a timeout) leaves the next message free to try again.
        if (/support|elicitation is not|not available/i.test(String(error?.message ?? error))) useDialog = false
      })
  }
  // `inDialog: false` for the echo of the user's own question: it goes to the timeline only (it
  // is what later summaries read). Everything else the user should see also goes to the dialog.
  const info = async (message, { inDialog = true } = {}) => {
    await session.log(message, { level: 'info' })
    if (inDialog) dialog(message)
  }
  const progress = (message) => session.log(message, { level: 'info', ephemeral: true })
  const fail = async (message) => {
    await session.log(message, { level: 'error' })
    dialog(message)
  }
  const GENERATING = 'M365 Copilot が前の返答をまだ生成しています。終わってから実行してください(質問は送っていません。生成中かどうかは、`M365_COPILOT_STOP` に合うボタンがあるかで判断しています)。'

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
      restoreTo: 0,
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

  /** Send `prompt` and wait for the reply. Returns { reply, note }, or null after reporting why there is none. */
  async function exchange({ prefix, question, prompt, fresh, mode, newestId, onSent }) {
    await info(`${prefix} ${question}`, { inDialog: false })

    let note = ''
    // The window to give the foreground back to, when opening the new chat could not.
    let restoreTo = 0
    let focusLost = false
    if (fresh) {
      await progress('M365 Copilot: 新しいチャットを開いています…')
      const opened = await drive('newchat', { wait: true })
      // The driver presses nothing while a reply is still being written.
      if (opened.generating) {
        await fail(GENERATING)
        return null
      }
      // From here the window shows an empty chat, even if the send below fails.
      if (opened.newChat) Object.assign(chat, { started: false, lastSentId: undefined, instructed: null })
      if (opened.focusRestored === false) {
        focusLost = true
        restoreTo = Number.isInteger(opened.previous) ? opened.previous : 0
      }
      if (!opened.newChat) note = '\n\n_(新しいチャットのボタンが見つからなかったため、開いていたチャットに続けて送りました)_'
    }
    // `release`: undo a "keep on top" left by a run that ended while waiting (the CLI quit).
    // Asked for whatever the setting is now: only what the driver itself raised comes down.
    const before = await drive('snapshot', { wait: true, release: true })
    if (before.generating) {
      // The reply that is still being written would show up as the reply to this question.
      await fail(GENERATING)
      return null
    }
    if (!fresh && chat.hwnd && pinned && pinned !== chat.hwnd) {
      // The app was restarted, or another window is the target now: the chat this prompt was
      // written for (a continuation: only what is new, a reminder of the instructions) is not
      // the one on screen.
      Object.assign(chat, { started: false, lastSentId: undefined, instructed: null, hwnd: 0 })
      await fail('M365 Copilot のウィンドウが、前回送ったときと別のものに替わっています(アプリを起動し直した場合など)。続きとしては送れないので、何も送っていません。もう一度実行すると、新しいチャットとして会話全体の要約を添えて送ります。')
      return null
    }
    await progress('M365 Copilot: 送信しています…')
    try {
      const sent = await drive('send', { prompt, restoreTo, model: config.model })
      if (fresh || !chat.started) chat.instructed = null
      chat.started = true
      chat.hwnd = pinned
      // A send without the conversation must not mark the conversation as delivered.
      if (mode !== 'raw') chat.lastSentId = newestId
      onSent?.()
      // The send gives the foreground back itself; it is told where to when the new chat
      // could not. Without that, the app is still in front.
      if (sent.modelAsked && !sent.model) {
        const offered = (sent.modelsAvailable ?? []).filter(Boolean)
        note += offered.length
          ? `\n\n_(モデルの一覧に \`${config.model}\` に合うものが無かったため、選ばれているモデルのまま送りました。一覧: ${offered.join(' / ')})_`
          : '\n\n_(モデルの選択が見つからなかったため、選ばれているモデルのまま送りました)_'
      } else if (sent.modelChanged) {
        note += `\n\n_(モデル: ${sent.model})_`
      }
      if (sent.focusRestored === false || (focusLost && !restoreTo)) {
        note += '\n\n_(送信後、元のウィンドウを前面に戻せませんでした。M365 Copilot のウィンドウが前面に残っています)_'
      }
      return await receive(before, prompt, note)
    } finally {
      // The send keeps the window on top so that it goes on rendering; put it back, also
      // when the send itself failed part way.
      if (config.keepVisible) await drive('release').catch(() => {})
    }
  }

  /** Wait for the reply to `prompt`. Returns { reply, note }, or null after reporting why not. */
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
    // What one window showed says nothing about another.
    if (pinned !== structuredFor) {
      structured = false
      structuredFor = pinned
    }
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
      return null
    }
    if (!finished) note += `\n\n_(${seconds} 秒で打ち切りました。返答は途中までの可能性があります)_`
    return { reply, note }
  }

  async function askRaw(flags, question) {
    const turns = extractTurns(await session.getEvents())
    const fresh = flags.new || !chat.started
    const mode = flags.raw ? 'raw' : fresh || flags.full ? 'full' : 'delta'
    const plan = planContext(turns, { mode, lastSentId: chat.lastSentId, budget: config.budget })
    const prompt = composePrompt(question, plan)

    if (flags.dry) {
      await info(`**/m365-raw --dry** 送信する文面(${[...prompt].length} 文字、${fresh ? '新しいチャット' : 'いまのチャット'}):\n\n${prompt}`)
      return
    }
    const newestId = turns.length ? turns[turns.length - 1].id : undefined
    const got = await exchange({ prefix: RAW_ASK_PREFIX, question, prompt, fresh, mode: plan.mode, newestId })
    if (got) await info(`${REPLY_PREFIX}\n\n${got.reply}${got.note}`)
  }

  function readProfiles(events) {
    const dirs = sessionDirs(events, cwd)
    return { dirs, ...loadProfiles(configPaths({ env, root: dirs.root })) }
  }

  async function listProfiles() {
    const { profiles, origins, defaultProfile, sources, problems } = readProfiles(await session.getEvents())
    const names = Object.keys(profiles)
    const lines = names.map((name) => {
      const p = profiles[name]
      const tags = [name === defaultProfile ? '既定' : '', p.response?.format === 'json' ? 'JSON' : '', p.newChat ? '毎回新しいチャット' : '']
        .filter(Boolean)
        .join('・')
      const from = origins[name]?.origin === 'project' ? '(リポジトリ)' : ''
      return `- \`${name}\`${tags ? `(${tags})` : ''}${from}${p.description ? `: ${p.description}` : ''}`
    })
    const from = sources.length ? sources.map((s) => `- ${s}`).join('\n') : '- (m365.json が見つかりません)'
    const issues = problems.length ? `\n\n読み込めなかったもの:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''
    await info(`**/m365 のプロファイル**\n\n${lines.join('\n') || '- (なし)'}\n\n読み込んだファイル:\n${from}${issues}`)
  }

  async function ask(flags, question) {
    const events = await session.getEvents()
    const { dirs, profiles, defaultProfile, problems } = readProfiles(events)
    const name = flags.profile ?? defaultProfile
    // A broken m365.json stops the send rather than quietly dropping its profiles.
    if (problems.length) return fail(`m365.json に問題があるため送っていません(/m365-raw は使えます):\n${problems.map((p) => `- ${p}`).join('\n')}`)
    if (name && !Object.hasOwn(profiles, name))
      return fail(`プロファイル \`${name}\` がありません。\`/m365 --profiles\` で一覧を確認してください。`)
    const profile = name ? profiles[name] : undefined

    const named = mentions(question, dirs.cwd)
    const text = named.text
    // The same file given twice (`--file a.md` and `@./a.md`) is attached once.
    const seen = new Set()
    const paths = [...(flags.file ?? []), ...named.files].filter((p) => !seen.has(resolve(dirs.cwd, p)) && seen.add(resolve(dirs.cwd, p)))
    const { files, problems: fileProblems } = readAttachments(paths, { base: dirs.cwd, maxChars: config.fileBudget })
    for (const word of named.unknown) fileProblems.push(`${word}: そのファイルはありません`)
    if (fileProblems.length) return fail(`添付できません。何も送っていません。\n${fileProblems.map((p) => `- ${p}`).join('\n')}`)

    const fresh = flags.new || profile?.newChat || !chat.started
    const contextMode = profile?.context?.mode ?? 'delta'
    const mode = flags['no-context'] || contextMode === 'none' ? 'raw' : fresh || flags.full || contextMode === 'full' ? 'full' : 'delta'
    const turns = extractTurns(events)
    const plan = planContext(turns, { mode, lastSentId: chat.lastSentId, budget: profile?.context?.maxChars ?? config.budget })
    const key = name ? JSON.stringify([name, profile]) : null
    const full = fresh || chat.instructed !== key
    // Instructions from another profile are still in this chat; say they no longer hold.
    const replaces = !fresh && chat.instructed !== null && chat.instructed !== key
    const prompt = composePrompt(text, plan, [instructionBlock(name, profile, { full, replaces }), attachmentBlock(files)])

    if (flags.dry) {
      const head = [`${[...prompt].length} 文字`, fresh ? '新しいチャット' : 'いまのチャット', name ? `プロファイル ${name}` : 'プロファイルなし']
      if (files.length) head.push(`添付 ${files.map((f) => f.path).join('、')}`)
      await info(`**/m365 --dry** 送信する文面(${head.join('、')}):\n\n${prompt}`)
      return
    }

    const newestId = turns.length ? turns[turns.length - 1].id : undefined
    const got = await exchange({ prefix: ASK_PREFIX, question: text, prompt, fresh, mode: plan.mode, newestId, onSent: () => (chat.instructed = key) })
    if (!got) return
    if (profile?.response?.format !== 'json') return info(`${REPLY_PREFIX}\n\n${got.reply}${got.note}`)

    const parsed = parseJsonReply(got.reply, profile.response.schema)
    if (!parsed) return info(`${REPLY_PREFIX}\n\n${got.reply}${got.note}\n\n_(JSON として読み取れなかったため、そのまま表示しています)_`)
    const missing = parsed.missing.length ? `\n\n_(指定した形にない、または欠けているキー: ${parsed.missing.join(', ')})_` : ''
    await info(`${REPLY_PREFIX}\n\n\`\`\`json\n${JSON.stringify(parsed.value, null, 2)}\n\`\`\`${missing}${got.note}`)
  }

  function handler(command, spec, usage, run) {
    return async function (context) {
      const parsed = parseArgs(context?.args, spec)
      if (parsed.error) return fail(`${parsed.error}\n\n${usage}`)
      const { flags, question } = parsed
      if (flags.help || (!question && !flags.inspect && !flags.profiles)) return info(usage)
      if (busy) return fail('前の /m365 がまだ返答を待っています。終わってから実行してください。')

      busy = true
      pinned = 0
      try {
        if (flags.inspect) await inspect()
        else if (flags.profiles) await listProfiles()
        else await run(flags, question)
      } catch (error) {
        await fail(`/${command} に失敗しました: ${error?.message ?? error}`)
      } finally {
        busy = false
      }
    }
  }

  return {
    m365: handler('m365', OPTIONS, USAGE, ask),
    raw: handler('m365-raw', RAW_OPTIONS, RAW_USAGE, askRaw),
  }
}
