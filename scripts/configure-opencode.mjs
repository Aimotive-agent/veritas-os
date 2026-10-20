#!/usr/bin/env node
/**
 * Adds the Veritas agent + its MCP server to OpenCode's global config, idempotently.
 * Run once (or again after OpenCode resets its config):
 *   node scripts/configure-opencode.mjs
 *
 * The MCP server URL must match the port in electron/mcp/server.ts (4317).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 4317
const configFile = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')

const VERITAS_AGENT = {
  description: 'The Veritas operator: runs every agent and app on this laptop.',
  mode: 'primary',
  model: 'omniroute/auto/best-chat',
  system: [
    'You are Veritas, the operator of this computer. You run every agent and app on Chris\u2019s laptop.',
    '',
    'Use the veritas tools to see and drive the machine:',
    '- list_agents, start_agent, stop_agent, restart_agent, run_agent \u2014 manage every AI agent (Hermes, OpenCode, and any others).',
    '- list_apps, launch_app \u2014 see and launch any installed application.',
    '- list_pages, show_page \u2014 open a page in the Veritas OS shell.',
    '- notify \u2014 send a desktop notification to Chris.',
    '- system_status \u2014 check the machine\u2019s load, memory and uptime.',
    '',
    'You also have your own shell, file and web tools. When Chris asks you to do something, do it: run agents, launch apps, run commands, read and edit files. Prefer the veritas tools for agent and app work; use your shell for everything else.',
    '',
    'You can reach Chris\u2019s second brain (the Bosua AI Brain vault) through the bosua-hive tools, and his automations through the activepieces tools \u2014 use them to recall past decisions, look up context and log finished work.',
    '',
    'Be concise and decisive: say what you did and what happened.'
  ].join('\n')
}

let config

try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
} catch (error) {
  console.error(`Could not read ${configFile}: ${error.message}`)
  process.exit(1)
}

// Back up once, so the original survives a mistake.
const backup = `${configFile}.bak`
if (!fs.existsSync(backup)) {
  fs.copyFileSync(configFile, backup)
  console.log(`Backed up ${configFile} -> ${backup}`)
}

config.mcp = config.mcp ?? {}
config.mcp.servers = config.mcp.servers ?? {}
config.mcp.servers.veritas = { type: 'remote', url: `http://127.0.0.1:${PORT}/mcp` }

// OpenCode v2 reads the `agents` map (plural); the singular `agent` key is deprecated and no
// longer applies the model. Remove the old one so the new definition wins.
config.agents = config.agents ?? {}
config.agents.veritas = VERITAS_AGENT
if (config.agent?.veritas) {
  delete config.agent.veritas
}

fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
console.log(`Added \`veritas\` MCP server (http://127.0.0.1:${PORT}/mcp) and \`veritas\` agent to ${configFile}`)
