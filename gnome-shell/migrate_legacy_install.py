#!/usr/bin/env python3
"""One-time, reversible GNOME Shell VLIQ migration from the previous UUID.

Run by gnome-shell/install.sh during the first VLIQ install. The previous
extension's existing dconf preferences are backed up and migrated into the
new canonical VLIQ path before the old GNOME extension is disabled. Nothing
here deletes old user dconf data; a separate *explicit* finalize command
removes the disabled legacy installation only after VLIQ is verified live.

The former identity is referenced ONLY because it is necessary to migrate
an existing user installation; it is never shipped in the EGO Store ZIP.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

LEGACY_UUID = "velora@wonderer.tech"
NEW_UUID = "vliq@wonderer.tech"
LEGACY_DCONF = "/org/gnome/shell/extensions/velora/"
NEW_DCONF = "/org/gnome/shell/extensions/vliq/"

# These keys reflect the old running shell or ownership of Ubuntu Dock.
# Copy user options but NEVER claim a previous process's ownership state.
TRANSIENT_KEYS = {
    "bootstrap-loaded-generation",
    "bootstrap-loaded-revision",
    "runtime-revision",
    "runtime-loaded-revision",
    "runtime-error",
    # Retired Terminal Glass settings are no longer imported into VLIQ.
    "terminal-backdrop-blur-enabled",
    "terminal-backdrop-blur-radius",
    "terminal-backdrop-blur-status",
    "wallpaper-runtime-status",
    "dock-state-captured",
    "dock-extension-state-captured",
}
TRANSIENT_PREFIXES = ("dock-original-",)
KEY_PATTERN = re.compile(r"^([A-Za-z][A-Za-z0-9-]*)\s*=")


def state_root() -> Path:
    base = os.environ.get("XDG_STATE_HOME")
    return ((Path(base).expanduser() if base else
             Path.home() / ".local" / "state") / "vliq")


def old_extension_dir() -> Path:
    data = os.environ.get("XDG_DATA_HOME")
    root = Path(data).expanduser() if data else Path.home() / ".local" / "share"
    return root / "gnome-shell" / "extensions" / LEGACY_UUID


def command(args: list[str], *, input_text: str | None = None,
            required: bool = True) -> str:
    try:
        result = subprocess.run(
            args, input=input_text, capture_output=True, text=True,
            timeout=20, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        if not required:
            return ""
        raise RuntimeError(f"{args[0]} unavailable: {error}") from error
    if result.returncode != 0:
        if not required:
            return ""
        raise RuntimeError(
            f"{args[0]} exited with {result.returncode}: "
            f"{result.stderr.strip()[:240]}"
        )
    return result.stdout


def ensure_private_dir(root: Path) -> None:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink():
        raise RuntimeError("VLIQ migration state directory may not be a symlink")
    os.chmod(root, 0o700)


def atomic_private_write(path: Path, content: str) -> None:
    ensure_private_dir(path.parent)
    if path.is_symlink():
        raise RuntimeError("Refusing to overwrite symlinked migration state")
    fd, temporary = tempfile.mkstemp(prefix=".vliq-migrate-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def filter_user_settings(dump: str) -> str:
    """Retain GVariant values/sections verbatim, excluding runtime state."""
    output = []
    for line in dump.splitlines(keepends=True):
        match = KEY_PATTERN.match(line)
        if match:
            key = match.group(1)
            if key in TRANSIENT_KEYS or key.startswith(TRANSIENT_PREFIXES):
                continue
        output.append(line)
    return "".join(output)


def load_state() -> dict:
    location = state_root() / "migration-state.json"
    if not location.is_file():
        return {}
    if location.is_symlink():
        raise RuntimeError("Migration state is a symlink")
    try:
        value = json.loads(location.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read migration state: {error}") from error
    if not isinstance(value, dict) or value.get("version") != 1:
        raise RuntimeError("Unexpected VLIQ migration state format")
    return value


def save_state(value: dict) -> None:
    atomic_private_write(
        state_root() / "migration-state.json",
        json.dumps(value, sort_keys=True, indent=2) + "\n",
    )


def is_active(uuid: str) -> bool:
    output = command(["gnome-extensions", "list", "--active"],
                     required=False)
    return uuid in output.splitlines()


def read_shell_extension_list(key: str) -> list[str]:
    """Use GNOME's persisted extension flags, not just current-session state.

    A first install can be invisible to the running Wayland Shell until the
    next login. Ignoring the persisted list could re-enable BOTH UUIDs at
    the next login even when the old extension isn't currently active.
    """
    if key not in ("enabled-extensions", "disabled-extensions"):
        raise ValueError("Unsupported GNOME extension-list key")
    raw = command(["gsettings", "get", "org.gnome.shell", key]).strip()
    if raw.startswith("@as "):
        raw = raw[4:].strip()
    try:
        values = ast.literal_eval(raw)
    except (ValueError, SyntaxError) as error:
        raise RuntimeError(f"Invalid GNOME {key} value") from error
    if not isinstance(values, list) or not all(
        isinstance(value, str) for value in values
    ):
        raise RuntimeError(f"Unexpected GNOME {key} type")
    return values


def set_shell_extension_membership(uuid: str, enabled: bool) -> None:
    """Move only one UUID between GNOME's user extension lists.

    Keep every other extension and its order untouched, including Ubuntu
    Dock. This is separate from GNOME's live enable/disable RPC, which may
    fail when a newly installed UUID is not yet discovered on Wayland.
    """
    enabled_list = read_shell_extension_list("enabled-extensions")
    disabled_list = read_shell_extension_list("disabled-extensions")
    enabled_list = [item for item in enabled_list if item != uuid]
    disabled_list = [item for item in disabled_list if item != uuid]
    if enabled:
        enabled_list.append(uuid)
    else:
        disabled_list.append(uuid)

    def render(values: list[str]) -> str:
        return "[" + ", ".join(repr(value) for value in values) + "]"

    # Apply the disabled list first: during migration, preventing two
    # simultaneously active shaders is more important than eager enable.
    command(["gsettings", "set", "org.gnome.shell",
             "disabled-extensions", render(disabled_list)])
    command(["gsettings", "set", "org.gnome.shell",
             "enabled-extensions", render(enabled_list)])


def prepare() -> None:
    if not shutil.which("dconf"):
        # New installations don't need dconf for a migration. If the old
        # extension exists, however, migration cannot safely be skipped.
        if old_extension_dir().exists():
            raise RuntimeError(
                "dconf is required to preserve the previous extension's settings"
            )
        print("VLIQ: no previous dconf state to migrate.")
        return

    legacy = command(["dconf", "dump", LEGACY_DCONF])
    found = old_extension_dir().is_dir() or bool(legacy.strip())
    if not found:
        print("VLIQ: fresh installation; no legacy extension detected.")
        return

    root = state_root()
    state = load_state()
    if state.get("prepared"):
        print("VLIQ: existing migration checkpoint preserved.")
        return

    ensure_private_dir(root)
    # Back up the old settings BEFORE any writes and never delete them.
    if legacy.strip():
        backup = root / "legacy-settings-backup.ini"
        if not backup.exists():
            atomic_private_write(backup, legacy)

    existing_new = command(["dconf", "dump", NEW_DCONF])
    migrated = False
    filtered = filter_user_settings(legacy)
    if filtered.strip() and not existing_new.strip():
        command(["dconf", "load", NEW_DCONF], input_text=filtered)
        migrated = True
    elif existing_new.strip():
        print("VLIQ: existing new settings retained; not overwritten.")

    save_state({
        "version": 1,
        "prepared": True,
        "settings_copied": migrated,
        "retired": False,
    })
    print("VLIQ: existing settings backed up and prepared without deletion.")


def retire() -> None:
    # Only called after the new UUID is successfully installed and compiled.
    state = load_state()
    if not state.get("prepared"):
        print("VLIQ: no old installation to retire.")
        return
    if state.get("retired"):
        return

    was_active = is_active(LEGACY_UUID)
    was_enabled = LEGACY_UUID in read_shell_extension_list(
        "enabled-extensions"
    )
    if not (was_active or was_enabled):
        print("VLIQ: previous extension was already disabled.")
        return

    # The Shell may not currently know about an installed old UUID, even
    # though it remains enabled in org.gnome.shell for the NEXT login.
    # Persist the new membership independently of the live shell state.
    state["legacy_was_enabled"] = True
    state["retirement_pending"] = True
    save_state(state)
    try:
        if was_active:
            command(["gnome-extensions", "disable", LEGACY_UUID])
        set_shell_extension_membership(LEGACY_UUID, False)
    except Exception:
        # Do not strand the user with the old extension disabled and new
        # UUID undiscovered. Preserve the checkpoint if recovery fails.
        try:
            set_shell_extension_membership(LEGACY_UUID, True)
            command(["gnome-extensions", "enable", LEGACY_UUID],
                    required=False)
        finally:
            raise

    state["retirement_pending"] = False
    state["retired"] = True
    save_state(state)
    print("VLIQ: previous extension disabled for current and next sessions.")


def rollback() -> None:
    state = load_state()
    # Even on a fresh install, a failure after persist_extension_enabled
    # must remove the new UUID from the *next* session's enabled list.
    command(["gnome-extensions", "disable", NEW_UUID], required=False)
    set_shell_extension_membership(NEW_UUID, False)

    if not (state.get("retired") or state.get("retirement_pending")):
        print("VLIQ: failed new extension disabled; no previous runtime to restore.")
        return

    if state.get("legacy_was_enabled", True):
        set_shell_extension_membership(LEGACY_UUID, True)
        command(["gnome-extensions", "enable", LEGACY_UUID],
                required=False)
    state["retired"] = False
    state["retirement_pending"] = False
    save_state(state)
    print("VLIQ: rollback restored the previous extension.")


def finalize() -> None:
    """Explicit, non-destructive cleanup AFTER users verify VLIQ working."""
    if not is_active(NEW_UUID):
        raise RuntimeError("VLIQ must be active before removing the old extension")
    state = load_state()
    if not state.get("prepared"):
        print("VLIQ: no legacy install to finalize.")
        return
    if is_active(LEGACY_UUID):
        raise RuntimeError("Old extension is still active; refusing to uninstall")
    if old_extension_dir().exists():
        command(["gnome-extensions", "uninstall", LEGACY_UUID])
    # Deliberately preserve backup and old dconf values for user recovery.
    state["finalized"] = True
    save_state(state)
    print("VLIQ: old extension files removed; settings backup retained.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "retire", "rollback", "finalize"])
    args = parser.parse_args(argv)
    try:
        globals()[args.action]()
    except RuntimeError as error:
        print("VLIQ migration: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
