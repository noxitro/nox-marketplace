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
import { createStabilityTracker, extractReply } from './reply.mjs'

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
  }
  let busy = false

  const info = (message) => session.log(message, { level: 'info' })
  const progress = (message) => session.log(message, { level: 'info', ephemeral: true })
  const fail = (message) => session.log(message, { level: 'error' })

  // Every request carries every field: the driver script runs in strict mode and may not
  // read a property that is absent.
  const drive = (action, extra = {}) => call({ action, patterns: config.patterns, prompt: '', wait: false, ...extra })

  async function inspect() {
    const result = await drive('inspect')
    const windows = (result.windows ?? []).map((w) => `- ${w}`).join('\n') || '- (なし)'
    const elements =
      (result.elements ?? []).map((e) => `- ${e.type}${e.enabled === false ? ' (無効)' : ''}: ${e.name || '(名前なし)'}`).join('\n') ||
      '- (対象のウィンドウが見つからないか、要素がありません)'
    await info(`**M365 Copilot の UI 要素**\n\n対象ウィンドウ: ${result.window || '(見つかりません)'}\n\n開いているウィンドウ:\n${windows}\n\n入力欄・ボタン:\n${elements}`)
  }

  /** Send `prompt`, wait for the reply, and return it (or '' when none could be read). */
  async function exchange({ prefix, question, prompt, fresh, mode, newestId, onSent }) {
    await info(`${prefix} ${question}`)

    let note = ''
    if (fresh) {
      await progress('M365 Copilot: 新しいチャットを開いています…')
      const opened = await drive('newchat', { wait: true })
      // From here the window shows an empty chat, even if the send below fails.
      if (opened.newChat) Object.assign(chat, { started: false, lastSentId: undefined, instructed: null })
      if (!opened.newChat) note = '\n\n_(新しいチャットのボタンが見つからなかったため、開いていたチャットに続けて送りました)_'
    }
    const before = await drive('snapshot', { wait: true })
    await progress('M365 Copilot: 送信しています…')
    await drive('send', { prompt })
    if (fresh || !chat.started) chat.instructed = null
    chat.started = true
    // A send without the conversation must not mark the conversation as delivered.
    if (mode !== 'raw') chat.lastSentId = newestId
    onSent?.()

    const done = createStabilityTracker(config.stableMs)
    const deadline = clock.now() + config.timeoutMs
    let reply = ''
    let finished = false
    let announced = ''
    let misses = 0
    while (clock.now() < deadline) {
      await clock.sleep(config.pollMs)
      // The page is rebuilt while the reply streams, so a single look can fail. Give up
      // only when several in a row do.
      let shot
      try {
        shot = await drive('snapshot')
        misses = 0
      } catch (error) {
        if (++misses >= 3) throw error
        continue
      }
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
      return null
    }
    if (!finished) note += `\n\n_(${Math.round(config.timeoutMs / 1000)} 秒で打ち切りました。返答は途中までの可能性があります)_`
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
