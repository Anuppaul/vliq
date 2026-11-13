#!/usr/bin/env python3
"""Build and verify a minimal GNOME Extensions Store submission ZIP.

No Git command, executable binary, compiled schema, development installer,
TypeScript source or nested upstream extension is shipped. The package
contains the actual VLIQ GJS runtime and the vendored MIT renderer's
reviewable JavaScript, GLSL and licenses.

Usage:
    python3 tools/build_ego_release.py
    python3 tools/build_ego_release.py --check-only

The resulting ZIP can be uploaded at https://extensions.gnome.org/upload/.
This builder cannot replace GNOME Shell 50 runtime/device acceptance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "gnome-shell" / "vliq@wonderer.tech"
VENDOR = EXT / "vendor" / "liquid-glass"
ARCHIVE_NAME = "vliq@wonderer.tech.shell-extension.zip"

CANONICAL_SCHEMA = "org.gnome.shell.extensions.vliq.gschema.xml"
VENDOR_SCHEMA = (
    "org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml"
)

# Filename extensions allowed by EGO's source-only review.
EXTENSIONS = {".js", ".json", ".xml", ".css", ".frag", ".svg", ".md", ".txt"}
DANGEROUS = {".so", ".dll", ".exe", ".deb", ".pyc", ".ts", ".map", ".node"}


def collect() -> dict[str, bytes]:
    payload: dict[str, bytes] = {}

    def add(source: Path, target: str | None = None) -> None:
        if not source.is_file():
            raise ValueError(f"Missing required submission source: {source}")
        name = target or source.relative_to(EXT).as_posix()
        if name in payload:
            raise ValueError(f"Duplicate archive path: {name}")
        if name.startswith("/") or ".." in PurePosixPath(name).parts:
            raise ValueError(f"Unsafe archive path: {name}")
        payload[name] = source.read_bytes()

    # All top-level GJS runtime modules + their native popup/style resources.
    # This is deliberately narrower than blindly archiving the whole repo.
    for kind in ("*.js", "*.css"):
        for source in sorted(EXT.glob(kind)):
            add(source)
    add(EXT / "metadata.json")

    # EGO requires the top-level schema XML. Copy the vendored renderer's
    # schema XML ALONGSIDE VLIQ's canonical schema so the GNOME extension
    # installer can compile both in one standard schemas/ pass. Do NOT ship
    # vendor/..../schemas/gschemas.compiled; the user should not need to run
    # install.sh, build binaries or precompile the vendor schema after install.
    add(EXT / "schemas" / CANONICAL_SCHEMA)
    add(VENDOR / "schemas" / VENDOR_SCHEMA, "schemas/" + VENDOR_SCHEMA)

    # The production renderer uses its well-formatted dist/ JavaScript,
    # shader files, icons and CSS. Exclude development TypeScript, duplicate
    # extension.js/prefs.js/metadata.json, npm tooling, package-lock, and
    # graphical README/demo assets unrelated to the installed runtime.
    for kind in ("*.js",):
        for source in sorted((VENDOR / "dist").rglob(kind)):
            add(source)
    for source in sorted((VENDOR / "shaders").glob("*.frag")):
        add(source)
    for source in sorted((VENDOR / "icons").glob("*.svg")):
        add(source)
    add(VENDOR / "stylesheet.css")

    # Legally required copyright/license/provenance files.
    add(ROOT / "LICENSE", "LICENSE")
    add(ROOT / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")
    add(VENDOR / "LICENSE")
    add(VENDOR / "UPSTREAM.md")

    return dict(sorted(payload.items()))


def verify(payload: dict[str, bytes]) -> dict[str, str]:
    names = set(payload)
    required = {
        "metadata.json",
        "extension.js",
        "prefs.js",
        "stylesheet.css",
        "runtime.js",
        "runtime.css",
        "orbThemeRuntime.js",
        "quickBrightness.js",
        "nativeCssIntegration.js",
        "fullscreenPanelGuard.js",
        "wallpaperAtmosphere.js",
        "wallpaperAtmosphereEffect.js",
        "wallpaperAtmospherePreferences.js",
        "schemas/" + CANONICAL_SCHEMA,
        "schemas/" + VENDOR_SCHEMA,
        "vendor/liquid-glass/dist/liquidEffect.js",
        "vendor/liquid-glass/dist/rendering/material.js",
        "vendor/liquid-glass/shaders/glass.frag",
        "vendor/liquid-glass/stylesheet.css",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "vendor/liquid-glass/LICENSE",
    }
    absent = required - names
    if absent:
        raise ValueError("Required runtime files missing: " + ", ".join(sorted(absent)))

    if any(n.endswith("gschemas.compiled") for n in names):
        raise ValueError("Compiled GSettings schemas must not be submitted")
    if any(n.endswith("/metadata.json") for n in names):
        raise ValueError("A nested upstream extension metadata.json is forbidden")
    if any(n.endswith((".sh", ".py", ".ts", ".map", ".lock")) for n in names):
        raise ValueError("Development/build source leaked into Store ZIP")
    if any(n.startswith(("tools/", "docs/", ".github/", "vendor/liquid-glass/src/")) for n in names):
        raise ValueError("Unnecessary development source leaked into Store ZIP")
    if any(PurePosixPath(n).suffix in DANGEROUS for n in names):
        raise ValueError("Unexpected executable or TypeScript in Store ZIP")
    if any(n.endswith("node_modules") or "/node_modules/" in n for n in names):
        raise ValueError("Bundled npm dependencies are not permitted")

    meta = json.loads(payload["metadata.json"].decode("utf-8"))
    if meta.get("uuid") != "vliq@wonderer.tech":
        raise ValueError("Incorrect EGO extension UUID")
    if meta.get("shell-version") != ["50"]:
        raise ValueError("The supported shell version must be GNOME 50 only")
    if meta.get("settings-schema") != "org.gnome.shell.extensions.vliq":
        raise ValueError("Canonical GSettings schema mismatch")

    for key in ("schemas/" + CANONICAL_SCHEMA, "schemas/" + VENDOR_SCHEMA):
        xml = ElementTree.fromstring(payload[key])
        if xml.tag != "schemalist" or not xml.findall("schema"):
            raise ValueError("Malformed packaged GSettings schema " + key)
    schema_ids = {
        s.get("id") for name in ("schemas/" + CANONICAL_SCHEMA,
                               "schemas/" + VENDOR_SCHEMA)
        for s in ElementTree.fromstring(payload[name]).findall("schema")
    }
    if meta["settings-schema"] not in schema_ids or not any(
        s.startswith("org.gnome.shell.extensions.liquid-glass@")
        for s in schema_ids
    ):
        raise ValueError("Both canonical and vendor GSettings schema IDs required")

    # Catch missing local ESM dependencies before submitting the ZIP. GJS
    # built-in gi:// and resource:/// imports are intentionally exempt.
    for name, content in payload.items():
        if not name.endswith(".js"):
            continue
        text = content.decode("utf-8")
        rels = re.findall(
            r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.\.?/[^'"]+)['"]""",
            text,
        )
        for rel in rels:
            parts = list(PurePosixPath(name).parent.parts)
            for part in PurePosixPath(rel).parts:
                if part == "..":
                    if not parts:
                        raise ValueError(f"Import escapes package root: {name} -> {rel}")
                    parts.pop()
                elif part != ".":
                    parts.append(part)
            target = PurePosixPath(*parts).as_posix()
            if target not in names:
                raise ValueError(f"Broken import: {name} -> {rel} (missing {target})")

    return {name: hashlib.sha256(data).hexdigest() for name, data in payload.items()}


def create_zip(path: Path, payload: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9, strict_timestamps=True) as archive:
        for name, data in payload.items():
            # Deterministic bytes make it possible to compare independently
            # built reviewer artifacts without a Git checkout on device.
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED,
                             compresslevel=9)
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("Archive CRC verification failed")
        extracted = {name: archive.read(name) for name in archive.namelist()}
        if extracted != payload:
            raise ValueError("ZIP round-trip content mismatch")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out-dir", type=Path, default=ROOT / "dist" / "ego")
    p.add_argument("--check-only", action="store_true")
    args = p.parse_args()

    payload = collect()
    checksums = verify(payload)
    total_bytes = sum(map(len, payload.values()))
    if args.check_only:
        print(f"EGO source package preflight PASS: {len(payload)} files, "
              f"{total_bytes:,} bytes uncompressed")
        return
    path = args.out_dir / ARCHIVE_NAME
    create_zip(path, payload)
    manifest = args.out_dir / "vliq-ego-manifest.json"
    manifest.write_text(json.dumps({
        "uuid": "vliq@wonderer.tech",
        "gnome_shell": ["50"],
        "archive_name": path.name,
        "archive_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "file_count": len(payload),
        "uncompressed_bytes": total_bytes,
        "files_sha256": checksums,
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"EGO source package PASS: {path}")
    print(f"  Files: {len(payload)}; source bytes: {total_bytes:,}; "
          f"zip bytes: {path.stat().st_size:,}")
    print(f"  SHA256: {hashlib.sha256(path.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"EGO source package FAILED: {error}", file=sys.stderr)
        raise SystemExit(1) from error
