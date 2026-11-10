# Credits and model attribution

This release was produced in a DeepSeek Harness session on 2026-11-10. The
project owner asked for explicit attribution of which model did the code work
and which model reviewed it.

## Implementation

- **`deepseek-v4.1-flash`** — the DeepSeek Harness lead agent (opencode provider
  route) that designed and wrote the plugin, tests, documentation, packaging, and
  release repository.

## Review

- **`deepseek-v4.1-flash`** — a separate same-model subagent with a fresh context
  performed the first read-only stability review. It flagged the explicit-target
  scope, roster path handling, and requester-note authority issues that were then
  fixed.
- **`gpt-6.1-sol`** — invoked through the Codex subagent (`subagent_codex`,
  reasoning effort `ultra`) for an independent release-readiness review. Its
  findings drove the fail-closed target audit, strict session-id validation,
  duplicate-identity handling, room lock, bounded service awaits, documentation
  fixes, and the attribution section you are reading.
- **1.1.0 features** (targeted auto reminder, merge window, session-group panel)
  were implemented and covered by the offline suite without another external
  model review.

## Human

- **Repository owner** — product direction, acceptance criteria, environment,
  and authorization to call the reviewing model.

## Note

Model names identify the tooling used. Reviews are advisory and do not imply
endorsement by DeepSeek, OpenAI, or any other model provider. The plugin is an
unofficial community project.
