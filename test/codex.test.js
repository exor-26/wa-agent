const test = require('node:test')
const assert = require('node:assert/strict')
const { Codex } = require('../src/codex')

test('self-chat gets reserved capacity while other external chats wait', async () => {
  const provider = new Codex({ codexBin: '/synthetic/codex' })
  const releaseExternal = await provider.acquire()
  let externalStarted = false
  const nextExternal = provider.acquire().then(release => { externalStarted = true; return release })
  const releaseOwner = await provider.acquire(undefined, true)
  assert.equal(provider.active, 2)
  assert.equal(externalStarted, false)
  releaseOwner()
  assert.equal(externalStarted, false)
  releaseExternal()
  const releaseNext = await nextExternal
  assert.equal(externalStarted, true)
  releaseNext()
  assert.equal(provider.active, 0)
  assert.equal(provider.externalActive, 0)
})

test('cancelling queued generation does not leak capacity or block later owner work', async () => {
  const provider = new Codex({ codexBin: '/synthetic/codex' })
  const releaseExternal = await provider.acquire()
  const controller = new AbortController()
  const waiting = provider.acquire(controller.signal)
  controller.abort()
  await assert.rejects(waiting, /cancelled/)
  const releaseOwner = await provider.acquire(undefined, true)
  releaseExternal(); releaseOwner(); releaseOwner()
  assert.equal(provider.active, 0)
  assert.equal(provider.waiters.length, 0)
})
