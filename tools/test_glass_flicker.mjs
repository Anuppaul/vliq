import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Test actual shipped GNOME Shell methods without a running compositor.
// The fade policy is deliberately separate from native widget animation.
const fromSource = name => readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/' + name, import.meta.url
), 'utf8');

const cardsSource = await fromSource('shellCards.js');
const cardsModule = cardsSource.replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');
const ShellCardSurface = new Function(
    'St', 'GLib', 'Main',
    cardsModule + '\nreturn ShellCardSurface;'
)({}, {}, {});

function card(previewInTarget) {
    let alpha = 255;
    let width = 150;
    let height = 90;
    let destroys = 0;
    let creates = 0;
    let syncs = 0;
    let hides = 0;
    const target = {
        mapped: true, visible: true,
        width: 150, height: 90,
        get_parent: () => ({}),
        get_allocation_box: () => ({
            x1: 40, y1: 50,
            get_width: () => width, get_height: () => height,
        }),
        get_paint_opacity: () => alpha,
        scale_x: 1, scale_y: 1,
        get_pivot_point: () => [0.5, 0.5],
        translation_x: 0, translation_y: 0,
    };
    const material = {
        visible: true, opacity: 255, scale_x: 1, scale_y: 1,
        get_pivot_point: () => [0.5, 0.5],
        set_pivot_point() {}, set_scale() {},
        hide() {hides++; this.visible = false;},
        show() {this.visible = true;},
    };
    const vendor = {
        setPositionIfChanged() {},
        setSizeIfChanged() {},
        setTranslationIfChanged() {},
    };
    const surface = new ShellCardSurface(
        { _vendor: vendor, _settings: {} }, target
    );
    surface._material = material;
    surface._previewInTarget = previewInTarget;
    surface._ensureSceneManager = () => {
        if (!surface._sceneManager) {
            creates++;
            surface._sceneManager = {};
        }
    };
    surface._syncSceneLayers = () => { syncs++; };
    surface._releaseSceneManager = () => {
        if (surface._sceneManager) {
            destroys++;
            surface._sceneManager = null;
        }
    };
    return {
        surface, target, material,
        get alpha() {return alpha;}, set alpha(value) {alpha = value;},
        get width() {return width;}, set width(value) {width = value;},
        get height() {return height;}, set height(value) {height = value;},
        counts: () => ({creates, destroys, syncs, hides}),
    };
}

for (const preview of [false, true]) {
    const item = card(preview);
    item.surface.syncFrame();
    assert.deepEqual(item.counts(), {
        creates: 1, destroys: 0, syncs: 1, hides: 0,
    }, 'initial shell card capture is allocated once');

    // Cross zero alpha repeatedly while actor stays mapped: a native hover
    // animation must not tear down the same live window/wallpaper scene.
    for (const alpha of [128, 1, 0, 0, 25, 255, 0, 70, 255]) {
        item.alpha = alpha;
        item.surface.syncFrame();
    }
    assert.equal(item.counts().creates, 1, 'no cold restart on fade-in');
    assert.equal(item.counts().destroys, 0, 'no cloned scene teardown on fade');
    assert.equal(item.counts().hides, 0, 'mapped card must stay mapped');
    assert.equal(item.material.opacity, 255, 'fade-in restores proper alpha');

    // GNOME can publish a zero or invalid allocation for one frame during
    // Overview / workspace transitions without actually unmapping a card.
    for (const [width, height] of [[0, 90], [150, 0],
        [NaN, 90], [150, NaN], [150, 90]]) {
        item.width = width;
        item.height = height;
        item.surface.syncFrame();
        assert.equal(item.counts().destroys, 0,
            'transient allocation must not destroy mapped scene');
        assert.equal(item.counts().hides, 0,
            'transient allocation must not unmap material');
    }
    assert.equal(item.material.opacity, 255,
        'valid bounds restore glass after allocation settles');
    assert.equal(item.counts().creates, 1,
        'allocation glitch must not recreate clone manager');

    item.target.mapped = false;
    item.surface.syncFrame();
    assert.equal(item.counts().destroys, 1, 'unmapped card releases scene');
    assert.equal(item.counts().hides, 1);
    item.target.mapped = true;
    item.alpha = 255;
    item.surface.syncFrame();
    assert.equal(item.counts().creates, 2, 'genuine remap builds a fresh scene');
    assert.equal(item.material.visible, true);
}

const dockSource = await fromSource('liquidGlassDock.js');
const start = dockSource.indexOf('    _ensureNativeDockPaintState(entry) {');
const end = dockSource.indexOf('    _nativeDockGlassVisible(entry) {', start);
assert.ok(start !== -1 && end > start, 'shipped dock paint policy exists');
const policySource = dockSource.slice(start, end);
const groupChildren = [];
const uiGroup = {get_children: () => groupChildren,
    set_child_below_sibling(a, b) {
        groupChildren.splice(groupChildren.indexOf(a), 1);
        groupChildren.splice(groupChildren.indexOf(b), 0, a);
    },
};
const dockPolicy = new Function('Main',
    'return ({\n' + policySource + '\n})._ensureNativeDockPaintState;'
)({layoutManager: {uiGroup}});
let nativeOpacity = 0;
let tileOpacity = 0;
let labelOpacity = 0;
let iconOpacity = 0;
const root = {get_parent: () => uiGroup};
const glass = {get_parent: () => uiGroup};
groupChildren.push(root, glass);
const icon = {visible: true, icon: {
    visible: true, get opacity() {return iconOpacity;},
    set opacity(v) {iconOpacity = v;},
}, get opacity() {return labelOpacity;},
set opacity(v) {labelOpacity = v;}};
const item = {visible: true, child: icon,
    get opacity() {return tileOpacity;},
    set opacity(v) {tileOpacity = v;}};
const dash = {visible: true, _box: {get_children: () => [item]},
    get opacity() {return nativeOpacity;},
    set opacity(v) {nativeOpacity = v;}};
const entry = {nativeDock: {dash}, manager: {bgActor: glass}};
dockPolicy.call({_findNativeDockRoot: () => root}, entry);
assert.deepEqual(groupChildren, [glass, root], 'glass stays below native dock');
assert.deepEqual([nativeOpacity, tileOpacity, labelOpacity, iconOpacity],
    [0, 0, 0, 0], 'zero alpha belongs exclusively to Ubuntu Dock');

for (const a of [40, 0, 255, 0, 128]) {
    nativeOpacity = tileOpacity = labelOpacity = iconOpacity = a;
    dockPolicy.call({_findNativeDockRoot: () => root}, entry);
    assert.deepEqual([nativeOpacity, tileOpacity, labelOpacity, iconOpacity],
        [a, a, a, a], 'VLIQ must not fight native opacity animation');
}
assert.equal(groupChildren[0], glass);

console.log('Dock native opacity and ShellCard preview fade flicker regression PASS.');
