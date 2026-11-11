import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the shipped canonical settings bridge, vendored material bindings,
// and the existing LiquidEffect blur setter without a live GNOME compositor.
// No second copy of either implementation is tested or shipped.
const root = '../gnome-shell/vliq@wonderer.tech/';
const file = async name => readFile(new URL(root + name, import.meta.url), 'utf8');
const integration = await file('liquidGlassDock.js');
const materialSource = await file('vendor/liquid-glass/dist/rendering/material.js');
const effectSource = await file('vendor/liquid-glass/dist/liquidEffect.js');
const shader = await file('vendor/liquid-glass/shaders/glass.frag');
const canonicalSchema = await file('schemas/org.gnome.shell.extensions.vliq.gschema.xml');
const vendorSchema = await file(
    'vendor/liquid-glass/schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml'
);
const prefs = await file('prefs.js');
const begin = integration.indexOf('    _applyFrostedCrystalSettings() {');
const end = integration.indexOf('\n    async enable() {', begin);
assert.ok(begin >= 0 && end > begin);
const method = integration.slice(begin, end);
const bridge = new Function('clampNumber',
    'return ({' + method + '});')(
        (value, min, max) => Math.max(min, Math.min(max, value))
    );

const values = new Map([
    ['vliq-frost-amount', 0],
    ['vliq-frost-grain', 0.55],
    ['vliq-frost-edge-glow', 0.52],
    // Saved, user-customized Liquid v10 optics must be left unchanged.
    ['glass-displacement-scale', 36],
    ['glass-chroma-strength', 3.4],
    ['glass-rim-intensity', 0.22],
]);
const handlers = new Map();
let nextId = 0;
const vendor = {
    settings_schema: {has_key: key => values.has(key)},
    get_double(key) {
        // The real vendored schema contains many unrelated numeric Liquid
        // optics. This focused mock supplies their defaults without hiding
        // missing Frosted keys (which must always be explicitly present).
        if (!values.has(key)) {
            if (key.startsWith('vliq-frost-'))
                throw new Error('Missing Frosted key: ' + key);
            return 1.0;
        }
        return values.get(key);
    },
    set_double(key, value) {
        if (!values.has(key))
            throw new Error('Missing GSettings key: ' + key);
        if (values.get(key) === value)
            return;
        values.set(key, value);
        for (const [name, callback] of handlers.values())
            if (name === 'changed::' + key)
                callback();
    },
    connect(name, handler) {
        const id = ++nextId;
        handlers.set(id, [name, handler]);
        return id;
    },
    disconnect(id) {handlers.delete(id);},
    get_int: key => key === 'glass-blur-downscale' ? 2 : 1,
    get_boolean: () => false,
};
const controls = {
    'glass-style': 'liquid',
    'frost-density': 78,
    'frost-grain': 55,
    'frost-edge-glow': 52,
    'milky-opacity': 24,
    'milky-border': 20,
    'milky-whiteness': 0,
};
const canonical = {
    get_string: key => {
        if (key !== 'glass-style')
            throw new Error('Unexpected string key ' + key);
        return controls[key];
    },
    get_int: key => {
        if (!Object.hasOwn(controls, key))
            throw new Error('Unexpected int key ' + key);
        return controls[key];
    },
};
const instance = {
    _settings: vendor,
    _vliqSettings: canonical,
    _applyFrostedCrystalSettings: bridge._applyFrostedCrystalSettings,
};

// MaterialSettings must apply uniforms on creation and live setting changes.
const MaterialSettings = new Function(
    materialSource.replace(/^export\s+/gm, '') +
    '\nreturn MaterialSettings;'
)();
const uniformValues = new Map();
const uniform = {set: (key, value) => uniformValues.set(key, value)};
const blur = {setBlurMethod() {}, setDownscale() {}};
const events = [];
const material = new MaterialSettings(
    vendor, uniform, blur, () => {},
    (amount, initial) => events.push([amount, initial])
);
material.initialize();
assert.equal(uniformValues.get('vliq_frost_amount'), 0);
assert.equal(events.at(-1)[1], true);
instance._applyFrostedCrystalSettings();
assert.equal(values.get('vliq-frost-amount'), 0);
assert.equal(values.get('vliq-frost-grain'), 0.55);

// The first user switch should update ALL live effects; original settings
// are not rewritten. Density and edge glow can be adjusted while enabled.
controls['glass-style'] = 'frosted';
instance._applyFrostedCrystalSettings();
assert.equal(values.get('vliq-frost-amount'), 0.78);
assert.equal(uniformValues.get('vliq_frost_amount'), 0.78);
assert.equal(uniformValues.get('vliq_frost_grain'), 0.55);
assert.equal(events.at(-1)[1], false);
controls['frost-density'] = 34;
controls['frost-grain'] = 77;
controls['frost-edge-glow'] = 19;
instance._applyFrostedCrystalSettings();
assert.equal(uniformValues.get('vliq_frost_amount'), 0.34);
assert.equal(uniformValues.get('vliq_frost_grain'), 0.77);
assert.equal(uniformValues.get('vliq_frost_edge_glow'), 0.19);
assert.equal(values.get('glass-displacement-scale'), 36);
assert.equal(values.get('glass-chroma-strength'), 3.4);
assert.equal(values.get('glass-rim-intensity'), 0.22);

controls['glass-style'] = 'liquid';
instance._applyFrostedCrystalSettings();
assert.equal(uniformValues.get('vliq_frost_amount'), 0);
assert.equal(values.get('glass-displacement-scale'), 36);
assert.equal(values.get('glass-rim-intensity'), 0.22);

// Retest after switching back, including independently retained user choices.
controls['glass-style'] = 'frosted';
instance._applyFrostedCrystalSettings();
assert.equal(uniformValues.get('vliq_frost_amount'), 0.34);
material.clear();
assert.equal(handlers.size, 0, 'material must disconnect mode listeners');

// Exercise the actual LiquidEffect.blur setter, not an invented model.
// Liquid now has Frosted-like strong native diffusion, while the users'
// saved base radius and advanced optics remain intact. Both modes respect 0.
const blurBegin = effectSource.indexOf('    _applyVLIQBlurRadius() {');
const blurEnd = effectSource.indexOf('\n    /**', blurBegin);
assert.ok(blurBegin >= 0 && blurEnd > blurBegin);
const extractedMethods = effectSource.slice(blurBegin, blurEnd)
    // Class methods have no comma separators, unlike object literals.
    .replace(/\n    setBlurRadius\(radius\)/,
        ',\n    setBlurRadius(radius)');
const methods = new Function(
    'return ({' + extractedMethods + '});'
)();
const blurRadii = [];
const fx = {
    _blur: {setBlurRadius: radius => blurRadii.push(radius)},
    _requestedBlurRadius: null,
    _frostAmount: 0,
    ...methods,
};
fx.setBlurRadius(7);
assert.equal(blurRadii.at(-1), 28,
    'Liquid adds a strong 21px diffusion to the saved base');
assert.equal(fx._requestedBlurRadius, 7,
    'stronger Liquid blur must never overwrite the saved slider value');
fx._frostAmount = 0.78;
fx._applyVLIQBlurRadius();
assert.ok(Math.abs(blurRadii.at(-1) - 25.72) < 0.0001,
    'Frosted still tracks its independently selected density');
fx._frostAmount = 0;
fx._applyVLIQBlurRadius();
assert.equal(blurRadii.at(-1), 28,
    'returning to Liquid restores strong blur without touching base radius');

// The two modes have closely matched blur at the new Frosted default.
// They must stay *optically distinct* via the original Liquid shader, not
// by adding a CSS overlay, extra FBO or mutating refraction/edge settings.
fx._frostAmount = 0.88;
fx._applyVLIQBlurRadius();
assert.ok(Math.abs(blurRadii.at(-1) - 28.12) < 0.0001,
    'default Frosted and Liquid background diffusion should be comparable');
fx._frostAmount = 0;
fx._applyVLIQBlurRadius();
assert.equal(blurRadii.at(-1), 28);
assert.equal(fx._requestedBlurRadius, 7);

// The Blur slider stays live and its explicit OFF state works in both modes.
fx.setBlurRadius(14);
assert.equal(blurRadii.at(-1), 35, 'Liquid blur tracks slider changes');
assert.equal(fx._requestedBlurRadius, 14);
fx._frostAmount = 1;
fx._applyVLIQBlurRadius();
assert.equal(blurRadii.at(-1), 38, 'max Frosted density adds up to 24');
fx._frostAmount = 0;
fx._applyVLIQBlurRadius();
assert.equal(blurRadii.at(-1), 35);

fx.setBlurRadius(0);
assert.equal(blurRadii.at(-1), 0, 'Liquid blur=0 disables the effect');
fx._frostAmount = 0.88;
fx._applyVLIQBlurRadius();
assert.equal(blurRadii.at(-1), 0, 'Frosted blur=0 also disables the effect');
fx._frostAmount = 0;
fx._applyVLIQBlurRadius();
assert.equal(blurRadii.at(-1), 0);
assert.equal(fx._requestedBlurRadius, 0);

// A zero-amount toggle cannot create a second renderer or change v10 optics.
assert.match(effectSource, /const liquidExtra = 21\.0;/);
assert.match(effectSource, /const frostedExtra = Math\.min\(24\.0, this\._frostAmount \* 24\.0\)/);
assert.doesNotMatch(
    effectSource.slice(blurBegin, blurEnd),
    /setGlassGeometry\(|add_effect\(|new BlurRenderer|setTintColor\(/,
    'blur boost must stay inside existing blur pipeline');

// Test wiring and safety contracts: no hidden second layer/GL pass,
// Liquid has an identity path, all shader paths use same matte+grain.
for (const uniformName of [
    'vliq_frost_amount', 'vliq_frost_grain', 'vliq_frost_edge_glow',
])
    assert.match(shader, new RegExp('uniform float ' + uniformName + ';'));
assert.match(shader, /if \(frost < 0\.0001\)\s*return color;/);
assert.match(shader, /flatRgb = vliqCrystalBody\(flatRgb\)/);
assert.match(shader, /vec3 baseColor = vliqCrystalBody\(insideBaseColor\)/);
assert.equal(
    shader.match(/vliqCrystalGrain\(pixel_coord\)/g)?.length,
    2,
    'flat/full paths must share the same static grain implementation'
);
assert.doesNotMatch(shader, /sampler2D vliq_/);

// Full Crystal should be visually distinct, not merely Liquid with a white
// tint. Verify both rendering branches, the density-to-matte blend, the
// refraction suppression and the removal of RGB dispersion in Frosted mode.
// This remains a source-level GPU contract, NOT a live compositor screenshot.
assert.match(shader, /float matte = pow\(frost, 0\.62\)/);
assert.match(shader, /return mix\(desaturated, crystalWhite, 0\.87 \* matte\)/);
assert.match(shader, /float crystalLensSuppression = smoothstep\(/);
assert.match(shader, /dispPx \*= mix\(1\.0, 0\.09, crystalLensSuppression\)/);
assert.match(shader, /float crystalChroma = 1\.0 - smoothstep\(/);
assert.match(shader, /\* lensShape \* crystalChroma;/);
assert.match(shader, /vliqGlassGrain\(floor\(pixel \* 0\.25\) \* 4\.0\)/);
assert.match(shader, /vec3\(0\.79, 0\.90, 1\.0\)/);
assert.match(shader, /if \(frost < 0\.0001\)\s*return fine;/);
// At the *previous* 78% default, the matte crystal should already be strong
// even on an installation whose prior default is still stored explicitly.
const matteAmountAtOldDefault = 0.87 * Math.pow(0.78, 0.62);
assert.ok(matteAmountAtOldDefault > 0.73);
const smoothstep = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};
const remainingRefraction = 1 - 0.91 * smoothstep(0, 0.72, 0.78);
const remainingChroma = 1 - smoothstep(0, 0.45, 0.78);
assert.ok(remainingRefraction <= 0.1);
assert.equal(remainingChroma, 0, 'no rainbow edge on dense Frosted');
assert.equal(1 - 0.91 * smoothstep(0, 0.72, 0), 1,
    'Liquid refraction remains mathematically unchanged');
assert.equal(1 - smoothstep(0, 0.45, 0), 1,
    'Liquid RGB fringe remains unchanged');

assert.match(canonicalSchema, /<key name="glass-style" type="s">/);
assert.match(canonicalSchema, /<key name="frost-density" type="i">\s*<default>88<\/default>/);
assert.match(canonicalSchema, /<key name="frost-grain" type="i">\s*<default>62<\/default>/);
assert.match(canonicalSchema, /<default>'liquid'<\/default>/);
for (const key of ['frost-density', 'frost-grain', 'frost-edge-glow'])
    assert.match(canonicalSchema, new RegExp('<key name="' + key + '"'));
for (const key of [
    'vliq-frost-amount', 'vliq-frost-grain', 'vliq-frost-edge-glow',
])
    assert.match(vendorSchema, new RegExp('<key name="' + key + '"'));
assert.match(prefs, /model: Gtk\.StringList\.new\(\[\s*'Liquid Glass',\s*'Frosted Crystal'/);
assert.match(prefs, /settings\.set_string\(\s*'glass-style'/);
assert.match(prefs, /changed::glass-style/);
assert.match(integration, /this\._applyFrostedCrystalSettings\(\)/);
assert.match(integration, /'frost-density',\s*'frost-grain',\s*'frost-edge-glow'/);
assert.doesNotMatch(method, /glass-displacement-scale|glass-chroma-strength|glass-rim-intensity/);

console.log('Strong Liquid/Frosted native blur, preserved refractive optics, mode switching, slider OFF and regression checks PASS.');
