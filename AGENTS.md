# BB attention plugin

## Working agreement

Finish the authorized task through verification and integration. Preserve existing edits and unresolved requests across interruptions. Make routine implementation decisions locally; ask only when a missing decision materially changes the outcome. Existing authorization persists across turns.

Use tools available in the current session. Skills provide task guidance; they do not impose unrelated workflows or authorize external actions. Keep runtime model selection in the harness. Commits, pushes, publishing, messages, credential changes, and destructive operations need authorization covering the action. Do not add agent or model attribution.

Run checks appropriate to the change and required repository gates. Broaden or repeat checks for new changes, failures, or unresolved concerns. Report the result, verification, and actual limitations concisely.

## Repository context and verification

`server.ts` ranks attention and owns dismissal persistence; `app.tsx` renders the homepage section. Read `README.md` for the MPIV fork's occurrence contract: dismiss one thread/kind/timestamp occurrence, while later occurrences remain visible. Keep hidden, archived, and actively running threads filtered as specified.

Code checks are `npm run typecheck`, `npm test`, and `npm run build`. Use the fake plugin host and isolated state. Documentation-only changes need reference checks. Preserve the fork/upstream boundary and existing version pins. Do not install, reload, enable features, or dismiss real user attention while verifying source changes.
