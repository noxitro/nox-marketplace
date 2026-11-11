// Command-line parsing for /m365 and the settings read from environment variables.

export const USAGE = `**/m365** — Microsoft 365 Copilot に質問を送り、返答をここに表示します(GitHub Copilot のモデルは呼びません)。

- \`/m365 <質問>\` これまでの会話を圧縮して添え、質問を送る。2 回目以降は前回からの差分だけを添える
- \`/m365 --new <質問>\` M365 側で新しいチャットを始め、会話全体の要約を添えて送る
- \`/m365 --full <質問>\` いまのチャットのまま、会話全体の要約を添え直して送る
- \`/m365 --raw <質問>\` 会話を添えず、質問だけを送る
- \`/m365 --dry <質問>\` 送らずに、送る予定の文面だけを表示する
- \`/m365 --inspect\` M365 Copilot のウィンドウから見える UI 要素を書き出す(設定の調整用)`

const FLAGS = new Set(['new', 'full', 'raw', 'dry', 'inspect', 'help'])

/** Leading `--flag` words are options; the rest, untouched, is the question. */
export function parseArgs(args) {
  const flags = {}
  let rest = String(args ?? '').trim()
  for (;;) {
    const m = /^--([a-z]+)(?:\s+|$)/.exec(rest)
    if (!m) break
    if (!FLAGS.has(m[1])) return { error: `不明なオプション: --${m[1]}` }
    flags[m[1]] = true
    rest = rest.slice(m[0].length)
  }
  const picked = ['new', 'full', 'raw'].filter((f) => flags[f])
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
      // Process name of the target window. Empty: any process whose window title matches.
      process: env.M365_COPILOT_PROCESS || '',
    },
    budget: positiveInt(env.M365_COPILOT_MAX_CHARS, 6000),
    timeoutMs: positiveInt(env.M365_COPILOT_TIMEOUT_SEC, 180) * 1000,
    stableMs: positiveInt(env.M365_COPILOT_STABLE_MS, 3000),
    pollMs: positiveInt(env.M365_COPILOT_POLL_MS, 1500),
    driver: env.M365_COPILOT_DRIVER || '',
  }
}
