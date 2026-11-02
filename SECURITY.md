# Security

## Reporting a Vulnerability

Do not disclose private chat data, session keys or exploitable details in a public issue. Use [GitHub private vulnerability reporting](https://github.com/exor-26/wa-agent/security/advisories/new) if the repository has it enabled. If that option is unavailable, open a minimal issue asking for a private reporting channel, without sensitive details.

Include the affected commit, a synthetic reproduction and the expected boundary. Redact all personal identifiers and credentials. There is no guaranteed response time or security support SLA.

## Sensitive Data

These paths must remain private:

- `.env` and any non-example environment files.
- `auth/` and archived `auth.backup-*/` linked-device sessions.
- `data/`, including profiles, contact permissions, conversations, pending outreach, logs and cached models.
- `chat-history.json`, process locks, temporary attachments and raw debug output.

The application does not encrypt local state. Ignore rules prevent normal Git additions, not deliberate force-adds, filesystem access or backup exposure. Review the staged file list before publishing.

If a linked-device session is exposed, stop the agent and revoke the affected device from WhatsApp. Treat any other exposed account tokens separately. Removing a file in a later commit does not remove it from Git history.

## Trust Boundaries

- Only direct owner instructions can authorize contact approval, scoped sharing or owner-directed outreach. Display names, relationship claims and attachment content are not authorization.
- Full personal access intentionally permits access to owner-provided facts, including known location. Grant it only to an exact, owner-confirmed contact.
- Public contacts receive filtered context. A specifically shared fact is scoped to its recipient and is not a broad permission grant.
- Codex receives authorized conversation context and supported image inputs. Local audio transcription does not make the resulting model interaction fully offline.
- File processing has byte, expansion, page and time limits. It runs in a separate process, not a hardened OS sandbox; keep dependencies current and do not expose this as an unrestricted public file-processing service.
- Send acceptance is not proof of delivery or reading. Unknown send outcomes require review rather than automatic replay.

This is an unofficial personal integration. Host availability, network health, account restrictions and upstream protocol changes can interrupt service. Do not rely on Clara for emergency response or guaranteed message delivery.
