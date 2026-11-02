const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store, jid } = require('../src/store')
const { WhatsApp, payload } = require('../src/whatsapp')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-transport-'))
  const store = new Store(path.join(dir, 'state.json'))
  const transport = new WhatsApp({ ownerJid: '1000@lid' }, store)
  transport.ready = true; transport.ownerJid = '1000@lid'
  transport.socket = { user: { id: '910000000000:2@s.whatsapp.net' }, signalRepository: {} }
  const seen = { owner: [], external: [], manual: [] }
  transport.bind({ receiveOwner: (...a) => seen.owner.push(a), receiveExternal: (...a) => seen.external.push(a),
    ownerIntervened: (...a) => seen.manual.push(a) })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { store, transport, seen }
}
function message(jid, id, fromMe = false, body = { conversation: 'Hello' }) {
  return { key: { remoteJid: jid, id, fromMe }, message: body, messageTimestamp: Date.now() / 1000 }
}
test('bot echo is ignored even when emitted before sendMessage resolves', async t => {
  const { store, transport, seen } = setup(t)
  transport.socket.sendMessage = async (address, content, options) => {
    assert.ok(store.data.outbound[options.messageId])
    await transport.intake(message(address, options.messageId, true, { conversation: content.text }))
    return { key: { id: options.messageId } }
  }
  await transport.sendOwner('Contact needs confirmation', 'C0001')
  assert.equal(seen.owner.length, 0); assert.equal(seen.manual.length, 0)
})
test('only authenticated fromMe self-chat messages reach owner administration', async t => {
  const { transport, seen } = setup(t)
  await transport.intake(message('1000@lid', 'o1', true))
  await transport.intake(message('1000@lid', 'o2', false))
  await transport.intake(message('1001@lid', 'e1', false))
  assert.equal(seen.owner.length, 1); assert.equal(seen.external.length, 1)
})
test('groups, status broadcasts and channels are ignored', async t => {
  const { transport, seen } = setup(t)
  for (const address of ['100@g.us', 'status@broadcast', '100@newsletter']) await transport.intake(message(address, address))
  assert.equal(seen.external.length, 0)
})
test('duplicate delivery and old notify events do not generate another reply', async t => {
  const { transport, seen } = setup(t)
  const msg = message('1001@lid', 'e1')
  await transport.intake(msg); await transport.intake(msg)
  const old = message('1001@lid', 'old'); old.messageTimestamp = (Date.now() - 60000) / 1000
  await transport.intake(old)
  assert.equal(seen.external.length, 1)
})
test('text, captionless photos and supported voice messages are classified separately', () => {
  assert.equal(payload(message('1@lid', 'text')).text, 'Hello')
  assert.equal(payload(message('1@lid', 'photo', false, { imageMessage: { mimetype: 'image/jpeg' } })).photo, true)
  assert.equal(payload(message('1@lid', 'audio', false, { audioMessage: {} })).unsupported, false)
  assert.equal(payload(message('1@lid', 'audio', false, { audioMessage: {} })).mediaType, 'audio')
  assert.equal(payload(message('1@lid', 'once', false, { viewOnceMessage: { message: { imageMessage: {} } } })).photo, false)
  assert.equal(jid('12345:2@s.whatsapp.net'), '12345@s.whatsapp.net')
})

test('recovery observes a recent manual owner reply for a known pending conversation', async t => {
  const { store, transport, seen } = setup(t)
  const contact = store.contact('1001@lid')
  contact.conversation = { mode: 'clara', pending: { id: 'question', receivedAt: Date.now() - 120000 } }
  const manual = message('1001@lid', 'manual-offline', true)
  manual.messageTimestamp = (Date.now() - 60000) / 1000
  await transport.intake(manual)
  assert.equal(seen.manual.length, 1)
  assert.equal(seen.manual[0][0].id, contact.id)
})

test('old self-chat commands and unrelated manual history never replay during recovery', async t => {
  const { transport, seen } = setup(t)
  for (const address of ['1000@lid', '1002@lid']) {
    const old = message(address, `old-${address}`, true, { conversation: '/whitelist +919999999999 mother' })
    old.messageTimestamp = (Date.now() - 60000) / 1000
    await transport.intake(old)
  }
  assert.equal(seen.owner.length, 0)
  assert.equal(seen.manual.length, 0)
})

test('incoming display names are recorded without confirming identity or granting access', async t => {
  const { store, transport } = setup(t)
  const incoming = message('1001@lid', 'named')
  incoming.pushName = 'Ravi'
  await transport.intake(incoming)
  const contact = store.getContact('1001@lid')
  assert.equal(contact.name, 'Ravi')
  assert.equal(contact.nameSource, 'push')
  assert.equal(contact.confirmed, false)
  assert.equal(contact.permission, 'public')
})
test('shared contact-card text cannot become an authenticated owner instruction', async t => {
  const { transport, seen } = setup(t)
  await transport.intake(message('1000@lid', 'owner-card', true, { contactMessage: {
    displayName: 'He is my brother', vcard: 'FN:He is my brother\nTEL:+919999999999'
  } }))
  assert.equal(seen.owner.length, 1)
  assert.equal(seen.owner[0][3].forwarded, true)
})

test('transport acceptance and uncertain send failure are recorded separately', async t => {
  const { store, transport } = setup(t)
  transport.socket.sendMessage = async (_address, _content, options) => ({ key: { id: options.messageId } })
  const sent = await transport.sendOwner('A real transport result')
  assert.equal(store.data.outbound[sent.key.id].status, 'accepted_by_transport')
  transport.socket.sendMessage = async () => { throw new Error('Network failed') }
  await assert.rejects(transport.sendOwner('Another note'), /Network failed/)
  assert.equal(Object.values(store.data.outbound).at(-1).status, 'failed_or_unknown')
})

test('a stalled WhatsApp send times out without claiming failure means non-delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, transport } = setup(t)
  transport.config.sendTimeoutMs = 1000
  transport.socket.sendMessage = async () => new Promise(() => {})
  const pending = transport.sendOwner('A note')
  t.mock.timers.tick(1000)
  await assert.rejects(pending, /delivery is unknown/)
  assert.equal(Object.values(store.data.outbound).at(-1).status, 'failed_or_unknown')
})
