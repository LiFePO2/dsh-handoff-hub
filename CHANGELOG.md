# Changelog

## 1.0.0 — 2026-11-10

First public release.

- `handoff_board`: index the workspace handoff room, registered peers, document paths/sizes/timestamps, and live unregistered sessions with titles.
- `handoff_join`: register this session and atomically write its handoff document; validates duplicate names, document ownership, path traversal, size, and Windows reserved names.
- `handoff_nudge`: create one durable one-shot Schedule task per target so every peer is asked, near-simultaneously, to read the peer documents and update its own; explicit targets are re-verified against durable Session storage (existence, workspace, non-delegated); queue receipts returned per target.
- `handoff_leave`: remove only this session's roster entry; the handoff document is never deleted.
- `references`: up to 5 workspace-local `.md`/`.markdown`/`.txt` pointers included in every reminder (useful for sharing a usage guide).
- Prompt-injection boundary: reminder text marks documents as evidence, not instructions, and labels requester notes as untrusted.
- Stability: no timers, watchers, session-event writes, or prompt sections; effect-scoped tool registration; per-target failure isolation; atomic writes with Windows rename retry; bounded inputs and outputs; zero third-party runtime dependencies.
- Offline test suite: 39 integration cases plus static manifest checks.
- Release review hardening: fail-closed target workspace audit, strict Session-id
  validation, duplicate roster identity/name rejection, atomic room lock for
  join/leave, and bounded awaits around persistence and Schedule calls.
- Added `CREDITS.md` with explicit implementation and review model attribution.
