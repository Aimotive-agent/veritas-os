import http from 'node:http'
import os from 'node:os'
import type { AgentManager } from '../agents/manager.ts'
import { hostPlatform } from '../platform/index.ts'
import { log } from '../log.ts'

/*
 * A small MCP server Veritas OS hosts on loopback so OpenCode (the Veritas agent) can see and drive
 * the machine: every agent, every installed app, and the system itself. OpenCode connects to it as a
 * remote MCP server; the tools below are what make OpenCode the operator of the whole OS.
 */

const PORT = 4317

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<string>
}

const stringArg = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '')

interface VeritasShell {
  showPage: (page: string) => void
  notify: (title: string, body: string) => void
  sendTelegram: (text: string) => Promise<string>
}

const SHELL_PAGES = ['overview', 'hermes', 'veritas', 'agents', 'browser', 'missions', 'memory', 'files', 'automations', 'connections', 'settings']

function agentList(agents: AgentManager): string {
  const rows = agents.list().map(agent => `${agent.id} (${agent.name}): ${agent.phase}${agent.port ? ` :${agent.port}` : ''}`)

  return rows.length ? rows.join('\n') : 'No agents are registered.'
}

export class VeritasMcpServer {
  private server: http.Server | null = null

  constructor(
    private readonly agents: AgentManager,
    private readonly shell: VeritasShell
  ) {}

  port(): number {
    return PORT
  }

  start(): void {
    if (this.server) {
      return
    }

    this.server = http.createServer((request, response) => {
      if (request.method !== 'POST' || !request.url?.startsWith('/mcp')) {
        response.writeHead(405, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'POST /mcp only' }))
        return
      }

      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => {
        body += chunk
      })
      request.on('end', () => {
        void this.respond(body, response)
      })
    })

    this.server.on('error', error => log('mcp', `server error: ${error.message}`))
    this.server.listen(PORT, '127.0.0.1', () => log('mcp', `Veritas MCP listening on http://127.0.0.1:${PORT}/mcp`))
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async respond(raw: string, response: http.ServerResponse): Promise<void> {
    let request: { id?: unknown; method?: string; params?: Record<string, unknown> }

    try {
      request = JSON.parse(raw) as typeof request
    } catch {
      this.reply(response, undefined, { code: -32700, message: 'Parse error' })
      return
    }

    try {
      const result = await this.dispatch(request.method ?? '', request.params ?? {})
      // Notifications have no id and expect no response.
      if (request.id === undefined) {
        response.writeHead(202).end()
        return
      }
      this.reply(response, request.id, undefined, result)
    } catch (error) {
      this.reply(response, request.id, { code: -32603, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private reply(response: http.ServerResponse, id: unknown, error?: { code: number; message: string }, result?: unknown): void {
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id: id ?? null }

    if (error) {
      payload.error = error
    } else {
      payload.result = result ?? {}
    }

    response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    response.end(JSON.stringify(payload))
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: params.protocolVersion ?? '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'veritas', title: 'Veritas OS', version: '0.1.0' }
        }
      case 'notifications/initialized':
        return {}
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: this.toolSpecs() }
      case 'tools/call': {
        const name = stringArg(params, 'name')
        let args: Record<string, unknown> = {}

        try {
          args = (params.arguments ?? {}) as Record<string, unknown>
        } catch {
          args = {}
        }

        const tool = this.tools().find(candidate => candidate.name === name)

        if (!tool) {
          throw new Error(`no tool named ${name}`)
        }

        const text = (await tool.run(args)).slice(0, 4000)
        return { content: [{ type: 'text', text }] }
      }
      default:
        throw new Error(`unknown method ${method}`)
    }
  }

  private toolSpecs(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.tools().map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
  }

  private tools(): McpTool[] {
    const agents = this.agents
    const shell = this.shell

    return [
      {
        name: 'list_agents',
        description: 'List every AI agent in Veritas OS with its current phase.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => agentList(agents)
      },
      {
        name: 'start_agent',
        description: 'Start an agent by id.',
        inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
        run: async args => {
          const id = stringArg(args, 'agentId')
          if (!id) return 'Error: agentId is required.'
          await agents.start(id)
          return `${id} is starting.`
        }
      },
      {
        name: 'stop_agent',
        description: 'Stop an agent by id.',
        inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
        run: async args => {
          const id = stringArg(args, 'agentId')
          if (!id) return 'Error: agentId is required.'
          await agents.stop(id)
          return `${id} is stopped.`
        }
      },
      {
        name: 'restart_agent',
        description: 'Restart an agent by id.',
        inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
        run: async args => {
          const id = stringArg(args, 'agentId')
          if (!id) return 'Error: agentId is required.'
          await agents.restart(id)
          return `${id} is restarting.`
        }
      },
      {
        name: 'run_agent',
        description: 'Hand a goal to an agent that can run missions.',
        inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, goal: { type: 'string' } }, required: ['agentId', 'goal'] },
        run: async args => {
          const id = stringArg(args, 'agentId')
          const goal = stringArg(args, 'goal')
          if (!id || !goal) return 'Error: agentId and goal are required.'
          await agents.run(id, goal)
          return `${id} started on: ${goal}`
        }
      },
      {
        name: 'list_apps',
        description: 'List the applications installed on this computer (name and launch path).',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          const apps = await hostPlatform().listInstalledApps()
          return apps.map(app => `${app.name} — ${app.path}`).join('\n') || 'No installed apps found.'
        }
      },
      {
        name: 'launch_app',
        description: 'Launch an installed application by its path (from list_apps).',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        run: async args => {
          const appPath = stringArg(args, 'path')
          if (!appPath) return 'Error: path is required.'
          await hostPlatform().launchApp(appPath)
          return `Launched ${appPath}`
        }
      },
      {
        name: 'system_status',
        description: 'Read this computer: load, memory, uptime, CPUs and hostname.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          const load = os.loadavg()
          const total = os.totalmem()
          const free = os.freemem()

          return [
            `host: ${os.hostname()} (${os.platform()} ${os.release()})`,
            `cpus: ${os.cpus().length}`,
            `load: ${load.map(n => n.toFixed(2)).join(' / ')}`,
            `memory: ${(((total - free) / total) * 100).toFixed(0)}% used`,
            `uptime: ${Math.round(os.uptime() / 60)} minutes`
          ].join('\n')
        }
      },
      {
        name: 'list_pages',
        description: 'List the pages in the Veritas OS shell (open one with show_page).',
        inputSchema: { type: 'object', properties: {} },
        run: async () => `Pages: ${SHELL_PAGES.join(', ')}`
      },
      {
        name: 'show_page',
        description: 'Open a Veritas OS page on the screen (e.g. overview, agents, browser, missions).',
        inputSchema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] },
        run: async args => {
          const page = stringArg(args, 'page')
          if (!page) return 'Error: page is required.'
          if (!SHELL_PAGES.includes(page)) return `Error: unknown page "${page}". Known pages: ${SHELL_PAGES.join(', ')}`
          shell.showPage(page)
          return `Opened ${page}.`
        }
      },
      {
        name: 'notify',
        description: 'Show a desktop notification to Chris.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
        run: async args => {
          const title = stringArg(args, 'title')
          const body = stringArg(args, 'body')
          if (!title) return 'Error: title is required.'
          shell.notify(title, body || title)
          return 'Notification shown.'
        }
      },
      {
        name: 'send_telegram',
        description: 'Send a message to Chris on Telegram.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        run: async args => {
          const message = stringArg(args, 'message')
          if (!message) return 'Error: message is required.'
          return shell.sendTelegram(message)
        }
      }
    ]
  }
}
