// Reproduce the Veritas agent's ask() path outside Electron, with the app's environment.
import { VeritasAgent } from '../electron/veritas/agent.ts'

const agent = new VeritasAgent()
const started = Date.now()

try {
  const reply = await agent.ask(process.argv[2] ?? 'say hi in one word')
  console.log(`\nOK in ${((Date.now() - started) / 1000).toFixed(1)}s:\n${reply.slice(0, 600)}`)
} catch (error) {
  console.log(`\nFAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
