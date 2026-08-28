# bb-plugin-attention

A "Needs attention" section for the bb homepage / new-thread screen: the top
10 threads that want you, ranked most urgent first. This MPIV fork adds durable
dismissal for individual attention occurrences.

Upstream: [slogsdon/bb-plugin-attention](https://github.com/slogsdon/bb-plugin-attention).

## Screenshots

![attention](docs/screenshot.png)

*The "Needs attention" home screen section.*

## What counts as "needs attention"

Ranked `error` → `interaction` → `unread`, then by most recent attention:

- **error** — thread ended in an error state (`status`/`displayStatus` is
  `error`).
- **interaction** — a pending provider interaction: command/file/permission
  approval, plan review, an ask-user question, or a plugin input form.
- **unread** — a finished turn bb itself considers unread
  (`latestAttentionAt > lastReadAt`), i.e. the agent is waiting on you.

Hidden (background) threads, archived threads, and threads still running
without a blocker are excluded.

## Placement

The section registers with id `attention`, which sorts before `daily-ops`,
so it renders above the Daily ops homepage section (the client renders
homepage sections in plugin-id order).

## Surfaces

- **Homepage section** (id `attention`) — the ranked list; clicking a row
  opens the thread. Refreshes on mount and live via realtime on
  `thread.idle` / `thread.failed`.
- **CLI** — `bb attention list [--project <projectId>]` prints the same
  ranked list.

## Permanent dismissals

Enable the feature switch:

```sh
bb plugin config attention set permanentDismissalsEnabled true
bb plugin reload attention
```

Each New Thread row then has a **Dismiss** control. Dismissal is stored by
thread, attention kind, and occurrence timestamp. The same occurrence stays
hidden after page reloads and bb restarts. A later error, interaction, or
unread turn on that thread appears again.

## Install

```sh
bb plugin install https://github.com/mpiv-ai/bb-plugin-attention
# or, from a checkout:
bb plugin install path:path/to/bb-plugin-attention
```

Once installed, the homepage section appears automatically on the
homepage / new-thread screen; `bb attention list [--project <projectId>]`
is available as a CLI. Permanent dismissals are off until enabled.

## Removal

Set `permanentDismissalsEnabled` to `false` to stop filtering and remove the
Dismiss controls. Reinstall the upstream package to remove this fork. Its
dismissal table is additive and ignored by upstream releases.

## Development

```sh
npm run typecheck
npm test          # rank/filter/cap/CLI tests against the fake plugin host
bb plugin build .
```
