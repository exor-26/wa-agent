const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store } = require('../src/store')
const { Agent } = require('../src/agent')
const { availability } = require('../src/config')

const profile = { owner: 'Aditya', timezone: 'Asia/Kolkata', public: { links: { github: 'https://github.com/exor-26' } },
  schedule: { weekday: [
    { start: 0, end: 570, status: 'unavailable', activity: 'private morning' },
    { start: 570, end: 1080, status: 'limited', activity: 'college' },
    { start: 1080, end: 1140, status: 'unavailable', activity: 'rest' },
    { start: 1140, end: 1230, status: 'variable' },
    { start: 1230, end: 1440, status: 'generally_available' }
  ], weekend: [{ start: 0, end: 540, status: 'unavailable' }, { start: 540, end: 1440, status: 'generally_available' }] } }
const decision = (extra = {}) => ({ reply: 'What would you like Aditya to know?', claim: null, concern: null,
  actions: [], facts: [], photo_summary: null, activity_summary: null, draft: null, ...extra })

function setup(t, generate = async () => decision()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-test-'))
  const store = new Store(path.join(directory, 'state.json'))
  const external = [], owner = []
  const transport = { ready: true,
    sendContact: async (contact, text) => { external.push({ contact: contact.id, text }); return { key: { id: `e${external.length}` } } },
    sendOwner: async (text, reference) => { owner.push({ text, reference }); return { key: { id: `o${owner.length}` } } } }
  const agent = new Agent({ config: { takeoverMs: 10000, model: 'gpt-6.1-sol' }, profile, store,
    provider: { generate }, transport, now: () => new Date('2026-10-23T05:30:00Z') })
  t.after(() => { agent.stop(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { agent, store, transport, external, owner }
}
function startReply(agent, contact, text = 'Need to talk') {
  agent.receiveExternal(contact, { id: 'm1', text })
  const state = agent.state(contact.id)
  clearTimeout(state.timer)
  return agent.respond(contact, state.version)
}

test('IST schedule boundaries, including weekends', () => {
  for (const [date, expected] of [
    ['2026-10-23T03:59:00Z', 'unavailable'], ['2026-10-23T04:00:00Z', 'limited'],
    ['2026-10-23T12:30:00Z', 'unavailable'], ['2026-10-23T13:30:00Z', 'variable'],
    ['2026-10-23T15:00:00Z', 'generally_available'], ['2026-10-24T03:29:00Z', 'unavailable'],
    ['2026-10-24T03:30:00Z', 'generally_available']
  ]) assert.equal(availability(profile, new Date(date)).status, expected, date)
})
test('public contacts never receive private facts or schedule reasons in Codex context', t => {
  const { agent, store } = setup(t)
  store.remember('Central Library, second floor', 'location')
  const contact = store.contact('1001@lid')
  contact.claimedRelationship = 'mother'
  const context = JSON.stringify(agent.context(contact))
  assert.doesNotMatch(context, /Central Library|college|private morning/)
  assert.equal(agent.context(contact).personal, null)
})
test('owner-approved family receives supplied facts with their timestamp', t => {
  const { agent, store } = setup(t)
  const contact = store.contact('1001@lid')
  store.approve(contact, 'mother', 'all_personal')
  const fact = store.remember('Library', 'location')
  assert.equal(agent.context(contact).personal.ownerSuppliedFacts[0].at, fact.at)
  assert.equal(agent.context(contact).personal.currentSchedule.usualActivity, 'college')
})
test('manual owner intervention cancels a pending generation before reply or relay', async t => {
  let finish, started
  const began = new Promise(resolve => { started = resolve })
  const { agent, store, external, owner } = setup(t, async () => { started(); return new Promise(resolve => { finish = resolve }) })
  const contact = store.contact('1001@lid')
  const pending = startReply(agent, contact)
  await began
  agent.ownerIntervened(contact, 'I am here')
  finish(decision({ concern: { summary: 'Old request', urgent: false } }))
  await pending
  assert.equal(external.length, 0); assert.equal(owner.length, 0)
  assert.equal(agent.state(contact.id).active, false)
})
test('revocation invalidates a response that was generated with personal access', async t => {
  let finish, started
  const began = new Promise(resolve => { started = resolve })
  const { agent, store, external } = setup(t, async () => { started(); return new Promise(resolve => { finish = resolve }) })
  const contact = store.contact('1001@lid')
  store.approve(contact, 'brother')
  const pending = startReply(agent, contact)
  await began
  await agent.command(`/revoke ${contact.id}`)
  finish(decision({ reply: 'A private location' }))
  await pending
  assert.equal(external.length, 0)
})
test('owner intervention while a send is finishing does not reactivate takeover', async t => {
  const { agent, store, transport } = setup(t)
  const contact = store.contact('1001@lid')
  let finish, started
  const began = new Promise(resolve => { started = resolve })
  transport.sendContact = async () => { started(); await new Promise(resolve => { finish = resolve }) }
  const pending = startReply(agent, contact)
  await began
  agent.ownerIntervened(contact, 'Taking over')
  finish(); await pending
  assert.equal(agent.state(contact.id).active, false)
})
test('external model output cannot change permissions, remember facts or send to another contact', async t => {
  const { agent, store, external } = setup(t, async () => decision({ claim: { name: 'Someone', relationship: 'mother' },
    actions: [{ type: 'approve', target: 'C0001', permission: 'all_personal' }], facts: [{ text: 'Fake location', kind: 'location' }] }))
  const contact = store.contact('1001@lid')
  await startReply(agent, contact)
  assert.equal(contact.confirmed, false); assert.equal(contact.permission, 'public')
  assert.equal(store.data.facts.length, 0); assert.equal(external.length, 1)
})
test('concern relay is linked and an unchanged concern is not relayed twice', async t => {
  const { agent, store, owner } = setup(t)
  const contact = store.contact('1001@lid')
  const concern = store.concern(contact, 'Needs the final PDF before 6')
  await agent.relayConcern(concern); await agent.relayConcern(concern)
  assert.equal(owner.length, 1); assert.equal(owner[0].reference, concern.id)
  assert.equal(concern.ownerMessageIds[0], 'o1')
})
test('coding requests are collected for owner rather than solved', async t => {
  const { agent, store, external, owner } = setup(t, async () => { throw new Error('Should not call model') })
  const contact = store.contact('1001@lid')
  await startReply(agent, contact, 'Write Python code for my homework')
  assert.match(external[0].text, /pass this request/)
  assert.equal(owner.length, 1)
})
test('an immediate emergency skips the model and is relayed urgently', async t => {
  const { agent, store, external, owner } = setup(t, async () => { throw new Error('Should not call model') })
  const contact = store.contact('1001@lid')
  await startReply(agent, contact, 'My dad is unconscious and not breathing')
  assert.match(external[0].text, /emergency services/)
  assert.match(owner[0].text, /^URGENT/)
})
test('ambiguous owner instructions cannot send to an inferred contact', t => {
  const { agent, store } = setup(t)
  const contact = store.contact('1001@lid')
  assert.throws(() => agent.authorizeAction({ type: 'send', target: contact.id }, 'Tell him hello', null), /Specify one exact/)
})
test('explicit owner reply and whitelist commands persist and target the correct thread', async t => {
  const { agent, store, external } = setup(t)
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  await agent.command(`/whitelist ${a.id} mother`)
  assert.equal(a.permission, 'all_personal'); assert.equal(b.permission, 'public')
  const concern = store.concern(b, 'Waiting for file')
  await agent.command(`/reply ${concern.id} Please send the file.`)
  assert.equal(external[0].contact, b.id)
  assert.equal(external[0].text, 'Please send the file.')
})
test('contexts do not contain another contact history', async t => {
  let captured
  const { agent, store } = setup(t, async (context, messages) => { captured = { context, messages }; return decision() })
  const a = store.contact('1001@lid'), b = store.contact('1002@lid')
  store.append(a.id, 'user', 'Secret from A')
  await startReply(agent, b, 'Question from B')
  assert.doesNotMatch(JSON.stringify(captured), /Secret from A/)
})
test('phone and LID aliases share one contact, approval and history after restart', t => {
  const { store } = setup(t)
  const a = store.contact('1001@lid', ['919999999999@s.whatsapp.net'])
  store.approve(a, 'father'); store.append(a.id, 'user', 'Same person')
  const again = new Store(store.file)
  const b = again.contact('919999999999@s.whatsapp.net')
  assert.equal(b.id, a.id); assert.equal(b.confirmed, true)
  assert.equal(again.history(b.id)[0].text, 'Same person')
})
test('late authenticated alias mapping merges unapproved history into the approved contact', t => {
  const { store } = setup(t)
  const a = store.contact('1001@lid'), b = store.contact('919999999999@s.whatsapp.net')
  store.approve(b, 'mother')
  store.append(a.id, 'user', 'Earlier LID message')
  const merged = store.contact('1001@lid', ['919999999999@s.whatsapp.net'])
  assert.equal(merged.id, b.id); assert.equal(merged.confirmed, true)
  assert.equal(store.data.contacts[a.id], undefined)
  assert.equal(store.history(b.id)[0].text, 'Earlier LID message')
})
test('revoked contact context does not replay a previous personal assistant response', async t => {
  let messages
  const { agent, store } = setup(t, async (_context, history) => { messages = history; return decision() })
  const contact = store.contact('1001@lid')
  store.approve(contact, 'mother')
  store.append(contact.id, 'assistant', 'Private location', { visibility: 'personal' })
  store.revoke(contact)
  await startReply(agent, contact)
  assert.doesNotMatch(JSON.stringify(messages), /Private location/)
})
test('owner can whitelist an exact phone number before that person messages', async t => {
  const { agent, store } = setup(t)
  await agent.command('/whitelist +919999999999 mother')
  const contact = store.getContact('+919999999999')
  assert.equal(contact.permission, 'all_personal'); assert.equal(contact.confirmed, true)
})
test('newer incoming text invalidates an older in-progress response', async t => {
  let finish, started
  const began = new Promise(resolve => { started = resolve })
  const { agent, store, external } = setup(t, async () => { started(); return new Promise(resolve => { finish = resolve }) })
  const contact = store.contact('1001@lid')
  const pending = startReply(agent, contact, 'First part')
  await began
  agent.receiveExternal(contact, { id: 'm2', text: 'Actually the deadline changed' })
  finish(decision({ reply: 'Reply to obsolete text' }))
  await pending
  assert.equal(external.length, 0)
})
test('forwarded self-chat text cannot execute a permission command', async t => {
  const { agent, store } = setup(t)
  const contact = store.contact('1001@lid')
  await agent.receiveOwner(`/whitelist ${contact.id} mother`, null, null, { forwarded: true })
  assert.equal(contact.confirmed, false)
})
test('initial timer respects the full response window before taking over', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agent, store, external } = setup(t)
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'timed', text: 'Hello' })
  t.mock.timers.tick(9999)
  assert.equal(external.length, 0)
  t.mock.timers.tick(1)
  await agent.state(contact.id).queue
  assert.equal(external.length, 1)
  assert.equal(agent.state(contact.id).active, true)
})
test('self-chat emergency receives immediate help without waiting for Codex', async t => {
  const { agent, owner } = setup(t, async () => { throw new Error('Must not wait for model') })
  await agent.receiveOwner('My friend is unconscious and not breathing')
  assert.match(owner[0].text, /emergency services/)
})
test('forgetting a fact prevents reuse of earlier personal assistant replies', async t => {
  let history
  const { agent, store } = setup(t, async (_context, messages) => { history = messages; return decision() })
  const contact = store.contact('1001@lid')
  store.approve(contact, 'mother')
  store.remember('Private location', 'location')
  store.append(contact.id, 'assistant', 'Private location', { visibility: 'personal', memoryVersion: 0 })
  await agent.command('/forget location')
  await startReply(agent, contact)
  assert.doesNotMatch(JSON.stringify(history), /Private location/)
})

test('self-chat starts immediately without advancing any takeover timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const { agent, owner } = setup(t, async context => {
    calls++
    assert.equal(context.mode, 'OWNER')
    return decision({ reply: 'Yes, what do you need?' })
  })
  await agent.receiveOwner('Clara, can we talk?')
  assert.equal(calls, 1)
  assert.equal(owner.length, 1)
})

test('takeover handles repeated follow-ups, stays silent at closure and handles a later question', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const { agent, store, external } = setup(t, async (_context, history) => {
    calls++
    return decision({ reply: history.at(-1).text === 'Thanks' ? null : 'A short useful answer.' })
  })
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'q1', text: 'First question' })
  t.mock.timers.tick(10000); await agent.state(contact.id).queue
  agent.receiveExternal(contact, { id: 'q2', text: 'A necessary follow-up' })
  t.mock.timers.tick(649)
  assert.equal(external.length, 1)
  t.mock.timers.tick(1); await agent.state(contact.id).queue
  assert.equal(external.length, 2)
  agent.receiveExternal(contact, { id: 'q3', text: 'Thanks' })
  t.mock.timers.tick(650); await agent.state(contact.id).queue
  assert.equal(external.length, 2)
  assert.equal(agent.state(contact.id).active, true)
  assert.equal(contact.conversation.pending, null)
  t.mock.timers.tick(60000)
  assert.equal(calls, 3)
  agent.receiveExternal(contact, { id: 'q4', text: 'One more substantive question' })
  t.mock.timers.tick(650); await agent.state(contact.id).queue
  assert.equal(external.length, 3)
})

test('each owner message resets the handback timer and resumes from the shared context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 })
  let captured
  const { agent, store, external } = setup(t, async (context, history) => {
    captured = { context, history }
    return decision({ reply: 'I will check the remaining hosting detail with Aditya.' })
  })
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'q1', text: 'What is the price and does it include hosting?' })
  agent.ownerIntervened(contact, 'Around 15k, depending on scope.')
  t.mock.timers.tick(9000)
  agent.ownerIntervened(contact, 'That is only an estimate.')
  t.mock.timers.tick(9999)
  assert.equal(external.length, 0)
  t.mock.timers.tick(1); await agent.state(contact.id).queue
  assert.equal(external.length, 1)
  assert.equal(captured.context.conversation.ownerSpokeAfterRequest, true)
  assert.equal(captured.history.at(-1).text, 'That is only an estimate.')
  assert.ok(captured.history.some(entry => entry.text.includes('hosting?')))
})

test('owner silence with no pending contact request never sends a follow-up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const { agent, store, external } = setup(t, async () => { calls++; return decision() })
  const contact = store.contact('1001@lid')
  await startReply(agent, contact)
  agent.ownerIntervened(contact, 'I have handled it, thank you.')
  t.mock.timers.tick(10000); await agent.state(contact.id).queue
  assert.equal(calls, 1)
  assert.equal(external.length, 1)
  assert.equal(agent.state(contact.id).active, true)
  agent.receiveExternal(contact, { id: 'later', text: 'A new question' })
  t.mock.timers.tick(650); await agent.state(contact.id).queue
  assert.equal(external.length, 2)
})

test('a question already answered by the owner can close silently after handback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agent, store, external } = setup(t, async (_context, history) => {
    assert.equal(history.at(-1).role, 'owner')
    return decision({ reply: null })
  })
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'question', text: 'When can we meet?' })
  agent.ownerIntervened(contact, 'Tomorrow at 5. Confirm with me then.')
  t.mock.timers.tick(10000); await agent.state(contact.id).queue
  assert.equal(external.length, 0)
  assert.equal(contact.conversation.pending, null)
  t.mock.timers.tick(60000)
  assert.equal(external.length, 0)
})

test('a restart preserves takeover and safely recovers a recent unfinished text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agent, store, transport, external } = setup(t)
  const contact = store.contact('1001@lid')
  await startReply(agent, contact)
  agent.receiveExternal(contact, { id: 'unfinished', text: 'And what about the deadline?' })
  agent.stop()
  const restored = new Store(store.file)
  const again = new Agent({ config: agent.config, profile, store: restored, provider: agent.provider, transport })
  try {
    again.resume()
    assert.equal(again.state(contact.id).active, true)
    t.mock.timers.tick(9999)
    assert.equal(external.length, 1)
    t.mock.timers.tick(1); await again.state(contact.id).queue
    assert.equal(external.length, 2)
    assert.equal(restored.data.contacts[contact.id].conversation.pending, null)
    again.receiveExternal(restored.data.contacts[contact.id], { id: 'next', text: 'Another detail' })
    t.mock.timers.tick(650); await again.state(contact.id).queue
    assert.equal(external.length, 3)
  } finally { again.stop() }
})

test('reconnect preserves owner control until its grace period finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agent, store, transport, external } = setup(t)
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'question', text: 'Need a detail' })
  agent.ownerIntervened(contact, 'I am checking.')
  transport.ready = false
  agent.disconnect()
  assert.equal(agent.state(contact.id).active, false)
  t.mock.timers.tick(10000)
  assert.equal(external.length, 0)
  transport.ready = true
  agent.resume()
  t.mock.timers.tick(9999)
  assert.equal(external.length, 0)
  t.mock.timers.tick(1); await agent.state(contact.id).queue
  assert.equal(external.length, 1)
})

test('stale unfinished requests are not replayed after a restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 })
  const { agent, store, external } = setup(t)
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'old', text: 'Old question' })
  agent.disconnect()
  t.mock.timers.tick(300001)
  agent.resume()
  t.mock.timers.tick(10000); await agent.state(contact.id).queue
  assert.equal(external.length, 0)
  assert.equal(contact.conversation.pending, null)
})

test('a recovered photo requests a fresh image rather than inventing its contents', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agent, store, transport, external } = setup(t, async () => { throw new Error('No retained image') })
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'photo', text: '', photo: true, raw: { privateMediaKey: 'not-persisted' } })
  agent.stop()
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /privateMediaKey|not-persisted/)
  const restored = new Store(store.file)
  const again = new Agent({ config: agent.config, profile, store: restored, provider: agent.provider, transport })
  try {
    again.resume()
    t.mock.timers.tick(10000); await again.state(contact.id).queue
    assert.match(external[0].text, /resend that photo/)
  } finally { again.stop() }
})

test('failed owner relays do not suppress the contact answer or stop follow-ups', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agent, store, transport, external } = setup(t, async () => decision({
    claim: { name: 'A contact', relationship: 'friend' }, concern: { summary: 'Needs a reply about a meeting', urgent: false }
  }))
  transport.sendOwner = async () => { throw new Error('Self-chat unavailable') }
  const contact = store.contact('1001@lid')
  await startReply(agent, contact)
  assert.equal(external.length, 1)
  assert.equal(contact.verificationNotified, false)
  assert.equal(store.data.concerns.R0001.notifiedSummary, '')
  agent.receiveExternal(contact, { id: 'followup', text: 'It is about tomorrow.' })
  t.mock.timers.tick(650); await agent.state(contact.id).queue
  assert.equal(external.length, 2)
})

test('a slow owner notification cannot block the next external response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish, started
  const began = new Promise(resolve => { started = resolve })
  const { agent, store, transport, external } = setup(t, async () => decision({
    concern: { summary: 'Needs a meeting', urgent: false }
  }))
  transport.sendOwner = async () => { started(); await new Promise(resolve => { finish = resolve }); return { key: { id: 'note' } } }
  const contact = store.contact('1001@lid')
  const first = startReply(agent, contact)
  await began
  agent.receiveExternal(contact, { id: 'followup', text: 'One more detail' })
  t.mock.timers.tick(650)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(external.length, 2)
  finish()
  await first
  await agent.state(contact.id).queue
})

test('owner sees a recent-chat index without leaking raw runtime control state', async t => {
  let captured
  const { agent, store } = setup(t, async context => { captured = context; return decision() })
  const contact = store.contact('1001@lid')
  agent.receiveExternal(contact, { id: 'private', text: 'Unreferenced contact message' })
  await agent.receiveOwner('Hello Clara')
  assert.equal(captured.recentChats[0].lastIncoming.text, 'Unreferenced contact message')
  assert.equal(captured.contacts[0].conversation, undefined)
  assert.equal(captured.linkedThreads.length, 0)
})
