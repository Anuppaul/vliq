import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// GJS loads .js as ES modules; Node on CI may default to CommonJS.
// Load the exact shipped helper source as an ESM data URL for this test.
const source = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/frameBudget.js', import.meta.url
), 'utf8');
const {frameDue} = await import(
    `data:text/javascript,${encodeURIComponent(source)}`
);

// First paint is always due, including on a newly mapped glass actor.
assert.equal(frameDue(1000000, 0, 24), true);
// Stationary panel skips redundant per-frame transform reads under 24 FPS.
assert.equal(frameDue(1010000, 1000000, 24), false);
assert.equal(frameDue(1040000, 1000000, 24), false);
assert.equal(frameDue(1042000, 1000000, 24), true);
// An expanded Orb page never waits longer than its 30 FPS region budget.
assert.equal(frameDue(1020000, 1000000, 30), false);
assert.equal(frameDue(1034000, 1000000, 30), true);
// A monotonic clock reset must not stall a visible glass surface.
assert.equal(frameDue(10, 1000000, 24), true);
// Run the shipped surface with a controlled clock and Clutter boundary.
const panelSource = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/panelGlass.js', import.meta.url
), 'utf8');
let nowUs = 1000000;
const PanelGlassSurface = new Function('GLib', 'frameDue', 'global',
    panelSource.replace(/^import [\s\S]*?;\n/gm, '')
        .replace('export class', 'class') +
    '\nreturn PanelGlassSurface;'
)({get_monotonic_time: () => nowUs}, frameDue,
    {stage: {width: 1920, height: 1080}});
const panel = new PanelGlassSurface({
    setSizeIfChanged() {},
    setTranslationIfChanged() {},
});
let sizeReads = 0;
let sceneRefreshes = 0;
let captureRect;
panel._material = {
    mapped: true, visible: true, opacity: 255,
    x: 0, y: 0, width: 1920, height: 36,
    set_position(x, y) {this.x = x; this.y = y;},
    get_size() {sizeReads++; return [this.width, this.height];},
    get_transformed_position() {return [this.x, this.y];},
};
panel._sceneRoot = {x: 0, y: 0};
panel._sceneManager = {
    setCullRect(rect) {captureRect = rect;},
    sync() {sceneRefreshes++;},
};

panel.syncFrame();
assert.equal(sceneRefreshes, 1, 'initial panel capture is immediate');
for (let frame = 0; frame < 4; frame++) {
    nowUs += 10000;
    panel.syncFrame();
}
assert.equal(sizeReads, 1, 'skipped frames do not read Clutter allocation');
assert.equal(sceneRefreshes, 1);
nowUs += 2000;
panel.syncFrame();
assert.equal(sizeReads, 2, 'the next due frame reads the live allocation');
assert.equal(sceneRefreshes, 2, 'a stationary panel still refreshes its scene');

nowUs += 1000;
panel.setBounds(5, 0, 1920, 36);
assert.equal(sceneRefreshes, 3, 'moving panel bypasses the scene budget');
assert.deepEqual(captureRect, [5, 0, 1920, 36]);

console.log('Compositor frame budget tests passed.');
