const fs = require('node:fs')
const path = require('node:path')

function jid(value) {
  return String(value || '').replace(/:\d+(?=@)/, '').trim()
}
function directJid(value) {
  return /^\d+@(s\.whatsapp\.net|lid)$/.test(jid(value))
}
class Store {
  constructor(file, { historyLimit = 30, legacyHistoryFile } = {}) {
    this.file = file
    this.historyLimit = historyLimit
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      version: 1, nextContact: 1, nextConcern: 1, nextFact: 1, contacts: {}, aliases: {},
      history: {}, concerns: {}, facts: [], ownerHistory: [], outbound: {}, processed: {}, settings: {}
    }
    if (this.data.version !== 1) throw new Error('Unsupported state format')
    this.data.activities ||= {}
    this.data.contactNames ||= {}
    this.data.outreach ||= []
    this.data.shares ||= {}
    if (legacyHistoryFile && !this.data.legacyImported && fs.existsSync(legacyHistoryFile)) {
      const old = JSON.parse(fs.readFileSync(legacyHistoryFile, 'utf8'))
      for (const [address, entries] of Object.entries(old)) {
        if (!directJid(address) || !Array.isArray(entries)) continue
        this.data.history[jid(address)] = entries.filter(e => typeof e.text === 'string')
          .slice(-historyLimit).map(e => ({ role: e.role, text: e.text, at: null }))
      }
      this.data.legacyImported = true
    }
    for (const contact of Object.values(this.data.contacts)) {
      contact.names ||= contact.name ? { [contact.confirmed ? 'owner' : 'claimed']: contact.name } : {}
      this.applyNames(contact, contact.names)
      contact.identityAsked ??= this.history(contact.id).some(entry => entry.role === 'assistant' &&
        /your name|how (?:do you|you) know|aapka naam|tumhara naam/i.test(entry.text))
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(this.file), 0o700)
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }
  contact(address, aliases = []) {
    const addresses = [...new Set([address, ...aliases].map(jid).filter(directJid))]
    if (!addresses.length) throw new Error('Invalid personal chat address')
    const ids = [...new Set(addresses.map(a => this.data.aliases[a]).filter(Boolean))]
    // A server-provided phone/LID mapping may arrive after both aliases were seen.
    if (ids.length > 1) {
      const records = ids.map(id => this.data.contacts[id])
      const approved = records.filter(c => c.confirmed)
      if (approved.length > 1) throw new Error('Contact alias conflict; revoke one duplicate contact in self-chat first')
      const keep = approved[0] || records[0]
      for (const other of records.filter(c => c.id !== keep.id)) {
        for (const alias of other.aliases) {
          this.data.aliases[alias] = keep.id
          if (!keep.aliases.includes(alias)) keep.aliases.push(alias)
        }
        this.data.history[keep.id] = [...(this.data.history[keep.id] || []), ...(this.data.history[other.id] || [])]
          .sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).slice(-this.historyLimit)
        for (const concern of Object.values(this.data.concerns)) if (concern.contactId === other.id) concern.contactId = keep.id
        for (const sent of Object.values(this.data.outbound)) if (sent.reference === other.id) sent.reference = keep.id
        const otherActivity = this.data.activities[other.id]
        if (otherActivity && (!this.data.activities[keep.id] || otherActivity.updatedAt > this.data.activities[keep.id].updatedAt)) {
          this.data.activities[keep.id] = { ...otherActivity, contactId: keep.id }
        }
        delete this.data.activities[other.id]
        const focus = this.data.settings.ownerFocus
        if (focus) focus.contacts = [...new Set(focus.contacts.map(id => id === other.id ? keep.id : id))]
        if (this.data.settings.ownerDraft?.contact === other.id) this.data.settings.ownerDraft.contact = keep.id
        if (this.data.settings.ownerLastNotification?.contact === other.id) this.data.settings.ownerLastNotification.contact = keep.id
        if (this.data.settings.ownerLastNotification?.contacts) {
          this.data.settings.ownerLastNotification.contacts = [...new Set(this.data.settings.ownerLastNotification.contacts.map(id => id === other.id ? keep.id : id))]
        }
        for (const rule of this.data.settings.ownerControl?.instructions || []) if (rule.target === other.id) rule.target = keep.id
        for (const task of this.data.outreach) if (task.contact === other.id) task.contact = keep.id
        this.data.shares[keep.id] = [...(this.data.shares[keep.id] || []), ...(this.data.shares[other.id] || [])].slice(-30)
        delete this.data.shares[other.id]
        for (const note of this.data.settings.ownerNotifications || []) {
          note.contacts = [...new Set(note.contacts.map(id => id === other.id ? keep.id : id))]
        }
        keep.name ||= other.name
        keep.names = { ...other.names, ...keep.names }
        keep.claimedRelationship ||= other.claimedRelationship
        keep.introduced ||= other.introduced
        keep.verificationNotified ||= other.verificationNotified
        if (other.conversation && (!keep.conversation || other.conversation.updatedAt > keep.conversation.updatedAt)) {
          keep.conversation = other.conversation
        }
        delete this.data.history[other.id]
        delete this.data.contacts[other.id]
      }
      ids.splice(0, ids.length, keep.id)
    }
    let contact = this.data.contacts[ids[0]]
    if (!contact) {
      const id = `C${String(this.data.nextContact++).padStart(4, '0')}`
      contact = this.data.contacts[id] = { id, jid: jid(address), aliases: [], name: '',
        relationship: '', claimedRelationship: '', confirmed: false, permission: 'public',
        policyVersion: 0, introduced: false, verificationNotified: false, blocked: false }
    }
    for (const address of addresses) {
      this.data.aliases[address] = contact.id
      if (!contact.aliases.includes(address)) contact.aliases.push(address)
      if (this.data.history[address]) {
        this.data.history[contact.id] = [...(this.data.history[contact.id] || []), ...this.data.history[address]]
          .slice(-this.historyLimit)
        delete this.data.history[address]
      }
    }
    contact.jid = jid(address)
    contact.names ||= contact.name ? { [contact.confirmed ? 'owner' : 'claimed']: contact.name } : {}
    contact.identityAsked ??= this.history(contact.id).some(entry => entry.role === 'assistant' &&
      /your name|how (?:do you|you) know|aapka naam|tumhara naam/i.test(entry.text))
    for (const alias of contact.aliases) this.applyNames(contact, this.data.contactNames[alias])
    return contact
  }
  applyNames(contact, names) {
    contact.names ||= {}
    for (const source of ['owner', 'saved', 'claimed', 'push']) {
      if (typeof names?.[source] === 'string' && names[source].trim()) {
        contact.names[source] = names[source].replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 80)
      }
    }
    for (const source of ['owner', 'saved', 'claimed', 'push']) {
      if (contact.names[source]) { contact.name = contact.names[source]; contact.nameSource = source; break }
    }
  }
  cacheNames(entries) {
    for (const entry of entries || []) {
      const addresses = [entry.id, entry.lid, entry.phoneNumber].map(jid).filter(directJid)
      if (addresses.some(address => this.getContact(address))) this.contact(addresses[0], addresses.slice(1))
      for (const address of addresses) {
        const names = this.data.contactNames[address] ||= {}
        if (typeof entry.name === 'string' && entry.name.trim()) names.saved = entry.name.slice(0, 80)
        if (typeof entry.notify === 'string' && entry.notify.trim()) names.push = entry.notify.slice(0, 80)
        const contact = this.getContact(address)
        if (contact) this.applyNames(contact, names)
      }
    }
    this.save()
  }
  linkLegacy(ownerAliases) {
    for (const address of Object.keys(this.data.history)) {
      if (directJid(address) && !ownerAliases.has(jid(address))) this.contact(address).legacy = true
    }
    this.save()
  }
  getContact(reference) {
    const ref = String(reference || '').replace(/^#/, '').toUpperCase()
    if (this.data.contacts[ref]) return this.data.contacts[ref]
    const address = /^\+?[1-9]\d{6,14}$/.test(ref) ? `${ref.replace(/^\+/, '')}@s.whatsapp.net` : jid(reference)
    if (this.data.aliases[address]) return this.data.contacts[this.data.aliases[address]]
    const concern = this.data.concerns[ref]
    return concern ? this.data.contacts[concern.contactId] : null
  }
  append(id, role, text, extra = {}) {
    const history = id === 'owner' ? this.data.ownerHistory : (this.data.history[id] ||= [])
    history.push({ role, text: String(text || '').slice(0, 8000), at: new Date().toISOString(), ...extra })
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit)
    this.save()
  }
  history(id) { return id === 'owner' ? this.data.ownerHistory : (this.data.history[id] || []) }
  claim(contact, name, relationship) {
    if (contact.confirmed) return
    if (name) this.applyNames(contact, { claimed: name })
    if (relationship) contact.claimedRelationship = relationship.slice(0, 80)
    this.save()
  }
  approve(contact, relationship, permission = 'all_personal', name) {
    Object.assign(contact, { confirmed: true, relationship, permission, blocked: false,
      policyVersion: contact.policyVersion + 1, verificationNotified: true })
    if (name) this.applyNames(contact, { owner: name })
    this.save()
  }
  activity(contact, message, reply, { summary = null, covered = false } = {}) {
    const old = this.data.activities[contact.id]
    const content = summary || `Message: ${String(message.text || '[Photo]').slice(0, 220)}${reply ? `\nClara: ${reply.slice(0, 220)}` : ''}`
    if (old?.messageId === message.id && old.summary === content) return old
    const activity = this.data.activities[contact.id] = { contactId: contact.id, summary: content.slice(0, 650),
      messageId: message.id, revision: (old?.revision || 0) + 1, reportedRevision: old?.reportedRevision || 0,
      updatedAt: Date.now(), nextAttemptAt: Date.now() + 15000, attempts: 0 }
    if (covered) activity.reportedRevision = activity.revision
    this.save()
    return activity
  }
  revoke(contact, blocked = false) {
    Object.assign(contact, { confirmed: false, permission: 'public', blocked,
      policyVersion: contact.policyVersion + 1 })
    delete this.data.shares[contact.id]
    for (const task of this.data.outreach) if (task.contact === contact.id && ['queued', 'needs_recipient'].includes(task.status)) task.status = 'cancelled'
    this.save()
  }
  concern(contact, summary, urgent = false) {
    let concern = Object.values(this.data.concerns).find(c => c.contactId === contact.id && c.status === 'open')
    if (!concern) {
      const id = `R${String(this.data.nextConcern++).padStart(4, '0')}`
      concern = this.data.concerns[id] = { id, contactId: contact.id, status: 'open', notifiedSummary: '',
        createdAt: new Date().toISOString(), ownerMessageIds: [] }
    }
    concern.summary = summary.slice(0, 800)
    concern.urgent ||= urgent
    concern.updatedAt = new Date().toISOString()
    this.save()
    return concern
  }
  referenceForQuote(id) {
    return this.data.outbound[id]?.reference ||
      Object.values(this.data.concerns).find(c => c.ownerMessageIds.includes(id))?.id || null
  }
  remember(text, kind = 'personal') {
    if (/\b(password|passcode|otp|api.?key|access.?token|private.?key)\b|\bsk-[a-z0-9]{12,}/i.test(text)) throw new Error('Credentials cannot be saved as shareable personal facts')
    const existing = this.data.facts.find(f => f.text === text && f.kind === kind)
    if (existing && kind !== 'location') return existing
    if (kind === 'location') this.data.facts = this.data.facts.filter(f => f.kind !== 'location')
    const fact = { id: `F${String(this.data.nextFact++).padStart(4, '0')}`, text: text.slice(0, 2000),
      kind, at: new Date().toISOString(), source: 'owner' }
    this.data.facts.push(fact)
    this.data.facts = this.data.facts.slice(-100)
    this.save()
    return fact
  }
  noteNotification(contacts, reference = null) {
    const ids = (Array.isArray(contacts) ? contacts : [contacts]).filter(id => this.data.contacts[id])
    const at = Date.now()
    this.data.settings.ownerLastNotification = ids.length === 1 ? { contact: ids[0], at } : { contacts: ids, at }
    this.data.settings.ownerNotifications = [...(this.data.settings.ownerNotifications || []).filter(note =>
      at - note.at < 15 * 60000 && !note.contacts.every(id => ids.includes(id))), { contacts: ids, reference, at }].slice(-20)
    this.save()
  }
  shareFacts(contact, text, { persist = true } = {}) {
    const { literalPayloads } = require('./owner-context')
    const literals = literalPayloads(text)
    const shared = this.data.shares[contact.id] ||= []
    for (const fact of this.data.facts) {
      if (fact.kind !== 'personal') continue
      if (text.includes(fact.text) || literals.some(value => fact.text.includes(value))) {
        if (!shared.some(item => item.fact === fact.id)) shared.push({ fact: fact.id, at: new Date().toISOString(), source: 'owner_shared' })
      }
    }
    this.data.shares[contact.id] = shared.slice(-30)
    if (persist) this.save()
  }
  restoreSharedFacts() {
    if (this.data.settings.scopedSharesInitialized) return 0
    let restored = 0
    for (const contact of Object.values(this.data.contacts)) {
      if (!contact.confirmed && contact.policyVersion > 0) continue
      const before = this.data.shares[contact.id]?.length || 0
      // Only authenticated owner messages already recorded in this exact thread authorize a backfill.
      for (const entry of this.history(contact.id)) if (entry.role === 'owner' && entry.visibility === 'shared') {
        this.shareFacts(contact, entry.text, { persist: false })
      }
      restored += (this.data.shares[contact.id]?.length || 0) - before
    }
    this.data.settings.scopedSharesInitialized = true
    this.save()
    return restored
  }
  markOutbound(id, address, reference = null, kind = 'reply') {
    this.data.outbound[id] = { jid: jid(address), reference, kind, at: Date.now(), status: 'prepared' }
    this.prune()
    this.save()
  }
  seen(id) {
    if (this.data.processed[id]) return true
    this.data.processed[id] = Date.now()
    this.prune()
    this.save()
    return false
  }
  prune() {
    for (const key of ['processed', 'outbound']) {
      const entries = Object.entries(this.data[key]).filter(([, v]) => Date.now() - (v.at || v) < 86400000)
      this.data[key] = Object.fromEntries(entries.slice(-5000))
    }
  }
}
module.exports = { Store, jid, directJid }
