const { availability, modelId, log } = require('./config')
const { healthReferences, emergency, codingTask, limitReply } = require('./safety')
const { resolveOwner, matchingNames, sendIntent, draftIntent, availableDraft, meaningful, literalPayloads, inlinePayload, relationshipIntent, declaredRelationship, selectorText } = require('./owner-context')
const { OwnerPolicy, statusStatement, instructionIntent, urgentRequest } = require('./owner-policy')
const { Outbox, outreachTime } = require('./outbox')

const FOLLOWUP_MS = 650
const RECOVERY_MAX_AGE_MS = 5 * 60 * 1000

const HELP = `Clara self-chat commands:
/inbox | /contacts | /status
/approve C0001 mother all (or public)
/whitelist C0001 mother
/revoke C0001 | /block C0001
/reply R0001 Your exact message
/close R0001 | /thread C0001
/name C0001 Contact name (does not grant private access)
/remember A fact about me | /location My current place
/forget F0001 (or location)
/model sol | /model luna
/sleep [private] | /awake | /busy
/instructions | /uninstruct I0001
/outbox | /canceloutreach T00000000 | /sendpending C0001 | /cancelpending
/proactive on | /proactive off (automatic missing-detail follow-ups)
You can also give clear instructions naturally, referring to an ID or replying to a concern notification.`

class Agent {
  constructor({ config, profile, store, provider, transport, now = () => new Date() }) {
    Object.assign(this, { config, profile, store, provider, transport, now })
    this.chats = new Map()
    this.ownerVersion = 0
    this.ownerController = null
    this.ownerQueue = Promise.resolve()
    this.verifications = new Map()
    this.relays = new Map()
    this.activityTimers = new Map()
    this.activityWork = new Map()
    this.concernTimers = new Map()
    this.controls = new OwnerPolicy(store)
    this.digestWork = null
    this.digestRetryTimer = null
    this.stopping = false
    this.outbox = new Outbox({ store, ready: () => !this.stopping && this.transport.ready,
      send: (contact, text, task) => this.dispatchOutreach(contact, text, task),
      notify: task => this.notifyOutreach(task) })
  }
  state(id) {
    const contact = this.store.data.contacts[id]
    if (!contact.conversation) {
      const history = this.store.history(id)
      const lastAssistant = history.findLastIndex(entry => entry.role === 'assistant')
      const lastOwner = history.findLastIndex(entry => entry.role === 'owner')
      contact.conversation = { mode: lastAssistant > lastOwner ? 'clara' : 'waiting',
        pending: null, resumeAt: 0, lastOwnerAt: 0, updatedAt: Date.now() }
    }
    const old = this.chats.get(id)
    if (old && old.session !== contact.conversation) {
      clearTimeout(old.timer)
      old.controller?.abort()
      this.chats.delete(id)
    }
    if (!this.chats.has(id)) this.chats.set(id, { version: old ? old.version + 1 : 0, active: contact.conversation.mode === 'clara',
      session: contact.conversation, timer: null, controller: null, queue: Promise.resolve(),
      pendingPhoto: null, latest: contact.conversation.pending, lastErrorAt: 0 })
    return this.chats.get(id)
  }
  cancel(id, stopTakeover = false) {
    const state = this.state(id)
    state.version++
    clearTimeout(state.timer)
    state.timer = null
    state.controller?.abort()
    if (stopTakeover) state.active = false
    return state
  }
  schedule(contact, delay) {
    const state = this.state(contact.id)
    const version = state.version
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      if (this.stopping || !this.transport.ready || state.version !== version || contact.blocked ||
          this.store.data.contacts[contact.id] !== contact) return
      state.active = true
      state.session.mode = 'clara'
      state.session.updatedAt = Date.now()
      this.store.save()
      // Owner silence grants readiness, not permission to send an unsolicited message.
      if (!state.session.pending) return
      state.queue = this.respond(contact, version).catch(error => {
        log('CHAT_WORK_ERROR', { contact: contact.id, message: error.message })
      })
    }, Math.max(0, delay))
  }
  complete(contact, version) {
    const state = this.state(contact.id)
    if (state.version !== version) return
    state.session.pending = null
    state.session.resumeAt = 0
    state.session.updatedAt = Date.now()
    state.latest = null
    state.pendingPhoto = null
    this.store.save()
  }
  ownerIntervened(contact, text) {
    const state = this.cancel(contact.id, true)
    Object.assign(state.session, { mode: 'owner', lastOwnerAt: Date.now(),
      resumeAt: Date.now() + this.config.takeoverMs, updatedAt: Date.now() })
    this.store.append(contact.id, 'owner', text || '[Owner sent media]', { visibility: 'shared' })
    this.store.shareFacts(contact, text || '')
    this.schedule(contact, this.config.takeoverMs)
    log('OWNER_TOOK_OVER', { contact: contact.id })
  }
  receiveExternal(contact, message) {
    if (this.stopping || contact.blocked) return
    const state = this.cancel(contact.id)
    state.latest = message
    if (message.photo || message.mediaType) state.pendingPhoto = message
    const urgent = emergency(message.text)
    const delay = urgent ? 0 : state.active ? FOLLOWUP_MS : this.config.takeoverMs
    Object.assign(state.session, { pending: { id: message.id, text: String(message.text || '').slice(0, 8000),
      photo: !!message.photo, mediaType: message.mediaType || null, rejected: message.rejected || null,
      unsupported: !!message.unsupported, receivedAt: Date.now() },
    resumeAt: Date.now() + delay, updatedAt: Date.now() })
    this.store.append(contact.id, 'user', message.text || (message.mediaType ? `[Attachment: ${message.mediaType}]` : message.photo ? '[Photo]' : '[Unsupported media]'), { messageId: message.id })
    this.schedule(contact, delay)
    log('WAITING', { contact: contact.id, seconds: delay / 1000, active: state.active })
  }
  valid(contact, version, policyVersion) {
    return !this.stopping && this.transport.ready && this.store.data.contacts[contact.id] === contact && !contact.blocked &&
      this.state(contact.id).version === version && contact.policyVersion === policyVersion
  }
  routineHeld() { return this.controls.quiet || !!this.digestWork }
  refreshOwnerPolicy() {
    if (this.controls.quiet) {
      for (const timer of this.activityTimers.values()) clearTimeout(timer)
      this.activityTimers.clear()
      for (const timer of this.concernTimers.values()) clearTimeout(timer)
      this.concernTimers.clear()
    }
    for (const id of this.chats.keys()) {
      const contact = this.store.data.contacts[id]
      if (!contact) continue
      const state = this.cancel(id)
      if (contact.blocked) continue
      if (state.session.pending) this.schedule(contact, state.active ? FOLLOWUP_MS : this.config.takeoverMs)
      else if (state.session.mode === 'owner') this.schedule(contact, state.session.resumeAt - Date.now())
    }
  }
  setOwnerStatus(update) {
    const wasQuiet = this.controls.quiet
    const receipt = this.controls.setPresence(update)
    if (wasQuiet && !this.controls.quiet) this.store.data.settings.wakeDigestPending = true
    this.store.save()
    this.refreshOwnerPolicy()
    return receipt
  }
  context(contact) {
    const status = availability(this.profile, this.now())
    const personal = contact.confirmed && contact.permission === 'all_personal'
    const open = Object.values(this.store.data.concerns).find(c => c.contactId === contact.id && c.status === 'open')
    const state = this.state(contact.id)
    const control = this.controls.forContact(contact)
    const explicit = this.controls.data.presence
    return { mode: 'EXTERNAL', owner: this.profile.owner, public: this.profile.public,
      contact: { id: contact.id, introduced: contact.introduced, name: contact.name,
        nameSource: contact.nameSource || null, identityAsked: !!contact.identityAsked,
        confirmed: contact.confirmed, relationship: contact.confirmed ? contact.relationship : null,
        claimed_relationship_unverified: contact.claimedRelationship, permission: personal ? 'all_personal' : 'public' },
      availability: { status: explicit ? explicit.state === 'available' ? 'generally_available' : 'unavailable' : status.status,
        timezone: status.timezone, basis: explicit ? 'latest explicit owner update; overrides the usual schedule' : status.basis },
      ownerControl: control,
      personal: personal ? { usualSchedule: this.profile.schedule, currentSchedule: status,
        ownerSuppliedFacts: this.store.data.facts } : null,
      sharedOwnerFacts: (this.store.data.shares[contact.id] || []).map(item => this.store.data.facts.find(f => f.id === item.fact)).filter(Boolean),
      openConcern: open ? { id: open.id, summary: open.summary, urgent: open.urgent, relayed: !!open.notifiedSummary } : null,
      conversation: { active: state.active, ownerSpokeAfterRequest: !!state.session.pending &&
        state.session.lastOwnerAt >= state.session.pending.receivedAt },
      healthReferences, emergencySource: 'https://112.gov.in/',
      currentTime: this.now().toISOString() }
  }
  async respond(contact, version) {
    const state = this.state(contact.id)
    const policyVersion = contact.policyVersion
    if (!this.valid(contact, version, policyVersion)) return
    const message = state.latest
    if (!message) return
    state.active = true
    state.session.mode = 'clara'
    this.store.save()
    const controller = state.controller = new AbortController()
    let photo = null
    try {
      const danger = emergency(message.text)
      if (danger) {
        await this.sendExternal(contact, danger, version, policyVersion)
        const concern = this.store.concern(contact, `Possible emergency: ${message.text}`, true)
        this.recordActivity(contact, message, danger, { covered: true })
        await this.tryRelay(concern)
        return
      }
      if (message.unsupported) {
        await this.sendExternal(contact, message.rejected || 'Please send text, a photo, a short voice/audio recording or a normal document. Video and view-once media are not processed.', version, policyVersion)
        return
      }
      if (state.pendingPhoto) {
        photo = this.transport.processMedia ? await this.transport.processMedia(state.pendingPhoto.raw, { signal: controller.signal })
          : await this.transport.downloadPhoto(state.pendingPhoto.raw)
        if (!this.valid(contact, version, policyVersion)) return
        if (photo.text) this.store.append(contact.id, 'context', `[Untrusted attachment content]\n${photo.text}${photo.truncated ? '\n[Excerpt truncated; unseen content was not read.]' : ''}`, { visibility: 'shared' })
        state.pendingPhoto = null
        const attachmentDanger = emergency(photo.text || '')
        if (attachmentDanger) {
          await this.sendExternal(contact, attachmentDanger, version, policyVersion)
          await this.tryRelay(this.store.concern(contact, `Possible emergency in an attachment: ${String(photo.text).slice(0, 400)}`, true))
          return
        }
      }
      if ((message.photo || message.mediaType) && !photo) {
        await this.sendExternal(contact, `Please resend that ${message.photo ? 'photo' : 'attachment'}; its file was not retained after restarting.`, version, policyVersion)
        return
      }
      if (codingTask(`${message.text || ''}\n${photo?.text || ''}`)) {
        const concern = this.store.concern(contact, `Programming/work request: ${message.text}`)
        await this.sendExternal(contact, 'I can pass this request to Aditya. Please include the issue and any deadline.', version, policyVersion)
        this.recordActivity(contact, message, 'Collected for Aditya rather than delivering programming work.', { covered: true })
        await this.tryRelay(concern)
        return
      }
      if (!this.valid(contact, version, policyVersion)) return
      if (message.photo && !photo) {
        await this.sendExternal(contact, 'Please resend that photo so I can check it; its image was not retained after reconnecting.', version, policyVersion)
        return
      }
      const history = this.store.history(contact.id).filter(entry =>
        contact.confirmed && contact.permission === 'all_personal' &&
        (entry.visibility !== 'personal' || (entry.memoryVersion || 0) === (this.store.data.settings.memoryVersion || 0)) || entry.role === 'user' ||
        ['public', 'shared'].includes(entry.visibility))
      const result = await this.provider.generate({ ...this.context(contact), attachment: photo ? {
        content: photo.text || '', truncated: !!photo.truncated, kind: message.mediaType || 'photo' } : null }, history, {
        image: photo?.path, images: photo?.images, signal: controller.signal, model: this.store.data.settings.model || this.config.model
      })
      if (!this.valid(contact, version, policyVersion)) return
      this.store.claim(contact, result.claim?.name, result.claim?.relationship)
      if (photo && result.photo_summary) {
        this.store.append(contact.id, 'context', `[Photo description] ${result.photo_summary.slice(0, 1000)}`, {
          visibility: contact.confirmed && contact.permission === 'all_personal' ? 'personal' : 'public',
          memoryVersion: this.store.data.settings.memoryVersion || 0
        })
        state.pendingPhoto = null
      }
      const urgent = urgentRequest(message.text)
      const concern = result.concern?.summary.trim()
        ? this.store.concern(contact, result.concern.summary, result.concern.urgent || urgent)
        : urgent ? this.store.concern(contact, `Sender says this is urgent: ${message.text}`, true) : null
      if (concern) for (const plan of result.outreach || []) {
        try { this.planFollowup(plan, contact, concern) }
        catch (error) { log('FOLLOWUP_REJECTED', { contact: contact.id, message: error.message }) }
      }
      let reply = limitReply(result.reply)
      if (reply && /```|\bfunction\s+\w+\s*\(|\bimport\s+\w+\s+from\b/.test(reply)) {
        reply = 'I can collect the details of this work request for Aditya. What does he need to know?'
      }
      if (reply) {
        const sent = await this.sendExternal(contact, reply, version, policyVersion)
        if (sent) {
          contact.introduced = true
          if (/your name|how (?:do you|you) know|aapka naam|tumhara naam/i.test(reply)) contact.identityAsked = true
          this.store.save()
        }
      } else this.complete(contact, version)
      if (this.valid(contact, version, policyVersion)) {
        this.recordActivity(contact, message, reply, { summary: result.activity_summary, covered: !!concern })
      }
      // Self-chat delivery failures must not prevent the external answer or end takeover.
      if (this.valid(contact, version, policyVersion)) await this.notifyVerification(contact)
      if (concern && this.valid(contact, version, policyVersion)) await this.tryRelay(concern, photo?.path)
    } catch (error) {
      if (controller.signal.aborted || !this.valid(contact, version, policyVersion)) return
      log('REPLY_FAILED', { contact: contact.id, message: error.message.slice(0, 500) })
      if (/^MEDIA_/.test(error.code || '')) {
        await this.sendExternal(contact, error.message, version, policyVersion)
        return
      }
      if (Date.now() - state.lastErrorAt > 300000) {
        state.lastErrorAt = Date.now()
        await this.sendExternal(contact, 'I am having trouble replying right now. Your message is here for Aditya.', version, policyVersion)
      }
    } finally {
      if (state.controller === controller) state.controller = null
      await photo?.cleanup()
    }
  }
  async sendExternal(contact, text, version, policyVersion) {
    if (!this.valid(contact, version, policyVersion)) return false
    await this.transport.sendContact(contact, text)
    if (this.valid(contact, version, policyVersion)) this.state(contact.id).active = true
    this.store.append(contact.id, 'assistant', text, {
      visibility: contact.confirmed && contact.permission === 'all_personal' ? 'personal' : 'public',
      memoryVersion: this.store.data.settings.memoryVersion || 0
    })
    this.complete(contact, version)
    log('REPLY_SENT', { contact: contact.id, active: this.state(contact.id).active })
    return true
  }
  async notifyVerification(contact) {
    if (this.routineHeld()) return
    if (this.verifications.has(contact.id)) return this.verifications.get(contact.id)
    if (contact.confirmed || !contact.claimedRelationship || contact.verificationNotified) return
    const activity = this.store.data.activities[contact.id]
    const revision = activity?.revision
    const note = `New contact ${contact.id}\nName: ${contact.name || 'not provided'} (${contact.nameSource || 'unknown source'})\nClaims: ${contact.claimedRelationship}\nContact: ${contact.aliases.join(', ')}${activity ? `\n${activity.summary}` : ''}\nReply /approve ${contact.id} <relationship> all (or public), or /revoke ${contact.id}.`
    const work = (async () => {
      try {
        await this.transport.sendOwner(note, contact.id)
        this.store.noteNotification(contact.id, contact.id)
        contact.verificationNotified = true
        if (activity) activity.reportedRevision = Math.max(activity.reportedRevision, revision)
        this.store.save()
      } catch (error) { log('VERIFICATION_RETRY_PENDING', { contact: contact.id, message: error.message }) }
    })()
    this.verifications.set(contact.id, work)
    try { await work } finally { this.verifications.delete(contact.id) }
  }
  async tryRelay(concern, image = null) {
    try { await this.relayConcern(concern, image) }
    catch (error) {
      log('RELAY_RETRY_PENDING', { concern: concern.id, message: error.message })
      clearTimeout(this.concernTimers.get(concern.id))
      if (!this.stopping && (!this.routineHeld() || concern.urgent)) {
        const timer = setTimeout(() => {
          this.concernTimers.delete(concern.id)
          if (concern.status === 'open') this.tryRelay(concern)
        }, 30000)
        timer.unref?.()
        this.concernTimers.set(concern.id, timer)
      }
    }
  }
  recordActivity(contact, message, reply, options = {}) {
    if (!meaningful(message.text) && !message.photo && !message.mediaType) return
    const activity = this.store.activity(contact, message, reply, options)
    this.scheduleActivity(activity)
  }
  scheduleActivity(activity) {
    clearTimeout(this.activityTimers.get(activity.contactId))
    this.activityTimers.delete(activity.contactId)
    if (this.stopping || this.routineHeld() || activity.revision <= activity.reportedRevision) return
    const timer = setTimeout(() => {
      this.activityTimers.delete(activity.contactId)
      this.flushActivity(activity.contactId).catch(error => log('ACTIVITY_FAILED', { contact: activity.contactId, message: error.message }))
    }, Math.max(0, activity.nextAttemptAt - Date.now()))
    timer.unref?.()
    this.activityTimers.set(activity.contactId, timer)
  }
  async flushActivity(id) {
    if (this.activityWork.has(id)) return this.activityWork.get(id)
    const contact = this.store.data.contacts[id]
    const activity = this.store.data.activities[id]
    if (!contact || !activity || activity.revision <= activity.reportedRevision || this.stopping || this.routineHeld()) return
    const work = (async () => {
      const revision = activity.revision
      try {
        if (!this.transport.ready) throw new Error('WhatsApp is disconnected')
        const verification = !contact.confirmed && contact.claimedRelationship && !contact.verificationNotified
        const text = `${contact.name || 'Unnamed contact'} | ${id}${contact.confirmed ? '' : ' | unverified'}\n${activity.summary}${verification ? `\nClaims: ${contact.claimedRelationship}. Confirm this exact contact before private access.` : ''}`
        await this.transport.sendOwner(text, id, 'activity')
        this.store.noteNotification(id, id)
        if (verification) contact.verificationNotified = true
        activity.reportedRevision = Math.max(activity.reportedRevision, revision)
        activity.attempts = 0
        this.store.append('owner', 'context', `[Activity report sent to your self-chat]\n${text}`, { contactId: id })
        log('ACTIVITY_REPORTED', { contact: id, revision })
      } catch (error) {
        activity.attempts++
        activity.nextAttemptAt = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(activity.attempts, 4))
        log('ACTIVITY_RETRY_PENDING', { contact: id, message: error.message })
      } finally {
        this.store.save()
        this.scheduleActivity(this.store.data.activities[id])
      }
    })()
    this.activityWork.set(id, work)
    try { await work } finally { this.activityWork.delete(id) }
  }
  async relayConcern(concern, image = null) {
    while (this.relays.has(concern.id)) await this.relays.get(concern.id).catch(() => {})
    if (!this.transport.ready) return
    if (this.routineHeld() && !concern.urgent) return
    if (concern.notifiedSummary === concern.summary) return
    const contact = this.store.data.contacts[concern.contactId]
    const label = contact.confirmed ? contact.name || contact.relationship : contact.name || 'Unconfirmed contact'
    const summary = concern.summary
    const text = `${concern.urgent ? 'URGENT ' : ''}${label} | ${contact.id} | ${concern.id}\n${summary}\nReply to this note to discuss it privately. Use /reply ${concern.id} <message> to send a response.`
    const work = (async () => {
      const sent = await this.transport.sendOwner(text, concern.id, 'notification', image)
      this.store.noteNotification(contact.id, concern.id)
      this.store.append('owner', 'context', `[Concern notification sent to your self-chat]\n${text}`, { contactId: contact.id })
      if (sent?.key?.id) concern.ownerMessageIds.push(sent.key.id)
      concern.notifiedSummary = summary
      concern.notifiedAt = new Date().toISOString()
      clearTimeout(this.concernTimers.get(concern.id))
      this.concernTimers.delete(concern.id)
      this.store.save()
    })()
    this.relays.set(concern.id, work)
    try { await work } finally { this.relays.delete(concern.id) }
  }
  async flushPending() {
    await this.outbox.drain()
    if (this.store.data.settings.wakeDigestPending && !this.controls.quiet) {
      await this.flushHeldDigest()
      if (this.store.data.settings.wakeDigestPending) return
    }
    for (const contact of Object.values(this.store.data.contacts)) {
      if (!contact.blocked) await this.notifyVerification(contact)
    }
    for (const concern of Object.values(this.store.data.concerns)) {
      if (concern.status === 'open' && concern.summary !== concern.notifiedSummary) {
        await this.tryRelay(concern)
      }
    }
    for (const activity of Object.values(this.store.data.activities)) this.scheduleActivity(activity)
  }
  async flushHeldDigest() {
    if (this.digestWork) return this.digestWork
    if (this.controls.quiet || this.stopping || !this.store.data.settings.wakeDigestPending) return
    clearTimeout(this.digestRetryTimer)
    this.digestRetryTimer = null
    const work = (async () => {
      try {
        if (!this.transport.ready) throw new Error('WhatsApp is disconnected')
        const pending = []
        for (const contact of Object.values(this.store.data.contacts)) {
          const activity = this.store.data.activities[contact.id]
          const activityRevision = activity && activity.revision > activity.reportedRevision ? activity.revision : null
          const concern = Object.values(this.store.data.concerns).find(item => item.contactId === contact.id && item.status === 'open' && item.summary !== item.notifiedSummary)
          const verification = !contact.confirmed && contact.claimedRelationship && !contact.verificationNotified ? contact.claimedRelationship : null
          if (!activityRevision && !concern && !verification) continue
          pending.push({ id: contact.id, activityRevision, concernId: concern?.id, concernSummary: concern?.summary,
            verification, text: `${contact.name || 'Unnamed contact'} | ${contact.id}${concern ? ` | ${concern.id}${concern.urgent ? ' URGENT' : ''}` : ''}\n${(concern?.summary || activity?.summary || 'Introduced themselves.').slice(0, 260)}${verification ? `\nClaims: ${verification} (unverified).` : ''}` })
        }
        for (let index = 0; index < pending.length; index += 4) {
          if (this.controls.quiet || this.stopping) return
          const batch = pending.slice(index, index + 4)
          const sent = await this.transport.sendOwner(`While you were away:\n\n${batch.map(item => item.text).join('\n\n')}`, batch.length === 1 ? batch[0].id : null, 'digest')
          this.store.noteNotification(batch.map(item => item.id))
          for (const item of batch) {
            const activity = this.store.data.activities[item.id]
            if (activity && item.activityRevision) activity.reportedRevision = Math.max(activity.reportedRevision, item.activityRevision)
            const concern = this.store.data.concerns[item.concernId]
            if (concern) {
              concern.notifiedSummary = item.concernSummary
              concern.notifiedAt = new Date().toISOString()
              if (sent?.key?.id) concern.ownerMessageIds.push(sent.key.id)
            }
            const contact = this.store.data.contacts[item.id]
            if (contact && contact.claimedRelationship === item.verification) contact.verificationNotified = true
          }
          this.store.append('owner', 'context', `[Wake-up summary sent]\n${batch.map(item => item.text).join('\n\n')}`)
          log('WAKE_DIGEST_SENT', { contacts: batch.length })
        }
        this.store.data.settings.wakeDigestPending = false
        this.store.save()
      } catch (error) {
        this.store.data.settings.wakeDigestPending = true
        this.store.save()
        log('WAKE_DIGEST_PENDING', { message: error.message })
        clearTimeout(this.digestRetryTimer)
        if (!this.stopping) {
          this.digestRetryTimer = setTimeout(() => this.flushHeldDigest(), 30000)
          this.digestRetryTimer.unref?.()
        }
      }
    })()
    this.digestWork = work
    try { await work } finally { this.digestWork = null }
  }
  resume() {
    this.outbox.arm()
    this.outbox.drain().catch(error => log('OUTREACH_FAILED', { message: error.message }))
    for (const contact of Object.values(this.store.data.contacts)) {
      if (contact.blocked) continue
      const state = this.cancel(contact.id)
      const pending = state.session.pending
      if (pending && Date.now() - pending.receivedAt > RECOVERY_MAX_AGE_MS) {
        this.complete(contact, state.version)
        log('STALE_REPLY_SKIPPED', { contact: contact.id })
      }
      if (state.session.pending) {
        state.latest ||= state.session.pending
        // Give linked-device message sync time to reveal an owner's intervening reply.
        this.schedule(contact, Math.max(this.config.takeoverMs, state.session.resumeAt - Date.now()))
      } else if (state.session.mode === 'owner') {
        this.schedule(contact, state.session.resumeAt - Date.now())
      }
      if (!state.session.pending && !this.store.data.activities[contact.id]) {
        const history = this.store.history(contact.id)
        const lastReply = history.findLastIndex(entry => entry.role === 'assistant')
        const index = history.slice(0, Math.max(0, lastReply)).findLastIndex(entry => entry.role === 'user' && entry.at && meaningful(entry.text))
        const entry = history[index]
        if (entry && Date.now() - Date.parse(entry.at) < 86400000) {
          const reply = history.slice(index + 1).findLast(item => item.role === 'assistant')
          if (reply) this.recordActivity(contact, { ...entry, id: entry.messageId || entry.at }, reply.text)
        }
      }
    }
    this.store.save()
  }
  receiveOwner(text, quoteReference = null, imageMessage = null, { forwarded = false, requestKey = null } = {}) {
    this.ownerVersion++
    const version = this.ownerVersion
    this.ownerController?.abort()
    this.store.append('owner', 'owner', text || '[Photo]')
    const danger = emergency(text)
    if (danger) {
      return this.transport.sendOwner(danger, null, 'reply')
        .then(() => this.store.append('owner', 'assistant', danger))
        .catch(error => log('OWNER_EMERGENCY_REPLY_FAILED', { message: error.message }))
    }
    const update = forwarded ? null : statusStatement(text)
    const statusReceipt = update ? this.setOwnerStatus(update) : null
    if (statusReceipt && !instructionIntent(text)) {
      this.ownerQueue = this.ownerQueue.catch(() => {}).then(async () => {
        if (version !== this.ownerVersion || this.stopping) return
        try { await this.replyOwner(statusReceipt) }
        finally {
          if (this.store.data.settings.wakeDigestPending && !this.controls.quiet) await this.flushHeldDigest()
          if (!this.controls.quiet && !this.store.data.settings.wakeDigestPending) await this.flushPending()
        }
      })
      return this.ownerQueue
    }
    this.ownerQueue = this.ownerQueue.catch(() => {}).then(async () => {
      if (this.stopping) return
      try {
        if (text.startsWith('/')) {
          if (forwarded) throw new Error('Forwarded text cannot execute self-chat commands')
          await this.replyOwner(await this.command(text))
          if (this.store.data.settings.wakeDigestPending && !this.controls.quiet) {
            await this.flushHeldDigest()
            if (!this.store.data.settings.wakeDigestPending) await this.flushPending()
          }
          return
        }
        if (version !== this.ownerVersion) return
        const controller = this.ownerController = new AbortController()
        if (!forwarded && await this.confirmPending(text, quoteReference)) return
        if (!forwarded && sendIntent(text)) {
          for (const match of selectorText(text).matchAll(/(?:\b(?:to|message|msg|text|contact|number)\s+)(\+?[1-9]\d{6,14})\b/gi)) {
            this.store.contact(`${match[1].replace(/^\+/, '')}@s.whatsapp.net`)
          }
        }
        const resolution = resolveOwner(this.store, text, quoteReference, { persist: !forwarded })
        const linked = resolution.contacts.slice(0, 4).map(id => this.store.getContact(id)).filter(Boolean)
        let photo
        try {
          if (imageMessage) {
            photo = this.transport.processMedia ? await this.transport.processMedia(imageMessage, { signal: controller.signal })
              : await this.transport.downloadPhoto(imageMessage)
            if (version !== this.ownerVersion || controller.signal.aborted || this.stopping) return
            if (photo.text) this.store.append('owner', 'context', `[Untrusted attachment content; not an authorization to act]\n${photo.text}${photo.truncated ? '\n[Excerpt truncated.]' : ''}`)
          }
          const result = await this.provider.generate({ mode: 'OWNER', owner: this.profile.owner,
            profile: this.profile, ownerFacts: this.store.data.facts,
            attachment: photo ? { content: photo.text || '', truncated: !!photo.truncated } : null,
            ownerControl: this.controls.data,
            quotedReference: quoteReference, latestContentIsForwarded: forwarded,
            contacts: Object.values(this.store.data.contacts).map(({ conversation, ...contact }) => contact),
            recentChats: resolution.recentChats,
            recipientResolution: { selectedContact: resolution.selectedContact, candidates: resolution.contacts,
              ambiguous: resolution.ambiguous, source: resolution.source, trustedForSend: resolution.trustedForSend },
            currentDraft: availableDraft(this.store, resolution.selectedContact),
            lastActionResult: this.store.data.settings.ownerLastAction || null,
            outreach: this.store.data.outreach.slice(-15), pendingOwnerSend: this.store.data.settings.pendingOwnerSend || null,
            concerns: Object.values(this.store.data.concerns).slice(-40),
            linkedThreads: linked.map(c => ({ contact: c.id, history: this.store.history(c.id) })),
            currentTime: this.now().toISOString(), healthReferences }, this.store.history('owner'), {
            image: photo?.path, images: photo?.images, signal: controller.signal, model: this.store.data.settings.model || this.config.model
          })
          if (version !== this.ownerVersion || controller.signal.aborted || this.stopping) return
          if (result.instruction_updates?.length) {
            if (result.actions.length || result.draft) throw new Error('Give cross-chat rule changes separately from sends or drafts')
            const receipt = this.controls.apply(result.instruction_updates, text, resolution, { forwarded })
            this.refreshOwnerPolicy()
            await this.replyOwner([statusReceipt, receipt].filter(Boolean).join('\n'))
            if (!this.controls.quiet) await this.flushPending()
            return
          }
          if (statusReceipt) {
            await this.replyOwner(statusReceipt)
            if (!this.controls.quiet) await this.flushPending()
            return
          }
          const receipts = []
          if (!forwarded && /\b(i am|i'm|i have|i live|i work|i study|i prefer|i like|my |remember|save|note)\b/i.test(text)) {
            for (const fact of result.facts) {
              const saved = this.store.remember(fact.text, fact.kind)
              receipts.push(`Saved ${saved.id}.`)
            }
          }
          const relationship = !forwarded && declaredRelationship(text)
          const knownPerson = relationship && resolution.trustedForSend && this.store.getContact(resolution.selectedContact)
          if (knownPerson && (!knownPerson.confirmed || knownPerson.relationship !== relationship)) {
            this.cancel(knownPerson.id)
            this.store.approve(knownPerson, relationship, knownPerson.permission || 'public')
            receipts.push(`Saved ${knownPerson.id} as your ${relationship}; private access is unchanged.`)
          }
          const supplied = literalPayloads(text)
          if (!forwarded && sendIntent(text) && !resolution.selectedContact && supplied.length === 1 &&
              !result.draft && !result.actions.some(action => action.type === 'send')) {
            this.store.data.settings.pendingOwnerSend = { text: supplied[0], ownerText: text,
              candidates: resolution.contacts, at: Date.now(), requestKey,
              ownerEntryAt: this.store.history('owner').findLast(entry => entry.role === 'owner')?.at }
            this.store.save()
          }
          if (result.draft) {
            if (forwarded || !draftIntent(text) || result.actions.length || !resolution.selectedContact ||
                this.store.getContact(result.draft.target)?.id !== resolution.selectedContact || !result.draft.text?.trim()) {
              throw new Error('Specify one person and ask for a draft explicitly; no message was sent')
            }
            this.store.data.settings.ownerDraft = { contact: resolution.selectedContact,
              text: limitReply(result.draft.text, true), at: Date.now(), used: false }
            this.store.save()
            await this.replyOwner(`Draft for ${this.store.getContact(resolution.selectedContact).name || resolution.selectedContact}:\n${this.store.data.settings.ownerDraft.text}`, resolution.selectedContact)
            return
          }
          if (result.actions.length || result.outreach?.length) {
            if (forwarded) throw new Error('Give a direct instruction rather than forwarding an approval')
            if (result.actions.filter(action => action.type === 'send').length > 1) throw new Error('Specify one outgoing message at a time')
            // Approval is proposed by the model, but only an explicit owner intent can execute it.
            const rank = type => ['remember', 'location'].includes(type) ? 0 : type === 'send' ? 2 : 1
            const ordered = [...result.actions].sort((a, b) => rank(a.type) - rank(b.type))
            for (const [index, action] of ordered.entries()) {
              if (version !== this.ownerVersion || controller.signal.aborted || this.stopping) return
              try {
                this.authorizeAction(action, text, quoteReference, resolution)
                const target = this.store.getContact(action.target)
                if (action.type === 'approve' && target?.confirmed && target.relationship === action.relationship &&
                    target.permission === (action.permission || 'public')) continue
                action.requestKey = requestKey ? `${requestKey}:${index}` : null
                const acknowledgement = await this.execute(action)
                this.store.append('owner', 'context', `[Executed action: ${action.type}] ${acknowledgement}`, { contactId: this.store.getContact(action.target)?.id })
                receipts.push(acknowledgement)
              } catch (error) {
                if (action.type === 'send' && sendIntent(text) && action.text &&
                    /exact contact|Which person|Unknown contact/.test(error.message) &&
                    (inlinePayload(text, action.text) || text.toLowerCase().includes(action.text.trim().toLowerCase()))) {
                  this.store.data.settings.pendingOwnerSend = { text: action.text, ownerText: text,
                    candidates: resolution.contacts, at: Date.now(), requestKey,
                    ownerEntryAt: this.store.history('owner').findLast(entry => entry.role === 'owner')?.at }
                  this.store.save()
                }
                receipts.push(`Not ${action.type === 'send' ? 'sent' : 'changed'}: ${error.message}.`)
              }
            }
            for (const plan of result.outreach || []) {
              try { receipts.push(this.planOutreach(plan, text, resolution)) }
              catch (error) { receipts.push(`Outreach not queued: ${error.message}.`) }
            }
            const success = receipts.some(item => /^(Saved|Sent|Queued|Cancelled|Using|Closed|Revoked)/.test(item))
            const reply = `${success ? '' : 'Could not complete that: '}${receipts.join('\n')}`
            await this.replyOwner(reply, resolution.selectedContact)
            if (!success) this.store.append('owner', 'context', `[Owner request failed or could not be confirmed] ${reply.slice(0, 500)}`)
          } else if (result.reply || receipts.length) {
            let reply = limitReply(result.reply, true)
            if (sendIntent(text)) {
              if (/^(?:i(?:'ve| have)?\s+)?(?:sent|forwarded|messaged|shared)\b/i.test(reply || '')) reply = ''
              reply = `No message was sent.${reply ? ` ${reply}` : ' Please identify the exact recipient and intended message.'}`
            }
            await this.replyOwner([...receipts, reply].filter(Boolean).join('\n'), resolution.selectedContact)
          }
        } finally { await photo?.cleanup() }
      } catch (error) {
        if (version !== this.ownerVersion || /cancelled/i.test(error.message)) return
        log('OWNER_WORK_FAILED', { message: error.message.slice(0, 500) })
        this.store.append('owner', 'context', `[Owner request failed or could not be confirmed] ${error.message.slice(0, 220)}`)
        if (this.transport.ready) await this.transport.sendOwner(`${statusReceipt ? `${statusReceipt}\nAdditional request not saved: ` : 'Could not complete that: '}${error.message.slice(0, 220)}. Use /help for exact commands.`, null, 'reply')
      }
    })
    return this.ownerQueue
  }
  async replyOwner(text, reference = null) {
    await this.transport.sendOwner(text, reference, 'reply')
    this.store.append('owner', 'assistant', text, { contactId: this.store.getContact(reference)?.id })
  }
  authorizeAction(action, text, quoteReference, resolution = resolveOwner(this.store, text, quoteReference, { persist: false })) {
    const intent = {
      send: { test: sendIntent },
      approve: { test: value => /\b(approve|whitelist|allow|access|confirm)\b|\b(?:can\s+)?share\s+(?:my\s+)?(?:personal|private)\b/i.test(value) || relationshipIntent(value) },
      revoke: /\b(revoke|remove|unwhitelist|stop sharing)\b/i,
      remember: /\b(remember|save|note)\b/i, location: /\b(location|i am at|i'm at|currently at)\b/i,
      set_model: /\b(model|switch|use luna|use sol)\b/i, close: /\b(close|resolve|done)\b/i
    }
    if (!intent[action.type]?.test(text)) throw new Error('Please give an explicit action instruction')
    if (['send', 'approve', 'revoke', 'close'].includes(action.type)) {
      const phone = String(action.target || '').replace(/^\+/, '')
      let phoneProvided = false
      if (['approve', 'send'].includes(action.type) && /^[1-9]\d{6,14}$/.test(phone) && selectorText(text).includes(phone)) {
        action.target = this.store.contact(`${phone}@s.whatsapp.net`).id
        phoneProvided = true
      }
      const contact = this.store.getContact(action.target)
      if (!contact) throw new Error('Unknown contact/concern; use its C0001 or R0001 reference')
      const names = matchingNames(this.store, text, true)
      const refMatches = quoteReference && this.store.getContact(quoteReference)?.id === contact.id
      const focusedSend = ['send', 'approve'].includes(action.type) && resolution.selectedContact === contact.id && resolution.trustedForSend
      if (action.type === 'send' && resolution.ambiguous) throw new Error('Which person should receive this? No message was sent')
      if (!phoneProvided && !refMatches && !selectorText(text).toUpperCase().includes(action.target.toUpperCase()) &&
          !(names.length === 1 && names[0].id === contact.id) && !focusedSend) {
        throw new Error('Specify one exact contact or reply to its notification')
      }
      if (action.type === 'send' && /\b(send|msg|message|forward)\s+(it|this|that)\b(?!\s+(guy|person|contact)\b)|\breply\s+(with\s+)?it\b/i.test(text) && !inlinePayload(text, action.text)) {
        const draft = availableDraft(this.store, contact.id)
        if (!draft) throw new Error('What exact message should I send? There is no current draft for this person')
        action.text = draft.text
        action.usesDraft = true
      }
      if (action.type === 'send' && /\b(send|msg|message|tell|reply)(?:\s+to)?\s+(him|her|them|this guy|that guy|[CR]\d{4})\s*[.!?]*$/i.test(text)) {
        throw new Error('What exact message should I send?')
      }
      if (action.type === 'approve' && action.permission === 'all_personal' && !/\b(whitelist|all|full|personal)\b/i.test(text)) {
        throw new Error('Specify public or all personal access explicitly')
      }
    }
  }
  async confirmPending(text, quoteReference) {
    const pending = this.store.data.settings.pendingOwnerSend
    if (!pending || Date.now() - pending.at > 15 * 60000) return false
    if (/^(cancel|forget|stop|don't send|do not send)\b/i.test(text.trim())) {
      delete this.store.data.settings.pendingOwnerSend; this.store.save()
      await this.replyOwner('Pending send cancelled.'); return true
    }
    if (!/^(yes|yeah|correct|send|msg|message|[CR]\d{4})\b/i.test(text.trim())) return false
    const resolution = resolveOwner(this.store, text, quoteReference, { persist: false })
    const previousOwner = this.store.history('owner').filter(entry => entry.role === 'owner').at(-2)
    const cleanConfirmation = previousOwner?.at === pending.ownerEntryAt &&
      (this.store.data.settings.ownerLastNotification?.at || 0) <= pending.at
    const target = resolution.selectedContact || (cleanConfirmation && pending.candidates?.length === 1 && /^(yes|yeah|correct)[.! ]*$/i.test(text) ? pending.candidates[0] : null)
    if (!target || pending.candidates?.length && !pending.candidates.includes(target)) return false
    await this.replyOwner(await this.finishPending(target), target)
    return true
  }
  async finishPending(target) {
    const pending = this.store.data.settings.pendingOwnerSend
    const contact = this.store.getContact(target)
    if (!pending || Date.now() - pending.at > 15 * 60000 || !contact || contact.blocked) throw new Error('No current pending message for that contact')
    delete this.store.data.settings.pendingOwnerSend; this.store.save()
    return this.execute({ type: 'send', target: contact.id, text: pending.text, requestKey: pending.requestKey })
  }
  planOutreach(plan, text, resolution) {
    if (plan.operation === 'cancel') {
      if (!/\b(cancel|stop|remove)\b/i.test(text) || !text.toUpperCase().includes(String(plan.id).toUpperCase())) throw new Error('Explicitly identify the outreach to cancel')
      return this.outbox.cancel(plan.id)
    }
    if (plan.operation !== 'create' || !sendIntent(text)) throw new Error('Outreach requires a direct owner messaging request')
    const action = { type: 'send', target: plan.target, text: plan.text }
    this.authorizeAction(action, text, null, resolution)
    const dueAt = outreachTime(text, plan.dueAt, this.profile.timezone)
    if (dueAt && Date.parse(dueAt) < Date.now() - 60000) throw new Error('That outreach time is already in the past')
    const contact = this.store.getContact(action.target)
    const task = this.outbox.create({ contact, text: action.text, dueAt })
    return `Queued ${task.id} for ${contact.name || contact.id}${dueAt ? ` at ${dueAt}` : ''}; no incoming message is required.`
  }
  planFollowup(plan, contact, concern) {
    const due = Date.parse(plan.dueAt)
    if (this.store.data.settings.proactiveEnabled === false || plan.operation !== 'create' || plan.reason !== 'missing_detail' || this.store.getContact(plan.target)?.id !== contact.id ||
        !Number.isFinite(due) || due < Date.now() + 5 * 60000 || due > Date.now() + 86400000 ||
        this.store.data.outreach.some(task => task.contact === contact.id && task.concern === concern.id)) throw new Error('Follow-ups require one necessary missing-detail question for this open concern, 5 minutes to 24 hours ahead')
    return this.outbox.create({ contact, text: plan.text, dueAt: plan.dueAt, source: 'follow_up', concern: concern.id })
  }
  async dispatchOutreach(contact, text, task) {
    const wasActive = this.state(contact.id).active
    this.cancel(contact.id, true)
    try {
      const sent = await this.transport.sendContact(contact, text, contact.id)
      if (!sent?.key?.id) throw new Error('WhatsApp returned no message ID; delivery status is unknown')
      this.store.data.settings.ownerLastAction = { type: 'send', contact: contact.id, text,
        status: 'accepted_by_transport', messageId: sent.key.id, task: task.id, at: Date.now() }
      if (task.source === 'owner') {
        this.store.append(contact.id, 'owner', text, { visibility: 'shared', viaClara: true })
        this.store.shareFacts(contact, text)
        const focus = this.store.data.settings.ownerFocus
        if (!focus || focus.at <= task.createdAt) this.store.data.settings.ownerFocus = {
          contacts: [contact.id], at: task.createdAt, source: 'owner_send', trustedForSend: true }
      } else {
        this.store.append(contact.id, 'assistant', text, { visibility: contact.confirmed && contact.permission === 'all_personal' ? 'personal' : 'public' })
      }
      const state = this.state(contact.id)
      state.active = true
      Object.assign(state.session, { mode: 'clara', pending: null, resumeAt: 0, updatedAt: Date.now() })
      state.latest = null; state.pendingPhoto = null
      this.store.append('owner', 'context', `[Outreach ${task.id} accepted by WhatsApp] ${contact.id}: ${text}`, { contactId: contact.id })
      return sent
    } catch (error) {
      this.store.data.settings.ownerLastAction = { type: 'send', contact: contact.id, text,
        status: 'failed_or_unknown', task: task.id, at: Date.now(), error: error.message.slice(0, 220) }
      this.state(contact.id).active = wasActive
      if (this.state(contact.id).session.pending) this.schedule(contact, this.config.takeoverMs)
      this.store.save(); throw error
    }
  }
  async notifyOutreach(task) {
    if (this.routineHeld() || !this.transport.ready) return false
    const status = task.status === 'accepted_by_transport' ? 'Accepted by WhatsApp (delivery/read not confirmed)' :
      task.status === 'failed_or_unknown' ? 'Delivery unknown; check the chat before retrying' : task.status
    const text = `Outreach ${task.id} | ${task.contact}\n${status}\n${task.text.slice(0, 300)}`
    const sent = await this.transport.sendOwner(text, task.contact, 'outreach_result')
    if (!sent?.key?.id) return false
    this.store.noteNotification(task.contact, task.contact)
    this.store.append('owner', 'context', `[Outreach result sent to self-chat]\n${text}`, { contactId: task.contact })
    return true
  }
  async execute(action) {
    const contact = this.store.getContact(action.target)
    switch (action.type) {
      case 'approve':
        if (!contact || !action.relationship) throw new Error('Specify contact and relationship')
        this.cancel(contact.id)
        this.store.approve(contact, action.relationship, action.permission || 'public', action.name)
        return `Saved ${contact.id} as ${contact.relationship}; ${contact.permission === 'all_personal' ? 'full owner-provided personal access, including known location' : 'public information only'}.`
      case 'revoke':
        if (!contact) throw new Error('Unknown contact')
        this.cancel(contact.id, true); this.store.revoke(contact)
        return `Revoked personal access for ${contact.id}.`
      case 'send': {
        if (!contact || !action.text?.trim()) throw new Error('Specify the contact and exact reply')
        const task = this.outbox.create({ contact, text: limitReply(action.text, true), requestKey: action.requestKey })
        this.store.data.settings.ownerLastAction = { type: 'send', contact: contact.id, text: action.text,
          status: task.status, task: task.id, at: Date.now() }
        this.store.save()
        await this.outbox.drain()
        if (task.status === 'failed_or_unknown') throw new Error(task.error)
        if (task.status === 'accepted_by_transport' && action.usesDraft) this.store.data.settings.ownerDraft.used = true
        this.store.save()
        return task.status === 'accepted_by_transport' ? `Sent to ${contact.name || contact.id}.` : `Queued ${task.id} for ${contact.name || contact.id}; it will send when connected.`
      }
      case 'remember': case 'location': {
        if (!action.text?.trim()) throw new Error('Supply the information to remember')
        const fact = this.store.remember(action.text, action.type === 'location' ? 'location' : 'personal')
        return `Saved ${fact.id}${fact.kind === 'location' ? ' with the current timestamp' : ''}. Approved full-access contacts may receive it.`
      }
      case 'set_model':
        this.store.data.settings.model = modelId(action.model || action.text); this.store.save()
        return `Using ${this.store.data.settings.model} at low effort.`
      case 'close': {
        const concern = this.store.data.concerns[String(action.target).replace(/^#/, '').toUpperCase()]
        if (!concern) throw new Error('Specify an R0001 concern reference')
        concern.status = 'closed'; this.store.save(); return `Closed ${concern.id}.`
      }
      default: throw new Error('Unsupported action')
    }
  }
  async command(text) {
    const [raw, ...args] = text.trim().split(/\s+/)
    const cmd = raw.toLowerCase()
    const target = args[0]?.replace(/^#/, '').toUpperCase()
    const action = { target }
    if (['/approve', '/whitelist', '/reply'].includes(cmd) && /^\+?[1-9]\d{6,14}$/.test(target || '')) {
      action.target = this.store.contact(`${target.replace(/^\+/, '')}@s.whatsapp.net`).id
    }
    if (cmd === '/help') return HELP
    if (cmd === '/proactive') {
      if (!['on', 'off'].includes(args[0])) throw new Error('Use /proactive on or /proactive off')
      this.store.data.settings.proactiveEnabled = args[0] === 'on'
      if (args[0] === 'off') for (const task of this.store.data.outreach) if (task.source === 'follow_up' && task.status === 'queued') task.status = 'cancelled'
      this.store.save(); this.outbox.arm()
      return `Automatic missing-detail follow-ups ${args[0]}. Explicit owner-requested messages and scheduled outreach are unchanged.`
    }
    if (cmd === '/outbox') return this.store.data.outreach.slice(-15).map(item => `${item.id} | ${item.contact} | ${item.status}\n${item.text}`).join('\n\n') || 'No outreach tasks.'
    if (cmd === '/canceloutreach') return this.outbox.cancel(target)
    if (cmd === '/cancelpending') { delete this.store.data.settings.pendingOwnerSend; this.store.save(); return 'Pending send cancelled.' }
    if (cmd === '/sendpending') return this.finishPending(target)
    if (cmd === '/sleep') return this.setOwnerStatus({ state: 'sleeping', quietRoutine: true, discloseSleeping: args[0] !== 'private', urgentCalls: true })
    if (cmd === '/awake') return this.setOwnerStatus({ state: 'available', quietRoutine: false, discloseSleeping: false, urgentCalls: true })
    if (cmd === '/busy') return this.setOwnerStatus({ state: 'busy', quietRoutine: false, discloseSleeping: false, urgentCalls: true })
    if (cmd === '/instructions') return this.controls.list()
    if (cmd === '/uninstruct') {
      const receipt = this.controls.apply([{ operation: 'remove', id: args[0] }], `Remove instruction ${args[0]}`, {})
      this.refreshOwnerPolicy()
      return receipt
    }
    if (cmd === '/status') return `Clara: ${this.transport.ready ? 'connected' : 'disconnected'}\nModel: ${this.store.data.settings.model || this.config.model} / low\nAvailability: ${this.controls.data.presence?.state || availability(this.profile, this.now()).status}${this.controls.quiet ? ' / routine reports held' : ''}\nContacts: ${Object.keys(this.store.data.contacts).length}`
    if (cmd === '/contacts') return Object.values(this.store.data.contacts).map(c => `${c.id}: ${c.name || '?'} / ${c.confirmed ? c.relationship : `claims ${c.claimedRelationship || '?'}`} / ${c.permission}${c.blocked ? ' / blocked' : ''}`).join('\n') || 'No contacts yet.'
    if (cmd === '/inbox') return Object.values(this.store.data.concerns).filter(c => c.status === 'open').map(c => `${c.id} | ${c.contactId}${c.urgent ? ' | URGENT' : ''}\n${c.summary}`).join('\n\n') || 'No open concerns.'
    if (cmd === '/thread') {
      const contact = this.store.getContact(target)
      if (!contact) throw new Error('Unknown contact')
      this.store.data.settings.ownerFocus = { contacts: [contact.id], at: Date.now(), source: 'owner_thread_command' }
      this.store.save()
      return `${contact.id}\n${this.store.history(contact.id).slice(-12).map(e => `${e.role}: ${e.text}`).join('\n')}`
    }
    if (cmd === '/name') {
      const contact = this.store.getContact(target)
      const name = args.slice(1).join(' ').trim()
      if (!contact || !name) throw new Error('Use /name C0001 Contact name')
      this.store.applyNames(contact, { owner: name })
      this.store.data.settings.ownerFocus = { contacts: [contact.id], at: Date.now(), source: 'owner_name_command', trustedForSend: true }
      this.store.save()
      return `Saved ${contact.id} as ${contact.name}. Relationship and private access are unchanged.`
    }
    if (cmd === '/forget') {
      const before = this.store.data.facts.length
      this.store.data.facts = this.store.data.facts.filter(f => args[0] === 'location' ? f.kind !== 'location' : f.id !== target)
      this.store.data.settings.memoryVersion = (this.store.data.settings.memoryVersion || 0) + 1
      for (const c of Object.values(this.store.data.contacts)) this.cancel(c.id)
      this.store.save(); return `Removed ${before - this.store.data.facts.length} saved fact(s).`
    }
    if (cmd === '/approve' || cmd === '/whitelist') Object.assign(action, { type: 'approve', relationship: args[1], permission: cmd === '/whitelist' || args[2] === 'all' ? 'all_personal' : 'public' })
    else if (cmd === '/revoke') action.type = 'revoke'
    else if (cmd === '/block') {
      const contact = this.store.getContact(target)
      if (!contact) throw new Error('Unknown contact')
      this.cancel(contact.id, true); this.store.revoke(contact, true); return `Blocked ${contact.id}.`
    } else if (cmd === '/reply') Object.assign(action, { type: 'send', text: args.slice(1).join(' ') })
    else if (cmd === '/remember' || cmd === '/location') Object.assign(action, { type: cmd.slice(1), text: args.join(' ') })
    else if (cmd === '/model') Object.assign(action, { type: 'set_model', model: args[0] })
    else if (cmd === '/close') action.type = 'close'
    else throw new Error('Unknown command; use /help')
    return this.execute(action)
  }
  disconnect() {
    clearTimeout(this.digestRetryTimer)
    for (const timer of this.activityTimers.values()) clearTimeout(timer)
    this.activityTimers.clear()
    for (const timer of this.concernTimers.values()) clearTimeout(timer)
    this.concernTimers.clear()
    for (const id of this.chats.keys()) {
      if (this.store.data.contacts[id]) this.cancel(id)
      else { clearTimeout(this.chats.get(id).timer); this.chats.get(id).controller?.abort() }
    }
    this.ownerController?.abort()
    this.ownerVersion++
  }
  stop() { this.stopping = true; this.outbox.stop(); this.disconnect(); this.store.save() }
}
module.exports = { Agent, HELP }
