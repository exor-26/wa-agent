const FOCUS_TTL_MS = 15 * 60 * 1000
const SEND_WORD = /\b(send|msg|message|text|tell|reply|forward|inform|bhej(?:o)?|bol do)\b/i
const REFERENTIAL = /\b(him|her|them|this guy|that guy|this person|that person|it|he|she|his|their|usse|usko|isko)\b/i
const RELATION = /\bis\s+my\s+(?:(?:closest|close|trusted|best|real|elder|younger)\s+)?(brother|sister|mother|father|dad|mom|friend|colleague)\b|\b(?:my|mera|meri)\s+(brother|sister|bhai|behen|mother|father|dad|mom|friend)\b/i
function selectorText(text) {
  return String(text).replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, ' ')
    .replace(/https?:\/\/[^\s<>"']+|\b[a-z0-9][a-z0-9._+-]{1,100}@[a-z][a-z0-9.-]{1,60}\b/gi, ' ')
}

function literalPayloads(text) {
  return [...new Set([...(String(text).match(/\b[a-z0-9][a-z0-9._+-]{1,100}@[a-z][a-z0-9.-]{1,60}\b/gi) || []),
    ...(String(text).match(/https?:\/\/[^\s<>"']+/gi) || []),
    ...[...String(text).matchAll(/["\u201c]([^"\u201d\n]{1,2000})["\u201d]/g)].map(match => match[1])])]
}
function inlinePayload(text, proposed) {
  return literalPayloads(text).some(value => String(proposed).includes(value))
}
function relationshipIntent(text) {
  const declaration = String(text).replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, '')
  return !declaration.trim().endsWith('?') && !/^\s*(what|why|how|did|is|are|should|suppose|imagine)\b|\b(if|said|says|claims?|maybe|might)\b/i.test(declaration) && RELATION.test(declaration)
}
function declaredRelationship(text) {
  if (!relationshipIntent(text)) return null
  const declaration = String(text).replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, '')
  const match = declaration.match(/\bis\s+my\s+(?:(?:closest|close|trusted|best|real|elder|younger)\s+)?(brother|sister|mother|father|dad|mom|friend|colleague)\b/i)
  return match ? match[1].toLowerCase() : null
}
function freshNotifications(store) {
  const settings = store.data.settings
  const notifications = settings.ownerNotifications?.length ? settings.ownerNotifications : [settings.ownerLastNotification].filter(Boolean)
  return [...new Set(notifications.filter(note => note.at <= Date.now() && Date.now() - note.at < FOCUS_TTL_MS)
    .flatMap(note => note.contacts || [note.contact]).filter(id => store.data.contacts[id]))]
}

function sendIntent(text) {
  const original = text
  text = selectorText(text)
  if (!SEND_WORD.test(text)) return false
  const negative = text.match(/\b(don'?t|do not|never|mat|stop|cancel)\s+(?:\w+\s+){0,2}(send|msg|message|tell|reply|forward|inform|bhej)\b|\bnot yet\b/i)
  if (negative && negative.index < text.search(SEND_WORD)) return false
  if (/^\s*(did|have|has|was|were|why|when|who|what|where|anybody|anyone|is|are)\b/i.test(original)) return false
  const first = SEND_WORD.exec(text)
  if (/^\s+(?:to\s+)?(?:me|us)\b/i.test(text.slice(first.index + first[0].length))) return false
  if (/\b(draft|compose|prepare|suggest|hypothetical|suppose|imagine)\b/i.test(text)) return false
  return true
}
function draftIntent(text) {
  return /\b(draft|compose|prepare|suggest)\b|\b(what|how|kya)\b.*\b(reply|respond|bolu)\b/i.test(text)
}
function recentChats(store) {
  return Object.values(store.data.contacts).map(contact => {
    const history = store.history(contact.id)
    const incoming = history.findLast(entry => entry.role === 'user')
    const reply = history.findLast(entry => entry.role === 'assistant')
    const activity = store.data.activities[contact.id]
    return { contact: contact.id, name: contact.name || null, nameSource: contact.nameSource || null,
      confirmed: contact.confirmed, relationship: contact.confirmed ? contact.relationship : null,
      claimedRelationship: contact.claimedRelationship || null, legacy: !!contact.legacy,
      lastIncoming: incoming ? { text: incoming.text.slice(0, 300), at: incoming.at } : null,
      lastClaraReply: reply ? { text: reply.text.slice(0, 300), at: reply.at } : null,
      summary: activity?.summary || null, reportPending: !!activity && activity.revision > activity.reportedRevision ||
        Object.values(store.data.concerns).some(item => item.contactId === contact.id && item.status === 'open' && item.summary !== item.notifiedSummary) }
  }).filter(chat => chat.lastIncoming)
    .sort((a, b) => (Date.parse(b.lastIncoming.at) || 0) - (Date.parse(a.lastIncoming.at) || 0))
}
function matchingNames(store, text, trustedOnly = false) {
  const lower = selectorText(text).toLowerCase()
  return Object.values(store.data.contacts).filter(contact => {
    const names = (trustedOnly ? [contact.names?.owner, contact.names?.saved, contact.confirmed ? contact.name : null]
      : [contact.name, ...Object.values(contact.names || {})]).filter(Boolean)
    return names.some(name => {
      const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(lower)
    })
  })
}
function resolveOwner(store, text, quoteReference = null, { persist = true } = {}) {
  text = selectorText(text)
  const recent = recentChats(store)
  const references = [...(text.match(/\b[CR]\d{4}\b/gi) || [])]
  for (const phone of text.match(/\+?[1-9]\d{6,14}\b/g) || []) references.push(phone)
  if (quoteReference) references.push(quoteReference)
  let ids = [...new Set(references.map(ref => store.getContact(ref)?.id).filter(Boolean))]
  let source = ids.length ? 'explicit_reference' : null
  let trustedForSend = !!ids.length
  if (!ids.length) {
    ids = matchingNames(store, text).map(contact => contact.id)
    if (ids.length) {
      source = 'name'
      const trustedNames = matchingNames(store, text, true)
      trustedForSend = ids.length === 1 && trustedNames.length === 1 && trustedNames[0].id === ids[0]
    }
  }
  const latestQuery = /\b(last|latest|recent|anybody|anyone|who|kisne|kaun)\b/i.test(text) &&
    /\b(msg|message[ds]?|messaged|text(?:ed)?|chat|contact|say|said|asked|bola)\b/i.test(text)
  if ((!ids.length || source === 'name' && ids.length > 1) && latestQuery) {
    const dated = recent.filter(chat => chat.lastIncoming.at && (!ids.length || ids.includes(chat.contact)))
    const latest = dated[0]
    if (latest) ids = dated.filter(chat => chat.lastIncoming.at === latest.lastIncoming.at).map(chat => chat.contact)
    if (ids.length) { source = 'latest_conversation'; trustedForSend = true }
  }
  const focus = store.data.settings.ownerFocus
  if (!ids.length && REFERENTIAL.test(text) && focus && Date.now() - focus.at < FOCUS_TTL_MS) {
    ids = focus.contacts.filter(id => store.data.contacts[id])
    if (ids.length) { source = 'owner_focus'; trustedForSend = focus.trustedForSend !== false }
    const notification = store.data.settings.ownerLastNotification
    const notified = (notification?.contacts || [notification?.contact]).filter(id => store.data.contacts[id])
    if (ids.length && notification && notification.at > focus.at && notified.some(id => !ids.includes(id))) {
      ids = [...new Set([...ids, ...notified])]
      source = 'ambiguous_notification'
      trustedForSend = false
    }
  }
  // A single recent owner-facing notification may anchor a reply when no human selection is active.
  // Multiple notifications or matching names remain ambiguous rather than picking the newest sender.
  if (REFERENTIAL.test(text) || ids.length > 1 && source === 'name') {
    const notified = freshNotifications(store)
    const activeFocus = focus && Date.now() - focus.at < FOCUS_TTL_MS
    const eligible = ids.length && source === 'name' ? notified.filter(id => ids.includes(id)) : notified
    const focusCompatible = !activeFocus || focus.contacts.every(id => eligible.includes(id))
    if ((!ids.length && !activeFocus || source === 'name' && ids.length > 1 && focusCompatible) && eligible.length) {
      ids = eligible
      source = ids.length === 1 ? 'recent_owner_notification' : 'ambiguous_notification'
      trustedForSend = ids.length === 1
    }
  }
  if (!ids.length && /\b(my friend|other guy|other person)\b/i.test(text) && recent.length === 1) {
    ids = [recent[0].contact]; source = 'only_conversation'; trustedForSend = true
  }
  const resolution = { contacts: ids, selectedContact: ids.length === 1 ? ids[0] : null,
    ambiguous: ids.length > 1, source, trustedForSend, recentChats: recent.slice(0, 12) }
  if (persist && ids.length) {
    store.data.settings.ownerFocus = { contacts: ids, at: Date.now(), source, trustedForSend }
    store.save()
  }
  return resolution
}
function availableDraft(store, contactId) {
  const draft = store.data.settings.ownerDraft
  return draft && draft.contact === contactId && Date.now() - draft.at < FOCUS_TTL_MS && !draft.used ? draft : null
}
function meaningful(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/[.!?,\s]+$/g, '')
  return !!normalized && !/^(hi|hii+|hello|hey|hlw|what|okay|ok|thanks?|thank you|bye|hmm*|yes|no|nothing|good night|good morning|leave it|never ?mind|forget it|rehne do|chhodo)$/.test(normalized)
}

module.exports = { resolveOwner, recentChats, matchingNames, sendIntent, draftIntent, availableDraft, meaningful,
  literalPayloads, inlinePayload, relationshipIntent, declaredRelationship, selectorText, FOCUS_TTL_MS }
