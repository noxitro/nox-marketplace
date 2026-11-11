// Text files given with --file or @path are embedded in the prompt. Only text is accepted:
// a real upload would need the attach UI of Microsoft 365 Copilot, which this does not drive.

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const decoder = new TextDecoder('utf-8', { fatal: true })

/** True when `path` (relative to `base`) names an existing regular file. */
export function isFile(path, base) {
  try {
    return statSync(resolve(base, path)).isFile()
  } catch {
    return false
  }
}

/**
 * Read the files. Returns { files: [{ path, text, lines }], problems }. Nothing is sent when
 * there are problems, so a missing or oversized file is never silently dropped.
 */
export function readAttachments(paths, { base, maxChars }) {
  const files = []
  const problems = []
  let total = 0
  for (const path of paths) {
    const abs = resolve(base, path)
    const shown = isAbsolute(path) ? path : relative(base, abs) || path
    let bytes
    try {
      bytes = readFileSync(abs)
    } catch (error) {
      problems.push(`${shown}: 読めません (${error.code ?? error.message})`)
      continue
    }
    let text
    try {
      if (bytes.subarray(0, 8192).includes(0)) throw new Error('binary')
      text = decoder.decode(bytes)
    } catch {
      problems.push(`${shown}: テキスト(UTF-8)として読めません。PDF や Office などのファイルは添付できません`)
      continue
    }
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    total += [...text].length
    files.push({ path: shown, text, lines: text ? text.split('\n').length : 0 })
  }
  if (total > maxChars)
    problems.push(`添付の合計が ${total} 文字で、上限の ${maxChars} 文字を超えています(M365_COPILOT_FILE_MAX_CHARS で変えられます)`)
  return { files, problems }
}

/** The prompt section that carries the files. */
export function attachmentBlock(files) {
  if (!files.length) return ''
  const parts = ['添付ファイル(中身をそのまま載せています):']
  for (const f of files) parts.push(`----- ${f.path}(${f.lines} 行)-----\n${f.text}\n----- ${f.path} ここまで -----`)
  return parts.join('\n\n')
}
