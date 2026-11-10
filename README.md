# Handoff Hub

[![test](https://github.com/LiFePO2/dsh-handoff-hub/actions/workflows/test.yml/badge.svg)](https://github.com/LiFePO2/dsh-handoff-hub/actions/workflows/test.yml)

**Simultaneous handoff-document sync for independent DeepSeek Harness sessions.**

> Unofficial community plugin. Not affiliated with or endorsed by DeepSeek.

## Project attribution

- **Code work / implementation:** `deepseek-v4.1-flash` (DeepSeek Harness lead
  agent, opencode provider route), 2026-11-10.
- **Initial stability review:** `deepseek-v4.1-flash` (a separate same-model
  subagent with a fresh context).
- **Independent release review:** `gpt-6.1-sol` through the Codex subagent
  (`subagent_codex`, reasoning effort `ultra`).
- **Product direction, environment and acceptance:** the repository owner.

Model names identify the tooling used for this release. A review is advisory and
does not imply endorsement by any model provider. See [CREDITS.md](CREDITS.md).

When several model sessions work in one workspace, each tends to write a handoff
document — and then nobody reads the others' latest version. Handoff Hub gives
those sessions a tiny shared room and a single durable operation that asks every
peer, at the same time, to read the current handoff documents and update its own.

It is deliberately **not** a workflow engine, task tracker, dashboard, or memory
system. It coordinates the handoff files you already keep, in whatever format
you already use.

## What it does

- `handoff_board` — index the workspace handoff room: registered peers, each
  document's absolute path, size and timestamp, plus live unregistered sessions
  with titles.
- `handoff_join` — register this session under a display name and atomically
  write (or point at) its handoff document.
- `handoff_nudge` — create **one durable one-shot Schedule task per target** so
  every peer receives a user message asking it to read the peer documents,
  update its own, and re-register. Optional extra reference documents (for
  example a usage guide) are listed for every target.
- `handoff_leave` — remove only this session's roster entry. The handoff
  document is never deleted.

The plugin never calls a model API. It enqueues an ordinary user-role message
through DSH's shipped [`ctx.schedule`](https://github.com/deepseek-ai/deepseek-harness)
service; each target session then handles that message with its own model.

## Install

Requirements: DeepSeek Harness `>= 0.2.2-rc.1`, Node.js 22.19+ or 24+, and a
workspace containing the sessions to coordinate.

```bash
git clone https://github.com/LiFePO2/dsh-handoff-hub.git
```

Then install the local package as a DSH
bundle. Ask your DSH agent to run:

```text
plugin_manager install_bundle target=<absolute path to the cloned directory>
```

If the path contains spaces, quote it, for example
`target="D:\plugins\dsh-handoff-hub"`.

`plugin_manager` needs full-access approval. The bundle inserts one row named
`handoff-hub`; its four tools appear for every agent after the row activates.
No restart is normally required for a new bundle, but a linked-package update is
only picked up after the row is reloaded or DSH restarts.

The package is not on npm yet; a local directory install is the supported path.

> **Profile package-manager warning.** Installing any DSH bundle runs the
> profile's package manager. If you have manually patched packages under the
> profile's `node_modules` (for example a custom `@openai/codex` payload), back
> them up or pin them first. This plugin has no dependencies and does not touch
> them itself.

## Quick start

In each collaborating session (once):

```text
handoff_join
  name: "codex"
  doc: "2026-11-10-codex.md"
  content: "# Handoff: codex\n\n## Current state\n...\n"
```

Then, from any session:

```text
handoff_board                      # who is here, and where their documents are
handoff_nudge                      # ask every registered peer to sync now
```

Nudge one explicit session (no registration required, still workspace-audited):

```text
handoff_nudge
  targets: ["session-..."]
  note: "Please read the usage guide before continuing."
```

Share an extra document with every target:

```text
handoff_nudge
  references: ["work/handoff-hub/plugin/README.md"]
```

When a session is done:

```text
handoff_leave
```

## Delivery semantics

`handoff_nudge` creates a one-shot Schedule task per target with
`timing.kind = "after"` and `target.kind = "session"`:

1. Schedule validates the target Session without loading it, then persists the
   task.
2. At the occurrence, it resolves the target Agent (resuming the Session if
   needed) and calls `agent.followup()` with a user message.
3. A busy target queues the message; an idle target is woken.
4. Tasks survive DSH restarts. A delivery that is still queued after a restart
   is recovered by the Schedule service.

The tool returns a **queue receipt**, not proof of reading:

```text
[handoff-hub] Queued a handoff sync reminder to 3/3 sessions (about 1s delay).
- codex: queued · task schedule-... · fires 2026-11-10T08:31:42Z
- qwen: queued · task schedule-... · fires 2026-11-10T08:31:42Z
- stale-peer: failed · [session_not_found] target Session does not exist
```

Additional behavior worth knowing:

- Each target also receives a no-action `[SCHEDULE CHANGE]` notice that the
  Schedule service generates for a newly created task; the actual reminder is a
  second message.
- The reminder text is carried inside a JSON string by the Schedule framing, so
  line breaks appear as `\n` escapes in the raw message. Models read it fine.
- A reminder consumes one model turn per target; that is the intended cost of a
  nudge.

## Configuration

The bundle's patch carries defaults. To override them, add a matching row to
your profile's `cordis.patch.yml` (or edit the inserted row through your normal
profile configuration workflow):

```yaml
- id: handoff-hub
  name: 'dsh-handoff-hub'
  config:
    directory: 'work/handoff'   # absolute, or relative to each caller's cwd
    promptLanguage: 'zh'        # zh | en
    nudgeDelaySeconds: 1        # 1..60
    maxRecipients: 16           # 1..32
    maxDocBytes: 262144         # 4 KiB..4 MiB
    cleanupEndedTasks: false    # opt-in, see below
```

`cleanupEndedTasks` deletes this plugin's ended tasks before a nudge, but the
Schedule service injects a no-op `[SCHEDULE CHANGE]` notice into every involved
live session when a task is deleted. It therefore defaults to off.

## Shared state on disk

```text
<workspace>/work/handoff/
  <model-a>.md
  <model-b>.md
  .handoff-hub/
    participants/
      session-<uuid>.json      # one atomic roster entry per session
```

Roster entry:

```json
{
  "v": 1,
  "sessionId": "session-...",
  "name": "codex",
  "doc": "2026-11-10-codex.md",
  "cwd": "E:\\LAB\\DS GPT\\T1",
  "joinedAt": "2026-11-10T06:20:00.000Z",
  "updatedAt": "2026-11-10T06:20:00.000Z"
}
```

Delete a roster file to make a session leave without calling the tool. The
plugin never deletes or rewrites another session's document.

## Safety model

- **Targets are audited against durable Session storage.** Before scheduling,
  every target is checked with `ctx.sessionPersistence.stat()`: it must exist,
  must not be a delegated subagent Session, and its recorded `cwd` must match
  the caller's workspace. A tampered roster cannot redirect a reminder to a
  different workspace.
- **Roster is untrusted input.** Document names are re-validated on read
  (no `..`, path separators, traversal, or Windows reserved names); display names
  are stripped of control characters. Invalid entries are skipped with a warning.
- **Names and document names compare case-insensitively**, matching NTFS
  behavior, so `Lead.md` and `lead.md` cannot silently overwrite each other.
- **Documents and requester notes are framed as evidence, not instructions.**
  The reminder explicitly says the requester is a model session, not the user,
  and that document content must not be executed as commands.
- **Path checks for references** resolve symlinks and reject anything outside
  the caller's workspace; only small `.md`/`.markdown`/`.txt` pointers are
  allowed.

## Stability

The plugin is intentionally boring:

- no timers, filesystem watchers, polling loops, session-event writes, or system
  prompt sections;
- one `ctx.effect()` owns all tool registrations and unregisters them on unload;
- per-target `Promise.allSettled` isolation — one stale peer cannot fail a batch;
- atomic `tmp + rename` writes, with a bounded retry for transient Windows
  rename locks;
- bounded inputs and outputs (recipient cap, document cap, roster scan cap,
  report line cap);
- no third-party runtime imports — only Node built-ins.

## Known limitations

- Each peer must register once, or be named explicitly in `targets`; the plugin
  never auto-nudges unregistered sessions.
- Reading is asynchronous and not acknowledged. A peer can receive a reminder
  and still choose not to sync; the plugin cannot prove it read anything.
- Two sessions joining with the same new document name can race; the room lock
  serializes plugin joins and the second join is refused with `doc_taken`, but an
  external writer can still race a join. The last writer wins in that case and
  `handoff_join` reports a `[roster_conflict]` warning when it detects duplicate
  ownership.
- Ended Schedule tasks accumulate unless `cleanupEndedTasks` is enabled; they are
  harmless rows in the Host task list.
- Not a substitute for [`dsh-collab`](https://github.com/sessionhive/dsh-collab)
  when you need work orders, flow handoff, or a dashboard.

## Uninstalling

Remove the bundle (or disable its row). The room directory, handoff documents,
and roster entries are left untouched. **Reminders already queued in the
Schedule service are durable and may still be delivered after uninstall**; delete
them from the Automation tasks page if that is not desired.

## Compatibility

| Component | Status |
|---|---|
| DSH | tested with `0.2.2-rc.1`; requires `>= 0.2.2-rc.1 < 0.3.0` |
| Node.js | tested with 22.19 and 24; CI runs both |
| OS | Windows 10/11 tested; no native code, so Linux/macOS are expected to work but are not CI-tested |
| Models | provider-agnostic: the plugin never calls a model API; any model a session already uses can participate |

## Related projects

The DSH ecosystem has several adjacent plugins; pick the one that fits:

- [`dsh-collab`](https://github.com/sessionhive/dsh-collab) — multi-session
  collaboration with work orders, flow handoff, file memory, and a dashboard.
- [`dsh-handoff-bus`](https://www.npmjs.com/package/dsh-handoff-bus) —
  cross-session message bus for GUI conversations.
- [`dsh-handoff-session`](https://www.npmjs.com/package/dsh-handoff-session) —
  pressure-aware session handoff into a fresh session.
- [`dsh-auto-handoff`](https://www.npmjs.com/package/dsh-auto-handoff) —
  summarize a long session and continue in a new one.

## Development

```bash
node test/manifest.mjs
node test/harness.mjs
```

The offline harness uses a fake Cordis context and a real temporary directory.
It covers registration, roster validation, tampered entries, duplicate names,
path traversal, target auditing, failure isolation, references, leave, and
unload. CI runs both files on Node 22 and 24.

## License

MIT. See [LICENSE](LICENSE).
