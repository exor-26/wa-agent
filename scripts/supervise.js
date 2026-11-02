require('../src/logging').installSafeConsole()
const path = require('node:path')
const { config, log } = require('../src/config')
const { acquireLock } = require('../src/lock')
const { Supervisor } = require('../src/supervisor')

async function main() {
  const release = acquireLock(path.join(config.root, '.clara-supervisor.lock'), { entry: 'scripts/supervise.js' })
  process.on('exit', release)
  const supervisor = new Supervisor(config)
  let stopping = false
  async function stop(code = 0) {
    if (stopping) return
    stopping = true
    await supervisor.stop()
    release()
    process.exit(code)
  }
  process.on('SIGTERM', () => { stop().catch(() => process.exit(1)) })
  process.on('SIGINT', () => { stop().catch(() => process.exit(1)) })
  process.on('uncaughtException', error => {
    log('SUPERVISOR_FATAL', { message: error.message })
    stop(1).catch(() => process.exit(1))
  })
  supervisor.start()
}
main().catch(error => { log('SUPERVISOR_BOOT_FAILED', { message: error.message }); process.exitCode = 1 })
