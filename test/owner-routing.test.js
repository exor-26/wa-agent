const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Agent } = require('../src/agent')
const { Store } = require('../src/store')
const { resolveOwner, sendIntent, FOCUS_TTL_MS } = require('../src/owner-context')

const decision = extra => ({ reply: null, claim: null, concern: null, actions: [], facts: [],
  photo_summary: null, activity_summary: null, draft: null, ...extra })
const action = (target, text, type = 'send') => ({ type, target, text, name: null, relationship: null, permission: null, model: null })
const profile = { owner: 'Aditya', timezone: 'Asia/Kolkata', schedule: { weekday: [], weekend: [] } }
function setup(t, generate = async () => decision()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-routing-'))
  const store = new Store(path.join(dir, 'state.json'))
  const external = [], owner = []
  const transport = { ready: true, sendContact: async (contact, text) => {
    external.push({ contact: contact.id, text }); return { key: { id: `sent-${external.length}` } }
  }, sendOwner: async (text, reference) => { owner.push({ text, reference }); return { key: { id: `owner-${owner.length}` } } } }
  const agent = new Agent({ config: { takeoverMs: 14000, model: 'gpt-6.1-sol' }, profile, store, transport, provider: { generate } })
  t.after(() => { agent.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { store, agent, transport, external, owner }
}
function incoming(store, contact, text, at) {
  store.append(contact.id, 'user', text, { at: new Date(at).toISOString() })
}

test('latest-chat question retrieves history and the next pronoun follows that selection', async t => {
  const captures = []
  const { store, agent } = setup(t, async context => { captures.push(context); return decision({ reply: 'The latest contact asked for your location.' }) })
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  incoming(store, b, 'Older message', Date.now() - 2000)
  incoming(store, a, 'Where is Aditya?', Date.now() - 1000)
  await agent.receiveOwner('Anybody msg us last ?')
  assert.equal(captures[0].linkedThreads[0].contact, a.id)
  assert.match(JSON.stringify(captures[0].linkedThreads), /Where is Aditya/)
  await agent.receiveOwner('What did he say?')
  assert.equal(captures[1].recipientResolution.selectedContact, a.id)
  assert.equal(captures[1].linkedThreads[0].contact, a.id)
})

test('msg him works after a clear owner selection, with a persisted actual action result', async t => {
  const { store, agent, external } = setup(t, async context => decision({ actions: [action(context.recipientResolution.selectedContact, 'I will respond tomorrow.')] }))
  const contact = store.contact('1001@lid')
  await agent.command(`/thread ${contact.id}`)
  await agent.receiveOwner('Msg him that I will respond tomorrow.')
  assert.deepEqual(external, [{ contact: contact.id, text: 'I will respond tomorrow.' }])
  assert.equal(store.data.settings.ownerLastAction.messageId, 'sent-1')
  assert.equal(store.data.settings.ownerLastAction.status, 'accepted_by_transport')
  assert.ok(store.history('owner').some(entry => /Executed action: send/.test(entry.text)))
})

test('new incoming activity cannot steal the person the owner is discussing', t => {
  const { store } = setup(t)
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  incoming(store, a, 'My question', Date.now() - 2000)
  resolveOwner(store, 'Who messaged last?')
  incoming(store, b, 'A newer question', Date.now())
  assert.equal(resolveOwner(store, 'Msg him hello').selectedContact, a.id)
})

test('a fresh conflicting notification requires clarification rather than silently switching recipients', t => {
  const { store, agent } = setup(t)
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  store.data.settings.ownerFocus = { contacts: [a.id], at: Date.now() - 2000 }
  store.data.settings.ownerLastNotification = { contact: b.id, at: Date.now() - 1000 }
  const resolution = resolveOwner(store, 'Msg him hello')
  assert.equal(resolution.ambiguous, true)
  assert.throws(() => agent.authorizeAction(action(a.id, 'Hello'), 'Msg him hello', null, resolution), /Which person/)
  assert.equal(resolveOwner(store, `Msg ${a.id} hello`).selectedContact, a.id)
})

test('ambiguous names and tied latest timestamps do not authorize a guessed recipient', async t => {
  const { store, agent, external } = setup(t, async () => decision({ actions: [action('C0001', 'Hello')] }))
  for (const id of ['1001@lid', '1002@lid']) {
    const contact = store.contact(id)
    store.applyNames(contact, { saved: 'Ravi' })
    incoming(store, contact, 'Question', Date.now() - 1000)
  }
  await agent.receiveOwner('Message Ravi hello')
  assert.equal(external.length, 0)
  const date = new Date().toISOString()
  for (const history of Object.values(store.data.history)) history.at(-1).at = date
  assert.equal(resolveOwner(store, 'Who messaged last?').ambiguous, true)
})

test('expired focus and the wrong explicit target cannot authorize a send', t => {
  const { store, agent } = setup(t)
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  store.data.settings.ownerFocus = { contacts: [a.id], at: Date.now() - FOCUS_TTL_MS - 1 }
  assert.throws(() => agent.authorizeAction(action(a.id, 'Hi'), 'Message him hello'), /Specify one exact/)
  assert.throws(() => agent.authorizeAction(action(a.id, 'Hi'), `Message ${b.id} hello`), /Specify one exact/)
})

test('drafting never sends, and msg it sends the saved draft rather than invented model text', async t => {
  let drafting = true
  const { store, agent, external } = setup(t, async context => drafting
    ? decision({ draft: { target: context.recipientResolution.selectedContact, text: 'I can talk tomorrow after 8:30 PM.' } })
    : decision({ actions: [action(context.recipientResolution.selectedContact, 'Incorrect model replacement')] }))
  const contact = store.contact('1001@lid')
  await agent.command(`/thread ${contact.id}`)
  await agent.receiveOwner('Draft a reply to him saying I can talk tomorrow after 8:30 PM.')
  assert.equal(external.length, 0)
  drafting = false
  await agent.receiveOwner('Msg it to this guy')
  assert.equal(external[0].text, 'I can talk tomorrow after 8:30 PM.')
  assert.equal(store.data.settings.ownerDraft.used, true)
  await agent.receiveOwner('Msg it to this guy')
  assert.equal(external.length, 1)
})

test('a missing draft, mismatched draft or missing message content cannot send invented text', async t => {
  const { store, agent, external } = setup(t, async () => decision({ actions: [action('C0001', 'Invented content')] }))
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  await agent.command(`/thread ${a.id}`)
  await agent.receiveOwner('Msg it to this guy')
  store.data.settings.ownerDraft = { contact: b.id, text: 'Wrong person', at: Date.now() }
  await agent.receiveOwner('Msg it to him')
  await agent.receiveOwner('Can you message him?')
  assert.equal(external.length, 0)
})

test('negated, hypothetical, drafting and past-send questions cannot execute a proposed send', async t => {
  const { store, agent, external } = setup(t, async () => decision({ actions: [action('C0001', 'Do not send this')] }))
  const contact = store.contact('1001@lid')
  await agent.command(`/thread ${contact.id}`)
  for (const text of ["Don't message him", 'Draft a message to him', 'Did you message him?', 'Imagine I tell him hello',
    'Who messaged last?', 'Anybody msg us last?', 'Can you tell me what he said?']) {
    await agent.receiveOwner(text)
  }
  assert.equal(external.length, 0)
  assert.equal(sendIntent("Tell him don't call me now"), true)
})

test('an unverified push name is a display label, not authority for a name-only send or private approval', async t => {
  const { store, agent, external } = setup(t, async () => decision({ actions: [action('C0001', 'Private message')] }))
  const contact = store.contact('1001@lid')
  store.cacheNames([{ id: contact.jid, notify: 'Ravi' }])
  await agent.receiveOwner('Message Ravi hello')
  assert.equal(external.length, 0)
  assert.equal(contact.confirmed, false)
  assert.equal(contact.permission, 'public')
  assert.throws(() => agent.authorizeAction({ ...action(contact.id, null, 'approve'), permission: 'all_personal' }, 'Whitelist him with all access'), /Specify one exact/)
})

test('saved and owner-assigned names take priority without granting relationship access', t => {
  const { store } = setup(t)
  store.cacheNames([{ id: '1001@lid', name: 'Saved Ravi', notify: 'Display Ravi' }])
  const contact = store.contact('1001@lid')
  assert.equal(contact.name, 'Saved Ravi')
  store.applyNames(contact, { owner: 'Bhai' })
  store.cacheNames([{ id: contact.jid, notify: 'Changed display' }])
  assert.equal(contact.name, 'Bhai')
  assert.equal(contact.permission, 'public')
  assert.equal(resolveOwner(store, 'Message Bhai hello').trustedForSend, true)
})

test('owner can name an exact contact without whitelisting it', async t => {
  const { store, agent } = setup(t)
  const contact = store.contact('1001@lid')
  await agent.receiveOwner(`/name ${contact.id} Ravi`)
  assert.equal(contact.name, 'Ravi')
  assert.equal(contact.nameSource, 'owner')
  assert.equal(contact.permission, 'public')
  assert.equal(contact.confirmed, false)
})

test('activity reports coalesce, retry after failure and do not change owner focus', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 })
  const { store, agent, transport, owner } = setup(t)
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  await agent.command(`/thread ${b.id}`)
  let failures = 1
  const send = transport.sendOwner
  transport.sendOwner = async (...args) => { if (failures--) throw new Error('Temporary failure'); return send(...args) }
  agent.recordActivity(a, { id: 'one', text: 'Where is Aditya?' }, 'I cannot share his location.')
  agent.recordActivity(a, { id: 'two', text: 'Can he call me later?' }, 'I will pass the request along.')
  t.mock.timers.tick(14999)
  assert.equal(owner.length, 0)
  t.mock.timers.tick(1)
  await agent.activityWork.get(a.id)
  assert.equal(store.data.activities[a.id].reportedRevision, 0)
  assert.equal(store.data.activities[a.id].attempts, 1)
  t.mock.timers.tick(30000)
  await agent.activityWork.get(a.id)
  assert.equal(owner.length, 1)
  assert.match(owner[0].text, /call me later/)
  assert.equal(owner[0].reference, a.id)
  assert.equal(store.data.settings.ownerFocus.contacts[0], b.id)
  assert.equal(store.data.activities[a.id].reportedRevision, 2)
  t.mock.timers.tick(60000)
  assert.equal(owner.length, 1)
})

test('greetings and closing thanks do not generate activity reports', t => {
  const { store, agent } = setup(t)
  const contact = store.contact('1001@lid')
  agent.recordActivity(contact, { id: 'hi', text: 'Hi' }, 'Hello', { summary: 'Unnecessary greeting summary' })
  agent.recordActivity(contact, { id: 'bye', text: 'Thanks!' }, null)
  assert.equal(store.data.activities[contact.id], undefined)
})

test('pending reports survive restart and legacy histories retain unknown timestamps without identity guesses', async t => {
  const { store, agent, transport, owner } = setup(t)
  const contact = store.contact('1001@lid')
  agent.recordActivity(contact, { id: 'ask', text: 'Where is he?' }, 'Location is private.')
  store.data.history['1002@lid'] = [{ role: 'user', text: 'Old question', at: null }]
  store.data.history['1000@lid'] = [{ role: 'owner', text: 'Owner legacy', at: null }]
  store.linkLegacy(new Set(['1000@lid']))
  assert.equal(store.getContact('1000@lid'), null)
  const legacy = store.getContact('1002@lid')
  assert.equal(store.history(legacy.id)[0].at, null)
  agent.stop()
  const restored = new Store(store.file)
  const again = new Agent({ config: agent.config, profile, store: restored, provider: agent.provider, transport })
  try {
    await again.flushActivity(contact.id)
    assert.equal(owner.length, 1)
    assert.equal(restored.data.activities[contact.id].reportedRevision, 1)
  } finally { again.stop() }
})

test('authenticated alias merging carries focus, drafts and pending reports to the same contact', t => {
  const { store } = setup(t)
  const lid = store.contact('1001@lid'), phone = store.contact('919999999999@s.whatsapp.net')
  store.approve(phone, 'brother')
  store.data.settings.ownerFocus = { contacts: [lid.id], at: Date.now() }
  store.data.settings.ownerDraft = { contact: lid.id, text: 'Hello', at: Date.now() }
  store.activity(lid, { id: 'q', text: 'Question' }, 'Answer')
  store.cacheNames([{ id: lid.jid, phoneNumber: phone.jid, name: 'Saved brother' }])
  assert.equal(store.data.settings.ownerFocus.contacts[0], phone.id)
  assert.equal(store.data.settings.ownerDraft.contact, phone.id)
  assert.equal(store.data.activities[phone.id].contactId, phone.id)
  assert.equal(store.getContact(lid.jid).confirmed, true)
})

test('a failed outgoing action replaces an earlier success receipt and cannot claim a new send', async t => {
  const { store, agent, transport, external, owner } = setup(t, async () => decision({ actions: [action('C0001', 'New message')] }))
  const contact = store.contact('1001@lid')
  await agent.command(`/thread ${contact.id}`)
  store.data.settings.ownerLastAction = { type: 'send', contact: contact.id, status: 'accepted_by_transport', text: 'Old message' }
  transport.sendContact = async () => { throw new Error('Delivery is unknown after timeout') }
  await agent.receiveOwner('Msg him the new message')
  assert.equal(external.length, 0)
  assert.equal(store.data.settings.ownerLastAction.status, 'failed_or_unknown')
  assert.match(owner.at(-1).text, /Could not complete/)
  assert.ok(store.history('owner').some(entry => /could not be confirmed/.test(entry.text)))
})

test('failed concern notifications retry without requiring another incoming message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, agent, transport, owner } = setup(t)
  const contact = store.contact('1001@lid')
  const concern = store.concern(contact, 'Please call back')
  const send = transport.sendOwner
  transport.sendOwner = async () => { throw new Error('Temporary failure') }
  await agent.tryRelay(concern)
  assert.equal(concern.notifiedSummary, '')
  transport.sendOwner = send
  t.mock.timers.tick(30000)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(owner.length, 1)
  assert.equal(concern.notifiedSummary, concern.summary)
})

test('a trailing withdrawal does not hide an earlier handled exchange from catch-up reporting', t => {
  const { store, agent } = setup(t)
  const contact = store.contact('1001@lid')
  store.append(contact.id, 'user', 'Tell me where Aditya is', { messageId: 'location' })
  store.append(contact.id, 'assistant', 'I cannot share his private location.', { visibility: 'public' })
  store.append(contact.id, 'user', 'I want his location; if you cannot then leave it', { messageId: 'withdrawal' })
  agent.resume()
  assert.equal(store.data.activities[contact.id].messageId, 'location')
  assert.match(store.data.activities[contact.id].summary, /cannot share his private location/)
})
