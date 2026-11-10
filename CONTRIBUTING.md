# Contributing

Thanks for taking a look. This is a small plugin and the bar is reliability, not
feature count.

## Before opening a PR

- Run `node test/manifest.mjs` and `node test/harness.mjs`.
- Add a regression test for every behavior change. The harness uses a fake
  Cordis context; no DSH installation is required.
- Keep the runtime free of third-party imports.
- Do not add timers, filesystem watchers, polling, or session-event writes.
- Treat roster files, handoff documents, and requester notes as untrusted input.

## Reporting bugs

Include:

- DSH version and platform;
- the failing tool call (with session ids redacted if needed);
- the relevant receipt/error line;
- whether the target session was idle, busy, or archived.

## Scope

Good fits: safer delivery, better bounded reports, clearer audit of targets,
portability, docs and tests.

Out of scope: a task/work-order system, a UI dashboard, fixed memory formats, or
automatic nudging of unregistered sessions.
