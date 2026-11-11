// Runs the UI Automation driver (m365-uia.ps1) once per action. Requests and results travel
// through UTF-8 JSON files, so no prompt text ever passes through a command line or a
// console code page.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'm365-uia.ps1')

export class DriverError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr })
    )
  })
}

/**
 * Create the function that performs one driver action.
 *
 * `driver` replaces the PowerShell script with a Node.js module whose default export takes
 * the request and returns the result. It exists so the extension can be exercised where
 * there is no Windows desktop. (It is imported, not spawned: inside Copilot CLI
 * `process.execPath` is the CLI itself, not Node.js.)
 */
export function createDriver({ driver, platform = process.platform }) {
  let replacement
  return async function call(request, timeoutMs = 60_000) {
    let result
    if (driver) {
      replacement ??= (await import(pathToFileURL(resolve(driver)).href)).default
      result = await replacement(request)
    } else {
      if (platform !== 'win32') throw new DriverError('unsupported_platform', 'UI Automation は Windows でしか使えません。')
      result = await runScript(request, timeoutMs)
    }
    if (!result?.ok) throw new DriverError(result?.error ?? 'driver_error', result?.message ?? '不明なエラー')
    return result
  }
}

async function runScript(request, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), 'm365-'))
  const requestFile = join(dir, 'request.json')
  const outFile = join(dir, 'result.json')
  try {
    await writeFile(requestFile, JSON.stringify(request), 'utf8')
    const { error, stderr } = await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-RequestFile', requestFile, '-OutFile', outFile],
      timeoutMs
    )
    try {
      return JSON.parse((await readFile(outFile, 'utf8')).replace(/^\ufeff/, ''))
    } catch {
      const why = error?.killed ? '時間内に終わりませんでした' : (stderr || error?.message || '結果がありません').trim()
      throw new DriverError('driver_failed', `UI Automation ドライバを実行できませんでした: ${why}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
