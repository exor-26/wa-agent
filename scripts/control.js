const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { config } = require('../src/config')
const { inspect } = require('../src/runtime')
const { acquireLock } = require('../src/lock')
const { sanitizeLog } = require('../src/logging')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForConnection(settings = config, { timeoutMs = 45000, read = inspect, pause = sleep } = {}) {
  const deadline = Date.now() + timeoutMs
  let status
  do {
    status = read(settings)
    if (status.connection === 'connected' || ['pairing', 'pairing_required', 'session_conflict', 'attention'].includes(status.connection)) return status
    if (!status.running && !status.supervised) return status
    await pause(250)
  } while (Date.now() < deadline)
  return read(settings)
}

async function control(action, { wait = true } = {}) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Choose start, stop or restart')
  const release = acquireLock(path.join(config.root, '.clara-control.lock'))
  try {
    let status = inspect(config)
    if (action !== 'start' && (status.running || status.supervised)) {
      process.kill(status.supervisorPid || status.pid, 'SIGTERM')
      for (let i = 0; i < 100; i++) {
        status = inspect(config)
        if (!status.running && !status.supervised) break
        await sleep(100)
      }
      if (status.running || status.supervised) throw new Error('Clara did not stop; inspect its live logs before retrying.')
      console.log('Clara stopped.')
    } else if (action === 'stop') console.log('Clara is already stopped.')
    if (action === 'stop') return inspect(config)
    status = inspect(config)
    if (!status.running && !status.supervised) {
      fs.mkdirSync(path.dirname(config.stateFile), { recursive: true, mode: 0o700 })
      const logFile = path.join(path.dirname(config.stateFile), 'clara.log')
      sanitizeLog(logFile)
      const output = fs.openSync(logFile, 'a', 0o600)
      try {
        const child = spawn(process.execPath, ['scripts/supervise.js'], { cwd: config.root,
          detached: true, stdio: ['ignore', output, output], windowsHide: true })
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        child.unref()
      } finally { fs.closeSync(output) }
      for (let i = 0; i < 40 && !inspect(config).supervised; i++) await sleep(100)
    }
    status = wait ? await waitForConnection() : inspect(config)
    if (!status.running && !status.supervised) throw new Error(`Clara did not start. Check ${status.logFile}`)
    console.log(`Clara: ${status.running ? `RUNNING (PID ${status.pid})` : 'RECOVERING'}${status.supervised ? ' / supervised' : ''}`)
    console.log(`WhatsApp: ${status.connection.toUpperCase().replaceAll('_', ' ')}`)
    if (status.detail) console.log(JSON.stringify(status.detail))
    if (status.connection !== 'connected') console.log('Not connected yet. Recovery continues unless manual attention is required. Use npm run live.')
    return status
  } finally { release() }
}
if (require.main === module) control(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { control, waitForConnection }
