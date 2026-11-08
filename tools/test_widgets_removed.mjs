import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The stand-alone Clock and Calendar widgets have been retired. Keep the
// native GNOME Date Menu, top-bar clock, Dock and panel Liquid Glass intact.
const root = new URL('../', import.meta.url);
const read = relative => readFile(new URL(relative, root), 'utf8');
const ext = 'gnome-shell/vliq@wonderer.tech/';
const runtime = await read(ext + 'orbThemeRuntime.js');
const integration = await read(ext + 'liquidGlassDock.js');
const prefs = await read(ext + 'prefs.js');
const css = await read(ext + 'runtime.css');
const panel = await read(ext + 'panelGlass.js');
const schema = await read(ext + 'schemas/org.gnome.shell.extensions.vliq.gschema.xml');
const installer = await read('gnome-shell/install.sh');
const ci = await read('.github/workflows/repository-checks.yml');
const forbidden = /desktopClockWidget|desktopCalendarWidget|_desktopClockWidget|_desktopCalendarWidget|_clockPanel|_calendarPanel|clock-widget-|calendar-widget-|attachClockWidgetGlass|attachCalendarWidgetGlass|syncClockWidgetGlass|syncCalendarWidgetGlass|detachClockWidgetGlass|detachCalendarWidgetGlass/;

for (const [name, source] of [
    ['runtime', runtime], ['integration', integration],
    ['preferences', prefs], ['GSettings', schema],
    ['panel compositor', panel], ['stylesheet', css],
]) {
    assert.doesNotMatch(source, forbidden,
        'desktop widget reference remains in ' + name);
}
assert.doesNotMatch(prefs, /['"]Widgets['"]\s*,/,
    'retired Widgets page must not appear in Preferences');
assert.match(prefs, /['"]Performance['"]\s*,/,
    'performance controls must remain');
assert.match(runtime, /this\._setOrbEnabled\(/,
    'Orb launcher startup is preserved');
assert.match(integration, /setOrbDragging\(active\)/,
    'Orb drag/glass bridge remains');
assert.match(integration, /this\._topPanelIslands/,
    'top-bar panel islands remain');
assert.match(integration, /this\._popupGlassManager/,
    'GNOME native popup glass remains');
assert.match(css, /\.vliq-liquid-popup-content\.datemenu-popover/,
    'GNOME native Date Menu/calendar styles remain');
assert.match(panel, /Math\.min\(width, height\) > 240/,
    'bounded native panel size guard remains');
assert.doesNotMatch(panel, /_clockCard|vliq_clock_straight_edge_guard/,
    'Clock-only optical tuning must not leak to native panel');
assert.match(schema, /name="date-menu-glass-blur"/,
    'native Date Menu material settings remain');
assert.match(schema, /name="orb-enabled"/,
    'existing Orb settings remain');

// Installer must no longer ship either widget but must remove the old
// on-disk JS modules during both hot-deploy and full installs.
for (const name of ['desktopClockWidget.js', 'desktopCalendarWidget.js']) {
    const runtimeFiles = installer.match(/RUNTIME_FILES=\(([\s\S]*?)^\)/m)?.[1];
    const packedFiles = installer.match(/REQUIRED_PACKED_FILES=\(([\s\S]*?)^\s*\)/m)?.[1];
    assert.ok(runtimeFiles && packedFiles,
        'installer manifests are readable');
    assert.ok(!runtimeFiles.includes('"' + name + '"'),
        name + ' must not be included in the runtime manifest');
    assert.ok(!packedFiles.includes('"' + name + '"'),
        name + ' must not be included in the packed extension');
    assert.match(installer, new RegExp('rm -f[^\\n]*' + name.replace('.', '\\.') ),
        name + ' must be cleaned from older installs');
}
assert.match(installer, /remove_retired_widgets_in_dir "\$\{TARGET_DIR\}"/,
    'normal extension install must delete obsolete widgets');
assert.match(installer, /remove_retired_widgets_in_dir "\$\{live_dir\}"/,
    'live cached extension must delete obsolete widgets');
assert.doesNotMatch(ci, /node tools\/test_desktop_(clock|calendar)_widget\.mjs|node tools\/test_clock_panel_glass\.mjs/,
    'CI must not call deleted widget tests');
assert.match(ci, /node tools\/test_widgets_removed\.mjs/,
    'CI must verify desktop widget removal');
assert.match(ci, /node tools\/test_top_bar_islands\.mjs/,
    'native GNOME panel tests must remain');

console.log('Desktop widget removal and native GNOME Date Menu/Orb/Dock retention PASS.');
