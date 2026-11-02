const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { inspect, createReporter } = require('../src/runtime')

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-status-'))
  fs.mkdirSync(path.join(root, 'data'))
  const config = { root, stateFile: path.join(root, 'data/state.json'), model: 'gpt-6.1-sol' }
  fs.writeFileSync(path.join(root, '.clara.lock'), JSON.stringify({ pid: process.pid, host: os.hostname() }))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return config
}
test('status reports a fresh connection transition for the matching live process', t => {
  const config = setup(t)
  const reporter = createReporter(config, () => 'gpt-6-luna')
  try {
    reporter.update('connected')
    const status = inspect(config, { matches: () => true })
    assert.equal(status.running, true)
    assert.equal(status.connection, 'connected')
    assert.equal(status.model, 'gpt-6-luna')
  } finally { reporter.stop() }
})
test('status never presents an old connected snapshot as a live connection', t => {
  const config = setup(t)
  const reporter = createReporter(config, () => config.model)
  try {
    reporter.update('connected')
    assert.equal(inspect(config, { matches: () => true, now: Date.now() + 60000 }).connection, 'unknown')
    assert.equal(inspect(config, { matches: () => false }).connection, 'stopped')
  } finally { reporter.stop() }
})
test('status rejects a snapshot belonging to a different process', t => {
  const config = setup(t)
  fs.writeFileSync(path.join(config.root, 'data/runtime.json'), JSON.stringify({
    pid: process.pid + 1, connection: 'connected', updatedAt: new Date().toISOString()
  }))
  assert.equal(inspect(config, { matches: () => true }).connection, 'unknown')
})
