import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = '../gnome-shell/vliq@wonderer.tech/';
const read = p => readFile(new URL(base + p, import.meta.url), 'utf8');
const [prefs, schema, integration, panel, header, css] =
    await Promise.all([
        read('prefs.js'),
        read('schemas/org.gnome.shell.extensions.vliq.gschema.xml'),
        read('liquidGlassDock.js'),
        read('panelGlass.js'),
        read('topBarIslands.js'),
        read('runtime.css'),
    ]);

// Material choice persists, but never mutates the GNOME-wide dark setting.
assert.match(prefs, /'Dark Charcoal'/);
assert.match(prefs, /glassStyleValues = \['liquid', 'frosted', 'milky', 'charcoal'\]/);
assert.match(schema, /<choice value="charcoal"\/>/);
assert.doesNotMatch(integration, /set_string\(['"]color-scheme['"],\s*['"]prefer-dark['"]\)/);

// Evaluate the existing material source, not a second implementation.
function fromSource(source, begin, end, name, dependencies = {}) {
    const first = source.indexOf('    ' + begin);
    const last = source.indexOf('    ' + end, first + begin.length);
    assert.ok(first >= 0 && last > first, 'method boundaries ' + name);
    const body = source.slice(first, last);
    return new Function(...Object.keys(dependencies),
        'return ({' + body + '}).' + name + ';')(
        ...Object.values(dependencies));
}
const appearance = fromSource(integration, '_readSharedCardAppearance() {',
    '_applySharedDashMaterial(', '_readSharedCardAppearance', {
        clampNumber: (v, low, high) => Math.min(high, Math.max(low, v)),
        parseHexRgb: () => [255, 255, 255],
    });
let mode = 'charcoal';
const preferences = {
    get_string: key => key === 'glass-style' ? mode : '#ffffff',
    get_int: () => 24,
};
const host = {_vliqSettings: preferences};
const charcoal = appearance.call(host);
assert.equal(charcoal.charcoal, true);
assert.equal(charcoal.milky, false,
    'Charcoal must not switch off every VLIQ-managed GPU surface');
for (const other of ['liquid', 'frosted', 'milky']) {
    mode = other;
    const state = appearance.call(host);
    assert.equal(state.charcoal, false);
    assert.equal(state.milky, other === 'milky');
}

// Main.uiGroup gets exactly one global paint class, and Milky's global
// OSD/notification suppression must stay OFF for the Charcoal preset.
const paint = fromSource(integration,
    '_syncMilkyAppearanceClass(enabled, charcoal = false) {',
    '_applySharedCardAppearance()', '_syncMilkyAppearanceClass', {
        Main: {layoutManager: {uiGroup: {
            add_style_class_name: name => styles.add(name),
            remove_style_class_name: name => styles.delete(name),
        }}},
    });
const styles = new Set();
let osdSuppressed = null;
const app = {_syncMilkyOsdMaterial: enabled => {osdSuppressed = enabled;}};
paint.call(app, false, true);
assert.deepEqual([...styles], ['vliq-global-charcoal']);
assert.equal(osdSuppressed, false);
paint.call(app, true, false);
assert.deepEqual([...styles], ['vliq-global-milky']);
assert.equal(osdSuppressed, true);
paint.call(app, false, false);
assert.deepEqual([...styles], []);

// Only two topbar region types own the charcoal shader bypass.
assert.match(header, /charcoalHeader: mode === 'bottom'/);
assert.match(header, /cornerRadius: RADIUS, charcoalHeader: true/);
const surfaceUpdate = fromSource(panel, 'updateAppearance() {',
    'setBounds(', 'updateAppearance');
function checkMaterial(charcoalHeader, selected, shouldHide) {
    const material = {opacity: 173};
    const state = {
        _destroyed: false, _effect: null, _material: material,
        _requestedOpacity: 173, _milky: false, _charcoalHeader: charcoalHeader,
        _readAppearance: () => ({
            milky: selected === 'milky',
            charcoal: selected === 'charcoal',
        }),
    };
    surfaceUpdate.call(state);
    assert.equal(material.opacity, shouldHide ? 0 : 173,
        'unexpected renderer paint on ' + selected + '/' + charcoalHeader);
    if (shouldHide) {
        state._readAppearance = () => ({milky: false, charcoal: false});
        surfaceUpdate.call(state);
        assert.equal(material.opacity, 173,
            'renderer opacity must restore when leaving flat Charcoal');
    }
}
checkMaterial(true, 'charcoal', true); // 3-part and Bottom
checkMaterial(false, 'charcoal', false); // Full and native Dock
checkMaterial(true, 'liquid', false);
checkMaterial(true, 'frosted', false);
checkMaterial(true, 'milky', true);

// Existing popup/Quick/calendar/drop shadows retain their original style.
// The new CSS may ONLY modify native panel-owned actors.
const start = css.indexOf('/* Dark Charcoal: respect GNOME');
assert.ok(start >= 0);
const darkCSS = css.slice(start);
for (const selector of [
    '#panel.vliq-three-islands #panelLeft.vliq-panel-island',
    '#panel.vliq-three-islands #panelCenter.vliq-panel-island',
    '#panel.vliq-three-islands #panelRight.vliq-panel-island',
    '#panel.vliq-liquid-top-panel.vliq-bottom-taskbar',
]) {
    assert.ok(darkCSS.includes('.vliq-global-charcoal ' + selector),
        'Charcoal backplate missing: ' + selector);
}
assert.match(darkCSS, /rgba\(29, 31, 35, 0\.98\)/);
assert.match(darkCSS, /vliq-panel-island-inactive/);
assert.match(darkCSS, /color: rgba\(248, 249, 253, 0\.97\) !important/);
for (const excluded of [
    '.vliq-global-charcoal .dash-background',
    '.vliq-global-charcoal .vliq-liquid-popup-content',
    '.vliq-global-charcoal .vliq-native-notification-glass',
    '.vliq-global-charcoal .vliq-app-button',
    '.vliq-global-charcoal #panel.vliq-liquid-top-panel.vliq-full-header',
]) assert.ok(!darkCSS.includes(excluded),
    'Charcoal must not override native GNOME material: ' + excluded);
assert.match(integration,
    /if \(this\._vliqSettings\?\.get_string\?\.\('glass-style'\) === 'milky'\)/,
    'native Dock material may only be suppressed in Milky mode');
assert.doesNotMatch(integration,
    /\['milky', 'charcoal'\]\.includes\(mode\) \? 1\.0 : 0\.0/,
    'Charcoal cannot globally activate the Milky shader');
console.log('Dark Charcoal: 3-Part/Bottom only, native Dock and popups preserved PASS.');
