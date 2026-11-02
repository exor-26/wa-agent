const assert = require('node:assert/strict')
const { config } = require('../src/config')
const { Codex } = require('../src/codex')
const { healthReferences } = require('../src/safety')

async function main() {
  const provider = new Codex(config)
  const model = process.argv.includes('--luna') ? 'gpt-6-luna' : config.model
  const context = { mode: 'EXTERNAL', owner: 'Aditya', public: {}, personal: null,
    contact: { id: 'C0001', name: 'Ravi', introduced: true, confirmed: false,
      claimed_relationship_unverified: 'classmate', permission: 'public' },
    availability: { status: 'limited', basis: 'usual schedule, not live presence' },
    conversation: { active: true, ownerSpokeAfterRequest: false }, openConcern: null, healthReferences }
  const history = []
  async function check(label, runtime, messages, verify) {
    const started = Date.now()
    const result = await provider.generate(runtime, messages, { model })
    verify(result)
    console.log(`${label}: PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    return result
  }
  history.push({ role: 'user', text: 'Can you ask Aditya to review our project proposal?' })
  const initial = await check('Initial concern', context, history, result => assert.ok(result.reply))
  history.push({ role: 'assistant', text: initial.reply },
    { role: 'user', text: 'It is a college website proposal. We need his feedback by tomorrow evening.' })
  const followup = await check('Meaningful follow-up', context, history, result => {
    assert.ok(result.reply)
    assert.ok(result.concern?.summary)
    assert.doesNotMatch(result.reply, /what is your name|how do you know/i)
  })
  history.push({ role: 'assistant', text: followup.reply },
    { role: 'user', text: 'When can he review it?' },
    { role: 'owner', text: 'Tomorrow. Send me the proposal link first.' })
  await check('Owner already answered; stay silent', {
    ...context, conversation: { active: true, ownerSpokeAfterRequest: true }
  }, history, result => assert.equal(result.reply, null))
  history.push({ role: 'user', text: 'Should I send a link or a voice explanation?' })
  const resumed = await check('Continue after owner handback', context, history, result => assert.ok(result.reply))
  history.push({ role: 'assistant', text: resumed.reply }, { role: 'user', text: 'Okay, thanks, bye.' })
  await check('Close without unnecessary engagement', context, history, result => assert.equal(result.reply, null))
  await check('Live direct owner conversation', { mode: 'OWNER', owner: 'Aditya', contacts: [],
    concerns: [], ownerFacts: [], healthReferences }, [{ role: 'owner', text: 'Clara, are you here? Reply briefly to me.' }], result => {
    assert.ok(result.reply)
    assert.doesNotMatch(result.reply, /Aditya is (unavailable|absent)|pass.*to Aditya/i)
    assert.equal(result.actions.length, 0)
  })
  console.log(`Conversation smoke passed using ${model} / low. Synthetic context only; no WhatsApp messages sent.`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
