const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config({ quiet: true })

const root = path.resolve(__dirname, '..')
function integer(name, fallback, min = 1, max = 86400) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
  return value
}
const config = {
  root,
  authDir: path.resolve(root, process.env.AUTH_DIR || 'auth'),
  stateFile: path.resolve(root, process.env.STATE_FILE || 'data/state.json'),
  profileFile: path.resolve(root, process.env.PROFILE_FILE || 'data/profile.json'),
  legacyHistoryFile: path.resolve(root, process.env.CHAT_HISTORY_FILE || 'chat-history.json'),
  ownerJid: process.env.CLARA_CHAT_JID || '',
  takeoverMs: integer('OWNER_TAKEOVER_DELAY_SECONDS', 14) * 1000,
  historyLimit: integer('HISTORY_MAX_MESSAGES', 30, 4, 100),
  model: process.env.CODEX_MODEL || 'gpt-6.1-sol',
  codexBin: process.env.CODEX_BIN || '',
  codexTimeoutMs: integer('CODEX_TIMEOUT_SECONDS', 90, 10, 300) * 1000,
  waConnectTimeoutMs: integer('WA_CONNECT_TIMEOUT_SECONDS', 30, 10, 120) * 1000,
  waReconnectMaxMs: integer('WA_RECONNECT_MAX_SECONDS', 60, 5, 300) * 1000,
  maxPhotoBytes: integer('MAX_PHOTO_MB', 10, 1, 20) * 1024 * 1024,
  maxDocumentBytes: integer('MAX_DOCUMENT_MB', 10, 1, 20) * 1024 * 1024,
  maxAudioBytes: integer('MAX_AUDIO_MB', 8, 1, 16) * 1024 * 1024,
  maxAudioSeconds: integer('MAX_AUDIO_SECONDS', 180, 10, 300),
  maxDocumentPages: integer('MAX_DOCUMENT_PAGES', 20, 1, 40),
  mediaTimeoutMs: integer('MEDIA_TIMEOUT_SECONDS', 120, 30, 300) * 1000,
  logText: process.env.LOG_MESSAGE_TEXT === 'true'
}
const models = { sol: 'gpt-6.1-sol', luna: 'gpt-6-luna' }
function modelId(value) {
  const id = models[value] || value
  if (!Object.values(models).includes(id)) throw new Error('Choose sol or luna')
  return id
}
function readProfile() {
  if (!fs.existsSync(config.profileFile)) {
    throw new Error(`Create ${config.profileFile} using config/profile.example.json first`)
  }
  const profile = JSON.parse(fs.readFileSync(config.profileFile, 'utf8'))
  fs.chmodSync(config.profileFile, 0o600)
  if (!profile.owner || !profile.timezone || !profile.schedule) throw new Error('Profile needs owner, timezone and schedule')
  new Intl.DateTimeFormat('en', { timeZone: profile.timezone }).format()
  return profile
}
function availability(profile, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: profile.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]))
  const minute = Number(parts.hour) * 60 + Number(parts.minute)
  const day = ['Sat', 'Sun'].includes(parts.weekday) ? 'weekend' : 'weekday'
  const slot = profile.schedule[day].find(s => minute >= s.start && minute < s.end)
  return { status: slot?.status || 'unknown', timezone: profile.timezone,
    localTime: `${parts.weekday} ${parts.hour}:${parts.minute}`, usualActivity: slot?.activity || null,
    basis: 'usual schedule, not live presence or a promise of a reply' }
}
function log(event, data = {}) {
  console.log(`[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}`)
}
module.exports = { config, modelId, readProfile, availability, log }
