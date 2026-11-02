const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const {
  default: makeWASocket, useMultiFileAuthState,
  DisconnectReason, normalizeMessageContent, downloadMediaMessage, generateMessageIDV2
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { jid, directJid } = require('./store')
const { log } = require('./config')
const { qrPng } = require('./qr')
const { backoff, disconnectDetails } = require('./recovery')
const { MediaProcessor, mediaLimits, mediaError, classify, structuredText } = require('./media')

function payload(msg) {
  const content = normalizeMessageContent(msg.message)
  if (!content || content.protocolMessage || content.reactionMessage || content.senderKeyDistributionMessage) return null
  const media = classify(content, msg.message)
  const photo = media?.kind === 'photo' || media?.kind === 'sticker'
  const text = media?.rejected ? '' : content.conversation || content.extendedTextMessage?.text || media?.node?.caption || structuredText(content) || ''
  const derivedText = !!text && !content.conversation && !content.extendedTextMessage?.text && !media?.node?.caption
  const context = content.extendedTextMessage?.contextInfo || media?.node?.contextInfo
  return { id: msg.key.id, text, photo, mediaType: media?.kind || null, rejected: media?.rejected || null,
    unsupported: !!media?.rejected || !media && !text, derivedText, raw: msg,
    quotedId: context?.stanzaId || null, forwarded: !!context?.isForwarded }
}
class WhatsApp extends EventEmitter {
  constructor(config, store, dependencies = {}) {
    super(); this.config = config; this.store = store; this.ready = false; this.stopped = false
    this.socket = null; this.generation = 0; this.reconnectTimer = null; this.ownerAliases = new Set()
    this.logger = pino({ level: 'silent' }); this.bootAt = Date.now()
    this.qrVersion = 0
    this.makeSocket = dependencies.makeSocket || makeWASocket
    this.loadAuth = dependencies.loadAuth || useMultiFileAuthState
    this.reconnectAttempt = 0; this.connectionTimer = null; this.resumeTimer = null
    this.media = new MediaProcessor(config)
    this.downloadMedia = dependencies.downloadMedia || downloadMediaMessage
    this.lastClock = Date.now(); this.connectedAt = null; this.attention = false
    this.qrFile = path.join(path.dirname(config.stateFile || config.authDir || os.tmpdir()), 'pairing-qr.png')
    if (config.ownerJid) this.ownerAliases.add(jid(config.ownerJid))
  }
  bind(agent) { this.agent = agent }
  async start() {
    if (this.stopped || this.attention) return
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null
    clearTimeout(this.connectionTimer)
    const generation = ++this.generation
    this.disposeSocket()
    this.ready = false
    this.emit('connectionState', 'connecting')
    if (!this.resumeTimer) {
      this.lastClock = Date.now()
      this.resumeTimer = setInterval(() => this.checkResume(), 15000)
    }
    fs.mkdirSync(this.config.authDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.config.authDir, 0o700)
    this.authPromise ||= this.loadAuth(this.config.authDir).catch(error => { this.authPromise = null; throw error })
    const { state, saveCreds } = await this.authPromise
    if (generation !== this.generation || this.stopped) return
    for (const address of [state.creds.me?.id, state.creds.me?.lid]) if (address) this.ownerAliases.add(jid(address))
    for (const alias of this.ownerAliases) {
      if (this.store.data.history[alias]) {
        this.store.data.ownerHistory = [...this.store.data.history[alias], ...this.store.data.ownerHistory].slice(-this.store.historyLimit)
        delete this.store.data.history[alias]
        this.store.save()
      }
    }
    this.store.linkLegacy(this.ownerAliases)
    if (state.creds.me?.id) this.ownerJid = jid(state.creds.me.id)
    // Use the protocol version bundled with this Baileys build; no network fetch on every retry.
    const socket = this.socket = this.makeSocket({ auth: state, logger: this.logger,
      browser: ['Clara', 'Chrome', '1.0.0'], syncFullHistory: false, emitOwnEvents: true,
      connectTimeoutMs: this.config.waConnectTimeoutMs || 30000, keepAliveIntervalMs: 20000 })
    const save = () => {
      this.authWrites = (this.authWrites || Promise.resolve()).then(saveCreds)
        .catch(error => log('AUTH_SAVE_FAILED', { message: error.message }))
    }
    socket.ev.on('creds.update', save)
    const names = entries => {
      if (generation !== this.generation || this.stopped) return
      try { this.store.cacheNames((entries || []).filter(entry => !this.ownerAliases.has(jid(entry.id)))) }
      catch (error) { log('CONTACT_METADATA_FAILED', { message: error.message }) }
    }
    socket.ev.on('contacts.upsert', names)
    socket.ev.on('contacts.update', names)
    const history = update => names(update.contacts)
    socket.ev.on('messaging-history.set', history)
    const connection = update => {
      if (generation !== this.generation || this.stopped) return
      if (update.qr) {
        clearTimeout(this.connectionTimer)
        this.emit('connectionState', 'pairing')
        const qrVersion = ++this.qrVersion
        log('PAIRING_QR', { instruction: 'WhatsApp > Linked devices > Link a device; scan the terminal QR.' })
        qrcode.generate(update.qr, { small: true })
        qrPng(update.qr).then(buffer => {
          if (this.stopped || this.ready || qrVersion !== this.qrVersion) return
          fs.mkdirSync(path.dirname(this.qrFile), { recursive: true, mode: 0o700 })
          fs.writeFileSync(this.qrFile, buffer, { mode: 0o600 })
          log('QR_IMAGE', { file: this.qrFile })
        }).catch(error => log('QR_IMAGE_FAILED', { message: error.message }))
        this.emit('qr', update.qr)
      }
      if (update.connection === 'open') {
        clearTimeout(this.connectionTimer)
        this.connectedAt = Date.now()
        this.qrVersion++
        try { fs.unlinkSync(this.qrFile) } catch {}
        this.ready = true
        this.emit('connectionState', 'connected')
        this.ownerJid = jid(socket.user?.id || this.ownerJid || this.config.ownerJid)
        this.ownerAliases = new Set([socket.user?.id, socket.user?.lid, state.creds.me?.id, state.creds.me?.lid].filter(Boolean).map(jid))
        log('SERVICE_READY', { ownerSelfChat: !!this.ownerJid, qrScanner: 'Baileys terminal QR' })
        this.emit('ready')
        this.agent?.resume()
        this.agent?.flushPending().catch(error => log('PENDING_RELAY_FAILED', { message: error.message }))
      }
      if (update.connection === 'close') {
        this.connectionClosed(update.lastDisconnect?.error)
      }
    }
    const messages = upsert => {
      if (generation !== this.generation || !this.ready || !['notify', 'append'].includes(upsert.type)) return
      // Intake stays responsive while generation runs, so owner intervention is observed immediately.
      this.intakeQueue = (this.intakeQueue || Promise.resolve()).catch(() => {}).then(async () => {
        for (const msg of upsert.messages || []) {
          if (generation !== this.generation || !this.ready) break
          try { await this.intake(msg, generation) } catch (error) { log('MESSAGE_FAILED', { message: error.message }) }
        }
      })
    }
    socket.ev.on('connection.update', connection)
    socket.ev.on('messages.upsert', messages)
    this.detachSocket = () => {
      for (const [event, handler] of [['connection.update', connection], ['messages.upsert', messages],
        ['contacts.upsert', names], ['contacts.update', names], ['messaging-history.set', history],
        ['creds.update', save]]) socket.ev.off(event, handler)
    }
    this.connectionTimer = setTimeout(() => {
      if (generation !== this.generation || this.stopped || this.ready) return
      this.connectionClosed({ message: 'WhatsApp handshake timed out', output: { statusCode: 408 } })
    }, (this.config.waConnectTimeoutMs || 30000) + 10000)
  }
  disposeSocket() {
    this.detachSocket?.(); this.detachSocket = null
    const old = this.socket; this.socket = null
    try { old?.end(new Error('Clara connection replaced locally')) } catch {}
  }
  checkResume(now = Date.now()) {
    const gap = now - this.lastClock
    this.lastClock = now
    if (!this.stopped && !this.attention && gap > 75000) {
      log('HOST_RESUMED', { gapSeconds: Math.round(gap / 1000) })
      this.connectionClosed({ message: 'Host resumed; refreshing the WhatsApp socket', output: { statusCode: 408 } })
    }
  }
  connectionClosed(error) {
    if (this.stopped || this.attention) return
    clearTimeout(this.connectionTimer)
    this.ready = false; this.agent?.disconnect()
    this.generation++; this.qrVersion++
    this.disposeSocket()
    const detail = disconnectDetails(error)
    this.emit('connectionState', 'disconnected', detail)
    log('DISCONNECTED', detail)
    const code = detail.code
    if ([401, 403, 411, 440, 500].includes(code)) {
      this.attention = true
      clearTimeout(this.reconnectTimer); clearInterval(this.resumeTimer); this.resumeTimer = null
      const state = code === DisconnectReason.connectionReplaced ? 'session_conflict' : code === 401 ? 'pairing_required' : 'attention'
      const instruction = state === 'session_conflict'
        ? 'Another connection replaced Clara. Stop the other instance, then restart. Saved auth was retained.'
        : 'WhatsApp requires attention. Check Linked devices; run npm run pair only if relinking is needed. Saved auth was retained.'
      this.emit('connectionState', state, { ...detail, instruction })
      log('CONNECTION_ATTENTION', { ...detail, state, instruction })
      this.emit('attention', { code, state, instruction })
      return
    }
    if (this.connectedAt !== null && Date.now() - this.connectedAt >= 60000) this.reconnectAttempt = 0
    this.connectedAt = null
    this.scheduleReconnect(code === DisconnectReason.restartRequired ? 300 : null, detail)
  }
  scheduleReconnect(delay = null, detail = null) {
    if (this.stopped || this.attention) return
    clearTimeout(this.reconnectTimer)
    const attempt = ++this.reconnectAttempt
    const delayMs = delay ?? backoff(attempt, { maxMs: this.config.waReconnectMaxMs || 60000 })
    const information = { ...detail, attempt, delayMs, retryAt: new Date(Date.now() + delayMs).toISOString() }
    this.emit('connectionState', 'reconnecting', information)
    log('RECONNECT_SCHEDULED', information)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.start().catch(error => this.retry(error))
    }, delayMs)
  }
  retry(error) {
    if (this.stopped || this.attention) return
    log('CONNECT_FAILED', disconnectDetails(error))
    this.generation++; this.ready = false
    this.agent?.disconnect()
    clearTimeout(this.connectionTimer)
    this.disposeSocket()
    this.scheduleReconnect(null, disconnectDetails(error))
  }
  async intake(msg, generation = this.generation) {
    if (!this.ready || !msg.message || !directJid(msg.key?.remoteJid) || !msg.key.id) return
    if (this.store.data.outbound[msg.key.id]) return
    const timestamp = Number(msg.messageTimestamp || 0) * 1000
    const old = timestamp && timestamp < this.bootAt - 15000
    if (old && (!msg.key.fromMe || timestamp < Date.now() - 300000)) return
    const dedupKey = `${jid(msg.key.remoteJid)}:${msg.key.id}`
    if (this.store.data.processed[dedupKey]) return
    const address = jid(msg.key.remoteJid)
    const data = payload(msg)
    if (!data) return
    const aliases = [msg.key.remoteJidAlt].filter(Boolean)
    try {
      if (address.endsWith('@lid')) {
        const pn = await this.socket.signalRepository?.lidMapping?.getPNForLID(address)
        if (pn) aliases.push(pn)
      } else {
        const lid = await this.socket.signalRepository?.lidMapping?.getLIDForPN(address)
        if (lid) aliases.push(lid)
      }
    } catch (error) { log('CONTACT_MAPPING_UNAVAILABLE', { message: error.message }) }
    if (generation !== this.generation || !this.ready) return
    if (this.store.seen(dedupKey)) return
    const self = [address, ...aliases.map(jid)].some(a => this.ownerAliases.has(a))
    if (msg.key.fromMe && self) {
      if (old) return
      if (data.rejected) {
        this.sendOwner(data.rejected, null, 'reply').catch(error => log('OWNER_MEDIA_NOTICE_FAILED', { message: error.message }))
        return
      }
      Promise.resolve(this.agent.receiveOwner(data.text, this.store.referenceForQuote(data.quotedId), data.mediaType ? msg : null, { forwarded: data.forwarded || data.derivedText, requestKey: data.id }))
        .catch(error => log('OWNER_INTAKE_FAILED', { message: error.message }))
      return
    }
    if (self) return
    // Recovered pending work must also observe a recent manual reply sent while Clara was offline.
    if (old && ![address, ...aliases].some(alias => {
      const pending = this.store.getContact(alias)?.conversation?.pending
      return pending && timestamp >= pending.receivedAt - 1000
    })) return
    const contact = this.store.contact(address, aliases)
    if (!msg.key.fromMe && msg.pushName) {
      this.store.cacheNames([{ id: address, notify: msg.pushName }])
    }
    this.store.save()
    if (msg.key.fromMe) this.agent.ownerIntervened(contact, data.text)
    else {
      log('MESSAGE', { contact: contact.id, kind: data.mediaType || (data.unsupported ? 'unsupported' : 'text'),
        ...(this.config.logText ? { text: data.text } : {}) })
      this.agent.receiveExternal(contact, data)
    }
  }
  async send(address, text, reference, kind, image = null) {
    if (!this.ready || !this.socket) throw Object.assign(new Error('WhatsApp is disconnected'), { code: 'WA_NOT_CONNECTED' })
    if (!directJid(address)) throw new Error('Only personal WhatsApp chats are supported')
    const id = generateMessageIDV2(this.socket.user?.id)
    // Register BEFORE sendMessage; Baileys can emit the bot echo before its promise resolves.
    this.store.markOutbound(id, address, reference, kind)
    let timer
    try {
      const content = image ? { image: fs.readFileSync(image), caption: text } : { text }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WhatsApp send timed out; delivery is unknown. Check the chat before retrying.')), this.config.sendTimeoutMs || 30000)
        timer.unref?.()
      })
      const result = await Promise.race([this.socket.sendMessage(address, content, { messageId: id }), timeout])
      if (!result?.key?.id) throw new Error('WhatsApp returned no message ID; delivery status is unknown')
      if (result?.key?.id && result.key.id !== id) this.store.markOutbound(result.key.id, address, reference, kind)
      for (const key of new Set([id, result?.key?.id].filter(Boolean))) {
        this.store.data.outbound[key].status = 'accepted_by_transport'
      }
      this.store.save()
      return result
    } catch (error) {
      this.store.data.outbound[id].status = 'failed_or_unknown'
      this.store.save()
      throw error
    } finally { clearTimeout(timer) }
  }
  sendOwner(text, reference = null, kind = 'notification', image = null) {
    return this.send(this.ownerJid || this.config.ownerJid, text, reference, kind, image)
  }
  sendContact(contact, text, reference = null) { return this.send(contact.jid, text, reference, 'external_reply') }
  async processMedia(msg, { signal } = {}) {
    const content = normalizeMessageContent(msg?.message)
    const media = content && classify(content, msg.message)
    if (!media?.kind || media.rejected) throw mediaError(media?.rejected || 'Please resend that attachment; its file was not retained after restarting.')
    const limits = mediaLimits(this.config)
    if (Number(media.node.fileLength || 0) > limits[media.kind]) throw mediaError(`Please keep ${media.kind} attachments within ${Math.round(limits[media.kind] / 1024 / 1024)} MB.`)
    if (media.kind === 'audio' && Number(media.node.seconds || 0) > limits.seconds) throw mediaError(`Please keep voice/audio within ${limits.seconds} seconds.`)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-media-'))
    fs.chmodSync(directory, 0o700)
    const file = path.join(directory, 'input')
    let stream
    const cleanup = async () => fs.rmSync(directory, { recursive: true, force: true })
    let rejectDownload, cancelled = false
    const interrupted = new Promise((_, reject) => { rejectDownload = reject })
    const cancel = () => {
      cancelled = true; stream?.destroy()
      rejectDownload(mediaError('Media download cancelled or timed out. Please resend a smaller attachment.', signal?.aborted ? 'MEDIA_CANCELLED' : 'MEDIA_TIMEOUT'))
    }
    const deadline = setTimeout(cancel, 30000)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (signal?.aborted) throw mediaError('Media processing cancelled.', 'MEDIA_CANCELLED')
      const downloading = this.downloadMedia(msg, 'stream', {}, { logger: this.logger, reuploadRequest: this.socket.updateMediaMessage })
        .then(value => { if (cancelled) value.destroy(); return value })
      stream = await Promise.race([downloading, interrupted])
      const chunks = []
      const consume = async () => {
        let size = 0
        for await (const chunk of stream) {
          if (signal?.aborted) throw mediaError('Media processing cancelled.', 'MEDIA_CANCELLED')
          size += chunk.length
          if (size > limits[media.kind]) throw mediaError(`That attachment exceeds the ${Math.round(limits[media.kind] / 1024 / 1024)} MB limit.`)
          chunks.push(chunk)
        }
      }
      await Promise.race([consume(), interrupted])
      clearTimeout(deadline)
      fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 })
      const mime = String(media.node.mimetype || '').split(';')[0]
      const inferred = { 'application/pdf': 'document.pdf', 'text/plain': 'document.txt', 'text/csv': 'document.csv' }[mime]
      const result = await this.media.process(file, { kind: media.kind, name: path.basename(media.node.fileName || inferred || 'attachment') }, { signal })
      return { ...result, path: result.images?.[0] || null, cleanup }
    } catch (error) { await cleanup(); throw error }
    finally { clearTimeout(deadline); signal?.removeEventListener('abort', cancel); stream?.destroy() }
  }
  async downloadPhoto(msg) {
    const content = normalizeMessageContent(msg.message)
    if (!content?.imageMessage || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2) throw new Error('View-once photos are not processed')
    if (Number(content.imageMessage.fileLength || 0) > this.config.maxPhotoBytes) throw new Error('Photo exceeds size limit')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-photo-'))
    fs.chmodSync(directory, 0o700)
    const file = path.join(directory, 'photo.jpg')
    try {
      const stream = await downloadMediaMessage(msg, 'stream', {}, { logger: this.logger,
        reuploadRequest: this.socket.updateMediaMessage })
      let size = 0
      const chunks = []
      for await (const chunk of stream) {
        size += chunk.length
        if (size > this.config.maxPhotoBytes) { stream.destroy(); throw new Error('Photo exceeds size limit') }
        chunks.push(chunk)
      }
      fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 })
      return { path: file, cleanup: async () => fs.rmSync(directory, { recursive: true, force: true }) }
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }
  stop() {
    this.stopped = true; this.ready = false; this.generation++
    this.qrVersion++
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectionTimer); clearInterval(this.resumeTimer)
    this.disposeSocket()
    return this.authWrites || Promise.resolve()
  }
}
module.exports = { WhatsApp, payload }
