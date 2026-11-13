# nox-marketplace

Claude Code と GitHub Copilot CLI のプラグインのマーケットプレイス。skill・command・agent・extension を
1 つのソース(`shared/`)から各ハーネスの形に生成して配る。OpenCode 向けの生成物も同じソースから作る。

## プラグイン

| 名前 | 対象 | 内容 |
| --- | --- | --- |
| `independent-review` | Copilot CLI | カスタムエージェント `independent-reviewer`。変更を、実装した会話とは別の文脈で読み直し、ビルドとテストを自分で走らせて、正しさの問題を根拠付きで報告する。コードは直さない |
| `m365` | Copilot CLI | `/m365`・`/m365-raw` コマンド。質問を UI Automation 経由で Microsoft 365 Copilot のデスクトップアプリへ送り、返答をセッションに表示する。返答の指示(プロファイル)とテキストの添付に対応。Windows 専用 |

## 使う

### Claude Code

```bash
claude plugin marketplace add noxitro/nox-marketplace
```

```bash
claude plugin install <プラグイン名>@nox-marketplace
```

Claude Code では、プラグインの skill は名前の前にプラグイン名が付く(`/<プラグイン名>:<skill 名>`)。

### GitHub Copilot CLI

```bash
copilot plugin marketplace add noxitro/nox-marketplace
```

```bash
copilot plugin install <プラグイン名>@nox-marketplace
```

Copilot CLI は `.github/plugin/marketplace.json` を `.claude-plugin/marketplace.json` より先に探すので、
Copilot 向けに生成したプラグイン(`copilot-plugins/`)だけが見える。

#### independent-review

```bash
copilot plugin install independent-review@nox-marketplace
```

カスタムエージェント `independent-reviewer` が入る。変更を実装したセッションの中から呼ぶと、サブエージェントとして
別の文脈で動くので、実装中のやり取りを知らない目で差分を読み直す。

```text
independent-reviewer エージェントで、未コミットの変更を独立レビューして
independent-reviewer エージェントで、main から分かれた後の差分をレビューして
```

対話モードでは `/agent` の一覧からも選べる。レビューだけを 1 回走らせるときは、次のように起動する。

```bash
copilot --agent independent-reviewer --allow-tool='shell(git:*)' --prompt "未コミットの変更を独立レビューして"
```

`--prompt` での実行は許可を尋ねられないので、許可していないツールの要求は拒否される。差分を読むための `git` と、
テストを走らせるコマンド(`shell(npm:*)` など)を `--allow-tool` で許可しておく。許可した範囲のコマンドは
確認なしで動くので、広く許可するほど、下に書く「書き込まない」は指示だけが頼りになる。

- 範囲を言わなければ、未コミットの変更を、それが無ければ既定のブランチから分かれた後の差分を対象にする。
- 報告は、判定(要修正 / 問題なし / 判定できない)、必須の指摘(場所・条件・確度・根拠・直し方の案)、参考の所見、
  確かめたこと、確かめられなかったことの順に返る。
- 渡すツールは `read`・`search`・`execute` で、編集のツールは渡さない。ただしテストを走らせるためにシェルを
  使えるので、「書き込まない」はエージェントへの指示であって、仕組みによる保証ではない。
- モデルは定義で固定していない。実装したセッションの中から呼ぶと、そのセッションのモデルを引き継ぐ。
  レビューだけを 1 回走らせるときは、`--model` で実装に使ったのとは別のモデルを選ぶと、同じ見落としが重なりにくい。
- 同じ名前(ファイル名 `independent-reviewer`)のエージェントが個人やプロジェクトの側にあると、そちらが優先され、
  プラグインのものは読まれない。

#### m365

```bash
copilot plugin install m365@nox-marketplace
```

拡張(extension)は Copilot CLI の実験的な機能なので、`copilot --experimental` で起動するか、セッションで
`/settings experimental on` を実行しておく。Microsoft 365 Copilot のデスクトップアプリを開いた状態で使う。

```text
/m365 <質問>                  既定のプロファイルで送る(会話の要約は 2 回目以降、前回からの差分だけ)
/m365 --profile <名前> <質問>  m365.json のプロファイル(返答の指示・JSON の形)を選んで送る
/m365 --file <パス> <質問>     テキストファイルの中身を添えて送る(質問の中の @パス も添付になる)
/m365 --new <質問>            M365 側で新しいチャットを始め、会話全体の要約を添えて送る
/m365 --no-context <質問>     会話の要約を添えない
/m365 --dry <質問>            送らずに、送る予定の文面だけを表示する
/m365 --profiles              読み込んだプロファイルの一覧
/m365 --inspect               M365 Copilot のウィンドウから見える UI 要素を書き出す
/m365-raw <質問>              プロファイルも添付も使わず、質問と会話の要約だけを送る
```

どちらも拡張のプロセスで動くスラッシュコマンドで、Copilot CLI のモデルを呼ばない。会話の圧縮も文字列の
処理だけで行う。添える会話には、GitHub Copilot が行った作業(編集したファイル・実行したコマンドと失敗)と、
質問に関係する古い発言を含める。Copilot CLI が会話を圧縮した後は、CLI が作った要約をそのまま使う。プロファイルの書き方(見本は `m365.example.json`)・設定(環境変数)・注意点は [shared/extensions/m365/EXTENSION.md](shared/extensions/m365/EXTENSION.md) にある。

### OpenCode

OpenCode にはマーケットプレイスが無い。この clone の `dist/opencode` をユーザー環境変数 `OPENCODE_CONFIG_DIR` に
指定すると、OpenCode はそのフォルダの `agent/`・`command/` をグローバルの設定に足して読む。

```powershell
[Environment]::SetEnvironmentVariable('OPENCODE_CONFIG_DIR', '<この clone のパス>\dist\opencode', 'User')
```

## 構成

```text
shared/                 資産の単一ソース。編集するのはここだけ
  skills/<name>/SKILL.md
  commands/<name>.md
  agents/<name>.md
  extensions/<name>/    Copilot CLI の拡張。EXTENSION.md(frontmatter と説明)と extension.mjs、その他のファイル
plugins/<name>/         Claude Code のプラグイン(skills・commands・agents は生成物、.claude-plugin/plugin.json は手書き)
copilot-plugins/<name>/ Copilot CLI のプラグイン(skills・agents・extensions は生成物、plugin.json は手書き)
dist/opencode/          OpenCode 向けの生成物(agent/・command/)
.claude-plugin/marketplace.json   Claude Code のマーケットプレイス定義
.github/plugin/marketplace.json   Copilot CLI のマーケットプレイス定義
scripts/                build.mjs(生成)・validate.mjs(契約と定義の検査)
tests/                  拡張のコードのテスト(node --test)
toolkit.config.json     既定の出力先プラグイン(claudePlugin)。無ければ toolkit-core
```

生成物もコミットする(ビルドなしで入れられるように)。CI が `shared/` との食い違いを落とす。

## 資産の書き方

`shared/` の各ファイルは YAML の frontmatter を持つ。

```yaml
---
name: example-skill          # ファイル名(skill はフォルダ名)と一致させる。小文字英数字とハイフン、64 字まで
description: いつ使うか      # 1024 字まで
targets: [claude, opencode, copilot]
harness:                     # 任意。ハーネスごとの上書き
  claude:
    plugin: example          # 出力先のプラグイン。plugins/example/.claude-plugin/plugin.json が先に要る
    frontmatter: { model: opus }
  opencode:
    frontmatter: { mode: subagent }
  copilot:
    skip: true               # このハーネスには出さない
---
```

- `targets` に `copilot` を含む資産は、同じ名前の Copilot プラグイン(`copilot-plugins/<plugin>/plugin.json` が要る)にも出る。
  Copilot 向けの command は出せない(プラグインのコマンド形式が公式文書に無いため)。
  モデルを通さずに動かしたいコマンドは、extension がスラッシュコマンドとして登録する。
- extension は Copilot CLI だけのもの(`targets: [copilot]`)。フォルダの中身を、`EXTENSION.md` を除いてそのまま
  `copilot-plugins/<plugin>/extensions/<name>/` へ写す。Claude Code 側に同じ名前のプラグインが無いときは、
  出力先を `harness.copilot.plugin` で指定する。
- OpenCode では、skill は command として出る(command の `agent:` で実行するエージェントを固定できるため)。
- 本文の `{{ARGS}}` は、各ハーネスの引数の書き方に置き換わる。
- 本文にマシン固有の絶対パスを書かない(validate が落とす)。パスは設定や引数で渡す。

プラグインを足したら、定義(`plugin.json`)と両方の `marketplace.json` を同じ変更で直す。
定義があるのにマーケットプレイスに載っていないプラグインは、validate が落とす。

## 開発

必要なもの: Node.js 22 以上。

```bash
npm install
```

```bash
npm run build
```

```bash
npm run check
```

`build` は `plugins/*/{skills,commands,agents}`・`copilot-plugins/*/{skills,agents,extensions}`・`dist/` を消して作り直す。
`check` は frontmatter の契約とマーケットプレイスの定義を検査し、生成物が最新かを確かめ、テストを走らせる。

```bash
npm run smoke
```

`smoke` は、本物の Copilot CLI(`copilot` か `COPILOT_BIN`)にこのマーケットプレイスからプラグインを入れ、
対話画面でコマンドに応答があることと、モデルを使っていないこと(使用量がゼロ)を確かめる。tmux が要る。
ログインは不要で、一時的な `COPILOT_HOME` を使うので、普段の設定には触れない。

CI(`.github/workflows/ci.yml`)では次を確かめる。

| ジョブ | いつ | 内容 |
| --- | --- | --- |
| Validate and check generated output | 毎回 | 定義の検査と、生成物が `shared/` と一致するか |
| Test | 毎回 | テストを Linux と Windows、Node 22 と 24 で。UI Automation のドライバのテストは Windows でだけ動く |
| Copilot CLI smoke test | `main`・毎週・手動 | `npm run smoke` を最新の Copilot CLI で |
| Markdown lint | 毎回 | Markdown の書式 |

## 変更の流れ

`main` は直接変更しない。ブランチを切って PR を作り、持ち主がマージする(→ [AGENTS.md](AGENTS.md))。

## License

[MIT](LICENSE)
