import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = '../gnome-shell/vliq@wonderer.tech/';
const read = file => readFile(new URL(base + file, import.meta.url), 'utf8');
const [prefs, schema, integration, material, vendorSchema, effect, shader,
    topbar, css] = await Promise.all([
    read('prefs.js'),
    read('schemas/org.gnome.shell.extensions.vliq.gschema.xml'),
    read('liquidGlassDock.js'),
    read('vendor/liquid-glass/dist/rendering/material.js'),
    read('vendor/liquid-glass/schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml'),
    read('vendor/liquid-glass/dist/liquidEffect.js'),
    read('vendor/liquid-glass/shaders/glass.frag'),
    read('topBarIslands.js'),
    read('runtime.css'),
]);

// Three persisted choices; selection index 2 must be writable and restored.
assert.match(prefs, /'Liquid Glass',\s*'Frosted Crystal',\s*'Milky Glass'/);
assert.match(prefs, /glassStyleValues = \['liquid', 'frosted', 'milky'\]/);
assert.match(prefs, /glassStyle\.selected < glassStyleValues\.length/);
assert.match(schema, /<choice value="milky"\/>/);
assert.match(vendorSchema, /<key name="vliq-milky-mode" type="d">/);

// Execute the actual canonical-to-vendor bridge, not a restatement.
const begin = integration.indexOf('    _applyFrostedCrystalSettings() {');
const end = integration.indexOf('\n    async enable() {', begin);
assert.ok(begin >= 0 && end > begin);
const method = new Function('clampNumber',
    'return ({' + integration.slice(begin, end) + '});')(
    (n, lo, hi) => Math.max(lo, Math.min(hi, n))
)._applyFrostedCrystalSettings;
const vendor = new Map([
    ['vliq-frost-amount', 0], ['vliq-frost-grain', 0],
    ['vliq-frost-edge-glow', 0], ['vliq-milky-mode', 0],
    ['glass-displacement-scale', 42],
]);
const state = {
    mode: 'liquid', density: 88, grain: 62, edge: 52,
};
const instance = {
    _vliqSettings: {
        get_string: key => {
            assert.equal(key, 'glass-style');
            return state.mode;
        },
        get_int: key => ({
            'frost-density': state.density,
            'frost-grain': state.grain,
            'frost-edge-glow': state.edge,
        })[key],
    },
    _settings: {
        get_double: key => vendor.get(key),
        set_double: (key, value) => {
            assert.ok(vendor.has(key), 'unknown vendor key: ' + key);
            vendor.set(key, value);
        },
    },
};
method.call(instance);
assert.equal(vendor.get('vliq-frost-amount'), 0);
assert.equal(vendor.get('vliq-milky-mode'), 0);
state.mode = 'milky';
method.call(instance);
assert.equal(vendor.get('vliq-frost-amount'), 0);
assert.equal(vendor.get('vliq-milky-mode'), 1);
assert.equal(vendor.get('glass-displacement-scale'), 42);
state.mode = 'frosted';
method.call(instance);
assert.equal(vendor.get('vliq-milky-mode'), 0);
assert.equal(vendor.get('vliq-frost-amount'), 0.88);
state.mode = 'liquid';
method.call(instance);
assert.equal(vendor.get('vliq-milky-mode'), 0);
assert.equal(vendor.get('vliq-frost-amount'), 0);

// The shipped renderer binds the new uniform independently of the
// user-customized Liquid/Frosted lens and samples no background in Milky.
assert.match(material, /vliq_milky_mode/);
assert.match(material, /'vliq-milky-mode'/);
assert.match(material, /_onFrostChanged\?\.\(amount, initial, milkyMode\)/);
assert.match(effect, /this\._milkyMode = nextMilky;/);
assert.match(effect, /if \(this\._milkyMode >= 0\.5\)/);
const shaderBegin = shader.indexOf('    // Milky Glass:');
const shaderEnd = shader.indexOf(
    '    // ══════════════════════════════════════════════════════════════════════',
    shaderBegin);
assert.ok(shaderBegin > 0 && shaderEnd > shaderBegin);
const milkyBranch = shader.slice(shaderBegin, shaderEnd);
assert.match(milkyBranch, /if \(vliq_milky_mode > 0\.5\)/);
assert.match(milkyBranch, /insideMask \* clamp\(vliq_milky_opacity/);
assert.match(milkyBranch, /245\.0, 249\.0, 255\.0/);
assert.match(milkyBranch, /vliq_milky_whiteness/);
assert.match(milkyBranch, /vliq_milky_border/);
assert.match(milkyBranch, /cogl_color_out = vec4\(body \* a, a\)/);
assert.doesNotMatch(milkyBranch,
    /texture2D|sampleBackdrop|refract\(|shadowAlpha|new\s+/);
assert.match(topbar, /\{cornerRadius: RADIUS\}/,
    '3-Part restores the optical material for Liquid and Frosted');
assert.match(topbar, /cssOnly: true/,
    '3-Part retains a native fallback when glass fails');
assert.match(css, /rgba\(245, 249, 255, 0\.24\)/,
    'new material matches the accepted 3-Part main card RGB and opacity');

// Milky disables expensive backdrop blur without changing the stored base.
const blurBegin = effect.indexOf('    _applyVLIQBlurRadius() {');
const blurEnd = effect.indexOf('\n    /**', blurBegin);
const blurPart = effect.slice(blurBegin, blurEnd);
assert.match(blurPart, /this\._blur\.setBlurRadius\(0\);/);
assert.match(blurPart, /const liquidExtra = 21\.0;/);
assert.match(blurPart, /const frostedExtra = Math\.min\(24\.0, this\._frostAmount \* 24\.0\)/);
const blurCases = [
    {milky: 1, frost: 0, expected: 0},
    {milky: 0, frost: 0, expected: 31},
    {milky: 0, frost: 0.88, expected: 31.12},
];
for (const scenario of blurCases) {
    const radii = [];
    const ctx = {
        _requestedBlurRadius: 10,
        _milkyMode: scenario.milky,
        _frostAmount: scenario.frost,
        _blur: {setBlurRadius: n => radii.push(n)},
    };
    const methodOnly = blurPart.slice(0,
        blurPart.indexOf('    setBlurRadius(radius)'));
    assert.ok(methodOnly.includes('_applyVLIQBlurRadius()'));
    const apply = new Function(
        'return ({' + methodOnly + '})._applyVLIQBlurRadius;'
    )();
    apply.call(ctx);
    assert.ok(Math.abs(radii.at(-1) - scenario.expected) < 0.00001);
    assert.equal(ctx._requestedBlurRadius, 10,
        'saved blur value is unchanged when switching modes');
}
console.log('Milky 3rd material: picker, schema, live bridge, flat shader, blur restoration PASS.');
