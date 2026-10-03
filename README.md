# Daybook

A private, offline daily diary for blood sugar, sleep, movement, food and stress.
Everything runs on the device. There is no account, no server, no analytics and
no request to any other origin.

Daybook records what was written down and shows it back, side by side. It does
not interpret a reading, assign a cause, or give advice. Interpretation belongs
to a doctor.

## Properties

- Readings are stored in mmol/L. mg/dL exists only at the point of display, and
  switching units never rewrites a stored value.
- Averages, comparisons and tallies are computed from the diary each time. They
  are never stored.
- Every write is verified by reading it back. A write that does not persist
  raises a persistent notice, the session continues in memory, and export still
  works.
- A day is the local civil date, stored as `YYYY-MM-DD`.
- Export to CSV or JSON works offline and round-trips without loss. Import
  validates the file's shape, not its origin.
- Comparisons are shown only when they pass fixed gates: at least 5 days with a
  morning reading, at least 3 days on each side, a gap of at least 0.8 mmol/L,
  and a separation of t ≥ 2.5. The pairs are fixed in advance. Six comparisons
  run at once, so around 15% of what passes will be coincidence; the Patterns
  screen says so.
- Readings are coloured only against a range the user or their doctor entered.
  No default range ships.
- No reading is attributed to a hormone. Finger-prick readings cannot resolve
  the curve shapes that would require, and adrenaline, cortisol and insulin
  produce overlapping shapes in any case.

## Install

Daybook is an installable web app. It must be served over HTTPS, or the
service worker will not run.

On the device: open the URL in the browser, then *Add to Home Screen*. The app
prompts for this itself and stops once installed. Installing is what prevents
the browser from clearing the diary after a week unopened.

An installed copy picks up a new release the next time it is opened. The user
sees a prompt and chooses when to take it. Taking an update never touches the
diary.

## Run locally

```bash
python -m http.server 5178
```

Then open <http://localhost:5178>. Service workers are permitted on
`localhost`, so offline behaviour works locally.

The service worker serves cache-first. After editing a file, unregister the
worker and clear its caches before checking the change, or the browser keeps
showing the previous version.

## Tests

```bash
npm test
```

`node --test`, zero dependencies. Covers pure functions and static properties
of the source.

Checks that need a real browser live at `test/browser/`. Open
<http://localhost:5178/test/browser/> with the dev server running. The page
covers resolved contrast ratios, media-query breakpoints, the state-colour
rules, and whether the service worker's cache matches what the server serves.
Append `?only=<text>` to run matching tests only.

That page loads the app's modules but never `js/app.js`, which boots on load
and writes to storage. It reports whether the diary was touched as its final
result, and `npm test` fails if `app.js` is ever added to it.

## Deploy

```powershell
.\tools\release.ps1
```

Stamps the service worker, runs the suite, refuses to deploy if any test fails
or if zero tests ran, uploads to a versioned folder, then swaps it into place.

| Flag | Effect |
|---|---|
| `-Preflight` | Read-only. Proves the host, path and URL describe the same place. |
| `-List` | Lists the releases on the server. |
| `-Rollback <stamp>` | Restores a previous release. |
| `-Pages` | Publishes the same staged files to GitHub Pages instead. |
| `-Mirror` | Rebuilds this repository from the private one, as one commit. |
| `-Force` | Skips the confirmation prompt. |

The private host's target (SSH alias, remote folder, site URL) lives in
`tools/release.local.ps1`, which is git-ignored. Copy
`tools/release.local.example.ps1` to create it. The script refuses to run
without it. Run `-Preflight` after changing any value.

`-Pages` needs no target file. It pushes the staged set to the `gh-pages`
branch of this repository, served at <https://azadmotala.github.io/daybook/>.
Both hosts receive byte-identical releases.

`-Mirror` rebuilds this repository from the private one's `HEAD`: one
commit, without the workspace, refused if any file names the private host.
It runs the suite on that commit before pushing and again on a fresh clone
after. It needs the target file, to know what to look for.

The cache name in `sw.js` is derived by `tools/stamp-sw.mjs` from a hash of
every precached file and the worker itself. A test fails when it is stale. It
is never edited by hand.

## Layout

```
index.html            app shell
styles.css            design system, light and dark
sw.js                 service worker; cache name is derived, never typed
manifest.webmanifest  install metadata

js/store.js           storage, units, dates
js/engine.js          observations engine and its gates
js/ui.js              DOM helpers, bottom sheets, number pad
js/app.js             screens and wiring
js/update.js          new-release prompt
js/demo.js            fictional demo data; parks real days, never replaces them

test/                 node --test suite and test/browser/
tools/release.ps1     deploy, preflight, rollback, Pages, mirror
tools/stamp-sw.mjs    derives the cache name
tools/make-icons.py   regenerates the icon set
fonts/                Atkinson Hyperlegible, self-hosted
icons/                generated app icons
```

Exported diary files are git-ignored by pattern. They are a person's health
record and do not belong in a repository.

## Interface

- A custom number pad for readings. Keys are 67px at the default text size and
  scale with it.
- Atkinson Hyperlegible, self-hosted. Designed for low vision.
- Three text sizes: 18, 21 and 24px base.
- Light and dark, following the device unless overridden.
- Every section is tap-to-select and saves on every tap.

---

This app gives no medical advice and no dosing advice. It does not diagnose.
Nothing in it should be used to change medication.
