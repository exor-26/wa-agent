require('./src/logging').installSafeConsole()
const path = require('node:path')
const { config, readProfile, log } = require('./src/config')
const { Store } = require('./src/store')
const { Codex } = require('./src/codex')
const { Agent } = require('./src/agent')
const { WhatsApp } = require('./src/whatsapp')
const { acquireLock } = require('./src/lock')
const { createReporter } = require('./src/runtime')

async function main() {
  const release = acquireLock(path.join(config.root, '.clara.lock'))
  process.on('exit', release)
  const profile = readProfile()
  const store = new Store(config.stateFile, config)
  const restoredShares = store.restoreSharedFacts()
  if (restoredShares) log('SHARED_FACTS_RESTORED', { count: restoredShares })
  store.save()
  const reporter = createReporter(config, () => store.data.settings.model || config.model)
  process.on('exit', () => reporter.stop())
  const provider = new Codex(config)
  log('CODEX_READY', provider.doctor())
  const transport = new WhatsApp(config, store)
  const agent = new Agent({ config, profile, store, provider, transport })
  transport.bind(agent)
  transport.on('connectionState', (state, detail) => reporter.update(state, detail))
  let stopping = false
  const stop = (reason = 'requested', code = 0) => {
    if (stopping) return
    stopping = true
    agent.stop()
    const savedAuth = transport.stop()
    reporter.stop()
    process.exitCode = code
    const deadline = setTimeout(() => { log('SHUTDOWN_TIMEOUT', { reason }); process.exit(code || 1) }, 5000)
    Promise.resolve(savedAuth).then(() => {
      clearTimeout(deadline); release()
      log('STOPPED', { reason, code })
      process.exit(code)
    })
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('uncaughtException', error => { log('FATAL', { message: error.message }); stop('fatal', 1) })
  process.on('unhandledRejection', error => { log('FATAL', { message: String(error?.message || error) }); stop('unhandled_rejection', 1) })
  transport.on('attention', detail => {
    if (process.send && process.connected) {
      process.send({ type: 'attention', detail }, () => stop(detail.state, 78))
    }
  })
  if (process.send) process.on('disconnect', () => stop('supervisor_disconnected', 1))
  const readline = require('node:readline').createInterface({ input: process.stdin, terminal: false })
  readline.on('line', line => {
    if (line.trim() === '/quit') stop()
    else if (line.startsWith('/')) agent.command(line).then(async reply => {
      console.log(reply)
      if (!agent.controls.quiet && store.data.settings.wakeDigestPending) await agent.flushPending()
    }).catch(error => console.error(error.message))
  })
  await transport.start().catch(error => transport.retry(error))
}
if (require.main === module) main().catch(error => { log('BOOT_FAILED', { message: error.message }); process.exitCode = 1 })
module.exports = { main }
