import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the ACTUAL PanelGlassSurface updateAppearance implementation.
// Bottom is borderless, while Full/3-Part retain VLIQ's optical rim.
// No GNOME runtime or shader recompilation is required for this test.
const source = (await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/panelGlass.js', import.meta.url
), 'utf8'))
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');

const roles = {dock: Object.freeze({
    surfaceLight: true, blurScale: 0.85, blurMin: 4,
    blurMax: 7, contrastFloor: 1.04,
})};
const applyVLIQGlassRole = (effect, role, options) => {
    assert.equal(role, roles.dock, 'shared glass role not replaced');
    assert.equal(options.cornerRadius, 0);
    effect.setSurfaceLightEnabled(role.surfaceLight);
    effect.appliedOptions = options;
};
const PanelGlassSurface = new Function(
    'GLib', 'frameDue', 'VLIQ_GLASS_ROLES',
    'applyVLIQGlassRole', 'console',
    source + '\nreturn PanelGlassSurface;'
)({}, () => true, roles, applyVLIQGlassRole, console);

function fakeSurface(borderless) {
    const writes = [];
    const effect = {
        _uniforms: {set(key, value) {writes.push([key, value]);}},
        setSurfaceLightEnabled(value) {writes.push(['surfaceLight', value]);},
        setPadding(value) {writes.push(['padding', value]);},
        setShadowMaxRadius(value) {writes.push(['shadowMaxRadius', value]);},
        setCornerRadius(value) {writes.push(['cornerRadius', value]);},
        setIsDock(value) {writes.push(['isDock', value]);},
    };
    const surface = new PanelGlassSurface(
        {},
        {get_double() {return 1.0;}},
        () => ({r: 255, g: 255, b: 255, opacity: 0.03, blur: 7}),
        {cornerRadius: 0, borderless}
    );
    let redraws = 0;
    surface._effect = effect;
    surface._material = {queue_redraw() {redraws++;}};
    surface.updateAppearance();
    return {surface, writes, effect, redraws};
}
const bottom = fakeSurface(true);
assert.equal(bottom.surface._borderless, true);
assert.deepEqual(bottom.writes.filter(([key]) => key === 'surfaceLight'),
    [['surfaceLight', true], ['surfaceLight', false]],
    'bottom suppresses surface rim/specular/contour AFTER shared role');
assert.ok(bottom.writes.some(([k,v]) => k === 'ao_intensity' && v === 0),
    'bottom edge has zero inner ambient-occlusion stroke');
assert.ok(bottom.writes.some(([k,v]) => k === 'shadow_intensity' && v === 0),
    'bottom edge has zero shader shadow');
assert.equal(bottom.redraws, 1, 'repaint remains in existing effect');
assert.equal(bottom.effect.appliedOptions.tintStrength, 0.03,
    'bottom keeps its glass tint and blur');

const full = fakeSurface(false);
assert.equal(full.surface._borderless, false);
assert.deepEqual(full.writes.filter(([key]) => key === 'surfaceLight'),
    [['surfaceLight', true]],
    'Full Header keeps original Liquid Glass rim');
assert.ok(!full.writes.some(([k]) => k === 'ao_intensity'),
    'Full Header keeps configured ambient occlusion');
assert.ok(!full.writes.some(([k]) => k === 'shadow_intensity'),
    'Full Header retains its normal material profile');

bottom.writes.length = 0;
bottom.surface.updateAppearance();
assert.ok(bottom.writes.some(([k,v]) =>
    k === 'surfaceLight' && v === false),
    'appearance refresh cannot re-enable Bottom rim');
assert.ok(bottom.writes.some(([k,v]) =>
    k === 'ao_intensity' && v === 0),
    'appearance refresh cannot restore Bottom edge AO');

console.log('Bottom Taskbar borderless material: no rim/AO/shadow, other modes unaffected PASS.');
