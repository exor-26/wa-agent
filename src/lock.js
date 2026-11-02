const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { processMatches, processIdentity } = require('./runtime')

function acquireLock(file, { entry = path.relative(path.dirname(file), process.argv[1] || 'index.js'), matches = processMatches } = {}) {
  try {
    let previous
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      if (Date.now() - fs.statSync(file).mtimeMs < 30000) throw new Error('Clara lock is incomplete; retry after 30 seconds.')
    }
    if (!previous || !Number.isInteger(previous.pid) || previous.pid < 1 || typeof previous.host !== 'string') {
      if (Date.now() - fs.statSync(file).mtimeMs < 30000) throw new Error('Clara lock is incomplete; retry after 30 seconds.')
      fs.unlinkSync(file)
    } else {
      if (previous.host === os.hostname()) {
        // A live PID alone is not ownership: Linux reuses PIDs after a crash or WSL reboot.
        if (matches(previous.pid, path.dirname(file), previous.entry || 'index.js', previous)) {
          throw new Error(`Clara is already running (PID ${previous.pid})`)
        }
      } else throw new Error('Another host owns the Clara lock; check it before restarting')
      fs.unlinkSync(file)
    }
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = randomUUID()
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), entry, token,
    ...processIdentity() }), { flag: 'wx', mode: 0o600 })
  return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file) } catch {} }
}
module.exports = { acquireLock }
