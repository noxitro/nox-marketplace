#!/bin/bash
# Claude Code on the web のセッション開始時に走る (SessionStart フック)。
#
# 目的: クラウドのセッションからの commit / push にも共通の git フックを効かせる。
#   clone 直後のコンテナにはフックも gitleaks も無いので、エージェントの push は
#   push 後の CI (Secret scan) にしか掛からない。GitHub の push protection は
#   提携している発行元のトークン形式しか見ないため、個人メールやローカル絶対パスの
#   流入は pre-push で止めるしかない。
#
# やること (本体は noxitro/github-templates の git-hooks/):
#   1. github-templates を ~/.config/nox/github-templates に clone (あれば更新) する。
#   2. install.sh で global の core.hooksPath をそこへ向ける。
#   3. install-gitleaks.sh で gitleaks を固定バージョンで入れる。
#   どれが失敗してもセッションは止めない (gitleaks が無ければ組み込みパターンだけで検査する)。
#
# 手元 (Windows) では走らせない。手元の導入は github-templates の README の手順で 1 回だけ行う。
# settings.json 側でも同じ判定をしているが、直接呼ばれたときのためにここでも見る。
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# フックは同期で走るので、GitHub の応答が止まったときにセッションの開始を待たせ続けない。
limited() {
  if command -v timeout >/dev/null 2>&1; then timeout 60 "$@"; else "$@"; fi
}

dir="$HOME/.config/nox/github-templates"
if [ -d "$dir/.git" ]; then
  limited git -C "$dir" pull -q --ff-only || echo "session-start: github-templates の更新に失敗した。手元の版で続ける" >&2
else
  # 途中で打ち切られた clone を残すと、次回以降は「取得済み」と見なされて壊れたまま使われるので、
  # 一時ディレクトリに取ってから置き換える。
  # $dir が .git の無いディレクトリとして残っていると、mv がその中へ移して成功扱いになるので先に消す。
  # ここはこのフック専用の置き場で、手で置いたものを残す必要は無い。
  mkdir -p "$(dirname "$dir")"
  tmp="$dir.tmp.$$"
  rm -rf "$tmp"
  if limited git clone -q --depth 1 https://github.com/noxitro/github-templates "$tmp" && rm -rf "$dir" && mv "$tmp" "$dir"; then
    :
  else
    rm -rf "$tmp"
    echo "session-start: github-templates の取得に失敗した。フックは無効のまま" >&2
    exit 0
  fi
fi

# install.sh は実行した場所のリポジトリに残った旧方式の core.hooksPath も外すので、リポジトリの中で呼ぶ。
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || true
sh "$dir/git-hooks/install.sh" || echo "session-start: install.sh が失敗した。フックは無効のまま" >&2
sh "$dir/git-hooks/install-gitleaks.sh" >/dev/null ||
  echo "session-start: gitleaks の取得か検証に失敗した。組み込みパターンのみで検査する" >&2
exit 0
