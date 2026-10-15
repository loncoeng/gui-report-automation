# legacy/

**The first approach, and the one that was abandoned.** It works. It is not
what production runs.

It is kept because why the current approach (`src/gui-live.js`) looks the way
it does is not visible without reading this.

## What it tried

The obvious thing: drive Chrome with Playwright.

```
run-controlled.sh
  1. check the sign-in state and the target page in the running Chrome
  2. close the Chrome windows normally
  3. SIGTERM whatever Chrome is left, and confirm the profile is released
  4. run run.js against the automation data directory
  5. restore the original page with start-chrome.sh, pass or fail
```

## Why it was abandoned

**An ordinary Chrome and Playwright cannot hold the same profile at once.**
So this approach always comes down to closing the operator's Chrome.

While it is closed, whoever is using that VM is interrupted. What gets
restored afterwards is not quite what was there. For something that runs
every morning, that is too much to do to somebody.

**Copying the sign-in state was not an option either**, because it means
storing the credentials on the automation's side. The way around it was to
point at Chrome's own profile directory, and:

- Chrome 151 will not let DevTools drive `~/.config/google-chrome` directly
- a symlink in the default path is refused as well

which left bind-mounting the same directory for the duration of the run
(`prepare-user-data-bind.sh`). Arriving there was the point at which the
premise itself became the thing to doubt.

## What the current approach accepts instead

Do not close it, do not copy it, do not store it — taken as constraints. No
DevTools: the DOM is read by injecting `javascript:` into the address bar.
Far less control, and the operator's session is never touched.

The repository's own README has the detail.

## What is in here

| File | What it is |
|---|---|
| `run.js` | the Playwright implementation |
| `run-controlled.sh` | closing Chrome, running, restoring |
| `prepare-user-data-bind.sh` | the profile directory bind mount |
