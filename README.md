# gui-report-automation

[![test](https://github.com/lon-coeng/gui-report-automation/actions/workflows/test.yml/badge.svg)](https://github.com/lon-coeng/gui-report-automation/actions/workflows/test.yml)

*[日本語版 / Japanese version](README.ja.md)*

Scheduled automation that **borrows a long-running, human-owned Chrome session**
on a Linux VM to produce a daily report — without storing any credentials.

It never launches its own browser. It reuses the operator's existing signed-in
session, cookies and completed MFA as they are, and runs the whole chain —
download a CSV from an admin console, upload it to Google Drive, run Apps Script
aggregation, post to chat, clean up — in a way that fails safe at every step.

> Note: the code comments and the primary README are in Japanese, matching the
> deployment this was built for. This page covers the design; the code itself is
> readable without Japanese.

---

## What makes this hard

**A normal Chrome and Playwright cannot open the same profile at once.** The usual
answer is to close the browser and reopen it under automation — but that destroys
the signed-in session the operator maintains. Copying the login state was also off
the table, because it means storing credentials.

This repository accepts **"don't close it, don't copy it, don't store it"** as a
hard constraint and works within it.

| Constraint | Approach taken |
|---|---|
| Cannot close Chrome | No DevTools remote debugging. Read the DOM by typing `javascript:` into the address bar |
| Cannot copy or store login state | Identify windows and tabs by URL; drive visible controls by exact string match |
| Don't want a service-account key on disk | Impersonate the target service account briefly from the GCE instance identity (keyless) |
| No real display (headless VM) | Verify the virtual display size and pick the smallest safe mode before starting |
| Apps Script menus never reach the DOM | Fall back to screenshot OCR, tolerating known misrecognitions of Japanese labels |

## Design decisions

**Idempotency lives in a state file.** Every reporting date gets its own
`state/<date>.json`, written on success, failure *and* unknown outcomes. A date,
once started, is never re-run without a human looking at it. This exists so that
"it failed, so retry" cannot turn into a double post.

**Quarantine before deleting.** Files that existed before the run started, and
unfinished `.crdownload` files, are moved to `quarantine/<run-id>/` rather than
removed. The automation may only delete what it can prove it created.

**Never guess that a download finished.** Chrome appends `(1)`, ` (1)`, `(2)` to
duplicate names; all variants are treated as the same target. Only the one file
created after the download started, whose size held steady across three
consecutive polls, is promoted to the run folder under its canonical name. Only
that file is used downstream.

**When the result is unknown, stop.** If the Apps Script completion dialog times
out, the script does not re-run it. It verifies the outcome through a separate
read-only path (Sheets API). Missing cells, mismatched values, formula errors and
API errors all stop the run.

**Do not automate authentication.** If the target has signed out, the account
chooser is used only when exactly one matching account is visible. Passwords,
verification codes and CAPTCHAs are never typed. The moment 2FA or identity
verification is requested, the run is recorded as failed and stops.

**Layered safety locks.** Real work starts only when `--live` and every safety
flag are explicitly enabled. The default `config/automation.json` has them all
set to `false`.

## Layout

```
src/        the current implementation
  gui-live.js                   entry point for the resident-Chrome approach
  gui-runtime.js                address-bar injection, OCR, coordinate clicks
  gui-preflight.js              pre-flight checks (no side effects)
  gui-observe.js                OCR of on-screen labels only (no clicks/downloads)
  run-state.js                  per-reporting-date run state
  drive-verification.js         verifies the Drive upload result
  import-sheet-verification.js  verifies the result via Sheets API (keyless)
tools/      diagnostic and partial-run harnesses, outside the production path
legacy/     the Playwright approach that was tried and rejected, and why
config/     defaults / production / one-shot example
systemd/    timer units
test/       unit tests (node:test)
```

The target is an external admin console and live spreadsheets, so there is no way
to "just run it end to end and see." The harnesses under `tools/` exist for that
reason.

Why the straightforward approach — driving Chrome with Playwright — was abandoned
is written in [legacy/README.md](legacy/README.md). The constraints the current
implementation lives under come from there.

## Usage

```sh
sudo apt-get install -y xdotool xclip wmctrl

npm run resident-preflight   # only checks that the target tabs exist. No side effects
npm run gui-dry-run          # only walks the tabs. No real work
npm run resident-live        # real work, and only with the safety flags enabled
```

Copy `config/automation.json` to configure. The admin console URL, Chrome
profiles, spreadsheet IDs and gids, and the Drive folder are all supplied through
configuration — no target-specific values live in the code.

```sh
npm test      # unit tests
npm run check # syntax check across src/, tools/, legacy/, scripts/
```

Tests use only Node built-ins and mock `xrandr`, so they need neither a dependency
install nor a real display. CI runs them on Node 20 and 22.

> The two `display guard` tests depend on how shell scripts execute and fail on
> Windows. They pass on Linux and macOS.

## Stack

Node.js 20+ / Playwright (diagnostics only) / systemd timer / Google Sheets API /
Google Compute Engine / xdotool, xclip, wmctrl

## License

MIT. See [LICENSE](LICENSE).

A sanitised, public edition of a system still running in production, published
with the client's permission.
