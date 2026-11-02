# Changelog

## Unreleased

### Codex Migration

- Replace the local Ollama runtime and Modelfile with a saved-login Codex CLI adapter and runtime-selectable Sol/Luna models at low reasoning effort.
- Split the single-file agent into transport, policy, storage, provider, recovery and media modules.
- Add sanitized profile/environment templates and isolated regression tests.

### Conversations and Owner Control

- Persist takeover state and stop pending work when the owner intervenes.
- Make self-chat an immediate private control channel with linked concerns, recent-thread retrieval and expiring recipient selection.
- Add scoped standing instructions, sleep/wake handling, explicit contact approval and recipient-specific fact sharing.
- Validate compound save/confirm/send requests and retain ambiguous sends for exact recipient clarification.

### Outreach, Media and Recovery

- Add a persistent outbox for explicit immediate/offline/scheduled messages and bounded missing-detail follow-ups. Do not automatically replay unknown send outcomes.
- Add bounded local voice transcription, document extraction, image normalization and structured WhatsApp item handling. Exclude video, view-once media and unsafe file types.
- Add supervised background operation, socket deadlines, capped reconnect backoff, heartbeat recovery, live status and log redaction.

### Upgrading an Existing Checkout

Stop the agent before replacing dependencies, run `npm ci`, and compare `.env.example` with your private configuration without overwriting credentials. Create the private profile from `config/profile.example.json` if it is missing, run `npm run check` and `npm run doctor`, and run `npm run media:setup` to prepare voice support. Start with `npm run live` and verify that WhatsApp reports `CONNECTED`.

Existing auth and private state remain outside Git. Failed historical send requests are not automatically replayed. Background mode does not start Windows/WSL after shutdown or prevent host sleep. See the README for pairing and recovery commands.
