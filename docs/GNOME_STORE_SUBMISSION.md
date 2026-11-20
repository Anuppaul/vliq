# Publishing VLIQ on GNOME Extensions

**Status: preparing first submission, not approved or published.**

This guide describes the source package, reproducible release build, local
checks, first EGO upload, and reviewer handoff. It does **not** imply that GNOME
has accepted the extension.

## Official target

| Item | Value |
| --- | --- |
| Name | VLIQ |
| UUID | `vliq@wonderer.tech` |
| Target Shell | GNOME Shell **50** only |
| Repository | https://github.com/Anuppaul/vliq |
| Uploaded artifact | `vliq@wonderer.tech.shell-extension.zip` |
| License | MIT, including third-party upstream attribution |
| Release workflow | [GNOME Store package](../.github/workflows/gnome-store-package.yml) |
| Review guidelines | https://gjs.guide/extensions/review-guidelines/review-guidelines.html |
| Store upload | https://extensions.gnome.org/upload/ |

GNOME assigns the website-managed `version`; **do not add an artificial
`version` field** to `metadata.json`. Do not add unsupported GNOME versions.

## 1. Build the review ZIP

Every PR and push to `main` runs the **GNOME Store package** workflow.
Only download a successful `main` run when making the official submission:

1. Open **GitHub → Actions → GNOME Store package**, select the newest
   successful run on `main`.
2. Download the artifact **`vliq-gnome-store-upload-zip`**.
3. GitHub wraps files in an artifact archive. **Extract the artifact once**,
   and locate the actual inner `vliq@wonderer.tech.shell-extension.zip`.
   **Upload the inner ZIP**, not the GitHub artifact wrapper.
4. Download **`vliq-gnome-store-review-evidence`** separately to inspect
   `SHEXLI_REPORT.txt`, `SHEXLI_EXIT_STATUS.txt` and the SHA-256 manifest.
5. Compare the inner ZIP's SHA-256 with `vliq-ego-manifest.json` before
   uploading or distributing it.

Offline source builder (no Git command or additional Python packages needed):

```bash
python3 tools/build_ego_release.py --check-only
python3 tools/build_ego_release.py
```

The package will be under `dist/ego/`. The release builder is **not
included** in the final extension ZIP.

## 2. Why the Store ZIP differs from the source checkout

GNOME reviews readable JavaScript, native schemas and the resources needed
to run the extension. The release package intentionally includes:

- Top-level `metadata.json`, `extension.js`, `prefs.js`, `runtime.js`,
  other VLIQ runtime JS, `stylesheet.css` and `runtime.css`.
- **Both** canonical VLIQ and vendored Liquid Glass GSettings XML files
  together inside **top-level `schemas/`**. GNOME's normal extension schema
  compilation can therefore provide both schemas; **a Store installation
  must not require running VLIQ's developer `install.sh`**.
- The vendored renderer's non-minified, readable `dist/**/*.js`,
  `shaders/*.frag`, `stylesheet.css`, required `icons/*.svg`, and
  upstream MIT license/provenance.
- Root MIT `LICENSE` and `THIRD_PARTY_NOTICES.md`.

Excluded:

- `vendor/liquid-glass/src/**/*.ts`, npm metadata, lockfiles, TypeScript
  project files and redundant vendor extension/prefs/metadata entrypoints.
- Local installers, development utilities, screenshots/graphics/README
  attachments, caches, test fixtures and compiled `gschemas.compiled`.
- Executable binaries and program downloads.

GNOME's Store guidelines require reviewed JavaScript source and schema XML
and discourage bundled build tooling, binary executables and excess
unnecessary files.

## 3. Mandatory technical preflight

Before uploading a version:

- [ ] **Repository checks PASS**: GJS JavaScript syntax, wallpaper/material,
      Dock and popup tests, schema/XML checks, release-manifest preflight.
- [ ] **CodeQL PASS**: no outstanding actionable security finding.
- [ ] **GNOME Store package PASS**: ZIP generated and unpacks with both schemas;
      `glib-compile-schemas --strict --dry-run` passes on the extracted
      top-level `schemas/`.
- [ ] **Shexli reviewed**: inspect the actual `SHEXLI_REPORT.txt`. Any
      `error`, `manual_review`, or `warning` is a prompt to inspect the
      exact code and either fix it or prepare a defensible reviewer
      explanation. Running Shexli does **not** itself grant approval.
- [ ] **GNOME 50 physical test PASS** on a regular user session: install the
      Store-built inner ZIP, verify that the extension loads and Preferences
      opens **without** running `gnome-shell/install.sh`.
- [ ] On GNOME 50, verify Liquid Glass, Frosted Crystal, Wallpaper
      Milky White/Original, Orb, Spotlight, Calendar, Quick Settings, Dock
      autohide, GNOME Overview and clean **disable/re-enable**.
- [ ] Test wallpaper change, multi-monitor, app windows behind native
      popups, and rapid open/close transitions with no persistent black
      rectangle, recursive capture or stalled compositor.
- [ ] Confirm source license obligations, developer contact/report URL,
      and real screenshots from the version being submitted.

### Optional local Shexli

With Python 3.12 or later:

```bash
python3 -m venv .venv-shexli
. .venv-shexli/bin/activate
pip install -r tools/ego-review-requirements.txt
shexli dist/ego/vliq@wonderer.tech.shell-extension.zip --format text
```

Shexli is a static analyzer, not a GNOME Shell/GPU compositor test. The
dependency pin avoids an incompatible Tree-sitter parser combination.
Neither venv nor Shexli is shipped in VLIQ's extension ZIP.

### Shexli review findings observed during PR #64 preflight

The current upload ZIP successfully passes the structural/schema checks and
Shexli reports **0 errors, 1 warning**:

- **`EGO-P-007` — dynamically loaded JavaScript modules appear unreachable.**
  VLIQ's bootstrap loads its installed `runtime.js` using
  `import(target.moduleFile.get_uri())` and the Liquid Glass bridge loads
  vendored GJS modules using `import(moduleUri(root, ...))`. This is not a
  runtime download: all modules reside in the review ZIP, and the packaging
  preflight verifies ordinary relative import dependencies. The static
  reachability analyzer does not follow file-URI imports whose paths are
  computed at runtime.

This finding **requires honest reviewer scrutiny**. It is not appropriate
to silence Shexli by adding fake static imports or claiming every vendored
module has been dynamically exercised by CI. The maintainer should be able
to show the runtime module-loading code, justify the necessary bundled
renderer modules and describe cleanup for each manager if questioned.

An earlier warning `EGO-X-004` identified a blocking
`Gio.File.load_contents()` call in the development bootstrap marker
reader. This was addressed using an asynchronous Gio read with safe
fallback for Store installs that have no marker. The CI regression
`tools/test_store_bootstrap_async.mjs` prevents accidentally restoring
a synchronous Shell read.

`GNOME Store package` workflow success means the ZIP is **built** and
schema checks pass; Shexli warnings are preserved as review evidence and
do not imply official approval or guarantee the runtime is bug-free.

## 4. Upload to GNOME Extensions

1. Sign in (or register) at https://extensions.gnome.org/.
2. Read the review guidelines, Code of Conduct and GNOME maintainership
   expectations.
3. Open https://extensions.gnome.org/upload/.
4. Upload **`vliq@wonderer.tech.shell-extension.zip`** from the
   successful main release artifact, not a repository ZIP or artifact wrapper.
5. Confirm the metadata (VLIQ, UUID, GNOME Shell 50); submit for
   review and provide truthful screenshots/description as requested.
6. Await GNOME review by email. Address any requested corrections in a new
   source commit, generate a **new ZIP** from a successful main build, then
   submit it as the next version using the same form.

The notice about installing the **GNOME Browser Integration** extension and
native-messaging host is about browser-side control of installed GNOME
extensions. It is **not an instruction to embed a browser extension,
native-messaging app, binary or installer inside VLIQ's Store ZIP**.

## 5. Reviewer notes and limitations

VLIQ intentionally modifies GNOME Shell's popup/overview glass appearance
and supports Ubuntu Dock's native settings, but is **not** a substitute
for GNOME Shell, GTK application themes, or a second Dash-to-Dock instance.
The Ubuntu Dock-specific controls are available only when Ubuntu Dock's
schema is installed; other visual components remain separate.

The renderer is derived from an MIT-licensed upstream Liquid Glass
project. **Both licenses and provenance are retained**. Reviewer concerns
may include the codebase size, native Shell monkeypatching, the optional
development-only hot-update bootstrap, and GNOME private Shell APIs. These
must be explainable and maintained; source-level CI is **not** proof of EGO
review approval.

On GNOME Shell 50, extension code is privileged in the user's Shell
session. The maintainer must understand the code, be able to debug
regressions and restore every modification in `disable()`. If you cannot
test the final Store ZIP on GNOME Shell 50 and address Shexli findings,
**do not claim the extension is review-ready merely because CI is green**.

## 6. After approval

Only **after GNOME approves and publishes** VLIQ, update README with
the actual GNOME Extensions listing URL and verified supported platforms.
Do not fabricate an extension listing ID or use a Store-installed badge
before publication.
