#!/bin/bash
# Claude Code の PreToolUse フック。エージェントの push が、共通の pre-push を通らずに外へ出るのを止める。
#
# 公開リポジトリでは push した時点で公開される。push の後の CI (Secret scan) では間に合わないので、
# pre-push が確実に走る形の push だけを通す。
#
#   Bash / PowerShell の git push : 単独の 1 行で、決まった形
#       (git push [-u] [--force-with-lease] [--delete] [--tags] [origin] [<ref>...]) のものだけを通す。
#       --no-verify (省略形を含む)、git と push の間のオプション (-c / -C など)、環境変数の代入、
#       ほかのコマンドとの組み合わせ (&&・;・| など) は止める。そのうえで、このリポジトリの実効の
#       core.hooksPath が共通のフックを指していること、nox.hooks が false でないことを確かめる
#       (フックを入れていない新しい端末や、SessionStart が失敗したクラウドのセッションで止まる)。
#   git send-pack / git lfs push / gh api での contents・git の書き込み : 常に止める (git のフックを通らない)。
#   gh repo create --push・git subtree push : 内部で git push するので、フックが入った環境かだけを確かめる。
#   MCP の GitHub ツールのうちファイルやコミットを書くもの (push_files など) : 常に止める。
#
# push かどうかは、引用符・コメント・ヒアドキュメントの中 (コミットメッセージや PR の本文) を除いて、git の後の最初の語
# (サブコマンド) で見る。git stash push や git commit -m "... push ..." は push ではない。
#
# 事故を防ぐためのもので、わざと抜けようとするエージェントへの境界ではない
# (スクリプトに書いて実行する push、GraphQL でのコミットなどは見ていない)。
#
# 入力は標準入力の JSON (tool_name / tool_input.command / cwd)。止めるときは終了コード 2 と標準エラーの理由。
# Bash・PowerShell・MCP のすべての呼び出しで走るので、関係しない入力は Python を起動する前に抜ける。
set -uo pipefail

deny() {
  echo "push-guard: $1" >&2
  echo "  push は、単独の 1 行の git push origin <ブランチ> で行う (共通の pre-push を通る形)。" >&2
  echo "  フックが入っていないと言われたら、自分で設定を変えずにユーザーに導入を頼む (github-templates の README)。" >&2
  exit 2
}

input=$(cat)

case "$input" in
  *push*|*send-pack*|*gh*api*|*commit_files*|*create_or_update_file*|*delete_file*|*create_commit*|*update_file*) ;;
  *) exit 0 ;;
esac

py=''
# pre-push (git-hooks/find-python.sh) と同じものを探す。
for c in python3 python; do
  if "$c" -c 'import sys; sys.exit(sys.version_info[0] != 3)' >/dev/null 2>&1; then py=$c; break; fi
done
# 読めないのに通さない。ここまで来た入力は push に関係しうる。
[ -n "$py" ] || deny "Python が無く、入力を読めないので push かどうか判定できない (Python 3 を入れる)。"

# 判定の本体は隣の push-guard.py (引用符の扱いや区切りの分割を sh で書くと誤りやすいため)。入力は標準入力で渡す。
result=$(printf '%s' "$input" | "$py" "$(dirname "$0")/push-guard.py" 2>&1) || deny "入力を読めなかった: $result"
verdict=$(printf '%s\n' "$result" | head -1)
rest=$(printf '%s\n' "$result" | tail -n +2)
case "$verdict" in
  allow) exit 0 ;;
  deny) deny "$rest" ;;
  check) ;;
  *) deny "判定できなかった: $result" ;;
esac

# 以下の判定は git 自身に読ませる。このフックはエージェントのコマンドと同じ環境変数で動くので、
# GIT_CONFIG_COUNT / GIT_CONFIG_GLOBAL などで設定を変えていても、push のときと同じ実効値が見える
# (認証や名義を GIT_CONFIG_* で与える環境もあるので、変数があること自体では止めない)。
cd "${rest:-.}" 2>/dev/null || deny "作業ディレクトリ ${rest:-} に入れない。"
hp=$(git config core.hooksPath 2>/dev/null || true)
[ -n "$hp" ] || deny "core.hooksPath が設定されていない (共通のフックが入っていない)。"
case "$hp" in
  /* | [A-Za-z]:[\\/]* | '~'*) ;;
  *) hp="$(git rev-parse --show-toplevel 2>/dev/null)/$hp" ;;
esac
case "$hp" in '~'*) hp="${HOME:-}${hp#\~}" ;; esac
for f in pre-push enabled.sh scan.sh; do
  [ -f "$hp/$f" ] || deny "core.hooksPath ($hp) が共通のフックを指していない ($f が無い)。"
done
[ "$(git config --bool nox.hooks 2>/dev/null)" != false ] || deny "このリポジトリは nox.hooks = false で、pre-push の検査が外れている。"
exit 0
