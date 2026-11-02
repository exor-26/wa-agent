const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

function mediaError(message, code = 'MEDIA_REJECTED') { return Object.assign(new Error(message), { code }) }
function mediaLimits(config = {}) {
  return { photo: config.maxPhotoBytes || 10 * 1024 * 1024, document: config.maxDocumentBytes || 10 * 1024 * 1024,
    audio: config.maxAudioBytes || 8 * 1024 * 1024, sticker: 2 * 1024 * 1024,
    seconds: config.maxAudioSeconds || 180, pages: config.maxDocumentPages || 20,
    timeoutMs: config.mediaTimeoutMs || 120000 }
}
function classify(content, raw = {}) {
  if (raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension) return { rejected: 'View-once media remains private and is not processed.' }
  if (content.videoMessage || content.ptvMessage) return { rejected: 'Video is not supported. Please send a photo, voice note or normal document instead.' }
  if (content.imageMessage) return { kind: 'photo', node: content.imageMessage }
  if (content.stickerMessage) return { kind: 'sticker', node: content.stickerMessage }
  if (content.audioMessage) return { kind: 'audio', node: content.audioMessage }
  if (content.documentMessage) {
    const mime = String(content.documentMessage.mimetype || '')
    if (/^video\//.test(mime) || /\.(mp4|mkv|mov|webm|avi)$/i.test(content.documentMessage.fileName || '')) return { rejected: 'Video is not supported. Please send a photo, voice note or document instead.' }
    const name = content.documentMessage.fileName || ''
    return { kind: /^image\//.test(mime) || /\.(jpg|jpeg|png|webp|avif|heic)$/i.test(name) ? 'photo' :
      /^audio\//.test(mime) || /\.(ogg|opus|mp3|wav|m4a|aac|flac|aiff|amr)$/i.test(name) ? 'audio' : 'document', node: content.documentMessage }
  }
  return null
}
function structuredText(content) {
  const selection = content.buttonsResponseMessage?.selectedDisplayText || content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText
  if (selection) return `[Sender selected a WhatsApp option]\n${selection}`.slice(0, 2000)
  const loc = content.locationMessage || content.liveLocationMessage
  if (loc) return `[Sender-shared ${content.liveLocationMessage ? 'live-location snapshot, not continuous tracking' : 'location'}]\n${loc.name || ''}\n${loc.address || ''}\nLatitude: ${loc.degreesLatitude}; longitude: ${loc.degreesLongitude}`.slice(0, 2000)
  const cards = content.contactsArrayMessage?.contacts || (content.contactMessage ? [content.contactMessage] : [])
  if (cards.length) return `[Shared contact cards; unverified]\n${cards.slice(0, 10).map(card =>
    `${card.displayName || ''}\n${String(card.vcard || '').split(/\r?\n/).filter(line => /^(FN|N|TEL|EMAIL|ORG)[;:]/i.test(line)).join('\n')}`).join('\n')}`.slice(0, 6000)
  const poll = content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3
  if (poll) return `[Shared poll; reading only, no vote cast]\n${poll.name || ''}\n${(poll.options || []).slice(0, 20).map(option => option.optionName).join('\n')}`.slice(0, 3000)
  return ''
}

class MediaProcessor {
  constructor(config = {}) { this.config = config; this.tail = Promise.resolve() }
  async process(file, metadata, { signal } = {}) {
    if (signal?.aborted) throw mediaError('Media processing cancelled.', 'MEDIA_CANCELLED')
    const previous = this.tail.catch(() => {})
    let release, cancel
    const turn = new Promise(resolve => { release = resolve })
    this.tail = previous.then(() => turn)
    try {
      await Promise.race([previous, new Promise((_, reject) => {
        cancel = () => reject(mediaError('Media processing cancelled.', 'MEDIA_CANCELLED'))
        signal?.addEventListener('abort', cancel, { once: true })
      })])
      if (signal?.aborted) throw mediaError('Media processing cancelled.', 'MEDIA_CANCELLED')
      return await this.run(file, metadata, signal)
    } finally { signal?.removeEventListener('abort', cancel); release() }
  }
  run(file, metadata, signal) {
    const limits = mediaLimits(this.config)
    return new Promise((resolve, reject) => {
      const env = { ...process.env }
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN']) delete env[key]
      const child = spawn(process.execPath, ['--max-old-space-size=768', path.join(__dirname, '..', 'scripts', 'media-worker.js')], {
        cwd: path.dirname(file), env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      })
      let stdout = '', stderr = '', failure = null
      const kill = () => {
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch {}
      }
      const cancel = () => { failure = mediaError('Media processing cancelled.', 'MEDIA_CANCELLED'); kill() }
      const timer = setTimeout(() => { failure = mediaError('That attachment took too long. Please send a shorter voice note or a smaller document.', 'MEDIA_TIMEOUT'); kill() }, limits.timeoutMs)
      signal?.addEventListener('abort', cancel, { once: true })
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) { failure = mediaError('Attachment output exceeded the processing limit.'); kill() } })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000) })
      child.stdin.on('error', () => {})
      child.once('error', error => { failure = mediaError(`Media worker could not start: ${error.code || 'unknown error'}`) })
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel)
        if (failure) return reject(failure)
        try {
          const result = JSON.parse(stdout)
          if (code || result.error) throw mediaError(result.error || 'Unable to read that attachment. Please send a smaller PDF, text file, photo or voice note.')
          const directory = path.dirname(file)
          for (const image of result.images || []) {
            const relative = path.relative(directory, image)
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw mediaError('Invalid media output path.')
          }
          resolve(result)
        } catch (error) { reject(error.code ? error : mediaError('Unable to read that attachment. Please resend it in a supported format.')) }
      })
      child.stdin.end(JSON.stringify({ file, metadata, limits, cache: path.join(path.dirname(this.config.stateFile || path.join(os.tmpdir(), 'clara-data/state.json')), 'models') }))
    })
  }
}
module.exports = { MediaProcessor, mediaLimits, mediaError, classify, structuredText }
