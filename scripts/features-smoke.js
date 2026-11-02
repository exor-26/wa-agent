const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { config } = require('../src/config')
const { Store } = require('../src/store')
const { Agent } = require('../src/agent')
const { Codex } = require('../src/codex')
const { MediaProcessor } = require('../src/media')
const { FOCUS_TTL_MS } = require('../src/owner-context')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-features-smoke-'))
  const model = process.argv.includes('--luna') ? 'gpt-6-luna' : config.model
  const store = new Store(path.join(root, 'state.json')), external = [], owner = []
  const provider = new Codex(config)
  const profile = { owner: 'Aditya', timezone: 'Asia/Kolkata', public: {}, schedule: { weekday: [], weekend: [] } }
  const agent = new Agent({ config: { ...config, model }, profile, store, provider,
    transport: { ready: true, sendContact: async (contact, text) => {
      external.push({ contact: contact.id, text }); return { key: { id: `fake-send-${external.length}` } }
    }, sendOwner: async text => { owner.push(text); return { key: { id: `fake-owner-${owner.length}` } } } } })
  try {
    const old = store.contact('1001@lid'), bhai = store.contact('1002@lid')
    for (const contact of [old, bhai]) store.applyNames(contact, { saved: 'Bhai' })
    store.data.settings.ownerFocus = { contacts: [old.id], at: Date.now() - FOCUS_TTL_MS - 1000 }
    store.append(bhai.id, 'user', 'QR ya UPI ID de. Tujhe 5000 mangwana hai.')
    await agent.relayConcern(store.concern(bhai, 'Brother requests the owner UPI ID.'))
    await agent.receiveOwner('demo-26@ybl is my UPI ID. He is my brother. Send it to him and save this UPI.')
    assert.equal(external.length, 1, owner.at(-1))
    assert.equal(external[0].contact, bhai.id)
    assert.match(external[0].text, /demo-26@ybl/)
    assert.ok(store.data.facts.some(fact => fact.text.includes('demo-26@ybl')))
    assert.equal(bhai.confirmed, true)
    assert.equal(bhai.permission, 'public')
    console.log(`PASS ${model}: exact Bhai compound save/relationship/send; same-turn literal, no draft`)
    const result = await provider.generate(agent.context(bhai), [...store.history(bhai.id), { role: 'user', text: 'UPI ID phir se bata do' }], { model })
    assert.match(result.reply || '', /demo-26@ybl/)
    console.log(`PASS ${model}: specifically shared UPI available in that public-permission thread only`)
    await agent.receiveOwner('Message +919999999998 "Please call Aditya when you are free."')
    assert.equal(external.length, 2, owner.at(-1))
    assert.equal(external[1].contact, store.getContact('+919999999998').id)
    console.log(`PASS ${model}: first outgoing contact without an inbound message`)
    await agent.receiveOwner(`Message ${bhai.id} "Please call Aditya." in 10 minutes.`)
    assert.equal(external.length, 2, 'Scheduled task sent prematurely')
    assert.ok(store.data.outreach.some(task => task.status === 'queued' && task.contact === bhai.id && task.dueAt > Date.now()))
    console.log(`PASS ${model}: proactive scheduled message stays queued without any incoming event`)
    if (!process.argv.includes('--skip-audio')) {
      const response = await fetch('https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac', { signal: AbortSignal.timeout(30000) })
      assert.ok(response.ok, `Public Whisper test fixture download failed: ${response.status}`)
      const audio = path.join(root, 'input')
      fs.writeFileSync(audio, Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
      const media = new MediaProcessor(config)
      const transcript = await media.process(audio, { kind: 'audio', name: 'fixture.flac' })
      assert.match(transcript.text, /country/i)
      console.log('PASS local Whisper: real spoken-audio decoding and transcription; no audio uploaded')
    }
    console.log('All WhatsApp sends were mocked. No real contacts were messaged.')
  } finally { agent.stop(); fs.rmSync(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
