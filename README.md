# Clara WhatsApp Assistant

Clara is a private WhatsApp assistant built on top of `@whiskeysockets/baileys` and a local Ollama model. It is designed to sit between WhatsApp and a locally hosted LLM, answer low-risk messages directly, and stay out of the way when the owner responds manually.

## Overview

This project connects to WhatsApp Web through Baileys, keeps a small per-chat memory on disk, and uses a Clara-specific prompt to control how replies are generated.

The assistant has two operating modes:

- Owner chat mode: Clara speaks directly with Aditya in a dedicated control chat.
- External chat mode: Clara acts as Aditya's assistant, waits before taking over, and avoids making promises or commitments on his behalf.

## Features

- QR-based WhatsApp Web login using Baileys multi-file auth storage
- Delayed takeover for external chats so manual replies always get priority
- Continued assistant replies after takeover until the owner re-engages
- Local chat history persistence across restarts
- Local Ollama integration with automatic fallback URL discovery inside WSL
- Fast canned replies for common questions such as identity and availability
- Environment-driven configuration for chat IDs, timeouts, paths, and model settings

## How It Works

1. The service boots and loads local chat history from `CHAT_HISTORY_FILE`.
2. Baileys restores the WhatsApp session from `AUTH_DIR` or prints a QR code if the session is not linked.
3. Owner messages in `CLARA_CHAT_JID` go directly to the model as an owner conversation.
4. External messages start a takeover timer defined by `OWNER_TAKEOVER_DELAY_SECONDS`.
5. If the owner replies before the timer expires, Clara stays silent in that chat.
6. If the owner does not reply, Clara answers and takeover mode remains active for that chat until the owner sends a message again.

## Requirements

- Node.js 18+
- npm
- Ollama installed and running locally or otherwise reachable from WSL
- A WhatsApp account available for linking

## Setup

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Build the Clara model:

```bash
ollama pull qwen2.5:3b
ollama create qwen2.5:3b-clara -f Modelfile
```

Start Ollama if it is not already running:

```bash
ollama serve
```

## Configuration

The project reads runtime settings from `.env`. The tracked `.env.example` file is sanitized and intended as the starting template.

| Variable | Purpose | Default |
| --- | --- | --- |
| `CLARA_CHAT_JID` | Dedicated owner chat JID for direct Clara-to-owner conversation | unset |
| `OWNER_TAKEOVER_DELAY_SECONDS` | Seconds to wait before Clara replies in external chats | `14` |
| `AUTH_DIR` | Baileys multi-file auth directory | `./auth` |
| `OLLAMA_MODEL` | Ollama model tag used for generation | `qwen2.5:3b-clara` |
| `OLLAMA_URL` | Preferred Ollama base URL | `http://localhost:11434` |
| `CHAT_HISTORY_FILE` | On-disk history file used across restarts | `./chat-history.json` |
| `HISTORY_MAX_MESSAGES` | Retained messages per chat | `30` |
| `LLM_NUM_CTX` | Ollama context window override | `4096` |

### Finding `CLARA_CHAT_JID`

If you do not know the owner chat JID yet:

1. Start the service.
2. Send a message from the owner chat you want Clara to use.
3. Read the `chatJid` shown in the `MESSAGE_EVENT` or `ME_MESSAGE` log output.
4. Copy that value into `.env` as `CLARA_CHAT_JID`.

## Running

Start the assistant:

```bash
npm start
```

Validate the entrypoint without running the full service:

```bash
npm run check
```

## Runtime Notes

- The service is intended to run inside WSL.
- Ollama discovery prefers `OLLAMA_URL`, then tries common local endpoints, including the host bridge IP exposed to WSL.
- `auth/` and `.env` are intentionally ignored by Git because they may contain sensitive local state.
- `chat-history.json` is local state only and should not be committed.

## Logs

The runtime keeps logs short enough to scan live. The most useful human-facing log labels are:

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

- `index.js`: main runtime and message orchestration
- `Modelfile`: Clara-specific Ollama model definition
- `.env.example`: sanitized configuration template
- `README.md`: setup and operating notes

## Security

- Do not commit `auth/`. It contains WhatsApp session material.
- Do not commit `.env`. It may contain chat identifiers and local endpoints.
- Review Clara's prompt and the canned replies before using this with a real WhatsApp account.

## License

This project is released under the MIT License. See `LICENSE` for details.
