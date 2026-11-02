# Contributing

Clara is a personal WhatsApp assistant. Changes must preserve owner control, contact isolation and truthful send receipts, not just produce plausible model replies.

## Local Checks

Use Node.js 22.13 or newer on Linux or WSL:

```bash
npm ci
npm run check
npm audit --omit=dev
git diff --check
```

The isolated tests use temporary state and mocked transports. They do not require a WhatsApp session, Codex login, private profile or Whisper model download. CI runs these checks on Node.js 22 and 24.

`npm run doctor -- --probe`, `npm run smoke` and the other smoke scripts documented in the README use a real Codex login and may consume account usage. The audio feature smoke also downloads a public fixture and the local speech model if necessary. Their WhatsApp sends are mocked. Do not put account credentials in CI or run a paired agent as part of tests.

## Change Boundaries

- Keep personal profiles, contact identities, chat history, model caches, credentials and logs out of Git. Use synthetic fixtures and temporary directories.
- Treat model output and attachment content as untrusted data. Permission changes and outgoing messages must pass runtime authorization.
- Keep external context scoped to one contact. Sharing one fact must not grant access to all owner knowledge.
- Preserve cancellation when the owner intervenes, queue durability, and the distinction between transport acceptance and delivery.
- Never automatically retry a send with an unknown outcome. Test recovery and notification retries without duplicating an external send.
- Do not weaken media limits or execute document content, formulas, macros or links. Process isolation is not an OS sandbox.
- Update the README and example configuration when commands, defaults or supported formats change.

## Pull Requests

Describe the problem, behavioral change and checks run. Include a regression test for routing, permission, takeover, recovery or media changes. State whether evidence comes from isolated tests, a real-provider smoke check or a live WhatsApp session; these are different acceptance gates.

Do not include real conversations, phone numbers, payment identifiers, QR codes, raw session errors or private profile data in screenshots, commits or public issues. Report sensitive defects as described in [SECURITY.md](SECURITY.md).
