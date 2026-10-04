# Native source, notices, and library replacement

The `SyncShow-<version>-corresponding-sources.zip` asset is available beside the
installers on the same immutable version's GitHub release. Its source index
records each upstream URL, version, archive size and SHA-256. The accompanying
receipt binds that complete archive to the exact version. Keep the archive and
receipt together. An installer is never published without them.

SyncShow's own MIT source is the GitHub source archive for that same release
tag. Reverse engineering for debugging modifications to the LGPL libraries is
permitted; SyncShow imposes no additional restriction on modifying or replacing
them. The app has no native-library signature allowlist. Platform signatures
must be replaced when changing a signed application.

The source ZIP retains upstream source archives, their build scripts,
and a conservative superset of their license/copyright terms. Some retained
terms concern tests or build dependencies rather than linked code. The index
does not claim those unused components are part of SyncShow. Permissive
MIT/BSD/Apache components require their notices, not a bit-for-bit reproducible
native build. LGPL and MPL sources are provided in full.

Gitiles source exports use request-time file/PAX modification dates, so those
exports are sealed as deterministic uncompressed tar archives. Only transport
dates and owner metadata are normalized; every file byte, filename, mode and
link target is retained and included in the pinned SHA-256. The source index
marks these inputs with `archiveNormalization: gitiles-tar-v1`. Downloads with
changed source bytes, modes or links are rejected rather than silently repinned.

## libvips and its dependencies

The POSIX libraries are built by `sharp-libvips` revision
`4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6` for release 1.3.2. Its `build.sh`,
`build/posix.sh`, `versions.properties`, platform Dockerfiles, Meson files and
CMake toolchains are retained in the source ZIP. Run `./build.sh` without
arguments to see the upstream platform options. Unpack the matching dependency
archives from `SOURCE-INDEX.json`, make your modifications, and use the retained
recipe's platform configuration. The recipe itself records its compile and
link flags. The separate librsvg release `Cargo.lock` files identify Rust
dependencies; their checksum-pinned crate archives are included as well.

Windows uses the `build-win64-mxe` 8.18.3 **web** recipe at
`bca68727eb1df12c5d2b204a13a392989d505774`, and the retained sharp-libvips
`build/win.sh` post-processing step. `build.sh --help` documents the targets;
`--without-prebuilt` builds the container rather than relying on a prebuilt
image. The retained MXE revision is the observed helper-source resolution, not
a claim of an independently reproduced original container. The web dependency
versions match the shipped `versions.json`. The GPL-only fftw/poppler entries
in the upstream **all** recipe are absent from the shipped web library.

Windows' imagequant is Lovell's BSD 2-Clause 2.4.1 fork, whose copyright terms
are retained. Its supplemental POSIX source archive is not represented as the
exact Windows build archive; source distribution is not a condition of this
permissive component's BSD license.

Quit SyncShow before replacing libraries, and work on a copy of the installed
application. Preserve architecture, exported ABI, library filenames, and the
loader-relative paths expected by the Sharp addon:

* macOS: replace
  `Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-<arch>/lib/libvips-cpp.8.18.3.dylib`.
  Preserve its `@rpath`/`@loader_path` relationships with `install_name_tool` as
  described in the retained recipe. Re-sign the modified library and copied
  app locally using `codesign --force --deep --sign - <copied-app>`.
* Linux: replace
  `resources/app.asar.unpacked/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3`.
  For an AppImage, extract it with `--appimage-extract`, make the replacement in
  `squashfs-root`, and launch `squashfs-root/AppRun`. A `.deb` can be unpacked
  with `dpkg-deb --extract` into a writable copy.
* Windows: replace `libvips-42.dll` and, when rebuilding the C++ bridge,
  `libvips-cpp-8.18.3.dll` under
  `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib`.
  Use ABI-compatible x64 DLLs from the modified web build. Sharp loads the
  shared DLLs through its addon; the LGPL implementation is outside `app.asar`.

## Electron's FFmpeg library

Electron 43.2.0 pins Chromium 150.0.7871.129, whose DEPS pins FFmpeg revision
`ad41607c61898cf7150e0fb20fe4bbabd44922a3`. That exact complete FFmpeg archive,
including generated per-platform `chromium/config` headers, its configure/build
scripts and BUILD.gn, is included. Electron's source archive retains
`build/args/release.gn` (which selects the shared FFmpeg library), its FFmpeg
loader-path patch, and its source build instructions. The corresponding
Chromium build directory is supplied for the GN configuration.

Build the matching architecture with Electron's retained release args and
FFmpeg patch. The source intentionally includes disabled optional GPL files;
their presence in a source archive does not enable them in the shared Chromium
configuration. Preserve the shared library's exported ABI and architecture.
Replace `ffmpeg.dll` beside the Windows executable, `libffmpeg.so` beside the
Linux executable, or the macOS
`Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`.
Re-sign the copied macOS app after replacing the library. No SyncShow setting,
account, server request or author permission is needed for replacement.

After replacement, run the packaged launch, PDF, Sharp, and shared-service
checks from the matching SyncShow source tag. Keep the original application
until your modified copy passes. These checks establish that the replacement
is loadable and presentation functionality remains intact; they do not assert
bit-identical compilation or a legal opinion.

## Permissive native libraries

Canvas 1.0.3 is MIT; its pinned Skia revision is BSD 3-Clause. The retained
canvas release recipe and Skia DEPS describe the linked third-party inputs.
Rust crate versions are recovered from the official canvas release build log
at `https://github.com/Brooooooklyn/canvas/actions/runs/30338026389` and their
immutable registry archive checksums. Their source/notice terms are included,
as are Skia's linked Expat, FreeType, HarfBuzz, ICU, JPEG, WebP, PNG, Brotli,
JPEG XL, Highway, Wuffs and zlib inputs. FreeType is used under its FreeType
license; no GPL alternative is selected. These libraries may also be replaced
with ABI-compatible native addons. Their permissive terms do not require a
relinking test or original object files.
