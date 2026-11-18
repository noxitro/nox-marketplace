// GitHub Copilot の拡張。モデルは呼ばない(セッションの記録をランタイムから読んでファイルに書くだけ)。
//
// /export [file] [session] [パス]  Copilot CLI の /export file と同じ Markdown を書き出す。
//                                   パスなし → 作業フォルダの copilot-session-<ID>.md、フォルダ → その中、.md → そのファイル。
//                                   Copilot CLI(ターミナル)では組み込みの /export が優先され、この拡張のものは出ない。
//                                   デスクトップ アプリなど、組み込みの /export が無いところで使う。
// /export-usage [パス]              上と同じ Markdown に、返答ごとのトークンと AI クレジット、役 × モデルごとの合計を足す。
//                                   パスなし → 作業フォルダの copilot-session-<ID>-usage.md。/export usage [パス] でも同じ
//
// 相対パスはセッションの作業フォルダから解決する。
import { joinSession } from "@github/copilot-sdk/extension";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cliOutputPath, lastCwd, parseExportArgs, renderCliExport } from "./render-cli.mjs";

// 結果の 1 行は記録に残さない(残すと、次に書き出したときに「Info」として載る)
const tell = (message, level) => session.log(message, { ephemeral: true, ...(level ? { level } : {}) });

// 呼び出しごとの使用量(session.usage_record)は記録ファイルには残るが、getEvents() には含まれない(1.0.99 で確認)。
// セッションの作業フォルダの events.jsonl から、そのイベントだけを読み足す
function withUsageRecords(events, sessionId) {
  if (events.some((e) => e.type === "session.usage_record")) return events;
  const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  for (const dir of [session.workspacePath, join(home, "session-state", sessionId)]) {
    const f = dir && join(dir, "events.jsonl");
    if (!f || !existsSync(f)) continue;
    const records = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.includes('"session.usage_record"'))
      .flatMap((l) => {
        try {
          const e = JSON.parse(l);
          return e.type === "session.usage_record" ? [e] : [];
        } catch {
          return [];
        }
      });
    // 返答より後ろに置いても、apiCallId で結び付くので位置は問わない
    return [...events, ...records];
  }
  return events;
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

// 書き出した先を知らせる。デスクトップ アプリはセッションのログを画面に出さないので、
// ダイアログを出せるところでは確認ダイアログで知らせ、求められたらフォルダを開く(ダイアログは記録に残らない)
async function announce(message, file) {
  await tell(message);
  if (!session.capabilities?.ui?.elicitation) return;
  try {
    if (await session.ui.confirm(`${message}\nフォルダを開きますか?`)) openFolder(file);
  } catch {
    // ダイアログを出せなくても書き出しは済んでいる
  }
}

function openFolder(file) {
  const [cmd, args] =
    process.platform === "win32" ? ["explorer.exe", [`/select,${file}`]] : process.platform === "darwin" ? ["open", ["-R", file]] : ["xdg-open", [dirname(file)]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

// /export と /export-usage の本体。/export usage(引数での指定)も残す
async function exportSession(ctx, forceUsage) {
  const name = forceUsage ? "export-usage" : "export";
  try {
    const a = parseExportArgs(ctx.args);
    if (a.unsupported) {
      await tell(`/${name} ${a.unsupported} には対応していない(この拡張は file だけ)。/${name} [パス] で Markdown に書き出す。`, "warning");
      return;
    }
    const usage = forceUsage || a.usage;
    const now = new Date();
    const events = await session.getEvents();
    const cwd = lastCwd(events) || process.cwd();
    const file = cliOutputPath(a.path, cwd, ctx.sessionId, { resolve, join, isAbsolute }, usage ? "-usage" : "");
    let metrics = null;
    if (usage) {
      try {
        metrics = await session.rpc.usage.getMetrics();
      } catch {
        // 使用量の API は実験的。取れなくても呼び出しごとの記録から合計を作る
      }
    }
    const evs = usage ? withUsageRecords(events, ctx.sessionId) : events;
    write(file, renderCliExport({ events: evs, sessionId: ctx.sessionId, now, cwd, withUsage: usage, metrics }));
    await announce(`Session exported to: ${file}`, file);
  } catch (err) {
    await tell(`/${name} に失敗しました: ${err?.message ?? err}`, "error");
  }
}

const session = await joinSession({
  commands: [
    {
      // 拡張のコマンドには引数のヒント(組み込みの input)を付けられないので、説明文の先頭に引数を書く
      name: "export",
      description: "[パス] — Copilot CLI の /export file と同じ Markdown にセッションを書き出す(モデルは呼ばない)",
      handler: (ctx) => exportSession(ctx, false),
    },
    {
      name: "export-usage",
      description: "[パス] — /export に返答ごとのトークンと AI クレジット、役 × モデルごとの合計を足して書き出す(モデルは呼ばない)",
      handler: (ctx) => exportSession(ctx, true),
    },
  ],
});
