// Exercise the Veritas agent's projects and attachments end to end.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VeritasAgent } from '../electron/veritas/agent.ts'

const agent = new VeritasAgent()
const started = Date.now()

// 1. A second project, with its own folder and its own session.
const folder = path.join(os.tmpdir(), 'veritas-test-project')
fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(path.join(folder, 'SPEC.md'), 'The release checklist: tag, changelog, sign off.\n')

const status = agent.configure({ addProject: { name: 'Release', path: folder } })
const project = status.projects.find(p => p.name === 'Release')!
console.log('projects:', status.projects.map(p => `${p.name} (${p.path}) session=${p.sessionId.slice(0, 12)}…`).join(' | '))
console.log('current:', status.currentProject, '-> switching to Release')

agent.configure({ currentProject: project.id })

// 2. Ask with a file attached, from inside that project's folder.
const reply = await agent.ask('What is in the attached SPEC.md? One line.', 'app', [path.join(folder, 'SPEC.md')])
console.log(`\nask with attachment (${((Date.now() - started) / 1000).toFixed(1)}s):\n${reply.slice(0, 400)}`)

// 3. The transcript is per project.
const after = agent.status()
const mine = after.transcript.filter(e => e.projectId === project.id)
const general = after.transcript.filter(e => e.projectId !== project.id)
console.log(`\ntranscript -> Release: ${mine.length} entries, General: ${general.length} entries`)
console.log('release project session is separate:', project.sessionId !== after.projects[0].sessionId)

// 4. Memory is per project: the Release session should NOT know the General project's facts.
const memory = await agent.ask('What is my wifi network called? If you do not know, say so.', 'app')
console.log(`\nmemory check in the Release project: ${memory.slice(0, 200)}`)
