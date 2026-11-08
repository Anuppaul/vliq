import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Run the shipped GNOME GJS method, not a second implementation of the
// migration. The mock settings also catch unknown/misspelled schema keys.
async function loadSource(path) {
    return (await readFile(new URL(path, import.meta.url), 'utf8'))
        .replace(/^import[\s\S]*?;\s*$/gm, '')
        .replace(/^export\s+/gm, '');
}
const roleSource = await loadSource('../gnome-shell/vliq@wonderer.tech/glassMaterialSystem.js');
const roles = new Function(roleSource + '\nreturn VLIQ_GLASS_ROLES;')();
const adapters = new Function(roleSource + '\nreturn VLIQ_GLASS_ADAPTERS;')();
const runtimeSource = await loadSource('../gnome-shell/vliq@wonderer.tech/liquidGlassDock.js');
const Integration = new Function('VLIQ_GLASS_ROLES',
    runtimeSource + '\nreturn LiquidGlassIntegration;')(roles);
const keys = new Map([
    ['glass-max-z', 'max_z'],
    ['glass-displacement-scale', 'displacement_scale'],
    ['glass-ior', 'ior'],
    ['glass-chroma-strength', 'chroma_strength'],
    ['glass-specular-intensity', 'specular_intensity'],
    ['glass-shininess', 'shininess'],
    ['glass-rim-width', 'rim_width'],
    ['glass-rim-intensity', 'rim_intensity'],
    ['glass-rim-power', 'rim_power'],
    ['glass-rim-light-color-intensity', 'rim_light_color_intensity'],
    ['glass-sheen-intensity', 'sheen_intensity'],
]);
const v8 = new Map([
    ['glass-max-z', 118], ['glass-displacement-scale', 42],
    ['glass-ior', 1.68], ['glass-chroma-strength', 1.4],
    ['glass-specular-intensity', 0.55], ['glass-shininess', 62],
    ['glass-rim-width', 2.8], ['glass-rim-intensity', 0.90],
    ['glass-rim-power', 2.3], ['glass-rim-light-color-intensity', 1.18],
    ['glass-sheen-intensity', 0.10],
]);
const v9 = new Map([
    ['glass-max-z', 132], ['glass-displacement-scale', 50],
    ['glass-ior', 1.68], ['glass-chroma-strength', 1.6],
    ['glass-specular-intensity', 0.69], ['glass-shininess', 70],
    ['glass-rim-width', 3.3], ['glass-rim-intensity', 1.07],
    ['glass-rim-power', 2.15], ['glass-rim-light-color-intensity', 1.24],
    ['glass-sheen-intensity', 0.15],
]);

function migrate(source, version) {
    const values = new Map(source);
    const writes = [];
    const settings = {
        get_double(key) {
            if (!values.has(key)) throw new Error('unknown setting: ' + key);
            return values.get(key);
        },
        set_double(key, value) {
            if (!values.has(key)) throw new Error('unknown setting: ' + key);
            writes.push([key, value]);
            values.set(key, value);
        },
    };
    const canonical = {
        version,
        get_int(key) {
            assert.equal(key, 'glass-optics-profile-version');
            return this.version;
        },
        set_int(key, nextVersion) {
            assert.equal(key, 'glass-optics-profile-version');
            this.version = nextVersion;
        },
    };
    Integration.prototype._ensureFullGlassOpticsProfile.call({
        _settings: settings, _vliqSettings: canonical,
    });
    return {values, writes, version: canonical.version};
}

function checkCurrent(map) {
    for (const [key, uniform] of keys)
        assert.equal(map.get(key), roles.innerCard.optics[uniform], key);
}

// Fresh v9 -> v10 -> v11; previous settings are migrated once.
const fromV9 = migrate(v9, 9);
assert.equal(fromV9.version, 11);
assert.equal(fromV9.writes.length, 11);
checkCurrent(fromV9.values);

// Older machines retain pinned v8 values before upgrading through v11.
const fromV8 = migrate(v8, 8);
assert.equal(fromV8.version, 11);
assert.equal(fromV8.writes.length, 21);  // 10 in v9, then 11 in v10
checkCurrent(fromV8.values);

// Advanced custom user values (even optical off = 0) must survive.
const customSettings = new Map(v9);
customSettings.set('glass-max-z', 166);
customSettings.set('glass-chroma-strength', 0);
customSettings.set('glass-rim-intensity', 0.34);
customSettings.set('glass-ior', 1.94);
const custom = migrate(customSettings, 9);
assert.equal(custom.version, 11);
assert.equal(custom.writes.length, 7);
for (const key of [
    'glass-max-z', 'glass-chroma-strength', 'glass-rim-intensity',
    'glass-ior',
])
    assert.equal(custom.values.get(key), customSettings.get(key));

// Migration is idempotent; no accidental every-login GSettings writes.
const secondRun = migrate(fromV9.values, 11);
assert.equal(secondRun.writes.length, 0);
assert.equal(secondRun.version, 11);

// Existing v10 installs have the previous 3.7px stock Rim Width. Reduce
// only that exact seed, not an intentionally customized user preference.
const v10 = new Map(fromV9.values);
v10.set('glass-rim-width', 3.7);
const slimmer = migrate(v10, 10);
assert.equal(slimmer.version, 11);
assert.deepEqual(slimmer.writes, [['glass-rim-width', 2.0]]);
assert.equal(slimmer.values.get('glass-rim-width'), 2.0);
for (const manualWidth of [0, 0.9, 1.6, 4.8]) {
    const user = new Map(fromV9.values);
    user.set('glass-rim-width', manualWidth);
    const migrated = migrate(user, 10);
    assert.equal(migrated.version, 11);
    assert.equal(migrated.writes.length, 0);
    assert.equal(migrated.values.get('glass-rim-width'), manualWidth);
}

assert.ok(roles.innerCard.optics.max_z > v9.get('glass-max-z'));
assert.ok(roles.innerCard.optics.displacement_scale > v9.get('glass-displacement-scale'));
assert.ok(roles.innerCard.optics.ior > v9.get('glass-ior'));
assert.ok(roles.innerCard.optics.specular_intensity > v9.get('glass-specular-intensity'));
assert.ok(adapters.orb.hoverResponse > 0.48);
assert.ok(adapters.spotlight.hoverResponse > 0.40);
assert.equal(adapters.orb.sceneFpsCap, 24);
assert.equal(roles.innerCard.blurMax, 7);
assert.equal(roles.innerCard.blurMethod, 1);
assert.equal(roles.innerCard.settingsOwnOptics, true);
assert.equal(roles.innerCard.multiRegion, true);
assert.ok(roles.innerCard.interaction.damping > 0 &&
          roles.innerCard.interaction.damping < 1);
console.log('Liquid v8→v11, thinner stock rim, custom settings and GPU frame budgets PASS.');
