import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = '../gnome-shell/vliq@wonderer.tech/';
const read = file => readFile(new URL(root + file, import.meta.url), 'utf8');
const [prefs, schema, dock, vendorSchema, material, shader] =
    await Promise.all([
        read('prefs.js'),
        read('schemas/org.gnome.shell.extensions.vliq.gschema.xml'),
        read('liquidGlassDock.js'),
        read('vendor/liquid-glass/schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml'),
        read('vendor/liquid-glass/dist/rendering/material.js'),
        read('vendor/liquid-glass/shaders/glass.frag'),
    ]);
const controls = [
    ['milky-opacity', 24, 'vliq-milky-opacity', 'vliq_milky_opacity'],
    ['milky-border', 20, 'vliq-milky-border', 'vliq_milky_border'],
    ['milky-whiteness', 0, 'vliq-milky-whiteness', 'vliq_milky_whiteness'],
];
for (const [key, value, vendorKey, uniform] of controls) {
    assert.match(schema, new RegExp('<key name="' + key + '" type="i">\\s*<default>' + value + '</default>'));
    assert.match(schema, new RegExp('<range min="0" max="100"'));
    assert.ok(prefs.includes("settings, '" + key + "'"),
        'Appearance must expose ' + key);
    assert.ok(prefs.includes("title: 'Milky Glass'"));
    assert.ok(dock.includes("'" + key + "'"),
        'canonical settings must watch ' + key);
    assert.ok(dock.includes("'" + vendorKey + "'"),
        'material bridge must update ' + vendorKey);
    assert.ok(vendorSchema.includes('name="' + vendorKey + '"'));
    assert.ok(material.includes("'" + vendorKey + "'"));
    assert.ok(shader.includes('uniform float ' + uniform + ';'));
}
assert.match(prefs, /milky\.set_sensitive\(settings\.get_string\('glass-style'\) === 'milky'\)/);
assert.match(prefs, /settings\.connect\('changed::glass-style', syncMilkyControls\)/);

// Real GJS material CSS builders, evaluated with the existing clamp logic.
const begin = dock.indexOf('function milkyPaintTokens(');
const end = dock.indexOf('function canonicalExtensionRoot()', begin);
assert.ok(begin > 0 && end > begin);
const {milkyPaintTokens, buildMilkyAppearanceCss} =
    new Function('clampNumber', dock.slice(begin, end) +
        '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss};')(
        (value, lo, hi) => Math.min(hi, Math.max(lo, value)));
const defaults = milkyPaintTokens({
    milkyOpacity: 0.24, milkyBorder: 0.20, milkyWhiteness: 0,
});
assert.equal(defaults.fill, 'rgba(245,249,255,0.240)');
assert.equal(defaults.rim, 'inset 0 0 0 1px rgba(255,255,255,0.200)');
const low = buildMilkyAppearanceCss({
    milky: true, milkyOpacity: 0.03, milkyBorder: 0,
    milkyWhiteness: 1,
});
assert.match(low, /rgba\(255,255,255,0\.030\)/);
assert.match(low, /box-shadow: none !important;/);
const high = buildMilkyAppearanceCss({
    milky: true, milkyOpacity: 0.90, milkyBorder: 0.75,
    milkyWhiteness: 0.5,
});
assert.match(high, /0\.900/);
assert.match(high, /rgba\(255,255,255,0\.750\)/);
assert.ok(high.includes('vliq-panel-island-inactive'));
assert.doesNotMatch(high, /:not\\(/,
    'St.Theme cannot reliably parse browser-only :not() selectors');
const afterFill = high.lastIndexOf('background-color: transparent !important;');
const beforeFill = high.indexOf('rgba(255,255,255,0.750)');
assert.ok(afterFill > beforeFill,
    'hidden islands must have a stronger explicit transparent override');
assert.ok(high.includes(
    '#panel.vliq-three-islands #panelCenter.vliq-panel-island.vliq-panel-island-inactive'),
    'center clock island must stay hidden while inactive');
assert.equal(buildMilkyAppearanceCss({milky: false}), '',
    'Milky CSS must never override Liquid or Frosted');
assert.equal(milkyPaintTokens({milkyOpacity: -1}).fill,
    'rgba(245,249,255,0.000)');
assert.match(dock, /buildMilkyAppearanceCss\(state\)/);

// Execute actual canonical-to-vendor bridge using new slider values.
const a = dock.indexOf('    _applyFrostedCrystalSettings() {');
const b = dock.indexOf('\n    async enable() {', a);
assert.ok(a >= 0 && b > a);
const bridge = new Function('clampNumber',
    'return ({' + dock.slice(a, b) + '})._applyFrostedCrystalSettings;')(
        (v, lo, hi) => Math.min(hi, Math.max(lo, v)));
const vals = new Map([
    ...controls.map(([, value, vendorKey]) => [vendorKey, value / 100]),
    ['vliq-frost-grain', 0.62],
    ['vliq-frost-edge-glow', 0.52],
    ['vliq-frost-amount', 0],
    ['vliq-milky-mode', 0],
    ['glass-displacement-scale', 58],
]);
const user = {
    'glass-style': 'milky', 'frost-grain': 62,
    'frost-edge-glow': 52, 'frost-density': 88,
    'milky-opacity': 75, 'milky-border': 40,
    'milky-whiteness': 65,
};
const ctx = {
    _settings: {
        settings_schema: {has_key: key => vals.has(key)},
        get_double: key => vals.get(key),
        set_double: (key, value) => vals.set(key, value),
    },
    _vliqSettings: {
        get_string: key => user[key],
        get_int: key => user[key],
    },
};
bridge.call(ctx);
assert.equal(vals.get('vliq-milky-mode'), 1);
assert.equal(vals.get('vliq-milky-opacity'), 0.75);
assert.equal(vals.get('vliq-milky-border'), 0.4);
assert.equal(vals.get('vliq-milky-whiteness'), 0.65);
user['glass-style'] = 'liquid';
bridge.call(ctx);
assert.equal(vals.get('vliq-milky-mode'), 0);
assert.equal(vals.get('glass-displacement-scale'), 58,
    'Liquid optics must remain untouched');
console.log('Milky controls: live native paint, uniform bridge and mode isolation PASS.');
