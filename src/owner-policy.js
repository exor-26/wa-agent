const STYLE = ['brief', 'professional', 'friendly', 'english', 'hindi', 'hinglish']
const INTAKE = ['take_messages', 'ask_deadline', 'no_commitments', 'urgent_calls_only', 'no_calls']
const CONDITIONS = ['all', 'talk_request', 'work_request', 'availability_request']

function normalized(text) { return String(text || '').replace(/[\u2018\u2019]/g, "'").trim() }
function statusStatement(text) {
  const value = normalized(text).toLowerCase()
  const declaration = value.replace(/^(?:(?:hey|clara)[,\s]+)*/, '').split(/[.!;,\n]/, 1)[0]
  if (/^(what if|if|suppose|imagine|he said|she said|i said|did|should|can|would|could)\b/.test(value) ||
      /\b(tomorrow|yesterday|might|hypothetical|example|later)\b|\b(at|after|in)\s+\d/.test(declaration) || declaration.endsWith('?')) return null
  const prefix = "(?:(?:hey|clara)[,\\s]+)*(?:i'm|im|i am)\\s+"
  if (new RegExp(`^${prefix}(going to (sleep|bed)|off to (sleep|bed)|heading to bed|about to sleep|sleeping)\\b`).test(value) ||
      /^(main|mai|mein)\s+(ab\s+)?sone ja (raha|rahi)\b/.test(value)) {
    return { state: 'sleeping', quietRoutine: true,
      discloseSleeping: !/\b(don't|do not|never)\b.*\b(tell|say|share|reveal)\b/.test(value),
      urgentCalls: !/\b(don't|do not|never)\s+call\b|\bno calls\b/.test(value) }
  }
  if (new RegExp(`^${prefix}(awake|back|free now|available now)\\b`).test(value) ||
      new RegExp(`^${prefix}(free|available)[.!]?$`).test(value) ||
      /^i (just |have just |have )?woke(n)? up\b/.test(value) || /^(main|mai|mein)\s+uth (gaya|gayi)\b/.test(value)) {
    return { state: 'available', quietRoutine: false, discloseSleeping: false, urgentCalls: true }
  }
  if (new RegExp(`^${prefix}(busy|unavailable|not available|away)\\b`).test(value)) {
    return { state: 'busy', quietRoutine: false, discloseSleeping: false, urgentCalls: true }
  }
  return null
}
function instructionIntent(text) {
  const original = normalized(text)
  const polite = /^(can|could|would|will) you\s+(please\s+)?/i.test(original)
  const value = original.replace(/^(can|could|would|will) you\s+(please\s+)?/i, '')
  if (/^(what if|suppose|imagine|he said|she said|i said|did|should|would|could)\b/i.test(value) || !polite && value.endsWith('?')) return false
  const outsideQuotes = value.replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, '')
  if (statusStatement(value) && /\b(keep|use|always|when|if|ask|reply|replies|respond)\b/i.test(outsideQuotes) &&
      !/\b\w+\s+(said|says|asked)\b/i.test(outsideQuotes)) return true
  return /^(please\s+)?(always|from now on|keep|use|reply|respond|ask|don't|do not|never|take|collect|only|avoid|if|when|tell everyone|tell anyone|let people know|i want you to|i prefer|clear|remove|forget|reset)\b/i.test(value)
}
function urgentRequest(text) {
  return /\b(urgent|urgently|emergency|asap)\b/i.test(text) && !/\b(not|isn't|is not|isnt|no)\s+(urgent|(?:an? )?emergency)\b/i.test(text)
}
function family(kind, value) {
  if (kind === 'style') return ['english', 'hindi', 'hinglish'].includes(value) ? 'language' : value === 'brief' ? 'length' : 'tone'
  if (kind === 'intake' && ['no_calls', 'urgent_calls_only'].includes(value)) return 'calls'
  return value
}

class OwnerPolicy {
  constructor(store) {
    this.store = store
    store.data.settings.ownerControl ||= { revision: 0, presence: null, nextInstruction: 1, instructions: [] }
  }
  get data() { return this.store.data.settings.ownerControl }
  get quiet() { return !!this.data.presence?.quietRoutine }
  setPresence(update) {
    this.data.presence = { ...update, updatedAt: new Date().toISOString(), source: 'direct_owner' }
    this.data.revision++
    this.store.save()
    if (update.state === 'sleeping') return `Sleep mode on. I'll handle ordinary messages, hold routine reports, and ${update.urgentCalls ? 'suggest calling only for urgent requests' : 'not suggest calling you'}${update.discloseSleeping ? '. I may say you are sleeping when someone wants to talk' : '. I will keep the reason private'}. Say "I'm awake" to resume reports.`
    if (update.state === 'available') return 'Sleep/away status cleared. I will resume normal reporting and summarize any held updates.'
    return 'I will treat you as busy across chats and keep the reason private. Tell me when you are available again.'
  }
  forContact(contact) {
    const personal = contact.confirmed && contact.permission === 'all_personal'
    const applicable = this.data.instructions.filter(rule =>
      rule.audience === 'all' || rule.audience === 'personal' && personal || rule.audience === 'contact' && rule.target === contact.id)
    const rank = { all: 0, personal: 1, contact: 2 }
    const selected = new Map()
    for (const rule of applicable.sort((a, b) => rank[a.audience] - rank[b.audience] || a.at.localeCompare(b.at))) {
      selected.set(`${rule.kind}:${family(rule.kind, rule.value)}`, rule)
    }
    const instructions = [...selected.values()]
    const presence = this.data.presence
    const noCalls = instructions.some(rule => rule.kind === 'intake' && rule.value === 'no_calls')
    return { revision: this.data.revision,
      presence: presence ? { status: presence.state === 'sleeping' && !presence.discloseSleeping && !personal ? 'unavailable' : presence.state,
        updatedAt: personal ? presence.updatedAt : null, basis: 'latest explicit owner update, not device presence',
        shareSleepingStatus: presence.state === 'sleeping' && presence.discloseSleeping,
        urgentCallAllowed: presence.urgentCalls && !noCalls,
        replyAfterWake: presence.state === 'sleeping' && presence.discloseSleeping } : null,
      instructions: instructions.map(({ id, kind, value, text, audience }) => ({ id, kind, value, text, scope: audience })) }
  }
  apply(updates, ownerText, resolution, { forwarded = false } = {}) {
    if (!updates?.length) return ''
    if (forwarded || !instructionIntent(ownerText)) throw new Error('Give a direct instruction to change cross-chat rules; quoted or hypothetical content cannot change them')
    const instructions = this.data.instructions.map(rule => ({ ...rule }))
    let next = this.data.nextInstruction
    const receipts = []
    for (const update of updates) {
      if (update.operation === 'clear') {
        if (!/\b(clear|remove|forget|reset)\b.*\b(all|standing|saved)\b.*\b(instructions?|rules?)\b/i.test(ownerText)) throw new Error('Explicitly ask to clear all saved instructions')
        instructions.splice(0)
        receipts.push('Cleared saved cross-chat instructions; contact permissions are unchanged.')
        continue
      }
      if (update.operation === 'remove') {
        if (!update.id || !ownerText.toUpperCase().includes(update.id.toUpperCase()) || !/\b(remove|forget|delete|clear)\b/i.test(ownerText)) throw new Error('Specify the instruction ID to remove')
        const index = instructions.findIndex(rule => rule.id === update.id.toUpperCase())
        if (index < 0) throw new Error('Unknown instruction ID')
        instructions.splice(index, 1)
        receipts.push(`Removed ${update.id.toUpperCase()}.`)
        continue
      }
      if (update.operation !== 'add') throw new Error('Unsupported instruction operation')
      if (!['all', 'personal', 'contact', 'owner'].includes(update.audience)) throw new Error('Specify who this rule applies to')
      const outsideQuotes = ownerText.replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, '')
      const global = /\b(everyone|anyone|anybody|all|people|external|across chats|cross.chat|other chats)\b/i.test(outsideQuotes)
      if (!global && /\b(with me|to me|my chat|self.chat|this chat)\b/i.test(outsideQuotes) && update.audience !== 'owner') throw new Error('This request is scoped to self-chat, not other people')
      if (!global && /\b(approved|whitelisted|family|personal contacts)\b/i.test(outsideQuotes) && !['personal', 'contact'].includes(update.audience)) throw new Error('This request is limited to approved personal contacts')
      if (!global && /\b[CR]\d{4}\b/i.test(outsideQuotes) && update.audience !== 'contact') throw new Error('Keep this rule limited to the explicitly identified contact')
      const target = update.audience === 'contact' ? this.store.getContact(update.target)?.id : null
      if (update.audience === 'contact' && (!target || target !== resolution.selectedContact || !resolution.trustedForSend)) throw new Error('Identify one exact contact for this rule')
      if (update.audience === 'personal' && !/\b(family|whitelisted|approved|personal)\b/i.test(ownerText)) throw new Error('Specify whether the rule is for approved personal contacts')
      if (update.audience === 'owner' && !/\b(self.chat|my chat|with me|to me|this chat)\b/i.test(ownerText)) throw new Error('Specify that this rule is only for your self-chat')
      if (update.kind === 'style' && !STYLE.includes(update.value) || update.kind === 'intake' && !INTAKE.includes(update.value)) throw new Error('That behavior needs clarification before it can be saved')
      let text = null
      if (update.kind === 'notice') {
        text = update.text?.trim()
        if (!CONDITIONS.includes(update.value) || !text || text.length > 400 || !ownerText.includes(text) ||
            !/\b(tell|say|reply|respond|share|kehna|bol)\b/i.test(ownerText)) throw new Error('Give the exact wording and when Clara should say it')
        if (/\b(don't|do not|never|stop|avoid)\b.{0,40}\b(tell|say|share|reveal|reply|respond)\b/i.test(outsideQuotes)) throw new Error('A request not to disclose something cannot become a notice that discloses it')
        if (/\b(password|passcode|otp|api.?key|access.?token|private.?key)\b|\bsk-[a-z0-9]{12,}/i.test(text)) throw new Error('Credentials cannot be saved as an external reply rule')
      } else if (!['style', 'intake'].includes(update.kind)) throw new Error('Unsupported rule; clarify the desired reply style, intake behavior or exact notice')
      // Only typed behavior or explicitly supplied reply text reaches external chats, never the owner's raw private message.
      const old = instructions.findIndex(rule => rule.kind === update.kind && family(rule.kind, rule.value) === family(update.kind, update.value) &&
        rule.audience === update.audience && rule.target === target)
      const id = old >= 0 ? instructions[old].id : `I${String(next++).padStart(4, '0')}`
      const rule = { id, kind: update.kind, value: update.value, audience: update.audience, target, text,
        at: new Date().toISOString(), source: 'direct_owner' }
      if (old >= 0) instructions[old] = rule
      else instructions.push(rule)
      receipts.push(`Saved ${id}: ${text || update.value.replace(/_/g, ' ')} (${update.audience}${target ? `: ${target}` : ''}).`)
    }
    if (instructions.length > 30) throw new Error('Remove an old rule before adding another; maximum 30 saved instructions')
    Object.assign(this.data, { instructions, nextInstruction: next, revision: this.data.revision + 1 })
    this.store.save()
    return receipts.join('\n')
  }
  list() {
    return `Owner status: ${this.data.presence?.state || 'usual schedule'}${this.quiet ? ' / routine reports held' : ''}\n${this.data.instructions.map(rule => `${rule.id}: ${rule.text || rule.value.replace(/_/g, ' ')} / ${rule.audience}${rule.target ? ` ${rule.target}` : ''}`).join('\n') || 'No saved cross-chat rules.'}`
  }
}

module.exports = { OwnerPolicy, statusStatement, instructionIntent, urgentRequest, STYLE, INTAKE, CONDITIONS }
