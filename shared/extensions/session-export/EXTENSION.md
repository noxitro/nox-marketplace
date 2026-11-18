---
name: session-export
description: /export と /export-usage コマンド。セッションの記録を、Copilot CLI の /export file と同じ Markdown に書き出す。/export-usage は、返答ごとのトークンと AI クレジット、役 × モデルごとの合計を足す。モデルは呼ばない。
targets: [copilot]
harness:
  copilot:
    plugin: session-export
---

# session-export

Copilot CLI と GitHub Copilot app のセッションに 2 つのコマンドを足す拡張。セッションの記録をランタイムから読み、
Markdown のファイルに書き出す。モデルは呼ばないので、トークンも AI クレジットも使わない。

- `/export`: Copilot CLI の `/export file` と同じ Markdown。
- `/export-usage`: 上の Markdown に、返答ごとの使用量と、セッション全体の合計を足したもの。

Copilot CLI(ターミナル)には組み込みの `/export` があり、拡張のコマンドより優先される(組み込みと同じ名前の
拡張のコマンドは一覧に出ない)。この拡張の `/export` は、組み込みの `/export` が無いホスト(SDK でランタイムを
動かすアプリなど)のためのもの。`/export-usage` はどこでも使える。

## 使い方

| 打つもの | 書き出す先 |
| --- | --- |
| `/export` または `/export file` | 作業フォルダの `copilot-session-<セッション ID>.md`(CLI と同じ) |
| `/export <フォルダ>` | そのフォルダの中に同じ名前で |
| `/export <パス>.md` | そのファイル(上書き) |
| `/export-usage [パス]` | パスなしは作業フォルダの `copilot-session-<セッション ID>-usage.md`。パスの扱いは `/export` と同じ |

- 相対パスはセッションの作業フォルダから解決する。
- `/export usage [パス]` は `/export-usage [パス]` と同じ。
- CLI の `/export` のサブコマンドのうち `html`・`gist`・`link`・`off`・`research` には対応していない(警告だけ出す)。
- 拡張のコマンドには引数のヒント(入力欄の候補)を付けられないので、一覧の説明文の先頭に引数を書いている。

書き出した先は、記録に残らない 1 行(`session.log` の `ephemeral`)で知らせる。確認ダイアログを出せるホストでは、
続けて「フォルダを開きますか?」と尋ね、Accept でファイルの場所を開く(Windows はエクスプローラー、macOS は Finder、
Linux は `xdg-open` でフォルダ)。どちらも記録に残らないので、次の書き出しには載らない。

## 仕組み

1. 拡張(`extension.mjs`)が `joinSession({ commands })` で `/export` と `/export-usage` を登録する。スラッシュコマンドの
   ハンドラは拡張のプロセスで動き、モデルには何も送らない。
2. 記録は `session.getEvents()` から読む。CLI がイベントから画面のタイムラインを組み、それを Markdown にする 2 段を
   なぞって書き出す(`render-cli.mjs`)。
3. `/export-usage` では、ランタイムが呼び出しごとに残す `session.usage_record` を使う。このイベントは `getEvents()` に
   含まれないので、セッションのフォルダ(`session.workspacePath`、無ければ `$COPILOT_HOME` か `~/.copilot` の
   `session-state/<セッション ID>/`)の `events.jsonl` から読み足し、`apiCallId` で返答に結び付ける。

`/export-usage` が足すもの:

- 冒頭の `### Usage`: セッション全体の AI クレジットと呼び出し回数、役(main と委譲先のエージェント)× モデルごとの
  呼び出し回数・AI クレジット・入力・キャッシュ読み・キャッシュ書き・出力・推論のトークン。
- 各返答の下の 1 行(`<sub>Usage: モデル · in 入力 (cache read … / write …) · out 出力 · reasoning 推論 · AI クレジット · 所要時間</sub>`)。
  本文の無い返答(ツールを呼んだだけのもの)は、その返答の最後のツールの下に付く。委譲先の呼び出しは、委譲のまとまりの中に付く。

呼び出しごとの記録が無いセッションでは、返答ごとの行は付かず、合計だけをランタイムの集計
(`session.rpc.usage.getMetrics()`。実験的な API)から出す。合計の行に出どころを書く。

## 注意

- CLI の画面にだけ出た表示(ヒント、シェルの途中出力、フックの進捗)は記録に無いので入らない。所要時間と
  書き出した時刻は、この拡張で書き出した時点のもの。
- 書式は Copilot CLI 1.0.100 の `/export file` の出力に合わせた。CLI の版上げで書式が変わることがあるので、そのときは
  CLI の出力と突き合わせて `render-cli.mjs` を直す。
- 書き出したファイルには依頼文と応答が全文で入る。エージェントが読んだ設定ファイルなどの中身が混ざることがあるので、
  人に渡すときは中身を確かめる。
- 拡張は Copilot CLI の実験的な機能で、版上げで API や有効にする方法が変わることがある。
- 拡張はセッションができてから読み込まれる。新しいセッションの最初の入力に打った `/export` は、コマンドとしてではなく
  依頼としてモデルに送られることがある。一覧に出ているのを確かめてから使う。
- テストは `tests/session-export.test.mjs`。`render-cli.mjs` は合成したイベント列で、`extension.mjs` はフェイクの SDK
  (`tests/fixtures/`)で、登録するコマンドと書き出しを確かめる。
