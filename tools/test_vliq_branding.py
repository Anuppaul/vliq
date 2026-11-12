"""Full VLIQ GNOME extension identity, packaging, and preserved migration tests."""
from __future__ import annotations

import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "gnome-shell" / "vliq@wonderer.tech"
METADATA = EXT / "metadata.json"
SCHEMA = EXT / "schemas" / "org.gnome.shell.extensions.vliq.gschema.xml"


class VLIQBrandingTests(unittest.TestCase):
    def test_exact_product_name(self):
        metadata = json.loads(METADATA.read_text(encoding="utf-8"))
        self.assertEqual(metadata["name"], "VLIQ")
        self.assertEqual(metadata["shell-version"], ["50"])
        self.assertNotIn("VLIQ Desktop", metadata["description"])

    def test_canonical_new_extension_uuid_and_schema(self):
        metadata = json.loads(METADATA.read_text(encoding="utf-8"))
        self.assertEqual(metadata["uuid"], "vliq@wonderer.tech")
        self.assertEqual(metadata["settings-schema"],
                         "org.gnome.shell.extensions.vliq")
        self.assertEqual(metadata["url"],
                         "https://github.com/Anuppaul/vliq")
        schema = SCHEMA.read_text(encoding="utf-8")
        self.assertIn(
            '<schema id="org.gnome.shell.extensions.vliq" '
            'path="/org/gnome/shell/extensions/vliq/">', schema
        )
        for key in ("orb-enabled", "quick-brightness-enabled",
                    "spotlight-enabled"):
            self.assertIn(f'name="{key}"', schema)

    def test_new_installer_and_automatic_reversible_migration(self):
        script = (ROOT / "gnome-shell" / "install.sh").read_text()
        self.assertIn('UUID="vliq@wonderer.tech"', script)
        self.assertIn('VLIQ_SCHEMA="org.gnome.shell.extensions.vliq"',
                      script)
        self.assertIn("VLIQ installer:", script)
        for action in ("prepare", "retire", "rollback"):
            self.assertIn(f'migrate_legacy_install.py" {action}', script)
        self.assertNotIn("VLIQ Desktop", script)

    def test_vliq_store_zip_release_archive_and_title(self):
        builder = (ROOT / "tools" / "build_ego_release.py").read_text()
        self.assertIn(
            'ARCHIVE_NAME = "vliq@wonderer.tech.shell-extension.zip"',
            builder
        )
        release = (ROOT / ".github" / "workflows" / "release.yml").read_text()
        self.assertIn('ARCHIVE="vliq-${VERSION}.tar.gz"'.replace("\\", ""), release)
        self.assertIn('--title "VLIQ ${TAG}"'.replace("\\", ""), release)
        self.assertNotIn("VLIQ Desktop", release)

    def test_preferences_runtime_and_wallpaper_preset_brand(self):
        prefs = (EXT / "prefs.js").read_text()
        runtime = (EXT / "orbThemeRuntime.js").read_text()
        presets = (EXT / "wallpaperAtmosphereConfig.js").read_text()
        self.assertIn("Milky Glass", prefs)
        self.assertNotIn("terminal-backdrop-blur", prefs)
        self.assertIn("VLIQ", runtime)
        for name in ("VLIQ Natural", "VLIQ Cinematic",
                     "VLIQ Atmosphere"):
            self.assertIn(name, presets)
        for source in (prefs, runtime, presets):
            self.assertNotIn("VLIQ Desktop", source)

    def test_glass_renderer_shared_api_is_consistent(self):
        consumer = (EXT / "liquidGlassDock.js").read_text()
        producer = (EXT / "glassMaterialSystem.js").read_text()
        self.assertIn("applyVLIQGlassRole", consumer)
        self.assertIn("export function applyVLIQGlassRole(", producer)
        self.assertNotIn("applyVeloraGlassRole", consumer)

    def test_docs_public_name_and_legacy_migration_only(self):
        readme = (ROOT / "README.md").read_text()
        self.assertTrue(readme.startswith("# VLIQ\n"))
        self.assertIn("## Why VLIQ", readme)
        self.assertIn("VLIQ", (ROOT / "gnome-shell" / "README.md").read_text())
        migration = (ROOT / "docs" / "VLIQ_REBRAND.md").read_text()
        self.assertIn("Public name: VLIQ.", migration)
        self.assertIn("vliq@wonderer.tech", migration)
        helper = (ROOT / "gnome-shell" / "migrate_legacy_install.py").read_text()
        self.assertIn('LEGACY_UUID = "velora@wonderer.tech"', helper)
        self.assertIn('NEW_UUID = "vliq@wonderer.tech"', helper)


if __name__ == "__main__":
    unittest.main()
