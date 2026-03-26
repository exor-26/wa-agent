# Clara WhatsApp Assistant

WhatsApp assistant automation built with `@whiskeysockets/baileys` and a local Ollama model.

## What It Does

- Connects to WhatsApp Web through Baileys.
- Replies to the owner chat immediately.
- Waits before replying to other chats, so manual owner replies take priority.
- Keeps per-chat conversation history, including across restarts.
- Uses a local Ollama model with a Clara-specific `Modelfile`.

## Conversation Rules

- Owner chat:
  - Clara speaks directly with Aditya.
  - Casual conversation is allowed.
  - Clara should not act like a relay assistant in this chat.
- External chats:
  - Clara speaks as Aditya's assistant.
  - Clara can answer general questions directly when Aditya is not needed.
  - Clara must not reveal private information or make promises on Aditya's behalf.
  - If Aditya personally needs to decide, approve, meet, or respond, Clara relays the request without committing him.

## Runtime Flow

1. Start the bot.
2. If auth already exists, Baileys connects directly.
3. If auth does not exist, the terminal prints a QR code.
4. After WhatsApp connects, the bot starts handling messages.
5. Owner messages in `CLARA_CHAT_JID` go straight to the LLM.
6. Other chats wait `OWNER_TAKEOVER_DELAY_SECONDS`.
7. If the owner replies first, Clara stays silent in that chat.
8. If Clara takes over once, she continues replying in that chat until the owner re-engages.

## Requirements

- Node.js 18 or newer
- npm
- Ollama installed locally
- WhatsApp account available for linking

## Installation

```bash
npm install
```

## Ollama Setup

1. Pull the base model:

```bash
ollama pull qwen2.5:3b
```

2. Build the Clara model from the included `Modelfile`:

```bash
ollama create qwen2.5:3b-clara -f Modelfile
```

3. Start Ollama:

```bash
ollama serve
```

## Configuration

The bot reads configuration from `.env`.

Included files:

- `.env.example`: sanitized template for new environments
- `.env`: local machine settings, ignored by git

Current environment keys:

- `CLARA_CHAT_JID`: owner chat JID used for direct owner-to-Clara conversation
- `OWNER_TAKEOVER_DELAY_SECONDS`: wait time before Clara replies to external chats
- `AUTH_DIR`: Baileys auth storage path
- `OLLAMA_MODEL`: Ollama model tag
- `OLLAMA_URL`: Ollama HTTP endpoint
- `CHAT_HISTORY_FILE`: persisted per-chat history file
- `HISTORY_MAX_MESSAGES`: retained messages per chat
- `LLM_NUM_CTX`: Ollama context window for generation

## Running

```bash
npm start
```

Useful command:

```bash
npm run check
```

## Finding `CLARA_CHAT_JID`

If you do not know the owner chat JID yet:

1. Run the bot.
2. Send a message from the owner chat.
3. Read the `chatJid` shown in the `MESSAGE_EVENT` or `ME_MESSAGE` log.
4. Set that value in `.env`.

## Logs

The runtime keeps logs intentionally short. The most useful lines are:

- `CONNECTION_UPDATE`
- `SERVICE_READY`
- `MESSAGE_EVENT`
- `ME_MESSAGE`
- `USER_MESSAGE`
- `USER_WAITING_FOR_OWNER`
- `LLM_INPUT`
- `LLM_CONNECTED`
- `CLARA_REPLY_SENT`
- `LLM_CONNECTION_FAILED`

## Repository Layout

- `index.js`: main WhatsApp bot runtime
- `Modelfile`: Clara-specific Ollama model definition
- `.env.example`: configuration template
- `README.md`: project setup and operating notes

## Data and Security Notes

- `auth/` is local-only and must never be committed.
- `chat-history.json` stores per-chat memory locally and is ignored by git.
- `.env` is local-only and may contain sensitive identifiers.

## Dependencies

Core packages:

- `@whiskeysockets/baileys`
- `axios`
- `dotenv`
- `pino`
- `qrcode-terminal`
