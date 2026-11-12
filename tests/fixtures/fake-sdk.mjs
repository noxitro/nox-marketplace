// Stand-in for @github/copilot-sdk/extension. joinSession() records the commands the
// extension registers, runs each with --help once the extension has finished starting, and
// prints the result as JSON on stdout.
export async function joinSession(config) {
  const logs = []
  const session = {
    log: async (message, options = {}) => void logs.push({ message, ...options }),
    getEvents: async () => [],
  }
  setTimeout(async () => {
    const out = { commands: (config.commands ?? []).map((c) => ({ name: c.name, description: c.description })), help: {} }
    for (const c of config.commands ?? []) {
      await c.handler({ sessionId: 'test', command: `/${c.name} --help`, commandName: c.name, args: '--help' })
      out.help[c.name] = logs.at(-1)?.message
    }
    process.stdout.write(JSON.stringify(out))
  }, 0)
  return session
}
