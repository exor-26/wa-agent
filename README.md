# Clara

A personal WhatsApp assistant for handling messages when the account owner cannot fully engage. Clara collects concerns, relays them to the owner's WhatsApp self-chat, and keeps each contact's conversation separate.

Baileys provides the WhatsApp connection and terminal QR pairing. Codex CLI supplies short responses using the existing ChatGPT login, with bounded local processing for supported attachments. No Ollama server or API key is required.

This is a personal, unofficial linked-device integration, not a hosted service or an official WhatsApp bot API. Use it only with an account you control. Review the privacy boundaries below before pairing or granting a contact access.

## Behavior

- New messages wait for the configured owner-response window (14 seconds by default).
- After takeover, Clara handles meaningful follow-ups promptly, collects only essential details and closes naturally. She does not send arbitrary periodic nudges or keep a finished conversation going. A genuinely necessary missing-detail check for an open concern can be scheduled once, independently of a new inbound message.
- Any manual owner message cancels pending generation for that contact and pauses Clara. Each further owner message resets the grace period. When the owner goes quiet, Clara becomes ready again and answers only a still-unresolved contact request, continuing from the shared conversation rather than starting over.
- Takeover state survives reconnects and restarts. Recent unfinished replies get a fresh owner-response window after reconnection; pending messages older than five minutes are not automatically replayed. Attachment files are not retained, so an unfinished attachment may need to be resent after a restart.
- The private schedule informs availability; it does not override the timer or imply live whereabouts.
- Unknown contacts can introduce themselves and explain their concern. Relationship claims are sent to self-chat for owner confirmation.
- Personal information is filtered out before a public contact's context reaches Codex. Owner-approved full-access contacts may receive the owner's supplied facts, including known location with its timestamp.
- Self-chat is both a live private conversation with Clara and an inbox of linked concerns. It has no takeover or schedule delay, and a model slot is reserved so external conversations cannot occupy all capacity. Model generation and network latency still apply. Discussion and drafts do not send replies externally; an explicit instruction and an unambiguous target are required.
- Owner questions such as "Who messaged last?" retrieve the recent conversation and select its contact for follow-ups such as "What did he say?" or "Msg him that I'll reply tomorrow." Selection expires after 15 minutes, survives a restart, and is never changed by another person's incoming message or an automatic notification. Ambiguous references require clarification.
- With no active human-selected thread, one fresh owner-facing notification can anchor "he/him" to that exact conversation. Conflicting notifications remain ambiguous. Duplicate saved names are never merged by name; a single relevant notification can disambiguate them without changing contact identity.
- Compound owner requests are applied step by step: save the supplied fact, confirm an unambiguous directly stated relationship, and send the intended content. A same-message UPI ID or quoted literal does not require an unrelated saved draft. Receipts distinguish saved, sent, queued and rejected steps. A brother declaration alone does not grant all private information; explicitly sending one fact shares only that fact with that recipient.
- Owner-directed messages can initiate any exact known contact or an explicitly provided full phone number, even without prior inbound history. The persistent outbox handles offline and scheduled sends, separate from takeover timers. Scheduled times are checked against the owner's local timezone; relative delays are computed by runtime. Queued scheduled messages expire one hour after their due time; immediate offline requests expire after a day. Unknown/interrupted sends never automatically repeat.
- An automatic missing-detail follow-up is restricted to the same open concern and contact, 5 minutes to 24 hours later, at most once per concern. New incoming details, manual owner intervention, closure, blocking or expiry cancel obsolete follow-ups. `/proactive off` stops these automatic checks; explicit owner-requested messages are separate. Scheduled/previously offline sends report their transport result to self-chat, holding routine notices during sleep mode.
- "Draft a reply to him ..." saves a private draft without sending. "Msg it to this guy" sends that current unused draft to the selected contact. Missing, expired or mismatched drafts are not guessed. Runtime records successful send results; transport acceptance is not proof of delivery or reading.
- Meaningful handled exchanges, including refused private-information requests, produce short self-chat activity reports even when no actionable concern is raised. Reports coalesce for 15 seconds, persist across restarts and retry after failures. Greetings and closing thanks do not produce reports. Recent previously handled messages can be backfilled once after an upgrade; untimestamped legacy histories are not presented as new activity.
- Contact labels use owner-assigned names, available saved WhatsApp names, self-reported names and display names in that order. Name sources remain explicit and none automatically grants personal access. A sender-chosen display name alone cannot authorize a name-only outgoing message. WhatsApp may not supply a saved name for every contact.
- Direct owner status and supported standing instructions persist across chats and restarts. "I'm going to sleep" activates sleep handling immediately: normal questions are still answered, requests to talk get the authorized sleeping status, urgent callers may be told to call, routine activity/concern/identity reports are held, and genuine urgent concerns still report immediately. No calls are placed by Clara. "I'm awake" clears the temporary status and sends grouped held updates. Ordinary self-chat remains live and does not silently clear sleep mode.
- Sleep disclosure is a narrow owner-authorized exception, not permission to share other personal information. `/sleep private` keeps the reason private from public contacts. Private facts stay separate from reply rules. Current explicit status overrides the usual schedule; no wake-up time is invented, and the mode remains active until the owner changes it.
- Clear standing requests such as "Keep replies brief", "Reply in Hindi", "Ask for a deadline for work requests", or an exact conditional notice can be saved by natural conversation. Rules can apply globally, to approved personal contacts, one explicitly identified contact, or self-chat only. Supported behavior is typed; ambiguous or unsupported instructions require clarification instead of a false acknowledgement. Rules cannot approve contacts, grant private access, execute tools or authorize unsolicited outgoing messages. Forwarded, quoted, hypothetical and external content cannot install rules.
- Text, ordinary photos/stickers, voice notes/audio, supported documents, contact cards, location snapshots, poll text and common option replies are supported. Video (including video disguised as a document), view-once media, executable files and arbitrary archives are excluded. Raw attachments are temporary and removed after processing/cancellation; only bounded text excerpts or descriptions remain in the private thread.
- External coding tasks and substantial work are collected for the owner instead of being solved. Everyday help stays brief.
- Medicine help is limited to general uses from the verified references in `src/safety.js`. No prescriptions, doses, pill identification, diagnosis or assurances of safety. Emergencies receive immediate guidance to contact local emergency services rather than waiting for the owner.
- Groups, channels and status broadcasts are ignored.

## Requirements

- Node.js 22.13 or newer (tested on Node 24 in WSL)
- npm
- A working Codex CLI signed in with the owner's ChatGPT account
- WhatsApp on the owner's phone for linked-device pairing

On WSL, Clara prefers the newer Windows desktop Codex executable and reuses its saved login. `CODEX_BIN` can override discovery. The older npm CLI may not support the same models as the desktop app; `npm run doctor` prints the selected executable.

## Setup

```bash
npm ci
cp .env.example .env
mkdir -p data
cp config/profile.example.json data/profile.json
```

Edit `data/profile.json` with the owner's name, approved public links, timezone and private schedule. Schedule intervals use minutes since midnight, with separate weekday and weekend arrays. The example deliberately contains no personal schedule. The configured profile and all runtime state are ignored by Git.

```bash
npm run doctor
npm run check
npm run media:setup
npm start
```

When a QR appears, use **WhatsApp > Linked devices > Link a device** on the phone and scan the terminal QR. An existing linked session reconnects without another scan.

If WhatsApp has logged the session out, stop Clara and run `npm run pair`. This archives the old auth directory inside the project before starting a fresh pairing flow. Auth is never silently deleted.

## Operating From Self-Chat

```text
/help
/status
/contacts
/inbox
/approve C0001 mother all
/whitelist C0001 brother
/whitelist +919999999999 mother
/approve C0002 client public
/revoke C0001
/block C0002
/reply R0001 Please send the requirements document.
/thread C0001
/name C0001 Ravi
/close R0001
/remember I prefer messages instead of calls.
/location Library, second floor
/forget F0001
/forget location
/model sol
/model luna
/sleep
/sleep private
/awake
/busy
/instructions
/uninstruct I0001
/outbox
/canceloutreach T12345678
/sendpending C0001
/cancelpending
/proactive off
/proactive on
```

`all` / `/whitelist` grants access to all owner-provided personal knowledge, including known location. A public approval confirms the relationship without granting personal access. Approval applies to an exact account contact, not to anyone claiming the same name or relationship. No family contacts are preapproved: the owner must identify their actual contacts.
If WhatsApp does not provide a usable name, `/name C0001 Ravi` assigns your own contact label without approving a relationship or changing private access.

Clear natural instructions also work, for example: "Whitelist C0001 as my mother with full personal access" or, while replying to a concern notification, "Tell them I need the file first." Commands provide a deterministic option when a natural instruction is ambiguous. Do not forward an approval message as a substitute for a direct instruction.

For owner status and standing behavior, ordinary self-chat statements are enough:

```text
I'm going to sleep.
I'm awake.
Keep external replies brief and professional.
Reply in Hindi from now on.
Ask for a deadline when someone brings a work request.
If anyone asks about availability, say "Please leave a text message."
/instructions
/uninstruct I0001
```

Clara acknowledges saved rules only after runtime validation. Supported rules persist independently of the short conversation history and never copy the owner's raw private message into external context. Contact-specific rules override global defaults; private-family rules do not reach public contacts. Sleep timing and other personal details remain private unless separately authorized. Use `/sleep private` if the sleeping reason itself should remain private. Waking sends a grouped text summary; temporary photo files are not retained for delayed forwarding.

For an immediate proactive message, say `Message +919999999999 "Please call Aditya."` or use `/reply C0001 Your exact message`. No incoming message or broad family whitelist is required. For later outreach, say `Message C0001 "Please call Aditya." in 10 minutes`. Use `/outbox` to inspect queued/results and `/canceloutreach <task-id>` to cancel a queued task. A retained ambiguous send can be completed with `/sendpending C0001` after selecting the exact contact. Historical failed requests are not silently re-sent after an upgrade.

## Attachment Processing

Defaults: photos 10 MB, documents 10 MB, audio 8 MB and 180 seconds, PDFs 20 pages. Stickers are capped at 2 MB and only their first frame is read. PDF text is extracted locally, and the first three pages are also rendered for visual content such as charts or QR codes. Scanned PDFs rely on these previews; unseen page graphics and truncated text are explicitly marked. DOCX, XLSX, PPTX, TXT, Markdown, CSV, JSON and RTF are read as bounded excerpts, not executed; old binary Office files and unsupported formats require a PDF/text export. Formulas, macros, scripts, links and XML external entities are not run.

Voice uses a local quantized multilingual Whisper-base model through Transformers.js and FFmpeg, not a new cloud transcription account or API key. `npm run media:setup` downloads/caches the roughly 77 MB model files under ignored `data/models/`; recordings are decoded/transcribed locally and the resulting text is passed to Codex. Recognition can be imperfect, especially with noise or mixed languages. Owner voice/file content is conversational data, not automatic authority to send externally or change permissions: give typed confirmation/caption instructions for those actions.

Parsing and transcription run one at a time in a separate, cancellable process with an elapsed-time limit and JavaScript heap cap. Owner text intake stays live while media work runs. Byte limits are checked from both metadata and the actual stream; downloads have their own deadline. Image dimensions, document expansion, page counts and extracted text are bounded. Files and media keys are not saved into the persistent pending-message record. After a restart an unfinished attachment may need to be resent. This is process isolation and bounded parsing, not a claim of an OS security sandbox.

The terminal accepts the same slash commands and `/quit`. External send commands really send messages. Ordinary terminal text is ignored.

## Start, Stop and Check

Run these from `~/wa-agent` in WSL:

```bash
cd ~/wa-agent
npm run live         # start if needed, show current state, then follow NEW events only
npm run live -- --restart # restart, then follow NEW events
npm run status       # process state and fresh WhatsApp connection state
npm run start:bg     # supervised background service; waits for connection or reports actual state
npm run stop
npm run restart      # restart the supervisor and worker; waits for WhatsApp status
tail -n 0 -F data/clara.log # logs only, without starting Clara or replaying old errors
```

`Ctrl+C` in `npm run live` closes the viewer, not the background agent. Use `npm run stop` to stop both the worker and its recovery supervisor. The supervisor restarts workers that crash, fail startup (including a temporary Codex CLI failure), or stop reporting their heartbeat for 90 seconds. Recovery uses capped backoff rather than a rapid restart loop. Concurrent control commands are locked, and stale locks are checked against the actual process command, working directory, boot ID and process start time so WSL PID reuse cannot block startup.

Transient WhatsApp failures recreate the socket with the existing credentials, capped exponential backoff and jitter. A connection deadline handles stalled handshakes, and long host-suspend gaps refresh a potentially half-open socket. Old socket events are detached and cannot revive stale work. Quiet conversations do not trigger reconnects. Network errors include safe native codes such as `ENETUNREACH` or `ETIMEDOUT` when supplied by the underlying error, not raw session data. The installed Baileys protocol default is used; reconnects do not depend on a separate latest-version lookup.

Logout, forbidden/bad-session errors and another-instance conflicts pause automatic retries for manual attention; credentials are never deleted automatically. A session conflict does not mean a new QR is needed: stop the other connection first. Run `npm run stop` before an intentional `npm run pair` reset.

Background mode continues after the terminal closes, while Windows and WSL remain running. It cannot run while the computer is shut down or asleep, and it does not automatically launch WSL after reboot. After powering on, run `npm run live`. No Windows power policy or startup task is installed. Use `npm start` for an unsupervised foreground terminal with the live QR. A status of RUNNING does not mean WhatsApp is paired: look for CONNECTED. `npm run status -- --json` provides machine-readable status, supervisor state and current retry details. Connection reports update at transitions and every 15 seconds; stale reports are marked unknown. A startup command waits up to 45 seconds, then prints the actual state if still recovering. An old `DISCONNECTED` line in `tail -n 50` is history, not current connection status.

Clara treats schedule entries as usual patterns and location entries as timestamped owner updates. It has no GPS connection. Full-access family members receive what is known, not a fabricated live location. `/remember` and explicit factual updates may be shared with full-access contacts; avoid saving credentials or other people's private conversations.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `CLARA_CHAT_JID` | Optional self-chat alias; the linked account identity is also detected | unset |
| `OWNER_TAKEOVER_DELAY_SECONDS` | Owner response window | `14` |
| `AUTH_DIR` | WhatsApp linked-device credentials | `./auth` |
| `CODEX_BIN` | Explicit executable path, otherwise discovered | auto |
| `CODEX_MODEL` | `gpt-6.1-sol` or `gpt-6-luna` | `gpt-6.1-sol` |
| `CODEX_TIMEOUT_SECONDS` | Maximum generation time | `90` |
| `WA_CONNECT_TIMEOUT_SECONDS` | WhatsApp socket connection timeout (plus 10-second handshake watchdog margin) | `30` |
| `WA_RECONNECT_MAX_SECONDS` | Maximum transient socket retry delay | `60` |
| `PROFILE_FILE` | Private owner profile and schedule | `./data/profile.json` |
| `STATE_FILE` | Contacts, permissions, concerns, owner facts and history | `./data/state.json` |
| `CHAT_HISTORY_FILE` | Optional old history file imported once | `./chat-history.json` |
| `HISTORY_MAX_MESSAGES` | Messages retained per conversation | `30` |
| `MAX_PHOTO_MB` | Maximum downloaded photo size | `10` |
| `MAX_DOCUMENT_MB` | Maximum downloaded document size | `10` |
| `MAX_AUDIO_MB` | Maximum audio/voice size | `8` |
| `MAX_AUDIO_SECONDS` | Maximum decoded recording duration | `180` |
| `MAX_DOCUMENT_PAGES` | Maximum PDF pages | `20` |
| `MEDIA_TIMEOUT_SECONDS` | Per-file parsing/transcription deadline | `120` |
| `LOG_MESSAGE_TEXT` | Include private text in terminal logs | `false` |

Both models run at **low** reasoning effort. `/model` persists an override in private state. Each generation is ephemeral; no shared Codex conversation is reused across WhatsApp contacts. Codex receives filtered context and conversation data through stdin and returns validated JSON. Shell, browser, connected apps, plugins and other agent tools are disabled, with a read-only sandbox. At most two generations run concurrently, with at most one external generation; owner requests get queue priority and reserved capacity.

## Checks

```bash
npm run check                 # syntax and isolated tests; no real WhatsApp sends
npm run doctor -- --probe     # real text generation using the saved Codex login
npm run smoke                 # real CLI text + synthetic image checks; no WhatsApp sends
npm run smoke -- --luna       # same checks on Luna
node scripts/conversation-smoke.js # real multi-turn and owner handback checks; no WhatsApp sends
node scripts/routing-smoke.js  # real owner retrieval, pronouns, drafting and sends through mocked transport
node scripts/policy-smoke.js   # real owner instructions, sleep/urgent/wake behavior; mocked transport
node scripts/features-smoke.js # real Bhai save/send, first contact, scheduling and public spoken-audio fixture; mocked WhatsApp
node scripts/features-smoke.js --luna --skip-audio # same routing/outreach checks with Luna
node scripts/media-vision-smoke.js # real multi-image/page-preview handoff to Codex; synthetic images, no WhatsApp sends
npm audit
```

Tests cover takeover cancellation, mid-generation permission changes, context isolation, linked concerns, owner-only actions, phone/LID aliases, duplicate messages, bot echoes and media classification.
Additional checks cover recent-chat retrieval, expiring recipient focus, ambiguous names, negative send instructions, exact draft reuse, reporting retries, name provenance and sensitive-log filtering.
Recovery checks cover stale/PID-reused locks, socket deadlines, suspended-host recovery, stale events, retained auth, capped retries, crash supervision, heartbeat stalls, explicit stop and live-log history isolation. These are isolated tests, not proof of indefinite network availability.

## Layout

```text
index.js                    Terminal entrypoint and shutdown
src/agent.js                Takeover, concerns and owner commands
src/owner-context.js        Owner-only recent-chat retrieval, recipient selection and draft lookup
src/owner-policy.js         Persistent scoped owner rules and explicit status overrides
src/whatsapp.js             Baileys connection, QR, media and message routing
src/codex.js                Saved-login CLI adapter and JSON validation
src/instructions.js         Shared instruction source and output schema
src/store.js                Atomic private state and contact identity mapping
src/config.js               Configuration and timezone-aware schedule
src/safety.js               Narrow health grounding and scope guards
src/logging.js              Console session-data guard and legacy-log sanitization
src/runtime.js              Live worker identity, supervisor and connection status
src/recovery.js             Capped backoff and safe nested network diagnostics
src/supervisor.js           Worker crash/startup/heartbeat recovery
src/outbox.js               Persistent owner/necessary-follow-up outreach, receipts and local-time checks
src/media.js                Media classification, limits and cancellable worker queue
scripts/media-worker.js     Local voice, PDF/Office/text and raster-image processing
config/profile.example.json Sanitized profile template
scripts/                    Diagnostics, checks and pairing reset
test/                       Isolated behavior and transport tests
```

## Privacy and Local Data

`auth/`, archived auth sessions, `.env`, `data/`, and the legacy history file are private. Do not publish them. State writes are atomic and private files use restrictive permissions. Recent outbound IDs prevent bot-generated self-chat notifications from being interpreted as owner instructions. A process lock prevents two Clara instances from using the same session.
Session-key debug dumps from dependencies are filtered before reaching console output. Background startup sanitizes older logs while the process is stopped, retaining safe structured event lines. This is log redaction, not session-key rotation or proof that old disk copies never existed.

Local storage does not mean all inference stays on the device. Filtered conversation text, authorized owner facts, extracted document text and image previews are passed to the configured Codex service. Audio decoding/transcription happens locally; its transcript can then enter that model context. Local chat state is not encrypted by this application. Protect the host, its backups and your linked-device credentials, and avoid using real chat exports in bug reports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local test workflow and safe change boundaries, [SECURITY.md](SECURITY.md) for private reporting and operational limits, and [CHANGELOG.md](CHANGELOG.md) for the migration summary. CI runs isolated checks without WhatsApp pairing or Codex credentials; real-provider smoke checks remain explicit local operations.

Clara is an unofficial personal WhatsApp integration built on [Baileys](https://github.com/WhiskeySockets/Baileys). CLI behavior follows the [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode). Health grounding uses [NHS paracetamol information](https://www.nhs.uk/medicines/paracetamol-for-adults/), [NHS cetirizine information](https://www.nhs.uk/medicines/cetirizine/about-cetirizine/) and [India's emergency response service](https://112.gov.in/).

MIT License. See [LICENSE](LICENSE).
