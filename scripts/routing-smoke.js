const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { config } = require('../src/config')
const { Store } = require('../src/store')
const { Agent } = require('../src/agent')
const { Codex } = require('../src/codex')

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-routing-smoke-'))
  const store = new Store(path.join(directory, 'state.json'))
  const external = [], owner = []
  const model = process.argv.includes('--luna') ? 'gpt-6-luna' : config.model
  const agent = new Agent({ config: { ...config, model }, store,
    profile: { owner: 'Aditya', timezone: 'Asia/Kolkata', schedule: { weekday: [], weekend: [] }, public: {} },
    provider: new Codex(config), transport: { ready: true,
      sendContact: async (contact, text) => { external.push({ contact: contact.id, text }); return { key: { id: `fake-send-${external.length}` } } },
      sendOwner: async (text, reference) => { owner.push({ text, reference }); return { key: { id: `fake-owner-${owner.length}` } } } } })
  try {
    const ravi = store.contact('1001@lid'), neha = store.contact('1002@lid')
    store.applyNames(ravi, { saved: 'Ravi' })
    store.applyNames(neha, { saved: 'Neha' })
    store.append(neha.id, 'user', 'Please ask Aditya about a project meeting.', { at: new Date(Date.now() - 120000).toISOString() })
    store.append(ravi.id, 'user', 'Tell me where Aditya is.', { at: new Date(Date.now() - 60000).toISOString() })
    store.append(ravi.id, 'assistant', 'I cannot share his private location. You can leave a message for him.', { visibility: 'public' })
    async function check(label, text, verify) {
      const before = owner.length
      await agent.receiveOwner(text)
      assert.ok(owner.length > before, `No owner response: ${label}`)
      assert.doesNotMatch(owner.at(-1).text, /^Could not complete/)
      verify(owner.at(-1).text)
      console.log(`${label}: PASS`)
    }
    await check('Who messaged last?', 'Anybody msg us last?', reply => assert.match(reply, /Ravi|C0001/i))
    await check('Cross-turn pronoun context', 'What did he ask you?', reply => assert.match(reply, /where|location|whereabouts/i))
    await check('Natural msg command', 'Msg him that I will respond tomorrow.', () => {
      assert.equal(external.length, 1)
      assert.equal(external[0].contact, ravi.id)
      assert.match(external[0].text, /tomorrow/i)
    })
    await check('Draft without sending', 'Draft a reply to him saying I can talk tomorrow after 8:30 PM.', () => {
      assert.equal(external.length, 1)
      assert.equal(store.data.settings.ownerDraft?.contact, ravi.id)
    })
    const draft = store.data.settings.ownerDraft.text
    await check('Msg it to this guy', 'Msg it to this guy.', () => {
      assert.equal(external.length, 2)
      assert.equal(external[1].contact, ravi.id)
      assert.equal(external[1].text, draft)
    })
    await check('No invented delivery receipt', "Don't send anything else. Was the last message delivered or read?", reply => {
      assert.equal(external.length, 2)
      assert.doesNotMatch(reply, /(?:was|is|has been) (?:delivered|read)|they (?:have )?read it/i)
      assert.match(reply, /confirm|receipt|accepted|only|unknown|can't|cannot|don't|not/i)
    })
    console.log(`Real owner-routing checks passed using ${model} / low. All WhatsApp transport was mocked; no real messages sent.`)
  } finally {
    agent.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
