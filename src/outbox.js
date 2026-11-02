const { randomUUID } = require('node:crypto')

function outreachTime(text, proposed, timezone, now = Date.now()) {
  const instruction = text.replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, '')
  const relative = instruction.match(/\bin\s+(\d{1,4})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i)
  if (relative) {
    const unit = /^(s)/i.test(relative[2]) ? 1000 : /^(h)/i.test(relative[2]) ? 3600000 : 60000
    return new Date(now + Number(relative[1]) * unit).toISOString()
  }
  if (!proposed) return null
  if (instruction.includes(proposed)) return proposed
  const clock = instruction.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (!clock) throw new Error('Give an exact send time, an ISO timestamp, or a delay such as in 10 minutes')
  let hour = Number(clock[1]); const minute = Number(clock[2] || 0)
  if (clock[3]) hour = hour % 12 + (/pm/i.test(clock[3]) ? 12 : 0)
  if (hour > 23 || minute > 59) throw new Error('Invalid send time')
  const parts = value => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]))
  const candidate = parts(Date.parse(proposed))
  if (+candidate.hour !== hour || +candidate.minute !== minute) throw new Error('The interpreted time does not match your local send time')
  const intended = parts(now + (/\btomorrow\b/i.test(instruction) ? 86400000 : 0))
  if (candidate.year !== intended.year || candidate.month !== intended.month || candidate.day !== intended.day) throw new Error('Specify the date; the interpreted day does not match your instruction')
  return proposed
}

class Outbox {
  constructor({ store, ready, send, notify = null, now = Date.now }) {
    Object.assign(this, { store, ready, send, notify, now })
    this.stopped = false; this.work = null
    for (const task of store.data.outreach) if (task.status === 'sending') {
      task.status = 'failed_or_unknown'; task.error = 'Interrupted during send; check the chat before retrying.'
      task.noticePending = true
    }
  }
  create({ contact, text, dueAt = null, source = 'owner', concern = null, requestKey = null }) {
    if (!contact || contact.blocked) throw new Error('Choose an unblocked, exact contact')
    if (!text?.trim() || text.length > 4000) throw new Error('Supply a normal-sized outgoing message (maximum 4000 characters)')
    const when = dueAt ? Date.parse(dueAt) : this.now()
    if (!Number.isFinite(when) || when > this.now() + 7 * 86400000) throw new Error('Choose an outreach time within the next seven days')
    const old = requestKey && this.store.data.outreach.find(task => task.requestKey === requestKey)
    if (old) return old
    const task = { id: `T${randomUUID().slice(0, 8).toUpperCase()}`, contact: contact.id, text: text.trim(),
      dueAt: when, expiresAt: Math.max(this.now(), when) + (dueAt ? 3600000 : 86400000), createdAt: this.now(),
      notifyResult: !!dueAt || !this.ready(), noticePending: false,
      source, concern, requestKey, status: 'queued', lastIncoming: this.store.history(contact.id).findLast(entry => entry.role === 'user')?.at || null }
    this.store.data.outreach = [...this.store.data.outreach.slice(-199), task]
    this.store.save()
    this.arm()
    return task
  }
  arm() {
    clearTimeout(this.timer)
    if (this.stopped) return
    const next = this.store.data.outreach.filter(task => task.status === 'queued').sort((a, b) => a.dueAt - b.dueAt)[0]
    if (!next && !(this.notify && this.store.data.outreach.some(task => task.noticePending))) return
    this.timer = setTimeout(() => {
      this.drain().catch(() => {}).finally(() => this.arm())
    }, next && this.ready() ? Math.max(1, Math.min(30000, next.dueAt - this.now())) : 30000)
    this.timer.unref?.()
  }
  cancel(id) {
    const task = this.store.data.outreach.find(item => item.id === id && item.status === 'queued')
    if (!task) throw new Error('No queued outreach with that ID')
    task.status = 'cancelled'; this.store.save(); this.arm()
    return `Cancelled ${id}.`
  }
  async drain() {
    if (this.stopped || !this.ready()) return
    if (this.work) return this.work
    this.work = (async () => {
      for (const task of this.store.data.outreach.filter(item => item.status === 'queued' && item.dueAt <= this.now())) {
        if (this.stopped || !this.ready()) break
        const contact = this.store.getContact(task.contact)
        const concern = this.store.data.concerns[task.concern]
        const changed = task.source === 'follow_up' &&
          (this.store.history(task.contact).findLast(entry => entry.role === 'user')?.at || null) !== task.lastIncoming
        if (!contact || contact.blocked || changed || task.source === 'follow_up' && concern?.status !== 'open' ||
            contact.conversation?.lastOwnerAt > task.createdAt || task.expiresAt < this.now()) {
          task.status = task.expiresAt < this.now() ? 'expired' : 'cancelled'; this.store.save(); continue
        }
        // Persist the reservation before touching the transport. Interrupted/uncertain sends never auto-repeat.
        task.status = 'sending'; task.attemptedAt = this.now(); this.store.save()
        try {
          const result = await this.send(contact, task.text, task)
          if (!result?.key?.id) throw new Error('No transport message ID; delivery is unknown')
          task.status = 'accepted_by_transport'; task.messageId = result.key.id
        } catch (error) {
          task.status = error.code === 'WA_NOT_CONNECTED' ? 'queued' : 'failed_or_unknown'
          task.error = String(error.message).slice(0, 220)
        }
        task.noticePending = task.notifyResult && task.status !== 'queued'
        this.store.save()
      }
      if (this.notify) for (const task of this.store.data.outreach.filter(item => item.noticePending)) {
        if (this.stopped || !this.ready()) break
        try { if (await this.notify(task)) { task.noticePending = false; task.notifiedAt = this.now(); this.store.save() } }
        catch { /* Reporting retries separately; it must never repeat the external send. */ }
      }
    })()
    try { await this.work } finally { this.work = null; this.arm() }
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
}
module.exports = { Outbox, outreachTime }
