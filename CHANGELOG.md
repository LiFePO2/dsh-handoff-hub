# Changelog

## 1.2.4 — 2026-11-19

- **`handoff_dispatch`**: Router → Worker task assignment over the Schedule
  service. The task and acceptance text sit in a non-authoritative
  `<<<DISPATCH_DATA … DISPATCH_DATA>>>` block that cannot override a Worker's
  charter; the reminder title uses a dedicated `[handoff-dispatch]` marker so
  dispatch tasks are never merged with sync reminders or swept by the ended-task
  cleanup. Task/acceptance lengths are bounded, control characters and
  self-targets are rejected, the Schedule call carries a 15 s abort signal, and a
  missing task id reports `dispatched: false` instead of a false success.
- **`handoff_purge_stale`**: deletes queued handoff/dispatch tasks whose target
  can no longer receive them — missing, archived, cross-workspace, or present but
  failing to resume (for example a preset that cannot be restored). `dryRun`
  previews per-task reasons; `sessionIds` purges explicit dead targets; the
  caller and every current roster member are always protected.
- Hardening: shared schedule-marker helpers, per-target failure isolation, and
  the inline `[unknown_target]`/`[invalid_reference]` paths kept intact.
- Test suite grows to 70 integration cases plus static manifest checks.


## 1.1.0 — 2026-11-11

- **Session group panel**: a sidebar entry and full management page for the
  current workspace (members, documents, live status, nudge one/all, remove,
  invite, auto-reminder switch). Browser half registers Slot components; Host
  routes are loopback-only and writes require `x-handoff-hub: 1`.
- **Targeted directory-change reminders**: skip the changed document's author and
  only nudge registered peers whose own document is older than (or missing
  relative to) the change.
- **Automatic merge**: `autoRemind.mergeSeconds` (default 60s) merges short bursts
  into one reminder instead of sending a message per change.
- 45 integration cases plus static manifest checks.

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
