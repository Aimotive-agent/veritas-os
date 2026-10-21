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
import { fileURLToPath } from 'node:url'

const PORT = 4317
const configFile = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
const definitionFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'veritas-agent.json')

// The agent's definition lives with the app, so the app and this script always agree.
let definition

try {
  definition = JSON.parse(fs.readFileSync(definitionFile, 'utf8'))
} catch (error) {
  console.error(`Could not read ${definitionFile}: ${error.message}`)
  process.exit(1)
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
// The model must exist in this config, so the agent runs on the model the user already uses.
config.agents.veritas = { ...definition, model: config.model ?? 'deepseek/deepseek-v4-pro' }
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
