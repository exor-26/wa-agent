const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

require('dotenv').config()

const Pino = require('pino')
const qrcode = require('qrcode-terminal')
const axios = require('axios')
const fs = require('fs')

function envInt(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const CLARA_CHAT_JID = process.env.CLARA_CHAT_JID || ''
const OWNER_TAKEOVER_DELAY = envInt('OWNER_TAKEOVER_DELAY_SECONDS', 14) * 1000
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b-clara'
const CHAT_HISTORY_FILE = process.env.CHAT_HISTORY_FILE || './chat-history.json'
const HISTORY_MAX_MESSAGES = envInt('HISTORY_MAX_MESSAGES', 30)
const LLM_NUM_CTX = envInt('LLM_NUM_CTX', 4096)

const seenIds = new Set()
const sentIds = new Set()
const takeoverTimers = new Map()
const takeoverActiveChats = new Set()
const lastExternalAt = new Map()
const lastExternalText = new Map()
const lastOwnerAt = new Map()
const chatControlVersion = new Map()
const chatQueues = new Map()
const chatHistory = new Map()

let sock = null
let restarting = false
let serviceReady = false
let lastQrValue = null
let bootStartedAt = Date.now()
let activeOllamaUrl = process.env.OLLAMA_URL || null
let historyLoaded = false
let historyFlushTimer = null

function summarizeText(text, maxLength = 120) {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function loadHistoryFromDisk() {
  if (historyLoaded) return
  historyLoaded = true

  try {
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return

    const raw = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'))
    for (const [chatJid, entries] of Object.entries(raw || {})) {
      if (!Array.isArray(entries)) continue

      const normalizedEntries = entries
        .map((entry) => ({
          role: entry?.role,
          text: typeof entry?.text === 'string' ? entry.text.trim() : ''
        }))
        .filter((entry) => entry.text && (entry.role === 'owner' || entry.role === 'user' || entry.role === 'assistant'))
        .slice(-HISTORY_MAX_MESSAGES)

      if (normalizedEntries.length) {
        chatHistory.set(chatJid, normalizedEntries)
      }
    }

    log('CHAT_HISTORY_LOADED', { chats: chatHistory.size })
  } catch (error) {
    logError('CHAT_HISTORY_LOAD_ERROR', error, { file: CHAT_HISTORY_FILE })
  }
}

function flushHistoryToDisk() {
  if (historyFlushTimer) {
    clearTimeout(historyFlushTimer)
    historyFlushTimer = null
  }

  try {
    const payload = {}
    for (const [chatJid, entries] of chatHistory.entries()) {
      payload[chatJid] = entries.slice(-HISTORY_MAX_MESSAGES)
    }
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(payload, null, 2))
  } catch (error) {
    logError('CHAT_HISTORY_SAVE_ERROR', error, { file: CHAT_HISTORY_FILE })
  }
}

function scheduleHistoryFlush() {
  if (historyFlushTimer) clearTimeout(historyFlushTimer)
  historyFlushTimer = setTimeout(flushHistoryToDisk, 250)
}

process.on('SIGINT', () => {
  flushHistoryToDisk()
  process.exit(0)
})

process.on('SIGTERM', () => {
  flushHistoryToDisk()
  process.exit(0)
})

process.on('exit', () => {
  flushHistoryToDisk()
})

function appendHistory(chatJid, role, text) {
  if (!chatJid || !text) return

  const history = chatHistory.get(chatJid) || []
  history.push({ role, text: String(text).trim() })

  if (history.length > HISTORY_MAX_MESSAGES) {
    history.splice(0, history.length - HISTORY_MAX_MESSAGES)
  }

  chatHistory.set(chatJid, history)
  scheduleHistoryFlush()
}

function formatHistory(chatJid, mode) {
  const history = (chatHistory.get(chatJid) || []).slice(-HISTORY_MAX_MESSAGES)

  if (!history.length) return '(no previous messages)'

  return history
    .map((entry) => {
      if (entry.role === 'assistant') return `Clara: ${entry.text}`
      if (entry.role === 'owner' || mode === 'owner') return `Aditya: ${entry.text}`
      return `User: ${entry.text}`
    })
    .join('\n')
}

function log(event, data = {}) {
  if (
    event === 'MESSAGE_SKIPPED_OLD_APPEND' ||
    event === 'MESSAGE_UPSERT' ||
    event === 'MESSAGES_UPDATE' ||
    event === 'MESSAGE_SKIPPED_NO_CONTENT' ||
    event === 'MESSAGE_SKIPPED_NO_TEXT' ||
    event === 'MESSAGE_SKIPPED_BAD_CHAT' ||
    event === 'MESSAGE_SKIPPED_SERVICE_NOT_READY' ||
    event === 'MESSAGE_UPSERT_SKIPPED_TYPE' ||
    event === 'CREDS_UPDATE' ||
    event === 'CREDS_SAVED' ||
    event === 'EVENT_HANDLERS_ATTACHED' ||
    event === 'SOCKET_CREATED' ||
    event === 'CHAT_WORK_START' ||
    event === 'CHAT_WORK_END' ||
    event === 'LLM_REQUEST_START' ||
    event === 'LLM_REQUEST_DONE' ||
    event === 'MESSAGE_RECEIVED' ||
    event === 'OWNER_MESSAGE' ||
    event === 'EXTERNAL_MESSAGE' ||
    event === 'TAKEOVER_TIMER_SET' ||
    event === 'TAKEOVER_TIMER_FIRED' ||
    event === 'TAKEOVER_TIMER_CLEARED' ||
    event === 'TAKEOVER_MODE_ENABLED' ||
    event === 'TAKEOVER_MODE_DISABLED' ||
    event === 'LLM_FLOW_START' ||
    event === 'SEND_SUCCESS'
  ) {
    return
  }
  console.log(`[${new Date().toISOString()}] ${event}`, data)
}

function logError(event, error, data = {}) {
  console.error(`[${new Date().toISOString()}] ${event}`, {
    ...data,
    message: error?.message,
    code: error?.code
  })
}

function logHuman(label, data = {}) {
  if (
    label === 'MESSAGE_UPSERT_EVENT' ||
    label === 'MESSAGES_UPDATE_EVENT'
  ) {
    return
  }
  console.log(`[${new Date().toISOString()}] ${label}`, data)
}

function normalizeJid(jid) {
  if (!jid) return ''
  return String(jid).split('@')[0]
}

function isClaraChatJid(chatJid) {
  return normalizeJid(chatJid) === normalizeJid(CLARA_CHAT_JID)
}

function getOllamaUrls() {
  const urls = []

  if (activeOllamaUrl) urls.push(activeOllamaUrl)
  if (process.env.OLLAMA_URL) urls.push(process.env.OLLAMA_URL)
  urls.push('http://localhost:11434')

  try {
    const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8')
    const nameserver = resolv.match(/^nameserver\s+([^\s]+)$/m)?.[1]
    if (nameserver) {
      urls.push(`http://${nameserver}:11434`)
    }
  } catch {}

  urls.push('http://172.31.32.1:11434')

  return [...new Set(urls.map((url) => url.replace(/\/$/, '')))]
}

function getChatVersion(chatJid) {
  return chatControlVersion.get(chatJid) || 0
}

function bumpChatVersion(chatJid) {
  const nextVersion = getChatVersion(chatJid) + 1
  chatControlVersion.set(chatJid, nextVersion)
  return nextVersion
}

function clearTakeoverTimer(chatJid, reason) {
  const timer = takeoverTimers.get(chatJid)
  if (!timer) return false

  clearTimeout(timer)
  takeoverTimers.delete(chatJid)
  log('TAKEOVER_TIMER_CLEARED', { chatJid, reason })
  return true
}

function setTakeoverActive(chatJid, active, reason) {
  const isActive = takeoverActiveChats.has(chatJid)
  if (active && !isActive) {
    takeoverActiveChats.add(chatJid)
    log('TAKEOVER_MODE_ENABLED', { chatJid, reason })
    return
  }

  if (!active && isActive) {
    takeoverActiveChats.delete(chatJid)
    log('TAKEOVER_MODE_DISABLED', { chatJid, reason })
  }
}

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.ephemeralMessage?.message?.conversation ||
    message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption
  )
}

function buildOwnerPrompt(chatJid) {
  return [
    'Mode: OWNER_CHAT',
    'This mode overrides any unavailable-assistant behavior.',
    'You are Clara.',
    'You are chatting directly with Aditya, the owner.',
    'Aditya is present in this chat.',
    'Do not say Aditya is unavailable.',
    'Do not relay messages to Aditya.',
    'Do not act like a gatekeeper in this chat.',
    'Casual conversation is allowed.',
    'If Aditya asks who he is, answer directly that he is Aditya.',
    'Reply naturally, clearly, and like a capable personal AI companion.',
    '',
    'Examples:',
    'Aditya: Do you know who I am?',
    'Clara: Yes. You are Aditya.',
    'Aditya: Who are you?',
    'Clara: I am Clara.',
    '',
    'Recent conversation:',
    formatHistory(chatJid, 'owner'),
    'Clara:'
  ].join('\n')
}

function buildExternalPrompt(chatJid) {
  return [
    'Mode: EXTERNAL_CHAT',
    'You are Clara, Aditya\'s WhatsApp assistant.',
    'Reply as Clara, not as Aditya.',
    'Act professional, human, calm, and helpful.',
    'Help directly when the query can be answered without Aditya.',
    'If the request needs Aditya personally (meeting, call, approval, payment, decision, availability), do not solve it yourself; acknowledge it and relay it briefly.',
    'Do not reveal private or personal information about Aditya.',
    'Do not make promises, commitments, approvals, timelines, or decisions on Aditya\'s behalf.',
    'Do not claim Aditya will call, meet, visit, approve, pay, or respond by a specific time.',
    'If something needs Aditya personally, acknowledge it and say you will pass it on or that he can review it when available.',
    'Do not suggest alternative contact channels unless the user explicitly asks.',
    'If the user is emotional, urgent, confused, or asking for help, respond appropriately and professionally.',
    'Use 1 to 3 short sentences unless more detail is necessary.',
    'Keep the reply concise and natural.',
    '',
    'Examples:',
    'User: Who are you?',
    'Clara: I\'m Clara. I\'m handling messages for Aditya while he\'s unavailable.',
    'User: I need to meet Aditya urgently.',
    'Clara: Understood. I\'ve noted that this is urgent and will pass it on to Aditya.',
    'User: What is 2 + 2?',
    'Clara: It is 4.',
    '',
    'Recent conversation:',
    formatHistory(chatJid, 'external'),
    'Clara:'
  ].join('\n')
}

async function callLLM(prompt) {
  const urls = getOllamaUrls()
  let lastError = null

  for (const baseUrl of urls) {
    try {
      const res = await axios.post(
        `${baseUrl}/api/generate`,
        {
          model: OLLAMA_MODEL,
          prompt,
          stream: false,
          options: {
            num_ctx: LLM_NUM_CTX,
            temperature: 0.3
          }
        },
        { timeout: 180_000 }
      )

      activeOllamaUrl = baseUrl
      const reply = res.data?.response?.trim()
      logHuman('LLM_CONNECTED', { url: baseUrl, model: OLLAMA_MODEL })
      return reply
    } catch (error) {
      lastError = error
    }
  }

  logHuman('LLM_CONNECTION_FAILED', {
    triedUrls: urls,
    message: lastError?.message
  })
  throw lastError || new Error('LLM connection failed')
}

function enqueueChatWork(chatJid, label, work) {
  const previous = chatQueues.get(chatJid) || Promise.resolve()

  const next = previous
    .catch(() => {})
    .then(async () => {
      log('CHAT_WORK_START', { chatJid, label })
      return work()
    })
    .catch((error) => {
      logError('CHAT_WORK_ERROR', error, { chatJid, label })
      return false
    })
    .finally(() => {
      log('CHAT_WORK_END', { chatJid, label })
      if (chatQueues.get(chatJid) === next) {
        chatQueues.delete(chatJid)
      }
    })

  chatQueues.set(chatJid, next)
  return next
}

async function generateAndSendReply(chatJid, prompt, meta) {
  return enqueueChatWork(chatJid, meta.reason, async () => {
    if (!serviceReady || !sock) {
      log('SEND_ABORT_SERVICE_NOT_READY', { chatJid, meta })
      return false
    }

    if (meta.chatVersion !== undefined && getChatVersion(chatJid) !== meta.chatVersion) {
      log('SEND_ABORT_CHAT_VERSION_CHANGED', {
        chatJid,
        reason: meta.reason,
        expectedVersion: meta.chatVersion,
        currentVersion: getChatVersion(chatJid)
      })
      return false
    }

    if (meta.requireTakeoverActive && !takeoverActiveChats.has(chatJid)) {
      log('SEND_ABORT_TAKEOVER_NOT_ACTIVE', { chatJid, reason: meta.reason })
      return false
    }

    log('LLM_FLOW_START', {
      chatJid,
      reason: meta.reason,
      text: meta.sourceText
    })
    logHuman('LLM_INPUT', {
      chatJid,
      reason: meta.reason,
      sourceText: summarizeText(meta.sourceText),
      historyCount: (chatHistory.get(chatJid) || []).length
    })

    const reply = await callLLM(prompt)
    if (!reply) {
      log('LLM_FLOW_EMPTY_REPLY', { chatJid, reason: meta.reason })
      logHuman('LLM_OUTPUT_EMPTY', { chatJid, reason: meta.reason })
      return false
    }

    if (meta.chatVersion !== undefined && getChatVersion(chatJid) !== meta.chatVersion) {
      log('SEND_ABORT_AFTER_LLM_CHAT_VERSION_CHANGED', {
        chatJid,
        reason: meta.reason,
        expectedVersion: meta.chatVersion,
        currentVersion: getChatVersion(chatJid)
      })
      return false
    }

    if (meta.requireTakeoverActive && !takeoverActiveChats.has(chatJid)) {
      log('SEND_ABORT_AFTER_LLM_TAKEOVER_NOT_ACTIVE', {
        chatJid,
        reason: meta.reason
      })
      return false
    }

    const res = await sock.sendMessage(chatJid, {
      text: reply.slice(0, 1500)
    })

    appendHistory(chatJid, 'assistant', reply)

    if (res?.key?.id) {
      sentIds.add(res.key.id)
      setTimeout(() => sentIds.delete(res.key.id), 60_000)
    }

    log('SEND_SUCCESS', {
      chatJid,
      reason: meta.reason,
      reply
    })
    logHuman('CLARA_REPLY_SENT', {
      chatJid,
      reason: meta.reason,
      reply: summarizeText(reply, 220)
    })
    return true
  })
}

function scheduleTakeover(chatJid) {
  clearTakeoverTimer(chatJid, 'reschedule')

  const sourceText = lastExternalText.get(chatJid)
  const externalAt = lastExternalAt.get(chatJid) || 0
  const ownerVersionAtSchedule = getChatVersion(chatJid)

  if (!sourceText) {
    log('TAKEOVER_NOT_SCHEDULED_NO_TEXT', { chatJid })
    return
  }

  const timer = setTimeout(async () => {
    takeoverTimers.delete(chatJid)

    const lastOwner = lastOwnerAt.get(chatJid) || 0
    const currentOwnerVersion = getChatVersion(chatJid)

    log('TAKEOVER_TIMER_FIRED', {
      chatJid,
      lastOwner,
      externalAt,
      ownerVersionAtSchedule,
      currentOwnerVersion
    })

    if (currentOwnerVersion !== ownerVersionAtSchedule) {
      log('TAKEOVER_ABORT_OWNER_REENGAGED', { chatJid })
      return
    }

    if (lastOwner > externalAt) {
      log('TAKEOVER_ABORT_OWNER_REPLIED', { chatJid, lastOwner, externalAt })
      return
    }

    const latestText = lastExternalText.get(chatJid)
    if (!latestText) {
      log('TAKEOVER_ABORT_NO_LATEST_TEXT', { chatJid })
      return
    }

    log('TAKEOVER_FIRST_REPLY_START', {
      chatJid,
      sourceText: latestText
    })

    const prompt = buildExternalPrompt(chatJid)
    const sent = await generateAndSendReply(chatJid, prompt, {
      reason: 'takeover_first_reply',
      sourceText: latestText,
      chatVersion: ownerVersionAtSchedule
    })

    if (sent) {
      setTakeoverActive(chatJid, true, 'first_reply_sent')
    } else {
      log('TAKEOVER_FIRST_REPLY_FAILED', { chatJid })
    }
  }, OWNER_TAKEOVER_DELAY)

  takeoverTimers.set(chatJid, timer)
  log('TAKEOVER_TIMER_SET', {
    chatJid,
    delayMs: OWNER_TAKEOVER_DELAY,
    sourceText
  })
  logHuman('USER_WAITING_FOR_OWNER', {
    chatJid,
    delaySeconds: OWNER_TAKEOVER_DELAY / 1000,
    text: summarizeText(sourceText)
  })
}

function shouldSkipOldAppend(msg, upsertType) {
  if (upsertType !== 'append') return false

  const timestampMs = Number(msg?.messageTimestamp || 0) * 1000
  if (!timestampMs) return false

  const isOld = timestampMs < bootStartedAt - 15_000
  if (isOld) {
    log('MESSAGE_SKIPPED_OLD_APPEND', {
      chatJid: msg.key?.remoteJid,
      timestampMs
    })
  }

  return isOld
}

async function handleOwnerMessage(chatJid, text, isClaraChat) {
  lastOwnerAt.set(chatJid, Date.now())
  const newVersion = bumpChatVersion(chatJid)

  clearTakeoverTimer(chatJid, 'owner_message')
  setTakeoverActive(chatJid, false, 'owner_message')
  appendHistory(chatJid, 'owner', text)

  log('OWNER_MESSAGE', {
    chatJid,
    isClaraChat,
    text,
    newVersion
  })
  logHuman('ME_MESSAGE', {
    chatJid,
    text: summarizeText(text),
    claraChatExpected: CLARA_CHAT_JID,
    claraChatMatched: isClaraChat
  })

  if (!isClaraChat) {
    log('OWNER_MESSAGE_MANUAL_CHAT_ONLY', {
      chatJid,
      expectedClaraChatJid: CLARA_CHAT_JID,
      actualNormalized: normalizeJid(chatJid),
      expectedNormalized: normalizeJid(CLARA_CHAT_JID)
    })
    logHuman('ME_MESSAGE_BLOCKED', {
      actualChatJid: chatJid,
      expectedClaraChatJid: CLARA_CHAT_JID
    })
    return
  }

  logHuman('ME_MESSAGE_TO_LLM', {
    chatJid,
    text: summarizeText(text)
  })
  const prompt = buildOwnerPrompt(chatJid)
  await generateAndSendReply(chatJid, prompt, {
    reason: 'owner_direct_reply',
    sourceText: text
  })
}

async function handleExternalMessage(chatJid, text) {
  const now = Date.now()
  lastExternalAt.set(chatJid, now)
  lastExternalText.set(chatJid, text)
  appendHistory(chatJid, 'user', text)

  const takeoverActive = takeoverActiveChats.has(chatJid)

  log('EXTERNAL_MESSAGE', {
    chatJid,
    text,
    takeoverActive
  })
  logHuman('USER_MESSAGE', {
    chatJid,
    text: summarizeText(text),
    takeoverActive
  })

  if (takeoverActive) {
    const chatVersion = getChatVersion(chatJid)
    const prompt = buildExternalPrompt(chatJid)

    await generateAndSendReply(chatJid, prompt, {
      reason: 'takeover_live_reply',
      sourceText: text,
      chatVersion,
      requireTakeoverActive: true
    })
    return
  }

  scheduleTakeover(chatJid)
}

async function handleMessage(msg, upsertType) {
  if (!msg?.message) {
    if (upsertType !== 'append') {
      log('MESSAGE_SKIPPED_NO_CONTENT', { upsertType })
    }
    return
  }

  if (shouldSkipOldAppend(msg, upsertType)) return

  const id = msg.key?.id
  if (!id) {
    log('MESSAGE_SKIPPED_NO_ID', {})
    return
  }

  if (seenIds.has(id)) {
    log('MESSAGE_SKIPPED_SEEN', { id })
    return
  }
  seenIds.add(id)
  setTimeout(() => seenIds.delete(id), 60_000)

  const chatJid = msg.key?.remoteJid
  if (!chatJid || chatJid === 'status@broadcast') {
    log('MESSAGE_SKIPPED_BAD_CHAT', { chatJid })
    return
  }

  if (msg.key?.fromMe && sentIds.has(id)) {
    log('MESSAGE_SKIPPED_BOT_ECHO', { chatJid, id })
    return
  }

  if (!serviceReady) {
    log('MESSAGE_SKIPPED_SERVICE_NOT_READY', { chatJid, upsertType })
    return
  }

  const text = extractText(msg.message)
  if (!text) {
    if (upsertType !== 'append') {
      log('MESSAGE_SKIPPED_NO_TEXT', { chatJid })
    }
    return
  }

  const isOwnerMsg = msg.key.fromMe === true
  const isClaraChat = isClaraChatJid(chatJid)

  log('MESSAGE_RECEIVED', {
    chatJid,
    id,
    upsertType,
    fromMe: msg.key.fromMe,
    isOwnerMsg,
    isClaraChat,
    expectedClaraChatJid: CLARA_CHAT_JID,
    participant: msg.key?.participant,
    participantAlt: msg.key?.participantAlt,
    text
  })
  logHuman('MESSAGE_EVENT', {
    direction: isOwnerMsg ? 'ME_TO_CHAT' : 'USER_TO_CHAT',
    chatJid,
    expectedClaraChatJid: CLARA_CHAT_JID,
    upsertType,
    text: summarizeText(text)
  })

  if (isOwnerMsg) {
    await handleOwnerMessage(chatJid, text, isClaraChat)
    return
  }

  await handleExternalMessage(chatJid, text)
}

async function startBot() {
  if (restarting) {
    log('START_SKIPPED_ALREADY_RESTARTING')
    return
  }

  restarting = true
  serviceReady = false
  lastQrValue = null
  bootStartedAt = Date.now()
  loadHistoryFromDisk()

  log('BOOT_START', { authDir: AUTH_DIR })

  if (!CLARA_CHAT_JID) {
    log('CONFIG_WARNING', {
      message: 'CLARA_CHAT_JID is not set. Owner direct chat mode will stay disabled until it is configured.'
    })
  }

  try {
    if (sock) {
      log('SOCKET_CLOSE_PREVIOUS')
      try { sock.ws?.close() } catch (error) {
        logError('SOCKET_CLOSE_PREVIOUS_ERROR', error)
      }
      sock = null
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const isRegistered = !!state?.creds?.registered

    log('AUTH_STATE', {
      registered: isRegistered
    })

    const waVersionInfo = await fetchLatestBaileysVersion().catch((error) => ({
      version: undefined,
      isLatest: false,
      error
    }))

    log('WA_VERSION', {
      version: waVersionInfo.version,
      isLatest: waVersionInfo.isLatest,
      error: waVersionInfo.error?.message || null
    })

    const socketConfig = {
      auth: state,
      logger: Pino({ level: 'silent' }),
      browser: ['Chrome', 'Linux', '120.0.0'],
      syncFullHistory: false,
      emitOwnEvents: true
    }

    if (waVersionInfo.version) {
      socketConfig.version = waVersionInfo.version
    }

    sock = makeWASocket(socketConfig)

    log('SOCKET_CREATED', {
      syncFullHistory: false,
      version: waVersionInfo.version || 'default',
      emitOwnEvents: true
    })

    sock.ev.on('creds.update', async () => {
      log('CREDS_UPDATE')
      try {
        await saveCreds()
        log('CREDS_SAVED')
      } catch (error) {
        logError('CREDS_SAVE_ERROR', error)
      }
    })

    sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
      const code =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode
      const message = lastDisconnect?.error?.message

      if (!connection && !qr && !code && !message) {
        return
      }

      log('CONNECTION_UPDATE', {
        connection,
        qr: !!qr,
        code,
        message
      })

      if (qr && qr !== lastQrValue) {
        lastQrValue = qr
        log('QR_READY')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        serviceReady = true
        restarting = false
        log('SERVICE_READY', {
          waitingForMessages: true
        })
      }

      if (connection === 'close') {
        serviceReady = false

        if (code === DisconnectReason.loggedOut || code === 401) {
          log('AUTH_CLEARED_LOGGED_OUT')
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch (error) {
            logError('AUTH_CLEAR_ERROR', error)
          }
        }

        restarting = false
        log('SERVICE_RESTART_SCHEDULED', {
          delayMs: 2000,
          code,
          message
        })
        setTimeout(startBot, 2000)
      }
    })

    sock.ev.on('messages.upsert', async (upsert) => {
      log('MESSAGE_UPSERT', {
        type: upsert?.type,
        count: upsert?.messages?.length || 0
      })
      logHuman('MESSAGE_UPSERT_EVENT', {
        type: upsert?.type,
        count: upsert?.messages?.length || 0
      })

      if (!upsert || (upsert.type !== 'notify' && upsert.type !== 'append')) {
        log('MESSAGE_UPSERT_SKIPPED_TYPE', {
          type: upsert?.type
        })
        return
      }

      for (const msg of upsert.messages || []) {
        try {
          await handleMessage(msg, upsert.type)
        } catch (error) {
          logError('MESSAGE_HANDLER_ERROR', error, {
            chatJid: msg?.key?.remoteJid,
            messageId: msg?.key?.id
          })
        }
      }
    })

    sock.ev.on('messages.update', (updates) => {
      log('MESSAGES_UPDATE', { count: updates?.length || 0 })
      logHuman('MESSAGES_UPDATE_EVENT', { count: updates?.length || 0 })
    })

    log('EVENT_HANDLERS_ATTACHED')
  } catch (error) {
    restarting = false
    logError('BOOT_FATAL', error)
    setTimeout(startBot, 3000)
  }
}

startBot()
