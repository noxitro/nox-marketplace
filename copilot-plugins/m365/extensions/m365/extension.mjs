// Copilot CLI extension: registers /m365 and /m365-raw, which relay a question to the
// Microsoft 365 Copilot desktop window through UI Automation and show the reply in the
// timeline. A slash command handler runs here, in this process; the Copilot CLI model is not
// called.

import { joinSession } from '@github/copilot-sdk/extension'
import { createCommands } from './lib/command.mjs'
import { createDriver } from './lib/driver.mjs'
import { loadConfig } from './lib/options.mjs'

const config = loadConfig(process.env)
let handlers

const session = await joinSession({
  commands: [
    {
      name: 'm365',
      description: 'Microsoft 365 Copilot に質問を送る(m365.json のプロファイルとテキスト添付に対応。モデルは呼ばない)',
      handler: (context) => handlers.m365(context),
    },
    {
      name: 'm365-raw',
      description: 'Microsoft 365 Copilot に質問と会話の要約だけを送る(モデルは呼ばない)',
      handler: (context) => handlers.raw(context),
    },
  ],
})

handlers = createCommands({ session, call: createDriver({ driver: config.driver }), config })
