# tools/

Diagnostic and partial-run harnesses used while building this.
**None of them are part of the production path.**

What this drives is somebody else's admin screen and a Google spreadsheet,
and every full run delivers a real report. So "just run it end to end and
see" is not available. These are the entry points that were built, one at a
time, to check a stage of it safely.

## diagnose-*

These only read the state of a screen. No clicking, no downloading, no
running a script, no notifications.

| File | What it reads |
|---|---|
| `diagnose-admin-controls.js` | lists the visible controls on the admin screen |
| `diagnose-admin-date-select.js` | the date selector's options and current value |
| `diagnose-drive.js` | the state of the Drive folder tab |
| `diagnose-drive-file-elements.js` | the DOM structure of a Drive file row |
| `diagnose-drive-menu.js` | the items in Drive's right-click menu |

## limited-*

These run one stage of the process. The starting point is pinned so that
"which state can it resume from" can actually be tested.

| File | From, to |
|---|---|
| `limited-upload-import-test.js` | upload through import |
| `limited-import-only-retry.js` | retry the import, and nothing else |
| `limited-through-main-menu-test.js` | as far as the main script's menu |
| `limited-resume-after-duplicate.js` | resuming after a stop on a duplicate |
| `limited-after-confirmed-uploads.js` | resuming once uploads are confirmed |

## Before running one

They assume some of the safety flags, and some of them touch real data.
Running one against production means checking the target date and the target
sheet first.
