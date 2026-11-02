const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { config } = require('../src/config')
const { Store } = require('../src/store')
const { Agent } = require('../src/agent')
const { Codex } = require('../src/codex')

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-policy-smoke-'))
  const store = new Store(path.join(directory, 'state.json'))
  const external = [], owner = []
  const model = process.argv.includes('--luna') ? 'gpt-6-luna' : config.model
  const agent = new Agent({ config: { ...config, model }, store, provider: new Codex(config),
    profile: { owner: 'Aditya', timezone: 'Asia/Kolkata', public: { links: { github: 'https://github.com/exor-26' } },
      schedule: { weekday: [], weekend: [] } },
    transport: { ready: true,
      sendContact: async (contact, text) => { external.push({ contact: contact.id, text }); return { key: { id: `fake-${external.length}` } } },
      sendOwner: async (text, reference, kind) => { owner.push({ text, reference, kind }); return { key: { id: `fake-owner-${owner.length}` } } } } })
  async function incoming(contact, text) {
    const before = external.length
    agent.receiveExternal(contact, { id: `incoming-${Date.now()}`, text })
    clearTimeout(agent.state(contact.id).timer)
    await agent.respond(contact, agent.state(contact.id).version)
    assert.equal(external.length, before + 1)
    return external.at(-1).text
  }
  try {
    await agent.receiveOwner('Keep external replies brief and ask for a deadline only when someone brings a work request.')
    assert.doesNotMatch(owner.at(-1).text, /^Could not complete/)
    assert.ok(agent.controls.data.instructions.some(rule => rule.value === 'brief'))
    assert.ok(agent.controls.data.instructions.some(rule => rule.value === 'ask_deadline'))
    console.log('Natural owner instruction saved for cross-chat use: PASS')
    await agent.receiveOwner("I'm going to sleep")
    const ravi = store.contact('1001@lid'), neha = store.contact('1002@lid')
    for (const [contact, name] of [[ravi, 'Ravi'], [neha, 'Neha']]) {
      store.applyNames(contact, { saved: name })
      Object.assign(contact, { introduced: true, identityAsked: true, verificationNotified: true, claimedRelationship: 'friend' })
    }
    owner.length = 0
    const normal = await incoming(ravi, "Where can I find Aditya's GitHub profile?")
    assert.match(normal, /github.com\/exor-26/)
    assert.doesNotMatch(normal, /sleep/i)
    assert.equal(owner.length, 0)
    console.log('Ordinary question handled normally while sleeping: PASS')
    const talk = await incoming(ravi, "Can I talk to Aditya right now? It isn't urgent.")
    assert.match(talk, /sleep/i)
    assert.doesNotMatch(talk, /call (him|Aditya) (right )?now/i)
    assert.equal(owner.length, 0)
    console.log('Nonurgent talk request gets the authorized sleep response: PASS')
    await incoming(neha, 'Can Aditya review my project proposal? The deadline is Friday.')
    assert.equal(owner.length, 0)
    assert.ok(Object.values(store.data.concerns).some(concern => concern.contactId === neha.id))
    console.log('Routine concern stays queued: PASS')
    const urgent = await incoming(ravi, 'I urgently need to talk to Aditya about an important family matter right now.')
    assert.match(urgent, /call/i)
    assert.ok(owner.some(note => /^URGENT/.test(note.text)))
    console.log('Urgent caller gets call guidance and immediate owner escalation: PASS')
    await agent.receiveOwner("I'm awake")
    assert.ok(owner.some(note => note.kind === 'digest' && /proposal|Friday/i.test(note.text)))
    assert.equal(agent.controls.quiet, false)
    console.log('Waking clears sleep mode and sends held updates: PASS')
    const awake = await incoming(ravi, 'Is Aditya still sleeping?')
    assert.doesNotMatch(awake, /(?:he|aditya) (?:is|still is|is still) sleeping/i)
    assert.match(awake, /awake|available|no longer|not sleeping/i)
    console.log('Old sleeping replies do not override the new owner status: PASS')
    await agent.receiveOwner('If anyone asks about availability, say "Please leave a text message."')
    assert.doesNotMatch(owner.at(-1).text, /^Could not complete/)
    assert.ok(agent.controls.data.instructions.some(rule => rule.kind === 'notice' && rule.text === 'Please leave a text message.'))
    console.log('Exact owner-supplied cross-chat notice saved: PASS')
    console.log(`Owner-policy smoke passed using ${model} / low. Synthetic data and mocked WhatsApp transport; no real sends.`)
  } finally {
    agent.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
