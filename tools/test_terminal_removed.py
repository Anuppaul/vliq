"""Prevent accidental reintroduction of retired Terminal Glass functionality."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "gnome-shell" / "vliq@wonderer.tech"


class RetiredTerminalFeatureTests(unittest.TestCase):
    def test_runtime_and_preferences_are_clean(self):
        for name in ("terminalBackdropBlur.js", "terminalBlurMask.js"):
            self.assertFalse((EXT / name).exists(), name)
        prefs = (EXT / "prefs.js").read_text(encoding="utf-8")
        runtime = (EXT / "orbThemeRuntime.js").read_text(encoding="utf-8")
        schema = (EXT / "schemas" /
                  "org.gnome.shell.extensions.vliq.gschema.xml").read_text(encoding="utf-8")
        for content in (prefs, runtime, schema):
            self.assertNotIn("terminal-backdrop-blur-", content)
            self.assertNotIn("TerminalBackdropBlurManager", content)
        self.assertNotIn("'Terminal',", prefs)
        self.assertNotIn("terminalBackdropBlur.js", runtime)

    def test_packaging_and_installer_retire_removed_modules(self):
        installer = (ROOT / "gnome-shell" / "install.sh").read_text(encoding="utf-8")
        builder = (ROOT / "tools" / "build_ego_release.py").read_text(encoding="utf-8")
        workflow = (ROOT / ".github/workflows/repository-checks.yml").read_text(encoding="utf-8")
        for old_name in ("terminalBackdropBlur.js", "terminalBlurMask.js"):
            self.assertIn(old_name, installer,
                          "installed legacy modules must be cleaned")
            self.assertNotIn('"' + old_name + '",', builder)
            self.assertNotIn('"' + old_name + '"\\n', installer)
        for old_test in ("test_terminal_backdrop_blur.mjs",
                         "test_terminal_blur_mask.mjs"):
            self.assertNotIn(old_test, workflow)

    def test_documentation_shows_current_features(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for word in ("Three live-switchable materials", "Milky Glass",
                     "deep charcoal", "notification badges"):
            self.assertIn(word, readme)
        for obsolete in ("docs/TERMINAL_GLASS.md",
                         "tools/vliq_terminal_glass.py"):
            self.assertNotIn(obsolete, readme)
        for old in ("docs/TERMINAL_GLASS.md",
                    "tools/test_terminal_glass.py",
                    "tools/vliq_terminal_glass.py"):
            self.assertFalse((ROOT / old).exists(), old)


if __name__ == "__main__":
    unittest.main()
