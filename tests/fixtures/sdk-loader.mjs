// Lets extension.mjs run outside Copilot CLI: `node --import <this file> extension.mjs`.
// Copilot CLI provides @github/copilot-sdk to its extensions; here it is replaced by
// fake-sdk.mjs, which records what the extension registers.
import { register } from 'node:module'

register('./sdk-hooks.mjs', import.meta.url)
