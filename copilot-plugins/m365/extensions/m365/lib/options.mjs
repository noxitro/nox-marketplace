// Command-line parsing for /m365 and /m365-raw, and the settings read from environment variables.

export const RAW_USAGE = `**/m365-raw** — Microsoft 365 Copilot に質問を送り、返答をここに表示します(GitHub Copilot のモデルは呼びません)。プロファイルと添付を使わない版です。

- \`/m365-raw <質問>\` これまでの会話を圧縮して添え、質問を送る。2 回目以降は前回からの差分だけを添える
- \`/m365-raw --new <質問>\` M365 側で新しいチャットを始め、会話全体の要約を添えて送る
- \`/m365-raw --full <質問>\` いまのチャットのまま、会話全体の要約を添え直して送る
- \`/m365-raw --raw <質問>\` 会話を添えず、質問だけを送る
- \`/m365-raw --dry <質問>\` 送らずに、送る予定の文面だけを表示する
- \`/m365-raw --inspect\` M365 Copilot のウィンドウから見える UI 要素を書き出す(設定の調整用)`

export const USAGE = `**/m365** — Microsoft 365 Copilot に質問を送り、返答をここに表示します(GitHub Copilot のモデルは呼びません)。m365.json のプロファイル(返答の指示・JSON の形)とテキストファイルの添付を使えます。

- \`/m365 <質問>\` 既定のプロファイルで送る。会話の要約は 2 回目以降、前回からの差分だけ
- \`/m365 --profile <名前> <質問>\` プロファイルを選んで送る
- \`/m365 --file <パス> <質問>\` テキストファイルの中身を添えて送る(複数可。質問の中の \`@パス\` も添付になる)
- \`/m365 --new <質問>\` M365 側で新しいチャットを始め、会話全体の要約を添えて送る
- \`/m365 --full <質問>\` いまのチャットのまま、会話全体の要約を添え直して送る
- \`/m365 --no-context <質問>\` 会話の要約を添えない
- \`/m365 --dry <質問>\` 送らずに、送る予定の文面だけを表示する
- \`/m365 --profiles\` 読み込んだプロファイルの一覧
- \`/m365 --inspect\` M365 Copilot のウィンドウから見える UI 要素を書き出す(設定の調整用)

素の質問だけを送るときは \`/m365-raw\` を使います。`

/** Options of each command: true for a flag, 'value' for one that takes a value, 'values' when it may repeat. */
export const RAW_OPTIONS = { new: true, full: true, raw: true, dry: true, inspect: true, help: true }
export const OPTIONS = {
  new: true,
  full: true,
  'no-context': true,
  dry: true,
  inspect: true,
  help: true,
  profiles: true,
  profile: 'value',
  file: 'values',
}

const VALUE_RE = /^(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/

/**
 * Leading `--option` words are options; the rest, untouched, is the question. A value may be
 * quoted ("a b" or 'a b') so that paths with spaces work.
 */
export function parseArgs(args, spec = RAW_OPTIONS) {
  const flags = {}
  let rest = String(args ?? '').trim()
  for (;;) {
    const m = /^--([a-z][a-z-]*)(?:\s+|$)/.exec(rest)
    if (!m) break
    const kind = Object.hasOwn(spec, m[1]) ? spec[m[1]] : undefined
    if (!kind) return { error: `不明なオプション: --${m[1]}` }
    rest = rest.slice(m[0].length)
    if (kind === true) {
      flags[m[1]] = true
      continue
    }
    const v = VALUE_RE.exec(rest)
    if (!v || (v[3] ?? '').startsWith('--')) return { error: `--${m[1]} には値が要ります` }
    const value = v[1] ?? v[2] ?? v[3]
    rest = rest.slice(v[0].length)
    if (kind === 'values') (flags[m[1]] ??= []).push(value)
    else flags[m[1]] = value
  }
  const picked = ['new', 'full', 'raw', 'no-context'].filter((f) => flags[f])
  if (picked.length > 1) return { error: `--${picked.join(' と --')} は同時に指定できません` }
  return { flags, question: rest.trim() }
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Settings. The patterns are regular expressions matched against the names UI Automation
 * reports; they depend on the app version and display language, so each can be replaced.
 */
export function loadConfig(env) {
  return {
    patterns: {
      // The desktop app titles its window just "Copilot". Anchored, so that a browser tab or
      // the "GitHub Copilot" window does not match.
      window: env.M365_COPILOT_WINDOW || '^(Microsoft 365 Copilot|M365 Copilot|Copilot)$',
      input: env.M365_COPILOT_INPUT || 'メッセージ|Message|チャット|Chat|質問|Ask|Copilot',
      send: env.M365_COPILOT_SEND || '^(送信|Send)',
      stop: env.M365_COPILOT_STOP || '停止|Stop',
      newChat: env.M365_COPILOT_NEWCHAT || '新しいチャット|New chat',
      // AutomationId of each reply in the chat. When no element matches, the reply is found
      // by comparing the window text before and after the send.
      reply: env.M365_COPILOT_REPLY || '^copilot-message-.*_$',
      // AutomationId of each message the user sent. A reply counts only when it comes after
      // the message just sent; without such elements, the reply ids alone decide.
      user: env.M365_COPILOT_USER || '^user-message-.*_$',
      // Process name of the target window. Empty: any process whose window title matches.
      process: env.M365_COPILOT_PROCESS || '',
      // AutomationId that marks the Microsoft 365 Copilot page (its message box and containers
      // carry ids that start like this). A window without one is not sent to: another app
      // can have a window with the same title.
      // `off` turns the check off (an empty value would fall back to the default).
      app: env.M365_COPILOT_APP_ID === 'off' ? '' : env.M365_COPILOT_APP_ID || '^m365-',
      // The button that opens the model menu.
      modelButton: env.M365_COPILOT_MODEL_BUTTON || 'モデル ?セレクター|[Mm]odel ?(selector|picker)',
    },
    budget: positiveInt(env.M365_COPILOT_MAX_CHARS, 30000),
    fileBudget: positiveInt(env.M365_COPILOT_FILE_MAX_CHARS, 20000),
    timeoutMs: positiveInt(env.M365_COPILOT_TIMEOUT_SEC, 180) * 1000,
    stableMs: positiveInt(env.M365_COPILOT_STABLE_MS, 3000),
    pollMs: positiveInt(env.M365_COPILOT_POLL_MS, 1500),
    driver: env.M365_COPILOT_DRIVER || '',
    // Keep the window on top (without the keyboard focus) while the reply is written: a
    // window covered by others stops rendering, and the reply never shows up.
    keepVisible: env.M365_COPILOT_KEEP_VISIBLE !== '0',
    // Where the output goes: `timeline` (session.log only), `dialog` (also a dialog), or
    // `auto`: a dialog where the host does not show session.log (the GitHub Copilot app).
    display: ['timeline', 'dialog'].includes(env.M365_COPILOT_DISPLAY) ? env.M365_COPILOT_DISPLAY : 'auto',
    // The model picked in Microsoft 365 Copilot before each send. Patterns in order of
    // preference, separated by `||`, compared case sensitively with the names in its model menu.
    // `off` leaves the menu alone.
    model: env.M365_COPILOT_MODEL === 'off' ? '' : env.M365_COPILOT_MODEL || 'GPT-5\\.6.*(Think|Deep)||Think Deeper',
    // How long the window text is not trusted as a reply after a send, when the window shows
    // neither a reply element nor a reply being generated yet.
    fallbackGraceMs: 15_000,
  }
}
