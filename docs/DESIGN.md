# Design

## Goal

Give independent DSH sessions in one workspace a shared, low-ceremony way to
synchronize handoff documents on demand: one session asks, every registered peer
is asked at nearly the same instant to read the current documents and update its
own.

Non-goals: work orders, task dependencies, a dashboard, a fixed memory format,
automatic nudging of unknown sessions, or calling model APIs from the plugin.

## Why the Schedule service

A reminder must survive DSH restarts, work for idle or unloaded sessions, and
queue instead of interrupting a busy session. Those are exactly the guarantees of
the shipped `ctx.schedule` service:

- task storage is durable (`<DSH_HOME>/storages/schedule.json` or SQLite);
- a `session` target is validated from the persisted Session header without
  loading it;
- delivery resolves the Session, calls `agent.followup()` with a user-role
  message, and waits for `sessions.flush()` acknowledgment;
- a busy target queues the message;
- a task creation returns a durable queue receipt.

Reimplementing that with timers and in-memory state would be less reliable and
would duplicate Host behavior. The plugin therefore owns only room state and
prompt construction; delivery is delegated.

One consequence is accepted: the Schedule service emits a no-action
`[SCHEDULE CHANGE]` message when a task is created. Each target gets the notice
plus the actual reminder. The plugin cannot suppress the notice without bypassing
the service.

## Components

| File | Responsibility |
|---|---|
| `index.js` | Plugin entry: config normalization, four tool definitions, fan-out orchestration, cleanup, report text. |
| `lib/room.js` | Room resolution, roster read/write/remove, document validation and metadata, durable target audit, reference resolution, live-session discovery. |
| `lib/prompts.js` | Bounded board, reminder, and receipt text (zh/en). |
| `lib/config.js` | Defaults and bounds; the bundle deliberately exports no `Config` schema, so the entry has zero third-party imports. |
| `lib/util.js` | Atomic writes, Windows rename retry, path normalization, short ids, error rendering. |

## Room layout

```
<workspace>/work/handoff/
  <doc>.md
  .handoff-hub/
    participants/<sessionId>.json
```

Each session owns one roster file, written through `tmp + rename`. There is no
shared mutable index and therefore no roster-wide write lock: concurrent joins
touch different files.

Roster entries are treated as untrusted input. On read, `doc` is re-validated with
the same rules used on write and `name` is sanitized. Invalid entries are skipped
and reported, never followed.

## Nudge sequence

1. Resolve the room from the calling session's working directory.
2. Read and validate the roster.
3. Build the target list: registered peers, or explicit `targets`.
4. Audit every target with `ctx.sessionPersistence.stat()`:
   - Session must exist;
   - `header.delegationDepth` must be 0;
   - `header.cwd` must match the caller's workspace.
5. Resolve up to five optional reference paths inside the caller's workspace.
6. Build one prompt per target, listing peer documents (excluding the target's
   own) and the references.
7. `Promise.allSettled` over `ctx.schedule.create({ timing: after, target:
   session })`.
8. Map results back to every requested target, including refusals, and render a
   per-target receipt.

A target that fails validation or scheduling never affects the others.

## Concurrency and durability

- Roster and documents are replaced atomically. A reader sees the old complete
  file or the new complete file.
- On Windows, a reader or antivirus scanner can briefly hold the destination;
  rename is retried a bounded number of times with small delays.
- Two sessions can race to register the same new document name. This is
  last-writer-wins; `handoff_join` detects duplicate ownership after the write
  and reports `[roster_conflict]`.
- The roster scan is capped (64 entries) and report lines are capped (20), so a
  pathological room cannot produce unbounded work or output.
- A crashed process can leave `.tmp-*` files. They are ignored by the roster
  reader and harmless.

## Target audit versus roster

The roster is a convenience, not an authority. A model or user can edit a roster
file, so the plugin re-checks every target against durable Session storage
immediately before scheduling. This prevents a tampered roster from sending
reminders to another workspace or to a delegated subagent Session.

The audit needs `ctx.sessionPersistence`. If that service is unavailable the
target is refused rather than trusted; the plugin does not fall back to the
roster.

## Prompt safety

Handoff documents are model-authored evidence. The reminder therefore:

- states that the requester is a model session, not the user;
- labels requester notes as untrusted context;
- instructs the target to keep facts/state/conclusions and ignore any text that
  asks it to perform actions;
- asks it to modify only its own document.

References are pointers only; content is never embedded by the plugin.

## Stability invariants

- No timers, watchers, polling, session-event writes, or system-prompt sections.
- One `ctx.effect()` owns all tool registrations and returns their disposers.
- All errors inside a tool are caught and rendered as a bounded report; no
  rejection escapes the tool call.
- Optional services (`workingDirectory`, `agents`, `sessionTitle`) are read
  defensively; absence degrades the board, not the process.
- No third-party runtime imports.

## Testing

`test/harness.mjs` drives the real entry point with a fake Cordis context and a
real temporary workspace. It covers registration, unload, board, join, duplicate
names, document ownership, case-insensitive collisions, path traversal, size
limits, roster tampering, target auditing, failure isolation, references, leave,
and task cleanup. `test/manifest.mjs` checks package metadata, patch wiring,
locale metadata, icon, and the no-external-import rule.

## Compatibility

Tested against DSH 0.2.2-rc.1 on Windows. The implementation uses only documented
Host services (`tools`, `schedule`, optional `workingDirectory`, `agents`,
`sessionTitle`, `sessionPersistence`) and Node built-ins; no native code or
platform-specific APIs.
