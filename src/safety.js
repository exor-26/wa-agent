// Grounding only: general medicine uses, never dosing or personal treatment.
const healthReferences = [
  { ingredient: 'paracetamol (acetaminophen)', use: 'commonly used for pain and high temperature',
    source: 'https://www.nhs.uk/medicines/paracetamol-for-adults/' },
  { ingredient: 'cetirizine', use: 'an antihistamine used for allergy symptoms; can cause sleepiness',
    source: 'https://www.nhs.uk/medicines/cetirizine/about-cetirizine/' }
]
function emergency(text) {
  const t = String(text || '').toLowerCase()
  if (/\b(example|hypothetical|in my code|in a game|write a story)\b/.test(t)) return null
  if (!/\b(can'?t breathe|cannot breathe|not breathing|unconscious|won'?t wake up|severe bleeding|bleeding heavily|overdose|swallowed poison|drank bleach|took too many (pills|tablets)|saans nahi aa|behosh)\b/.test(t)) return null
  return 'Call local emergency services now (112 if you are in India) and get someone nearby to help. Do not wait for Aditya; if poisoning is possible, do not induce vomiting.'
}
function codingTask(text) {
  return /```|\b(write|build|implement|debug|solve|fix|generate|deliver)\b.{0,70}\b(code|python|javascript|typescript|react|algorithm|program|sql query|c\+\+)\b|\b(code|python|javascript|program)\b.{0,45}\b(for me|solution|assignment|error|bug)\b/i.test(text || '')
}
function limitReply(text, owner = false) {
  if (!text) return null
  return String(text).trim().slice(0, owner ? 1600 : 650)
}
module.exports = { healthReferences, emergency, codingTask, limitReply }
