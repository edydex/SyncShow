# Browser preparation draft

Local preparation for a future LibreShow **Prepare online** action. Nothing in
this directory is a deployed product page. It does not start a server, contact a
church, sign in, upload files, publish a service or control presentation outputs.

Build with Node 24, without downloading dependencies:

```sh
npm run build:web-prepare
```

Serve `web-prepare/dist/` with an ordinary local static server and open it in a
browser. The generated files are ignored build output. This draft is separate
from the existing Electron package, Community server and their release pipelines.
No production hosting configuration is added.

## Reused contracts

The build includes the maintained `packages/service-core` browser implementation
and generates its archive validation helpers directly from the pure part of
`src/services/project/ServiceProjectExchange.js`. The included `source.json`
records input hashes. Desktop filesystem, Electron, sharp and office conversion
are excluded. No external JavaScript, font service or npm CDN is loaded.

Portable exchange remains schema-v1 `syncshow-service-project-bundle`, a
STORE-only ZIP with canonical `manifest.json`, canonical `project.json`, SHA-256
checksums and pinned PNG/JPEG/WebP assets. The legacy filename extension
`.syncshow-service` is retained. This branch adds `.libreshow` to both desktop
file dialogs and browser import/export, with the same archive semantics. The
desktop UI suggests `.libreshow`; existing programmatic export callers retain
their `.syncshow-service` default. Both filename choices produce identical bytes
for the same project/creator. Older released apps can still use the legacy
extension, available in the browser's download selector. No desktop release or
site publication has been made from this branch.

The draft uses the real service schema and group/text mutations. It can start a
service, add sections/plain notices/blanks, edit groups and plain notices across
outputs, move/duplicate/remove items with shared core mutations, undo accepted
changes, preview compiled text/images and save a verified portable service. Other supported items,
resources, metadata and image bytes remain intact. Unknown project fields,
unsupported presets/assets, invalid checksums and undeclared archive entries
cause a full rejection, rather than a partial import or lossy conversion.

## Explicit limits before publication

- The full existing planner is not drop-in static UI. It uses authenticated
  service-document, song/sermon, Bible and media endpoints. Its embedded desktop
  version also has a local HTTP adapter. A future shared local transport would
  allow more UI reuse; this first draft reuses its schema/mutations instead.
- This is a smaller editor, not full planner parity. Existing complex slides,
  songs, Bible readings, rich formatting and images are retained but not edited.
  No video/PowerPoint import, fonts, Community connection or live display is added.
- Browser archives are capped at 32 MiB before reading, compared with the desktop
  exchange's 128 MiB ceiling. Larger files are rejected untouched. Streaming and
  a worker are follow-up work; parsing/hashing currently uses the main thread.
- Text preview is approximate and uses locally available fonts. The desktop
  selects Arial or bundled Liberation Sans and applies its renderer/fit checks.
  Pixel-exact preview and bundled licensed fonts remain to implement and test.
- IndexedDB recovery stores verified archives and pending form edits locally.
  Each opened workspace/tab has a distinct copy; restore preserves original
  recovery entries and removal is explicit. Quota/disabled-storage failures warn
  without replacing active content. Browser eviction and edits made within the
  debounce window before a crash can still lose recovery data. Download remains
  the durable path; its completion must be confirmed before the guard is cleared.
- Serve the included CSP headers when hosted: no network connections, uploads,
  forms, frames, objects, remote scripts or remote fonts are allowed. The app
  makes no fetch/XHR/WebSocket/beacon request and has no backend or account.
  Files already present in the browser are never silently overwritten.
- Chrome 156 browser acceptance passes at desktop and 390px widths. File input, typed arrays,
  TextEncoder/TextDecoder, Blob downloads, dialog and beforeunload are used.
  Safari/Firefox, physical mobile downloads, broader accessibility and large
  real services need direct testing before a public launch. Real power-loss or
  browser-process crash recovery is not claimed; reload recovery was exercised.

## Tests

`node test/web-prepare.test.js` runs the shared core in a browser-like VM and
passes browser exports through the real desktop importer. It also exercises a
desktop export/browser export/desktop import round trip with exact project and
image-byte comparisons, malformed archive rejection and the no-network boundary.
Normal development needs the repository's declared dependencies installed.
Run `npm run test:web-prepare-browser` with an available Playwright installation
and sandbox-capable browser. `SYNCSHOW_PLAYWRIGHT_MODULE` can identify an existing
module; `SYNCSHOW_BROWSER_EXECUTABLE` selects a browser, and
`SYNCSHOW_BROWSER_TEST_OUTPUT` selects the artifact folder. The test serves only
static files on loopback, uses synthetic files in fresh unauthenticated profiles,
keeps the Chromium sandbox enabled, blocks external page requests, and closes
the server/browser. It exercises 13 browser cases including reload recovery,
pending edits, quota/unavailable storage, two-tab isolation, actual downloads,
both extensions, images, ordering, CSP and responsive layout. No venue or packaged
desktop acceptance is implied.

The complete existing planner UI is not yet adapted to a local browser transport.
This draft reuses its maintained schema, mutations and compiler; advanced editing
remains on desktop. Do not promise full planner parity or compatibility with an
unreleased desktop build. The new extension does not change project IDs, file
content contracts, existing desktop data or the old-file import path.
