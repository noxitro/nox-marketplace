// Copilot CLI extension: registers /m365, which relays a question to the Microsoft 365
// Copilot desktop window through UI Automation and shows the reply in the timeline.
// A slash command handler runs here, in this process; the Copilot CLI model is not called.

import { joinSession } from '@github/copilot-sdk/extension'
import { createCommand } from './lib/command.mjs'
import { createDriver } from './lib/driver.mjs'
import { loadConfig } from './lib/options.mjs'

const config = loadConfig(process.env)
let handler

const session = await joinSession({
  commands: [
    {
      name: 'm365',
      description: 'Microsoft 365 Copilot に質問を送り、返答を表示する(会話の要約を添える。モデルは呼ばない)',
      handler: (context) => handler(context),
    },
  ],
})

handler = createCommand({ session, call: createDriver({ driver: config.driver }), config })
