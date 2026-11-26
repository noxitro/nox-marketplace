// The code-review plugin is three prompts that have to agree with each other: the skill names
// the subagents it calls and the levels it accepts, and the subagents must not be handed an
// editing tool. Nothing runs these prompts in CI, so the checks here are about that agreement.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = join(root, 'copilot-plugins', 'code-review')

function read(file) {
  const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  const end = text.indexOf('\n---', 3)
  return { data: YAML.parse(text.slice(4, end)), body: text.slice(end + 4) }
}

const skill = read(join(plugin, 'skills', 'code-review', 'SKILL.md'))
const AGENTS = ['code-review-finder', 'code-review-verifier']
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const VERDICTS = ['確認済み', 'ありうる', '棄却']
const SEVERITIES = ['重要', '既存', '軽微']

test('code-review: skill が呼ぶサブエージェントは、同じプラグインに入っている', () => {
  // Copilot CLI lists a plugin's agent as <plugin>:<agent>; the bare name does not resolve.
  const called = [...skill.body.matchAll(/`code-review:(code-review-[a-z-]+)`/g)].map((m) => m[1])
  assert.deepEqual([...new Set(called)].sort(), AGENTS)
  const bare = [...skill.body.matchAll(/task ツールでカスタムエージェント `([^`]+)`/g)].map((m) => m[1])
  assert.deepEqual(bare.sort(), AGENTS.map((name) => `code-review:${name}`))
  for (const name of AGENTS) assert.ok(existsSync(join(plugin, 'agents', `${name}.agent.md`)), name)
})

test('code-review: サブエージェントに編集のツールを渡さない', () => {
  for (const name of AGENTS) {
    const { data } = read(join(plugin, 'agents', `${name}.agent.md`))
    assert.equal(data.name, name)
    assert.deepEqual(data.tools, ['read', 'search', 'execute'])
  }
})

test('code-review: レベルの表は、引数で受け付ける 5 つのレベルを 1 行ずつ持つ', () => {
  const rows = [...skill.body.matchAll(/^\| `([a-z]+)` \|.*\| (\d+) \|$/gm)].map((m) => [m[1], Number(m[2])])
  assert.deepEqual(rows.map(([level]) => level), LEVELS)
  const caps = rows.map(([, cap]) => cap)
  assert.deepEqual(caps, [...caps].sort((a, b) => a - b), '上限はレベルとともに増える')
  assert.equal(new Set(caps).size, caps.length)
})

test('code-review: 判定と重大度の語は、skill とサブエージェントで揃っている', () => {
  const bodies = [skill.body, ...AGENTS.map((name) => read(join(plugin, 'agents', `${name}.agent.md`)).body)]
  for (const body of bodies) for (const word of SEVERITIES) assert.ok(body.includes(word), word)
  // The finder proposes a severity only; verdicts belong to the skill and the verifier.
  for (const body of [bodies[0], bodies[2]]) for (const word of VERDICTS) assert.ok(body.includes(word), word)
})

test('code-review: 観点 A〜G はどのレベルの組分けでも、1 回ずつ割り当てられる', () => {
  const line = skill.body.split('\n').find((l) => l.startsWith('組の分け方'))
  assert.ok(line, '組の分け方の行がある')
  const groupings = [...line.matchAll(/`(high|xhigh)` は ([A-G+ /]+)/g)]
  assert.deepEqual(groupings.map((m) => m[1]), ['high', 'xhigh'])
  const expected = { high: 3, xhigh: 5 }
  for (const [, level, text] of groupings) {
    const groups = text.trim().split(' / ')
    assert.equal(groups.length, expected[level], `${level} の組の数は、表の探索役の体数と同じ`)
    assert.deepEqual(groups.flatMap((g) => g.split('+')).sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  }
  for (const letter of 'ABCDEFG') assert.match(skill.body, new RegExp(`^\\| ${letter} \\|`, 'm'))
})

test('code-review: プラグインの定義は skill と agents の場所を指している', () => {
  const manifest = JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8'))
  assert.equal(manifest.skills, 'skills')
  assert.equal(manifest.agents, 'agents')
})
