const fs = require('node:fs')
const path = require('node:path')
const { config } = require('../src/config')
const { acquireLock } = require('../src/lock')
if (require('../src/runtime').inspect(config).supervised) throw new Error('Run npm run stop before resetting pairing; the recovery supervisor is active.')
const release = acquireLock(path.join(config.root, '.clara.lock'))
try {
  const relative = path.relative(config.root, config.authDir)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Pairing reset requires an auth directory inside this project')
  if (fs.existsSync(config.authDir)) {
    const backup = `${config.authDir}.backup-${Date.now()}`
    fs.renameSync(config.authDir, backup)
    console.log(`Previous session preserved in ${backup}`)
  }
} finally { release() }
require('../index').main().catch(error => { console.error(error.message); process.exitCode = 1 })
