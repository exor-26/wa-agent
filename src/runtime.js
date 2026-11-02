const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function processIdentity(pid = process.pid) {
  if (process.platform !== 'linux') return {}
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return { bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }
  } catch { return {} }
}
function processMatches(pid, root, entry = 'index.js', identity = {}) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      const current = processIdentity(pid)
      return (!identity.bootId || identity.bootId === current.bootId) &&
        (!identity.startTime || identity.startTime === current.startTime) &&
        fs.realpathSync(`/proc/${pid}/cwd`) === fs.realpathSync(root) &&
        command.slice(1).some(arg => path.resolve(root, arg) === path.resolve(root, entry))
    }
    return true
  } catch { return false }
}
function inspect(config, { matches = processMatches, now = Date.now() } = {}) {
  const lock = readJson(path.join(config.root, '.clara.lock'))
  const snapshot = readJson(path.join(path.dirname(config.stateFile), 'runtime.json'))
  const manager = readJson(path.join(config.root, '.clara-supervisor.lock'))
  const supervision = readJson(path.join(path.dirname(config.stateFile), 'supervisor.json'))
  const supervised = !!manager && manager.host === os.hostname() &&
    matches(manager.pid, config.root, 'scripts/supervise.js', manager)
  const managerFresh = supervised && supervision?.pid === manager.pid && now - Date.parse(supervision.updatedAt) < 30000
  const running = !!lock && lock.host === os.hostname() && matches(lock.pid, config.root, lock.entry || 'index.js', lock)
  const fresh = running && snapshot?.pid === lock.pid && now - Date.parse(snapshot.updatedAt) < 45000
  return { running, pid: running ? lock.pid : null,
    connection: !running ? managerFresh ? supervision.state : supervised ? 'recovering' : 'stopped'
      : fresh ? snapshot.connection : 'unknown',
    supervised, supervisorPid: supervised ? manager.pid : null,
    restarts: managerFresh ? supervision.restarts : null,
    retryAt: managerFresh ? supervision.retryAt : null,
    detail: fresh ? snapshot.detail || null : managerFresh ? supervision.detail || null : null,
    model: snapshot?.model || readJson(config.stateFile)?.settings?.model || config.model,
    updatedAt: snapshot?.updatedAt || null,
    qrFile: path.join(path.dirname(config.stateFile), 'pairing-qr.png'),
    logFile: path.join(path.dirname(config.stateFile), 'clara.log') }
}
function createReporter(config, model) {
  const file = path.join(path.dirname(config.stateFile), 'runtime.json')
  let connection = 'starting', detail = null, closed = false
  function write() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, host: os.hostname(),
        connection, detail, model: model(), updatedAt: new Date().toISOString() }), { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
    } catch (error) { console.error(`Status reporting failed: ${error.message}`) }
  }
  write()
  const timer = setInterval(write, 15000)
  timer.unref()
  return {
    update(value, information = null) { if (!closed) { connection = value; detail = information; write() } },
    stop() { if (!closed) { closed = true; clearInterval(timer); connection = 'stopped'; write() } }
  }
}
module.exports = { readJson, processIdentity, processMatches, inspect, createReporter }
