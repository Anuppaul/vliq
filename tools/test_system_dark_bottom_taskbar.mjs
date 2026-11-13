import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Native Quick Settings Dark Style only darkens VLIQ's Bottom Taskbar.
// Appearance remains a three-material picker; no global dark overlay.
const root = '../gnome-shell/vliq@wonderer.tech/';
const read = p => readFile(new URL(root + p, import.meta.url), 'utf8');
const [prefs, schema, dock, panel, top, css] = await Promise.all([
    read('prefs.js'),
    read('schemas/org.gnome.shell.extensions.vliq.gschema.xml'),
    read('liquidGlassDock.js'),
    read('panelGlass.js'),
    read('topBarIslands.js'),
    read('runtime.css'),
]);

assert.match(prefs, /glassStyleValues = \['liquid', 'frosted', 'milky'\]/);
assert.doesNotMatch(prefs, /Dark Charcoal/);
assert.doesNotMatch(schema, /<choice value="charcoal"\/>/);
for (const source of [dock, panel, top, css]) {
    assert.doesNotMatch(source, /vliq-global-charcoal|charcoalHeader|\bcharcoal\b/);
}
assert.doesNotMatch(dock, /set_string\(['"]color-scheme['"]/);
assert.match(dock, /changed::color-scheme/);
assert.match(dock, /_desktopColorSchemeChangedId/);
assert.match(dock, /disconnect\(\s*this\._desktopColorSchemeChangedId\)/);

function method(code, start, end, name, context = {}) {
    const a = code.indexOf('    ' + start);
    const b = code.indexOf('    ' + end, a + start.length);
    assert.ok(a >= 0 && b > a, 'method missing: ' + name);
    return new Function(...Object.keys(context),
        'return ({' + code.slice(a, b) + '}).' + name + ';')(
        ...Object.values(context));
}
const appearance = method(dock, '_readSharedCardAppearance() {',
    '_applySharedDashMaterial(', '_readSharedCardAppearance', {
        clampNumber: (n, lo, hi) => Math.max(lo, Math.min(hi, n)),
        parseHexRgb: () => [255, 255, 255],
    });
let scheme = 'default', style = 'liquid';
const stateHost = {
    _vliqSettings: {
        get_string(k) {return k === 'glass-style' ? style : '#ffffff';},
        get_int() {return 24;},
    },
    _desktopInterfaceSettings: {
        get_string(k) {assert.equal(k, 'color-scheme'); return scheme;},
    },
};
for (const selected of ['liquid', 'frosted', 'milky']) {
    style = selected;
    scheme = 'prefer-dark';
    const dark = appearance.call(stateHost);
    assert.equal(dark.systemDarkTaskbar, true);
    assert.equal(dark.milky, selected === 'milky',
        'dark style may not change VLIQ material');
    for (const light of ['default', 'prefer-light']) {
        scheme = light;
        assert.equal(appearance.call(stateHost).systemDarkTaskbar, false);
    }
}
// No connected GNOME theme preference must be safe during startup.
assert.equal(appearance.call({_vliqSettings: stateHost._vliqSettings})
    .systemDarkTaskbar, false);

const setClass = method(top, '_syncSystemDarkTaskbarStyle() {',
    '_buildLayout(mode) {', '_syncSystemDarkTaskbarStyle');
const classes = new Set();
const chrome = {
    add_style_class_name(n) {classes.add(n);},
    remove_style_class_name(n) {classes.delete(n);},
};
const layout = {
    _panel: chrome, _layoutMode: 'bottom',
    _readAppearance: () => ({systemDarkTaskbar: true}),
};
setClass.call(layout);
assert.ok(classes.has('vliq-system-dark-taskbar'));
for (const other of ['split', 'full']) {
    layout._layoutMode = other;
    setClass.call(layout);
    assert.ok(!classes.has('vliq-system-dark-taskbar'),
        'dark taskbar class must never leak into ' + other);
}
layout._layoutMode = 'bottom';
layout._readAppearance = () => ({systemDarkTaskbar: false});
setClass.call(layout);
assert.ok(!classes.has('vliq-system-dark-taskbar'),
    'Quick Settings Light Style restores the saved material');
assert.match(top, /this\._syncSystemDarkTaskbarStyle\(\)/);
assert.match(top, /remove_style_class_name\?\.\('vliq-system-dark-taskbar'\)/);
assert.match(top, /systemDarkTaskbar: mode === 'bottom'/);
assert.match(top, /\{cornerRadius: RADIUS, cssOnly: this\._forceCssOnly\}/);

// The actual bounded GPU actor is suppressed for Dark+Bottom, not for
// Liquid/Frosted on any other native panel layout.
const update = method(panel, 'updateAppearance() {',
    'setBounds(', 'updateAppearance');
function surface(isBottom, state, hidden) {
    const material = {opacity: 191};
    const actor = {
        _destroyed: false, _effect: null, _material: material,
        _milky: false, _requestedOpacity: 191,
        _systemDarkTaskbar: isBottom, _readAppearance: () => state,
    };
    update.call(actor);
    assert.equal(material.opacity, hidden ? 0 : 191);
    actor._readAppearance = () => ({milky: false, systemDarkTaskbar: false});
    update.call(actor);
    assert.equal(material.opacity, 191,
        'leaving GNOME Dark Style restores renderer alpha');
}
surface(true, {milky: false, systemDarkTaskbar: true}, true);
surface(false, {milky: false, systemDarkTaskbar: true}, false);
surface(true, {milky: false, systemDarkTaskbar: false}, false);
surface(true, {milky: true, systemDarkTaskbar: false}, true);

const darkRuleStart = css.indexOf(
    "/* Follow GNOME Quick Settings' native Dark Style ONLY");
const nativeCssStart = css.indexOf('/* Shader-independent VLIQ fallback.');
const rule = css.slice(darkRuleStart, nativeCssStart > darkRuleStart
    ? nativeCssStart : undefined);
assert.ok(rule.startsWith('/* Follow GNOME'));
assert.match(rule, /#panel\.vliq-liquid-top-panel\.vliq-bottom-taskbar\.vliq-system-dark-taskbar/);
assert.match(rule, /rgba\(29,31,35,0\.98\)/);
assert.ok(rule.includes('.vliq-global-milky #panel'),
    'dark GNOME style must beat Milky CSS on Bottom Taskbar');
// Match actual selector targets, not explanatory CSS comment words.
for (const forbidden of [
    '#panel.vliq-three-islands',
    '#panel.vliq-full-header',
    '.vliq-liquid-popup-content',
    '.vliq-native-notification-glass',
    '#dashtodockDashContainer',
]) assert.ok(!rule.includes(forbidden),
    'native Dark Style must not repaint non-bottom surfaces: ' + forbidden);

// Validate the REAL GSettings lifecycle: native Dark Style emits a signal,
// VLIQ queues a live appearance refresh, and both listeners are disconnected
// on extension disable. Do not set or rewrite GNOME's color-scheme.
const connected = new Map(), disconnected = [];
let nextId = 0, refreshes = 0;
const desktop = {
    connect(name, callback) {
        const id = ++nextId;
        connected.set(name, {id, callback});
        return id;
    },
    disconnect(id) {disconnected.push(id);},
};
const setup = method(dock, '_setupSharedCardAppearanceSync() {',
    '_cleanupSharedCardAppearanceSync() {', '_setupSharedCardAppearanceSync', {
        Gio: {Settings: class {constructor() {return desktop;}}},
        DESKTOP_INTERFACE_SCHEMA: 'org.gnome.desktop.interface',
    });
const cleanup = method(dock, '_cleanupSharedCardAppearanceSync() {',
    '_getShellTheme() {', '_cleanupSharedCardAppearanceSync');
const owner = {
    _desktopInterfaceSettings: null,
    _desktopAccentChangedId: 0, _desktopColorSchemeChangedId: 0,
    _vliqSettings: null, _cardAppearanceSettingId: 0,
    _cardAppearanceApplyId: 0,
    _applySharedCardAppearance() {},
    _queueSharedCardAppearanceApply() {refreshes++;},
    _syncMilkyAppearanceClass() {},
    _unloadCardAppearanceStylesheet() {},
};
setup.call(owner);
assert.ok(connected.has('changed::color-scheme'));
assert.ok(connected.has('changed::accent-color'));
connected.get('changed::color-scheme').callback();
assert.equal(refreshes, 1);
cleanup.call(owner);
assert.ok(disconnected.includes(connected.get('changed::color-scheme').id),
    'Dark Style listener must be disconnected on disable');
assert.ok(disconnected.includes(connected.get('changed::accent-color').id));

console.log('GNOME Dark Style -> Bottom Taskbar only; appearance, layout and renderer restoration PASS.');
