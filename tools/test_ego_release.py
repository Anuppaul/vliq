"""Regression tests for the exact GNOME Extensions Store archive manifest."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


BUILDER = Path(__file__).resolve().parent / "build_ego_release.py"
spec = importlib.util.spec_from_file_location("build_ego_release", BUILDER)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EGOReleaseArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.package = module.collect()
        self.checksums = module.verify(self.package)

    def test_runtime_is_at_zip_root_not_uuid_wrapper(self):
        names = set(self.package)
        self.assertIn("extension.js", names)
        self.assertIn("metadata.json", names)
        self.assertIn("runtime.js", names)
        self.assertIn("prefs.js", names)
        self.assertNotIn("vliq@wonderer.tech/extension.js", names)
        manifest = json.loads(self.package["metadata.json"])
        self.assertEqual(manifest["uuid"], "vliq@wonderer.tech")
        self.assertEqual(manifest["shell-version"], ["50"])
        self.assertNotIn("version", manifest)

    def test_retired_desktop_widgets_are_not_packaged(self):
        names = set(self.package)
        self.assertNotIn("desktopClockWidget.js", names)
        self.assertNotIn("desktopCalendarWidget.js", names)
        self.assertNotIn("clock-widget-enabled",
                         self.package["schemas/org.gnome.shell.extensions.vliq.gschema.xml"]
                         .decode("utf-8"))
        self.assertNotIn("calendar-widget-enabled",
                         self.package["schemas/org.gnome.shell.extensions.vliq.gschema.xml"]
                         .decode("utf-8"))
        self.assertNotIn("desktopClockWidget",
                         self.package["orbThemeRuntime.js"].decode("utf-8"))
        self.assertNotIn("desktopCalendarWidget",
                         self.package["orbThemeRuntime.js"].decode("utf-8"))

    def test_two_schemas_are_in_top_level_standard_directory(self):
        schemas = {
            k for k in self.package
            if k.startswith("schemas/") and k.endswith(".gschema.xml")
        }
        self.assertEqual(schemas, {
            "schemas/org.gnome.shell.extensions.vliq.gschema.xml",
            "schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml",
        })
        self.assertFalse(any(p.endswith("gschemas.compiled") for p in self.package))

    def test_vendor_is_runtime_only_and_attributed(self):
        names = set(self.package)
        self.assertIn("vendor/liquid-glass/LICENSE", names)
        self.assertIn("vendor/liquid-glass/UPSTREAM.md", names)
        self.assertIn("THIRD_PARTY_NOTICES.md", names)
        self.assertIn("vendor/liquid-glass/dist/liquidEffect.js", names)
        self.assertIn("vendor/liquid-glass/shaders/glass.frag", names)
        self.assertIn("vendor/liquid-glass/stylesheet.css", names)
        self.assertFalse(any("/src/" in n for n in names))
        self.assertFalse(any(n.endswith((".ts", ".map", ".so")) for n in names))
        self.assertFalse(any(n.startswith("tools/") for n in names))
        self.assertFalse(any(n.endswith("install.sh") for n in names))
        self.assertFalse(any(
            n.endswith("/metadata.json") or n.endswith("/extension.js")
            for n in names
        ))

    def test_zip_is_byte_reproducible_and_has_manifest_compatible_hashes(self):
        with tempfile.TemporaryDirectory(prefix="vliq-ego-test-") as tmp:
            first = Path(tmp) / "a.zip"
            second = Path(tmp) / "b.zip"
            module.create_zip(first, self.package)
            module.create_zip(second, self.package)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with ZipFile(first) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.namelist(), sorted(self.package))
                self.assertEqual(archive.read("extension.js"),
                                 self.package["extension.js"])
            self.assertEqual(self.checksums["extension.js"],
                             hashlib.sha256(self.package["extension.js"]).hexdigest())

    def test_missing_runtime_import_is_rejected(self):
        invalid = dict(self.package)
        invalid.pop("runtime.js")
        with self.assertRaisesRegex(ValueError, "Required runtime files missing"):
            module.verify(invalid)

    def test_nested_metadata_is_rejected(self):
        invalid = dict(self.package)
        invalid["vendor/liquid-glass/metadata.json"] = b"{}"
        with self.assertRaisesRegex(ValueError, "nested upstream"):
            module.verify(invalid)


if __name__ == "__main__":
    unittest.main()
