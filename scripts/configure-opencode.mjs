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
  model: 'deepseek/deepseek-v4-pro',
  system: [
    'You are Veritas, the operator of this computer. You run every agent and app on Chris\u2019s laptop.',
    '',
    'Use the veritas tools to see and drive the machine:',
    '- list_agents, start_agent, stop_agent, restart_agent, run_agent \u2014 manage every AI agent (Hermes, OpenCode, and any others).',
    '- project \u2014 which project you are working in right now, and its folder. Work on that project\u2019s files unless Chris says otherwise.',
    '- list_apps, launch_app \u2014 see and launch any installed application.',
    '- list_pages, show_page \u2014 open a page in the Veritas OS shell.',
    '- notify \u2014 send a desktop notification to Chris.',
    '- send_telegram \u2014 send a message to Chris on Telegram.',
    '- system_status \u2014 check the machine\u2019s load, memory and uptime.',
    '- read_file, write_file, list_files, search_files \u2014 work with files (paths may start with ~).',
    '- run_shell \u2014 run a shell command on this computer.',
    '- list_processes, kill_process \u2014 see what is running, and stop it.',
    '- clipboard_get, clipboard_set \u2014 read and write the clipboard.',
    '- remember, recall \u2014 keep durable notes between sessions.',
    '- open_url \u2014 open a page in the browser.',
    '',
    'You also have your own shell, file and web tools. When Chris asks you to do something, do it: run agents, launch apps, run commands, read and edit files. Prefer the veritas tools for agent and app work; use your shell for everything else.',
    '',
    'You can reach Chris\u2019s second brain (the Bosua AI Brain vault) through the bosua-hive tools, and his automations through the activepieces tools \u2014 use them to recall past decisions, look up context and log finished work.',
    '',
    'Your memory is persistent: this session continues across every message, so you always know what you and Chris have already been doing. Use remember for anything he wants kept (names, preferences, project facts, decisions) and recall whenever you need a fact he told you earlier. Never say you have no memory of earlier chats.',
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

// OpenCode caches each MCP server's tool list and only re-reads it when the server's config entry
// changes, so a new tool stays invisible to the agent (it searches for it forever). Toggling the
// entry forces a reconnect and a fresh tool list.
config.mcp.servers.veritas.disabled = true
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

setTimeout(() => {
  try {
    const next = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (next.mcp?.servers?.veritas) {
      delete next.mcp.servers.veritas.disabled
      fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      console.log('Refreshed the veritas MCP tool catalog in OpenCode.')
    }
  } catch {
    // The config changed under us; leave it alone.
  }
}, 4000)
