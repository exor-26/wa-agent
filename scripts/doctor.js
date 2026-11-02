const fs = require('node:fs')
const { config, readProfile, availability } = require('../src/config')
const { Codex } = require('../src/codex')

async function main() {
  const profile = readProfile()
  const provider = new Codex(config)
  console.log(JSON.stringify({ node: process.version, ...provider.doctor(),
    profile: 'loaded (private)', timezone: profile.timezone,
    availability: availability(profile).status,
    whatsappAuthExists: fs.existsSync(config.authDir), scanner: 'Baileys terminal QR' }, null, 2))
  if (process.argv.includes('--probe')) {
    const result = await provider.generate({ mode: 'EXTERNAL', owner: profile.owner,
      public: profile.public, contact: { introduced: true, confirmed: false, permission: 'public' },
      availability: { status: 'limited' }, healthReferences: [] },
    [{ role: 'user', text: 'Please write me Python code to build a trading bot.' }])
    console.log('Real Codex CLI probe:', JSON.stringify(result))
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
