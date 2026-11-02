const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Store } = require('../src/store')
const { WhatsApp } = require('../src/whatsapp')
const { acquireLock } = require('../src/lock')
const { inspect, processIdentity, processMatches } = require('../src/runtime')
const { backoff, disconnectDetails } = require('../src/recovery')
const { Supervisor } = require('../src/supervisor')
const { waitForConnection } = require('../scripts/control')
const { follow } = require('../scripts/live')

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-recovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function transportSetup(t, extra = {}) {
  const root = directory(t)
  const store = new Store(path.join(root, 'state.json'))
  const sockets = []; let authLoads = 0
  const auth = { state: { creds: { me: { id: '910000000000@s.whatsapp.net' } } }, saveCreds: async () => {} }
  const transport = new WhatsApp({ authDir: path.join(root, 'auth'), stateFile: store.file,
    waConnectTimeoutMs: 1000 }, store, {
    loadAuth: async () => { authLoads++; return auth },
    makeSocket: () => {
      const socket = { ev: new EventEmitter(), user: auth.state.creds.me, ended: false,
        end() { this.ended = true } }
      sockets.push(socket); return socket
    }, ...extra
  })
  const seen = { disconnected: 0, resumed: 0, states: [] }
  transport.bind({ disconnect: () => seen.disconnected++, resume: () => seen.resumed++, flushPending: async () => {} })
  transport.on('connectionState', (state, detail) => seen.states.push({ state, detail }))
  t.after(() => transport.stop())
  return { transport, sockets, seen, authLoads: () => authLoads, root }
}

test('stale lock cannot mistake an unrelated live PID for Clara', t => {
  const file = path.join(directory(t), '.clara.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }))
  const release = acquireLock(file, { matches: () => false, entry: 'index.js' })
  assert.equal(JSON.parse(fs.readFileSync(file)).entry, 'index.js')
  release(); assert.equal(fs.existsSync(file), false)
})
test('a matching live worker retains its lock and credentials are untouched', t => {
  const file = path.join(directory(t), '.clara.lock')
  const previous = JSON.stringify({ pid: process.pid, host: os.hostname() })
  fs.writeFileSync(file, previous)
  assert.throws(() => acquireLock(file, { matches: () => true }), /already running/)
  assert.equal(fs.readFileSync(file, 'utf8'), previous)
})
test('lock release never removes a replacement ownership token', t => {
  const file = path.join(directory(t), '.clara.lock')
  const release = acquireLock(file)
  const replacement = { ...JSON.parse(fs.readFileSync(file)), token: 'new-owner' }
  fs.writeFileSync(file, JSON.stringify(replacement))
  release(); assert.equal(fs.existsSync(file), true)
})
test('old truncated locks recover but newly-written incomplete locks are not stolen', t => {
  const file = path.join(directory(t), '.clara.lock')
  fs.writeFileSync(file, '{')
  assert.throws(() => acquireLock(file), /incomplete/)
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(file, old, old)
  const release = acquireLock(file)
  assert.ok(JSON.parse(fs.readFileSync(file)).token)
  release()
})
test('process identity detects PID reuse across boots or start times', () => {
  const root = path.resolve(__dirname, '..')
  const identity = processIdentity()
  assert.equal(processMatches(process.pid, root, 'test/recovery.test.js', identity), true)
  assert.equal(processMatches(process.pid, root, 'index.js', identity), false)
  if (process.platform === 'linux') {
    assert.equal(processMatches(process.pid, root, 'test/recovery.test.js', { ...identity, bootId: 'previous-boot' }), false)
    assert.equal(processMatches(process.pid, root, 'test/recovery.test.js', { ...identity, startTime: '0' }), false)
  }
})
test('reconnect backoff grows, includes jitter and stays capped', () => {
  assert.equal(backoff(1, { random: () => 0 }), 2000)
  assert.equal(backoff(2, { random: () => 0 }), 4000)
  assert.equal(backoff(1, { random: () => 1 }), 2400)
  assert.equal(backoff(100, { random: () => 1 }), 60000)
})
test('network diagnostics retain nested native codes but never dump session objects', () => {
  const detail = disconnectDetails({ message: 'WebSocket Error ()', output: { statusCode: 408 },
    data: { errors: [{ code: 'ENETUNREACH', privKey: 'secret' }, { cause: { code: 'ETIMEDOUT' } }] } })
  assert.deepEqual(detail.networkCodes, ['ENETUNREACH', 'ETIMEDOUT'])
  assert.equal(JSON.stringify(detail).includes('secret'), false)
})
test('a transient close recreates one socket with the same auth and rejects old events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  t.mock.method(Math, 'random', () => 0)
  const { transport, sockets, seen, authLoads } = transportSetup(t)
  await transport.start()
  sockets[0].ev.emit('connection.update', { connection: 'open' })
  sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: {
    error: { message: 'WebSocket Error ()', output: { statusCode: 408 } }
  } })
  assert.equal(transport.ready, false)
  assert.equal(sockets[0].ended, true)
  assert.equal(seen.states.at(-1).state, 'reconnecting')
  t.mock.timers.tick(2000); await settle()
  assert.equal(sockets.length, 2)
  assert.equal(authLoads(), 1)
  sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.equal(transport.ready, false)
  sockets[1].ev.emit('connection.update', { connection: 'open' })
  assert.equal(transport.ready, true)
  assert.equal(seen.resumed, 2)
})
test('a stalled connection is recycled instead of hanging in connecting forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { transport, sockets, seen } = transportSetup(t)
  await transport.start()
  t.mock.timers.tick(11000)
  assert.equal(sockets[0].ended, true)
  assert.equal(seen.states.at(-1).state, 'reconnecting')
  assert.match(seen.states.at(-1).detail.message, /handshake timed out/)
})
test('long quiet connected chats do not trigger the connection deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { transport, sockets } = transportSetup(t)
  await transport.start()
  sockets[0].ev.emit('connection.update', { connection: 'open' })
  for (let i = 0; i < 20; i++) t.mock.timers.tick(15000)
  assert.equal(transport.ready, true)
  assert.equal(sockets.length, 1)
})
test('host resume refreshes a half-open socket without discarding auth', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { transport, sockets } = transportSetup(t)
  await transport.start()
  sockets[0].ev.emit('connection.update', { connection: 'open' })
  transport.lastClock = Date.now() - 90000
  transport.checkResume()
  assert.equal(transport.ready, false)
  assert.equal(sockets[0].ended, true)
  assert.equal(transport.attention, false)
})
for (const code of [401, 403, 411, 440, 500]) {
  test(`auth or conflict code ${code} pauses retries without deleting credentials`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const { transport, sockets, seen, root } = transportSetup(t)
    await transport.start()
    fs.writeFileSync(path.join(root, 'auth', 'retained'), 'private test marker')
    transport.connectionClosed({ output: { statusCode: code } })
    assert.equal(transport.attention, true)
    assert.equal(seen.states.at(-1).state, code === 440 ? 'session_conflict' : code === 401 ? 'pairing_required' : 'attention')
    t.mock.timers.tick(120000); await settle()
    assert.equal(sockets.length, 1)
    assert.equal(fs.existsSync(path.join(root, 'auth', 'retained')), true)
  })
}
test('post-pair restart 515 reconnects promptly rather than requiring a new QR', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { transport, sockets, seen } = transportSetup(t)
  await transport.start()
  transport.connectionClosed({ output: { statusCode: 515 } })
  assert.equal(seen.states.at(-1).detail.delayMs, 300)
  t.mock.timers.tick(300); await settle()
  assert.equal(sockets.length, 2)
})
test('stop while auth is loading cannot create a late socket', async t => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const { transport, sockets } = transportSetup(t, { loadAuth: () => pending })
  const starting = transport.start()
  transport.stop()
  resolve({ state: { creds: {} }, saveCreds: async () => {} })
  await starting
  assert.equal(sockets.length, 0)
})
test('stop cancels scheduled retries and does not reconnect later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { transport, sockets } = transportSetup(t)
  await transport.start()
  transport.connectionClosed({ output: { statusCode: 408 } })
  transport.stop()
  t.mock.timers.tick(120000); await settle()
  assert.equal(sockets.length, 1)
})
test('stale metadata lookups do not consume a message that must replay after reconnect', async t => {
  const { transport, sockets, root } = transportSetup(t)
  await transport.start()
  sockets[0].ev.emit('connection.update', { connection: 'open' })
  let resolve
  sockets[0].signalRepository = { lidMapping: { getPNForLID: () => new Promise(done => { resolve = done }) } }
  const msg = { key: { id: 'unconsumed', remoteJid: '1234@lid' }, message: { conversation: 'Hello' } }
  const intake = transport.intake(msg)
  transport.connectionClosed({ output: { statusCode: 408 } })
  resolve(null)
  await intake
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json')))
  assert.equal(state.processed['1234@lid:unconsumed'], undefined)
})
test('stop waits for pending credential persistence', async t => {
  let resolve
  const saving = new Promise(done => { resolve = done })
  const { transport, sockets } = transportSetup(t, { loadAuth: async () => ({ state: { creds: {} }, saveCreds: () => saving }) })
  await transport.start()
  sockets[0].ev.emit('creds.update', {})
  let stopped = false
  const stopping = transport.stop().then(() => { stopped = true })
  await settle()
  assert.equal(stopped, false)
  resolve(); await stopping
  assert.equal(stopped, true)
})

function supervisorSetup(t, read) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const root = directory(t); const children = []
  const supervisor = new Supervisor({ root, stateFile: path.join(root, 'state.json') }, {
    random: () => 0, inspect: read || (() => ({ running: false })),
    spawn: () => {
      const child = new EventEmitter()
      child.pid = 5000 + children.length
      child.kill = signal => { child.killedWith = signal; child.emit('close', null, signal); return true }
      children.push(child); return child
    }
  })
  t.after(async () => supervisor.stop())
  return { supervisor, children, root }
}
test('supervisor retries a boot failure and recreates a crashed worker', t => {
  const { supervisor, children } = supervisorSetup(t)
  supervisor.start()
  children[0].emit('close', 1, null)
  assert.equal(supervisor.state, 'recovering')
  assert.equal(supervisor.restarts, 1)
  t.mock.timers.tick(5000)
  assert.equal(children.length, 2)
})
test('supervisor never restarts after explicit stop during backoff', async t => {
  const { supervisor, children } = supervisorSetup(t)
  supervisor.start(); children[0].emit('close', 1, null)
  await supervisor.stop()
  t.mock.timers.tick(120000)
  assert.equal(children.length, 1)
})
test('supervisor retains manual attention instead of repeatedly fighting another session', t => {
  const { supervisor, children } = supervisorSetup(t)
  supervisor.start()
  children[0].emit('message', { type: 'attention', detail: { state: 'session_conflict' } })
  children[0].emit('close', 78, null)
  t.mock.timers.tick(120000)
  assert.equal(children.length, 1)
  assert.equal(supervisor.state, 'attention')
})
test('supervisor refuses to launch over an existing foreground worker', t => {
  const { supervisor, children } = supervisorSetup(t, () => ({ running: true }))
  supervisor.start()
  assert.equal(children.length, 0)
  assert.equal(supervisor.state, 'attention')
})
test('supervisor recycles a worker with no heartbeat after its startup grace', t => {
  const { supervisor, children } = supervisorSetup(t)
  supervisor.start()
  for (let i = 0; i < 19; i++) t.mock.timers.tick(5000)
  assert.equal(children[0].killedWith, 'SIGKILL')
  assert.equal(supervisor.state, 'recovering')
})
test('supervisor gives a suspended worker time to recover after the host wakes', t => {
  const { supervisor, children } = supervisorSetup(t)
  supervisor.start()
  t.mock.timers.tick(120000)
  assert.equal(children[0].killedWith, undefined)
  assert.equal(supervisor.resumeGraceUntil, Date.now() + 90000)
})
test('fresh heartbeat keeps a quiet worker alive', t => {
  let childPid
  const { supervisor, children } = supervisorSetup(t, () => childPid
    ? { running: true, pid: childPid, updatedAt: new Date().toISOString() } : { running: false })
  supervisor.start(); childPid = children[0].pid
  for (let i = 0; i < 30; i++) t.mock.timers.tick(5000)
  assert.equal(children[0].killedWith, undefined)
})
test('startup wait verifies connected instead of accepting a live PID', async () => {
  const states = ['connecting', 'reconnecting', 'connected']; let polls = 0
  const status = await waitForConnection({}, { read: () => ({ running: true, connection: states.shift() }),
    pause: async () => { polls++ } })
  assert.equal(status.connection, 'connected')
  assert.equal(polls, 2)
})
test('startup wait returns manual attention without promising connection', async () => {
  const status = await waitForConnection({}, { read: () => ({ running: false, supervised: true, connection: 'attention' }) })
  assert.equal(status.connection, 'attention')
})
test('runtime exposes supervised recovery while the worker is temporarily absent', t => {
  const root = directory(t)
  fs.writeFileSync(path.join(root, '.clara-supervisor.lock'), JSON.stringify({ pid: process.pid, host: os.hostname() }))
  fs.writeFileSync(path.join(root, 'supervisor.json'), JSON.stringify({ pid: process.pid, state: 'recovering',
    restarts: 2, retryAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
  const status = inspect({ root, stateFile: path.join(root, 'state.json') }, {
    matches: (_pid, _root, entry) => entry === 'scripts/supervise.js'
  })
  assert.equal(status.running, false)
  assert.equal(status.supervised, true)
  assert.equal(status.connection, 'recovering')
  assert.equal(status.restarts, 2)
})
test('live log follower prints only newly appended events', { timeout: 5000 }, async t => {
  const file = path.join(directory(t), 'clara.log')
  fs.writeFileSync(file, 'old DISCONNECTED event\n')
  let output = ''
  let received
  const written = new Promise(resolve => { received = resolve })
  const stop = follow(file, { intervalMs: 5, output: { write: data => { output += data; received() } } })
  t.after(stop)
  fs.appendFileSync(file, 'new SERVICE_READY event\n')
  await written
  assert.equal(output, 'new SERVICE_READY event\n')
})
