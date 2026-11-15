"""どのファイルに UTF-8 BOM を付けるかの決まり (このリポジトリ用)。

noxitro/github-templates の file-format.yml (check-file-format.py) が、既定の決まりの代わりに使う。

このリポジトリのテキストファイルは、PowerShell スクリプトも含めて BOM なしの UTF-8 にする。
既定の決まりは *.ps1 / *.psm1 / *.psd1 に BOM を求めるが、ここでは採らない。
m365 のドライバ (shared/extensions/m365/m365-uia.ps1) は ASCII だけで書き、BOM を付けない。
Windows PowerShell 5.1 は BOM の無いスクリプトをシステムのコードページで読むが、
ASCII だけならどのコードページでも同じに読める。ASCII だけであることは
tests/m365.test.mjs の「ASCII-only」のテストが確かめていて、BOM を付けるとそのテストが落ちる。
.editorconfig の charset もこれと揃えること。
"""

import fnmatch

# BOM が必要なもの
REQUIRED = []

# どちらでもよいもの
ANY = []

REQUIRED_POLICY = "required"
FORBIDDEN_POLICY = "forbidden"
ANY_POLICY = "any"


def policy(path):
    """path (リポジトリのルートからの / 区切りのパス) の BOM の決まりを返す。"""
    if any(fnmatch.fnmatch(path, p) for p in REQUIRED):
        return REQUIRED_POLICY
    if any(fnmatch.fnmatch(path, p) for p in ANY):
        return ANY_POLICY
    return FORBIDDEN_POLICY
