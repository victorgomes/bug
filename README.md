# bnz

A small CLI that fetches authenticated content from
[issuetracker.google.com](https://issuetracker.google.com) (Buganizer) and
[clusterfuzz.com](https://clusterfuzz.com), using a persistent headless
Chromium session driven by Playwright.

Built because there is no usable external API for either service and pasting
issue contents into another tool gets old fast.

The output is a faithful markdown dump of the rendered page (light DOM + open
shadow roots), so changes to either UI don't silently drop content — at worst
they make the output look a little different. A small amount of structured
extraction sits on top of the markdown for things the CLI itself needs to act
on (testcase links inside an issue, command-line flags on a CF page,
attachment download URLs, reproducer endpoints).

## Install

Create a packaged global installation rather than linking the checkout:

```sh
git clone <this repo> ~/repos/bnz
cd ~/repos/bnz
npm ci
npx playwright install chromium
archive="$(npm pack --pack-destination /tmp)"
sudo npm install --global "/tmp/$archive"
```

This installs both `bnz` and `bnz-mcp` on the system `PATH`. Installing the
checkout itself with `npm install --global .` creates a symlink back into the
checkout. That is convenient for development, but it is not a self-contained
tool installation and sandbox launchers may refuse to mount it. Installing the
tarball copies only the package's declared files into npm's global tool tree.

To update an existing installation after changing the source, rerun the
`archive=...` and `npm install --global` commands shown above. The install
replaces the previous package while keeping bnz's profile and cache under
`~/.config/bnz` untouched.

For development and tests, use the checkout directly without installing it:

```sh
npm ci
npm test
./bnz.js --help
node ./mcp-server/server.js
```

## First-time login

Each service is a one-time headed-browser login. The session is stored in a
persistent Playwright profile at `~/.config/bnz/profile`.

```sh
bnz login        # log into issuetracker.google.com
bnz cf login     # log into clusterfuzz.com
```

Both services use Google SSO, so logging into one usually carries the other —
but running both is harmless and ensures cookies are warm.

## Usage

### Fetch a Buganizer issue

```sh
bnz 505610970                  # one issue
bnz 505610970 506855825        # several issues, one Chromium session
bnz b/505610970                # `b/<id>` shorthand also works
bnz https://issuetracker.google.com/issues/505610970
bnz https://crbug.com/506855825
```

Output is the full page rendered as markdown, with a synthesized
`# Issue <id>` header plus a final `## Attachments` section listing any
attachment URLs found on the page.

### Fetch a ClusterFuzz testcase

```sh
bnz cf 5009280990216192         # by testcase key
bnz cf 505610970                # by Buganizer issue id (resolves the testcase link)
bnz cf b/505610970
bnz cf https://clusterfuzz.com/testcase?key=5009280990216192
bnz cf 505610970 --download-original   # also fetch the unminimized reproducer
```

Numeric input is disambiguated by length: 14+ digits is treated as a testcase
key; otherwise it's a Buganizer issue id and the issue's markdown is scanned
for a `clusterfuzz.com/testcase?key=...` link.

The output is the full testcase page as markdown plus appendix sections for
the minimized reproducer (always) and the original reproducer (when
`--download-original` is set).

### Download attachments

```sh
bug 505610970 --download-attachments              # to cwd
bug 505610970 --download-attachments=/tmp/bugs    # to a directory
```

Every attachment URL encountered on the page is fetched via the authenticated
session. A `## Downloaded attachments` section is appended to the markdown
output listing the resulting filenames and sizes.

### Search

```sh
bug list "reporter:me status:open"
bug list "assignee:me modified>now-7d"
bug list "componentid:1456355 status:open" --format=json
```

Runs a Buganizer search and emits the matching issues. The `--format=json`
form is suitable for piping into `xargs bug` for batch fetches.

### Common flags

| Flag                          | Effect                                                          |
|-------------------------------|-----------------------------------------------------------------|
| `--format=markdown`           | Default. Pretty-printed with ANSI color when stdout is a TTY.   |
| `--format=json`               | Structured object (or array, when multiple targets are passed). |
| `--refresh`                   | Bypass the cache for this fetch (writes back as usual).         |
| `--no-cache`                  | Disable cache reads and writes entirely.                        |
| `--download-original`         | cf: also fetch the unminimized reproducer.                      |
| `--download-attachments[=DIR]`| Download every attachment URL the page exposes.                 |
| `--debug`                     | Add `rawHtml` to JSON output.                                   |
| `--no-color`                  | Disable ANSI color (also respects `NO_COLOR`).                  |
| `-h`, `--help`                | Show usage.                                                     |

## How it works

Both sites are JavaScript SPAs (Polymer with shadow DOM), so we don't try to
hit any backend API. The extractor is three clean stages:

1. **Fetch**: Playwright launches Chromium against a persistent user-data dir,
   reusing the cookies from `bnz login` / `bnz cf login`. Navigate, wait for
   `networkidle`.
2. **Flatten** (in-page, ~70 lines in `lib/dom.js`): recursively walk the live
   DOM and emit HTML mirroring the rendered flat tree — descend into open
   shadow roots, replace each `<slot>` with its `assignedNodes({flatten:true})`.
   Drop invisible elements (`display:none`, `aria-hidden`) and a small media
   skip-list (script, style, iframe, svg, ...). The result is plain HTML.
3. **Render**: hand that HTML to [Turndown](https://github.com/mixmark-io/turndown)
   (with the GFM tables/strikethrough plugin) in Node to produce markdown.

On top of the markdown, a tiny amount of structured extraction handles the
things the CLI itself acts on: testcase keys inside an issue (regex), the
attachment URLs collected during the flatten walk, and reproducer downloads
probed via Playwright's request context.

Pages are cached at `~/.config/bug-cli/cache/` with a 5-minute TTL. Pass
`--refresh` to bust the cache for a single fetch, or `--no-cache` to disable
it entirely.

A single invocation can fetch multiple targets in one Chromium session —
`bug 1 2 3` and `bug cf a b c` both reuse one launched browser.

## Security notes

- The persistent profile at `~/.config/bnz/profile` contains authenticated
  Google session state. Treat it like a browser profile and do not share it.
- The cache at `~/.config/bug-cli/cache/` stores full markdown of fetched
  pages, which can contain sensitive issue content. It's mode-private by
  default (created with the user's umask).
- `--debug` includes raw HTML in JSON output. That can contain sensitive
  issue or testcase content.

## Limitations

- Shadow-DOM walking covers open shadow roots only. Closed shadow roots are
  invisible (Polymer/Buganizer use open roots, so this hasn't been a problem).
- Polymer pages often have lots of nested layout divs and component shells.
  The walker normalizes whitespace but doesn't try to interpret semantic
  structure beyond "this is a heading", "this is a link", "this is a code
  block". Expect more verbose output than a hand-curated version.
- `bnz login` / `bnz cf login` require manual interaction. Cookie rotation
  may eventually invalidate the session; re-run the login if requests start
  redirecting to `accounts.google.com`.

## Files

- `bnz.js` — CLI entry, dispatch, output rendering.
- `lib/url.js` — URL normalization (issue, testcase, search, attachment).
- `lib/browser.js` — Playwright session helpers + Turndown wiring.
- `lib/dom.js` — In-page flat-tree HTML serializer (shadow + slot projection).
- `lib/cache.js` — Disk cache.
- `lib/render.js` — Terminal sanitization, ANSI colors, header/appendix glue.
- `test/` — Unit tests (URL resolution, parsing, sanitization, cache key).
