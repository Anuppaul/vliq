#!/usr/bin/env bash
set -euo pipefail

UUID="vliq@wonderer.tech"
VLIQ_SCHEMA="org.gnome.shell.extensions.vliq"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/${UUID}"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SCHEMA_DIR="${SOURCE_DIR}/schemas"
BOOTSTRAP_MARKER="${TARGET_DIR}/.vliq-bootstrap-generation"
BOOTSTRAP_REVISION_MARKER="${TARGET_DIR}/.vliq-bootstrap-revision"
INSTALLER_VERSION="2026-10-02.220"

BOOTSTRAP_FILES=(
    "extension.js"
    "metadata.json"
    "stylesheet.css"
)

HOT_AUX_FILES=(
    "prefs.js"
    "nativeDockPreferences.js"
    "wallpaperAtmospherePreferences.js"
    "wallpaperAtmosphereConfig.js"
    "schemas/org.gnome.shell.extensions.vliq.gschema.xml"
)

RUNTIME_FILES=(
    "runtime.js"
    "orbThemeRuntime.js"
    "runtime.css"
    "apps.js"
    "geometry.js"
    "liquidGlassDock.js"
    "fullscreenPanelGuard.js"
    "glassMaterialSystem.js"
    "notificationGlass.js"
    "popupGlass.js"
    "shellCards.js"
    "appGridBackdrop.js"
    "wallpaperAtmosphere.js"
    "wallpaperAtmosphereEffect.js"
    "wallpaperAtmosphereConfig.js"
    "overviewSearchGlass.js"
    "overviewCloseGlass.js"
    "searchSurface.js"
    "spotlightGlass.js"
    "spotlightSearch.js"
    "quickBrightness.js"
    "terminalBackdropBlur.js"
    "terminalBlurMask.js"
    "sharedAdaptiveText.js"
    "orbGlass.js"
    "panelGlass.js"
    "topBarIslands.js"
    "bottomTaskbar.js"
    "frameBudget.js"
)

RUNTIME_DIRS=(
    "vendor/liquid-glass"
)

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

# Remove obsolete standalone widgets from legacy installations.
# The built-in GNOME top-bar clock and Date Menu are not affected.
remove_retired_widgets_in_dir() {
    local root="$1"
    rm -f "${root}/desktopClockWidget.js" "${root}/desktopCalendarWidget.js"
}

refresh_prefs_process() {
    # Ensure the new preferences module is on disk before closing the old
    # GNOME Extensions process (which may cache the previous JS module).
    [[ -f "${TARGET_DIR}/prefs.js" ]] ||
        fail "VLIQ preferences file was not installed."
    cmp -s "${SOURCE_DIR}/prefs.js" "${TARGET_DIR}/prefs.js" ||
        fail "Installed preferences differ from the requested checkout."
    if grep -Fq "'Widgets'," "${TARGET_DIR}/prefs.js" ||
       grep -Fq "clock-widget-enabled" "${TARGET_DIR}/schemas/org.gnome.shell.extensions.vliq.gschema.xml"; then
        fail "Retired desktop widgets were left in installed VLIQ."
    fi

    if command -v gapplication >/dev/null 2>&1; then
        gapplication quit org.gnome.Extensions >/dev/null 2>&1 || true
    fi
    echo "Verified: desktop widget controls and schema keys are retired."
    echo "Open settings with: gnome-extensions prefs ${UUID}"
}

for command_name in \
    gnome-shell gnome-extensions glib-compile-schemas gsettings python3 \
    mktemp sed grep sha256sum mkdir cp cmp rm sleep cat head tr env dirname find sort; do
    command -v "${command_name}" >/dev/null 2>&1 ||
        fail "${command_name} was not found."
done

for required_file in \
    "${BOOTSTRAP_FILES[@]}" "${HOT_AUX_FILES[@]}" "${RUNTIME_FILES[@]}"; do
    [[ -f "${SOURCE_DIR}/${required_file}" ]] ||
        fail "Required VLIQ file is missing: ${required_file}"
done

for required_dir in "${RUNTIME_DIRS[@]}"; do
    [[ -d "${SOURCE_DIR}/${required_dir}" ]] ||
        fail "Required VLIQ runtime directory is missing: ${required_dir}"
done

GNOME_VERSION="$(gnome-shell --version 2>/dev/null)" ||
    fail "Unable to read the GNOME Shell version."

echo "Detected: ${GNOME_VERSION}"
echo "VLIQ installer: ${INSTALLER_VERSION}"

GNOME_MAJOR="$(
    sed -nE 's/.* ([0-9]+)(\.[0-9]+.*)?$/\1/p' <<<"${GNOME_VERSION}"
)"
[[ -n "${GNOME_MAJOR}" ]] ||
    fail "Unable to parse GNOME Shell version: ${GNOME_VERSION}"
[[ "${GNOME_MAJOR}" == "50" ]] ||
    fail "This VLIQ branch targets GNOME Shell 50 only."

echo "Validating GSettings schema..."
glib-compile-schemas --strict --dry-run "${SCHEMA_DIR}"

# One-time migration is prepared only AFTER schema validation. It never
# removes the old installation or overwrites a configured VLIQ profile.
# The previous UUID is referenced only by the migration helper.
python3 "${SCRIPT_DIR}/migrate_legacy_install.py" prepare

SOURCE_BOOTSTRAP_GENERATION="$(
    sed -nE "s/^[[:space:]]*export[[:space:]]+const[[:space:]]+VLIQ_BOOTSTRAP_GENERATION[[:space:]]*=[[:space:]]*'([^']+)'.*/\\1/p" \
        "${SOURCE_DIR}/extension.js" | head -n1
)"
[[ -n "${SOURCE_BOOTSTRAP_GENERATION}" ]] ||
    fail "Unable to read VLIQ bootstrap generation from extension.js"

bootstrap_revision_for_dir() {
    local root="$1"
    local file

    for file in "${BOOTSTRAP_FILES[@]}"; do
        [[ -f "${root}/${file}" ]] || return 1
    done

    {
        for file in "${BOOTSTRAP_FILES[@]}"; do
            printf '%s\0' "${file}"
            cat "${root}/${file}"
        done
    } | sha256sum | sed -E 's/^([0-9a-f]{24}).*/\1/'
}

SOURCE_BOOTSTRAP_REVISION="$(bootstrap_revision_for_dir "${SOURCE_DIR}")" ||
    fail "Unable to fingerprint VLIQ bootstrap scaffold."

read_string_setting() {
    local key="$1"

    env GSETTINGS_SCHEMA_DIR="${TARGET_DIR}/schemas" \
        gsettings get "${VLIQ_SCHEMA}" "${key}" 2>/dev/null |
        sed -e "s/^'//" -e "s/'$//"
}

write_string_setting() {
    local key="$1"
    local value="$2"

    env GSETTINGS_SCHEMA_DIR="${TARGET_DIR}/schemas" \
        gsettings set "${VLIQ_SCHEMA}" "${key}" "'${value}'"
}

read_marker() {
    local path="$1"

    [[ -f "${path}" ]] || return 1
    head -n1 "${path}" 2>/dev/null | tr -d '\r\n'
}

installed_bootstrap_generation() {
    local generation=""

    generation="$(read_marker "${BOOTSTRAP_MARKER}" || true)"
    if [[ -n "${generation}" ]]; then
        printf '%s' "${generation}"
        return 0
    fi

    if [[ -f "${TARGET_DIR}/extension.js" ]]; then
        generation="$(
            sed -nE "s/^[[:space:]]*export[[:space:]]+const[[:space:]]+VLIQ_BOOTSTRAP_GENERATION[[:space:]]*=[[:space:]]*'([^']+)'.*/\\1/p" \
                "${TARGET_DIR}/extension.js" | head -n1
        )"
    fi

    [[ -n "${generation}" ]] || return 1
    printf '%s' "${generation}"
}

installed_bootstrap_revision() {
    local revision=""

    revision="$(read_marker "${BOOTSTRAP_REVISION_MARKER}" || true)"
    if [[ -n "${revision}" ]]; then
        printf '%s' "${revision}"
        return 0
    fi

    bootstrap_revision_for_dir "${TARGET_DIR}"
}

record_bootstrap_identity() {
    mkdir -p "${TARGET_DIR}"
    printf '%s\n' "${SOURCE_BOOTSTRAP_GENERATION}" > "${BOOTSTRAP_MARKER}"
    printf '%s\n' "${SOURCE_BOOTSTRAP_REVISION}" > "${BOOTSTRAP_REVISION_MARKER}"
}

bootstrap_scaffold_compatible() {
    local installed_generation
    local installed_revision

    [[ -d "${TARGET_DIR}" ]] || return 1
    [[ -f "${TARGET_DIR}/extension.js" ]] || return 1
    [[ -f "${TARGET_DIR}/metadata.json" ]] || return 1
    grep -Fq "VLIQ_BOOTSTRAP_API = 1" "${TARGET_DIR}/extension.js" ||
        return 1

    installed_generation="$(installed_bootstrap_generation)" || return 1
    installed_revision="$(bootstrap_revision_for_dir "${TARGET_DIR}")" || return 1

    if [[ "${installed_generation}" != "${SOURCE_BOOTSTRAP_GENERATION}" ||
          "${installed_revision}" != "${SOURCE_BOOTSTRAP_REVISION}" ]]; then
        echo "Installed bootstrap: ${installed_generation} / ${installed_revision}" >&2
        echo "Source bootstrap:    ${SOURCE_BOOTSTRAP_GENERATION} / ${SOURCE_BOOTSTRAP_REVISION}" >&2
        return 1
    fi

    # Schema/prefs are hot auxiliary data; only stable bootstrap bytes define this marker.
    record_bootstrap_identity

    return 0
}

sync_hot_aux() {
    local file
    local live_dir
    local runtime_source
    local destination

    for file in "${HOT_AUX_FILES[@]}"; do
        mkdir -p "$(dirname "${TARGET_DIR}/${file}")"
        cp -f "${SOURCE_DIR}/${file}" "${TARGET_DIR}/${file}"
    done
    remove_retired_widgets_in_dir "${TARGET_DIR}"

    # Liquid Glass registers GObject classes whose type names live for the
    # lifetime of the GNOME Shell process. Keep one canonical vendor tree
    # outside hashed runtime revisions so all later hot-swaps can reuse the
    # same cached module URI instead of evaluating registerClass() again.
    for runtime_source in "${RUNTIME_DIRS[@]}"; do
        destination="${TARGET_DIR}/${runtime_source}"
        rm -rf "${destination}"
        mkdir -p "$(dirname "${destination}")"
        cp -a "${SOURCE_DIR}/${runtime_source}" "${destination}"
    done

    [[ -f "${TARGET_DIR}/vendor/liquid-glass/dist/liquidEffect.js" ]] ||
        fail "Canonical Liquid Glass renderer sync failed."
    [[ -f "${TARGET_DIR}/vendor/liquid-glass/shaders/glass.frag" ]] ||
        fail "Canonical Liquid Glass shader sync failed."

    glib-compile-schemas --strict "${TARGET_DIR}/vendor/liquid-glass/schemas"

    [[ -f "${TARGET_DIR}/vendor/liquid-glass/schemas/gschemas.compiled" ]] ||
        fail "Canonical Liquid Glass GSettings compilation failed."

    glib-compile-schemas --strict "${TARGET_DIR}/schemas"
    [[ -f "${TARGET_DIR}/schemas/gschemas.compiled" ]] ||
        fail "Canonical VLIQ GSettings compilation failed."

    shopt -s nullglob
    for live_dir in "${HOME}"/.cache/vliq-live/"${SOURCE_BOOTSTRAP_REVISION}"-*/"${UUID}"; do
        [[ -d "${live_dir}" ]] || continue
        for file in "${HOT_AUX_FILES[@]}"; do
            mkdir -p "$(dirname "${live_dir}/${file}")"
            cp -f "${SOURCE_DIR}/${file}" "${live_dir}/${file}"
        done
        remove_retired_widgets_in_dir "${live_dir}"

        # prefs.js imports the upstream preference implementation relative to
        # the extension root. A developer live-registration uses live_dir as
        # that root, so mirror the vendored tree there as well.
        for runtime_source in "${RUNTIME_DIRS[@]}"; do
            destination="${live_dir}/${runtime_source}"
            rm -rf "${destination}"
            mkdir -p "$(dirname "${destination}")"
            cp -a "${SOURCE_DIR}/${runtime_source}" "${destination}"
        done

        glib-compile-schemas --strict             "${live_dir}/vendor/liquid-glass/schemas"
        glib-compile-schemas --strict "${live_dir}/schemas"
    done
    shopt -u nullglob

    refresh_prefs_process
}

ensure_bootstrap_active() {
    local loaded_generation
    local loaded_bootstrap_revision
    local loaded_runtime_revision
    local runtime_error
    local enable_output
    local i

    if ! gnome-extensions info "${UUID}" >/dev/null 2>&1; then
        return 20
    fi

    if ! gnome-extensions list --active 2>/dev/null | grep -Fxq "${UUID}"; then
        if ! enable_output="$(gnome-extensions enable "${UUID}" 2>&1)"; then
            echo "GNOME knows VLIQ but could not enable it:" >&2
            [[ -n "${enable_output}" ]] && echo "  ${enable_output}" >&2
            return 21
        fi
    fi

    for ((i = 0; i < 80; i++)); do
        loaded_generation="$(read_string_setting bootstrap-loaded-generation)"
        loaded_bootstrap_revision="$(read_string_setting bootstrap-loaded-revision)"
        loaded_runtime_revision="$(read_string_setting runtime-loaded-revision)"
        runtime_error="$(read_string_setting runtime-error)"

        if [[ -n "${loaded_generation}" &&
              "${loaded_generation}" != "${SOURCE_BOOTSTRAP_GENERATION}" ]]; then
            return 22
        fi


        if [[ "${loaded_generation}" == "${SOURCE_BOOTSTRAP_GENERATION}" &&
              -n "${loaded_runtime_revision}" ]]; then
            # Stable bootstrap bytes already match; normalize the old marker value.
            write_string_setting bootstrap-loaded-revision "${SOURCE_BOOTSTRAP_REVISION}"
            return 0
        fi

        if [[ -n "${runtime_error}" ]]; then
            echo "VLIQ bootstrap runtime error: ${runtime_error}" >&2
            return 23
        fi

        sleep 0.1
    done

    return 24
}

runtime_revision() {
    local file
    local runtime_source
    local relative

    {
        for file in "${RUNTIME_FILES[@]}"; do
            printf '%s\0' "${file}"
            cat "${SOURCE_DIR}/${file}"
        done

        printf '%s\0' "schemas/org.gnome.shell.extensions.vliq.gschema.xml"
        cat "${SOURCE_DIR}/schemas/org.gnome.shell.extensions.vliq.gschema.xml"

        for runtime_source in "${RUNTIME_DIRS[@]}"; do
            while IFS= read -r file; do
                relative="${file#${SOURCE_DIR}/}"
                printf '%s\0' "${relative}"
                cat "${file}"
            done < <(
                find "${SOURCE_DIR}/${runtime_source}" -type f -print |
                    LC_ALL=C sort
            )
        done
    } | sha256sum | sed -E 's/^([0-9a-f]{20}).*/\1/'
}

stage_runtime_revision() {
    local revision="$1"
    local runtime_dir
    local file
    local runtime_source
    local destination

    runtime_dir="${TARGET_DIR}/runtime-revisions/${revision}"
    mkdir -p "${runtime_dir}"

    for file in "${RUNTIME_FILES[@]}"; do
        cp -f "${SOURCE_DIR}/${file}" "${runtime_dir}/${file}"
    done

    for runtime_source in "${RUNTIME_DIRS[@]}"; do
        destination="${runtime_dir}/${runtime_source}"
        rm -rf "${destination}"
        mkdir -p "$(dirname "${destination}")"
        cp -a "${SOURCE_DIR}/${runtime_source}" "${destination}"
    done

    for file in "${RUNTIME_FILES[@]}"; do
        [[ -f "${runtime_dir}/${file}" ]] ||
            fail "Runtime staging is incomplete: ${file}"
    done

    for runtime_source in "${RUNTIME_DIRS[@]}"; do
        [[ -d "${runtime_dir}/${runtime_source}" ]] ||
            fail "Runtime staging is incomplete: ${runtime_source}"
    done

    [[ -f "${runtime_dir}/vendor/liquid-glass/dist/liquidEffect.js" ]] ||
        fail "Vendored Liquid Glass renderer is missing from staged runtime."
    [[ -f "${runtime_dir}/vendor/liquid-glass/shaders/glass.frag" ]] ||
        fail "Vendored Liquid Glass shader is missing from staged runtime."
    [[ -f "${runtime_dir}/vendor/liquid-glass/LICENSE" ]] ||
        fail "Vendored Liquid Glass license is missing from staged runtime."
}

persist_extension_enabled() {
    python3 - "${UUID}" <<'PY'
import ast
import subprocess
import sys

uuid = sys.argv[1]

def read_strv(key):
    raw = subprocess.check_output(
        ["gsettings", "get", "org.gnome.shell", key],
        text=True,
    ).strip()

    if raw.startswith("@as "):
        raw = raw[4:].strip()

    value = ast.literal_eval(raw)
    if not isinstance(value, list):
        raise SystemExit(
            f"Unexpected org.gnome.shell {key} value: {raw}"
        )
    return [str(item) for item in value]

def write_strv(key, values):
    rendered = "[" + ", ".join(repr(item) for item in values) + "]"
    subprocess.check_call(
        ["gsettings", "set", "org.gnome.shell", key, rendered]
    )

enabled = [
    item
    for item in read_strv("enabled-extensions")
    if item != uuid
]
disabled = [
    item
    for item in read_strv("disabled-extensions")
    if item != uuid
]

enabled.append(uuid)

write_strv("disabled-extensions", disabled)
write_strv("enabled-extensions", enabled)
PY
}

print_session_restart_required() {
    echo
    echo "VLIQ is installed and enabled for your user."
    echo "GNOME Shell has not loaded this newly installed local extension in the current session."
    echo
    echo "Log out and log back in once to activate VLIQ."
    echo "No Looking Glass, unsafe-mode, or developer live-registration is required."
}

finish_safe_activation() {
    local status

    persist_extension_enabled

    # Try only GNOME's normal public enable path in the current session.
    # If the running Shell has not discovered this newly installed local
    # extension yet, the persisted enabled state takes effect next login.
    if gnome-extensions info "${UUID}" >/dev/null 2>&1; then
        gnome-extensions enable "${UUID}" >/dev/null 2>&1 || true
    fi

    set +e
    ensure_bootstrap_active
    status=$?
    set -e

    case "${status}" in
        0)
            echo "VLIQ is active in the current GNOME Shell session."
            echo "No logout is required."
            return 0
            ;;
        23)
            echo "VLIQ was discovered but its runtime reported an error." >&2
            echo "Check:" >&2
            echo "  journalctl --user -b -o cat | grep -i -E 'vliq|gnome-shell'" >&2
            return 23
            ;;
        20|21|22|24)
            if [[ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null || echo false)" == "true" ]]; then
                echo
                echo "VLIQ is installed, but GNOME user extensions are globally disabled."
                echo "Re-enable user extensions, then log out and log back in once."
                return 0
            fi

            print_session_restart_required
            return 0
            ;;
        *)
            echo "Unexpected activation status ${status}." >&2
            return "${status}"
            ;;
    esac
}

hot_deploy_runtime() {
    local revision
    local previous_revision
    local runtime_dir
    local loaded_revision
    local runtime_error
    local file
    local i

    revision="$(runtime_revision)"
    previous_revision="$(read_string_setting runtime-revision)"
    [[ -n "${previous_revision}" ]] || previous_revision="base"

    loaded_revision="$(read_string_setting runtime-loaded-revision)"
    if [[ "${revision}" == "${loaded_revision}" ]]; then
        echo "VLIQ runtime is already current: ${revision}"
        echo "No logout is required."
        return 0
    fi

    runtime_dir="${TARGET_DIR}/runtime-revisions/${revision}"
    stage_runtime_revision "${revision}"

    write_string_setting runtime-error ""
    write_string_setting runtime-revision "${revision}"

    echo "Hot-loading VLIQ runtime revision ${revision}..."

    for ((i = 0; i < 80; i++)); do
        loaded_revision="$(read_string_setting runtime-loaded-revision)"
        runtime_error="$(read_string_setting runtime-error)"

        if [[ "${loaded_revision}" == "${revision}" ]]; then
            echo "VLIQ runtime hot-swap succeeded."
            echo "No logout is required."
            return 0
        fi

        if [[ -n "${runtime_error}" ]]; then
            break
        fi

        sleep 0.1
    done

    runtime_error="$(read_string_setting runtime-error)"
    echo "Hot-swap did not complete successfully." >&2

    if [[ -n "${runtime_error}" ]]; then
        echo "Runtime error: ${runtime_error}" >&2
    else
        echo "Runtime acknowledgement timed out." >&2
    fi

    echo "Rolling back to runtime revision ${previous_revision}..." >&2
    write_string_setting runtime-error ""
    write_string_setting runtime-revision "${previous_revision}"

    for ((i = 0; i < 50; i++)); do
        loaded_revision="$(read_string_setting runtime-loaded-revision)"
        if [[ "${loaded_revision}" == "${previous_revision}" ]]; then
            echo "Rollback succeeded." >&2
            break
        fi
        sleep 0.1
    done

    return 1
}

if bootstrap_scaffold_compatible; then
    sync_hot_aux

    set +e
    ensure_bootstrap_active
    BOOTSTRAP_STATUS=$?
    set -e

    case "${BOOTSTRAP_STATUS}" in
        0)
            echo "VLIQ bootstrap is active; using live runtime hot-swap."
            hot_deploy_runtime
            exit $?
            ;;
        20|21|22|24)
            echo "VLIQ bootstrap needs a normal Shell-session refresh."
            persist_extension_enabled
            print_session_restart_required
            exit 0
            ;;
        23)
            echo "VLIQ bootstrap is active, but the current runtime failed."
            echo "Attempting automatic recovery with a fresh hashed runtime..."
            hot_deploy_runtime
            exit $?
            ;;
        *)
            fail "Unexpected bootstrap status ${BOOTSTRAP_STATUS}"
            ;;
    esac
fi

BUILD_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

PACK_ARGS=(pack --force --out-dir="${BUILD_DIR}")

# Only package VLIQ-owned bootstrap/runtime files. Do NOT pass the vendored
# upstream extension tree as --extra-source: it contains its own metadata.json
# and UUID, and GNOME 50 may treat that nested metadata as the package identity.
# The complete vendor tree is copied deterministically into TARGET_DIR after
# gnome-extensions install and before VLIQ is enabled/live-registered.
for source_name in "${RUNTIME_FILES[@]}"; do
    PACK_ARGS+=(--extra-source="${source_name}")
done


PACK_ARGS+=("${SOURCE_DIR}")

echo "Building GNOME extension bundle..."
gnome-extensions "${PACK_ARGS[@]}"

# GNOME versions do not all use the same generated archive basename.
# The output directory is a fresh mktemp directory, so discover the bundle
# that pack actually created instead of assuming ${UUID}.shell-extension.zip.
mapfile -t PACK_CANDIDATES < <(
    find "${BUILD_DIR}" -maxdepth 1 -type f -name '*.zip' -print |
        LC_ALL=C sort
)

if [[ "${#PACK_CANDIDATES[@]}" -eq 0 ]]; then
    echo "gnome-extensions pack returned success but created no zip in:" >&2
    echo "  ${BUILD_DIR}" >&2
    echo "Build directory contents:" >&2
    find "${BUILD_DIR}" -maxdepth 2 -type f -print >&2 || true
    fail "GNOME extension bundle was not produced."
fi

if [[ "${#PACK_CANDIDATES[@]}" -gt 1 ]]; then
    echo "gnome-extensions pack created multiple zip bundles:" >&2
    printf '  %s\n' "${PACK_CANDIDATES[@]}" >&2
    fail "Unable to choose the VLIQ extension bundle safely."
fi

PACK_PATH="${PACK_CANDIDATES[0]}"
echo "Bundle: ${PACK_PATH}"

if command -v unzip >/dev/null 2>&1; then
    REQUIRED_PACKED_FILES=(
        "metadata.json"
        "extension.js"
        "topBarIslands.js"
        "bottomTaskbar.js"
        "prefs.js"
        "stylesheet.css"
        "runtime.js"
        "orbThemeRuntime.js"
        "quickBrightness.js"
        "terminalBackdropBlur.js"
        "terminalBlurMask.js"
        "runtime.css"
        "apps.js"
        "geometry.js"
        "liquidGlassDock.js"
        "fullscreenPanelGuard.js"
        "notificationGlass.js"
        "popupGlass.js"
        "shellCards.js"
        "schemas/org.gnome.shell.extensions.vliq.gschema.xml"
    )

    PACK_LIST="$(unzip -Z1 "${PACK_PATH}")"
    for packed_file in "${REQUIRED_PACKED_FILES[@]}"; do
        grep -Fxq "${packed_file}" <<<"${PACK_LIST}" ||
            fail "Bundle verification failed: ${packed_file} is missing."
    done

    PACK_UUID="$(
        unzip -p "${PACK_PATH}" metadata.json |
            python3 -c 'import json,sys; print(json.load(sys.stdin).get("uuid", ""))'
    )"
    [[ "${PACK_UUID}" == "${UUID}" ]] ||
        fail "Bundle UUID mismatch: expected ${UUID}, got ${PACK_UUID:-<empty>}"
fi

if gnome-extensions info "${UUID}" >/dev/null 2>&1; then
    gnome-extensions disable "${UUID}" >/dev/null 2>&1 || true
fi

echo "Installing VLIQ bootstrap with GNOME's extension installer..."
gnome-extensions install --force "${PACK_PATH}"

[[ -d "${TARGET_DIR}" ]] ||
    fail "Installation completed but ${TARGET_DIR} was not created."

# Do not rely on gnome-extensions install --force to refresh every
# extra source in an already existing user-extension directory. Make the
# canonical on-disk copy deterministic before any current-session live load.
for file in "${BOOTSTRAP_FILES[@]}" "${HOT_AUX_FILES[@]}" "${RUNTIME_FILES[@]}"; do
    parent="$(dirname "${TARGET_DIR}/${file}")"
    mkdir -p "${parent}"
    cp -f "${SOURCE_DIR}/${file}" "${TARGET_DIR}/${file}"
done
remove_retired_widgets_in_dir "${TARGET_DIR}"

for runtime_source in "${RUNTIME_DIRS[@]}"; do
    destination="${TARGET_DIR}/${runtime_source}"
    rm -rf "${destination}"
    mkdir -p "$(dirname "${destination}")"
    cp -a "${SOURCE_DIR}/${runtime_source}" "${destination}"
done

# Remove launcher-era modules left by older VLIQ installs.
rm -f \
    "${TARGET_DIR}/dock.js" \
    "${TARGET_DIR}/floatingDock.js" \
    "${TARGET_DIR}/dateMenuGlass.js"

glib-compile-schemas --strict "${TARGET_DIR}/vendor/liquid-glass/schemas"
[[ -f "${TARGET_DIR}/vendor/liquid-glass/schemas/gschemas.compiled" ]] ||
    fail "Installed Liquid Glass GSettings compilation failed."

glib-compile-schemas --strict "${TARGET_DIR}/schemas"
record_bootstrap_identity
refresh_prefs_process

for installed_file in \
    metadata.json extension.js topBarIslands.js bottomTaskbar.js prefs.js nativeDockPreferences.js wallpaperAtmospherePreferences.js wallpaperAtmosphereConfig.js stylesheet.css \
    runtime.js orbThemeRuntime.js terminalBackdropBlur.js runtime.css apps.js geometry.js \
    liquidGlassDock.js notificationGlass.js popupGlass.js shellCards.js; do
    [[ -f "${TARGET_DIR}/${installed_file}" ]] ||
        fail "Installed extension is incomplete: ${installed_file} is missing."
done

write_string_setting bootstrap-loaded-generation ""
write_string_setting bootstrap-loaded-revision ""
write_string_setting runtime-revision "base"
write_string_setting runtime-loaded-revision ""
write_string_setting runtime-error ""

echo
echo "VLIQ bootstrap/scaffold installed successfully:"
echo "  ${TARGET_DIR}"
echo
echo "Fresh local install is complete on disk."

# The new UUID is fully copied/compiled before the old UUID is disabled.
# This prevents both extensions from painting the GNOME Shell simultaneously.
python3 "${SCRIPT_DIR}/migrate_legacy_install.py" retire

if finish_safe_activation; then
    echo "VLIQ migration/install completed. Verify it after session refresh."
    echo "After visual verification, optional legacy cleanup:"
    echo "  python3 gnome-shell/migrate_legacy_install.py finalize"
    exit 0
else
    status=$?
    echo "VLIQ failed activation; restoring the previous extension." >&2
    python3 "${SCRIPT_DIR}/migrate_legacy_install.py" rollback || true
    exit "${status}"
fi
