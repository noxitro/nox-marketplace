# nox-marketplace

Claude Code と GitHub Copilot CLI のプラグインのマーケットプレイス。skill・command・agent を
1 つのソース(`shared/`)から各ハーネスの形に生成して配る。OpenCode 向けの生成物も同じソースから作る。

いまは骨組みだけで、プラグインはまだ載っていない。

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
plugins/<name>/         Claude Code のプラグイン(skills・commands・agents は生成物、.claude-plugin/plugin.json は手書き)
copilot-plugins/<name>/ Copilot CLI のプラグイン(skills・agents は生成物、plugin.json は手書き)
dist/opencode/          OpenCode 向けの生成物(agent/・command/)
.claude-plugin/marketplace.json   Claude Code のマーケットプレイス定義
.github/plugin/marketplace.json   Copilot CLI のマーケットプレイス定義
scripts/                build.mjs(生成)・validate.mjs(契約と定義の検査)
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
- OpenCode では、skill は command として出る(command の `agent:` で実行するエージェントを固定できるため)。
- 本文の `{{ARGS}}` は、各ハーネスの引数の書き方に置き換わる。
- 本文にマシン固有の絶対パスを書かない(validate が落とす)。パスは設定や引数で渡す。

プラグインを足したら、定義(`plugin.json`)と両方の `marketplace.json` を同じ変更で直す。
定義があるのにマーケットプレイスに載っていないプラグインは、validate が落とす。

## 開発

必要なもの: Node.js 20 以上。

```bash
npm install
```

```bash
npm run build
```

```bash
npm run check
```

`build` は `plugins/*/{skills,commands,agents}`・`copilot-plugins/*/{skills,agents}`・`dist/` を消して作り直す。
`check` は frontmatter の契約とマーケットプレイスの定義を検査し、生成物が最新かを確かめる。

## 変更の流れ

`main` は直接変更しない。ブランチを切って PR を作り、持ち主がマージする(→ [AGENTS.md](AGENTS.md))。

## License

[MIT](LICENSE)
