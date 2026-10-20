#!/usr/bin/env node
/**
 * Recreate the node_modules/upstream symlink that `@herald-os/client` needs, after `npm install`
 * prunes it. The pinned snapshot is vendored in ./upstream (see upstream/UPSTREAM.lock).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url)) // scripts/
const project = path.dirname(root)
const link = path.join(project, 'node_modules', 'upstream')
const target = path.join(project, 'upstream')

if (!fs.existsSync(path.join(project, 'upstream', 'UPSTREAM.lock'))) {
  console.warn('upstream/UPSTREAM.lock not found; skipping symlink.')
  process.exit(0)
}

if (!fs.existsSync(link)) {
  fs.symlinkSync(target, link, 'dir')
  console.log('Recreated node_modules/upstream -> ../upstream')
}
