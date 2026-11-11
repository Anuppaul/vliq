import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Execute the *shipped* GJS class methods with minimal GNOME actor mocks.
// This exercises the real layout/animation contracts without a display.
async function loadClass(path, type, injections = {}) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const body = source
        .replace(/^import\s[\s\S]*?;\s*$/gm, '')
        .replace(/^export\s+default\s+class\s+/gm, 'class ')
        .replace(/^export\s+class\s+/gm, 'class ');
    const keys = Object.keys(injections);
    return new Function(...keys, body + '\nreturn ' + type + ';')(
        ...Object.values(injections)
    );
}

const slots = [
    {x: 350, y: 280}, {x: 410, y: 350}, {x: 470, y: 420},
];
const sourceApps = ['One', 'Two', 'Three'];
const OrbRuntime = await loadClass(
    '../gnome-shell/vliq@wonderer.tech/orbThemeRuntime.js',
    'VLIQRuntime', {
        Extension: class {},
        GLib: {get_monotonic_time: () => 1000000},
        Clutter: {AnimationMode: {EASE_OUT_QUAD: 1, EASE_IN_QUAD: 2}},
        collectOrbApps: () => sourceApps,
        effectiveRingGap: (_, gap) => gap,
        arcForPosition: () => 360,
        slotsForGeometry: () => [slots, []],
        totalCapacity: lengths => lengths.reduce((a, b) => a + b, 0),
        allocateAcrossRings: n => [n, 0],
        selectGeometrySlots: (ring, n) => ring.slice(0, n),
        clamp: (n, low, high) => Math.max(low, Math.min(high, n)),
    }
);

function createRuntime() {
    const runtime = new OrbRuntime();
    runtime._settings = {
        get_string: key => ({
            'orb-app-source': 'all',
            'ring-mode': '2',
            'orb-geometry': 'orbit',
        })[key],
        get_int: key => ({
            'orb-size': 50, 'icon-size': 40, 'icon-gap': 6,
            'ring-gap': 65, 'animation-ms': 220,
        })[key] ?? 0,
        get_strv: () => [],
    };
    runtime._appSystem = {};
    runtime._shellSettings = {};
    runtime._orb = {get_position: () => [100, 100]};
    runtime._layer = {add_child(actor) {actor.parent = this;}};
    runtime._radialActors = [];
    runtime._closingActors = new Set();
    runtime._geometryActors = [];
    runtime._orbPageIndex = 0;
    runtime._menuOpen = false;
    runtime._dragging = false;
    for (const method of [
        '_cancelOpenTimer', '_cancelCloseTimer', '_cancelOrbAutoHideTimer',
        '_cancelOrbAutoFadeTimer', '_restoreOrbOpacity', '_revealOrb',
        '_destroyClosingActors', '_cancelAppPreviewHide', '_hideAppPreview',
        '_setOrbVisualPseudoClass', '_syncOrbPageIndicator',
        '_createGeometryLinks', '_hideOrbPageIndicator',
        '_destroyGeometryActors', '_hideTooltip', '_scheduleOrbAutoHide',
        '_scheduleOrbAutoFade',
    ])
        runtime[method] = () => {};
    runtime._monitorAt = () => ({x: 0, y: 0, width: 1280, height: 720});
    runtime._createAppButton = () => ({
        x: 0, y: 0, opacity: 255, scale_x: 1, scale_y: 1,
        set_position(x, y) {this.x = x; this.y = y;},
        ease(options) {this.animation = options;},
        remove_all_transitions() {},
        show() {},
        destroy() {this.destroyed = true;},
        get_parent() {return this.parent;},
    });
    return runtime;
}

const runtime = createRuntime();
runtime._openMenu();
assert.equal(runtime._radialActors.length, 3);
for (const [i, actor] of runtime._radialActors.entries()) {
    assert.equal(actor.x, slots[i].x, 'fixed native slot x');
    assert.equal(actor.y, slots[i].y, 'fixed native slot y');
    assert.equal(actor.translation_x, 125 - slots[i].x - 20);
    assert.equal(actor.translation_y, 125 - slots[i].y - 20);
    assert.equal(actor.animation.translation_x, 0);
    assert.equal(actor.animation.translation_y, 0);
    assert.equal('x' in actor.animation, false, 'never animate layout x');
    assert.equal('y' in actor.animation, false, 'never animate layout y');
}
const pageSession = runtime._orbPageSession;
runtime._closeMenu(false);
for (const actor of runtime._closingActors) {
    assert.equal('x' in actor.animation, false, 'native closing transform');
    assert.equal('y' in actor.animation, false, 'no closing relayout');
    assert.equal(actor.animation.translation_x, 105 - actor.x);
    assert.equal(actor.animation.translation_y, 105 - actor.y);
}

const paging = createRuntime();
paging._orbPageSession = pageSession;
paging._openMenu(true);
for (const actor of paging._radialActors) {
    assert.equal(actor.opacity, 255, 'no blank page during switch');
    assert.equal(actor.scale_x, 1);
    assert.equal(actor.scale_y, 1);
    assert.equal(actor.translation_x, 0);
    assert.equal(actor.translation_y, 0);
    assert.equal(actor.animation, undefined, 'paging does not rerun radial entrance');
}

// Regression: GNOME can fit fewer rings than the requested depth when
// Orb sits at a screen corner. Undefined outer slots must NEVER be indexed.
// This previously made a fixed 4-ring Orb fail to open entirely.
const CornerRuntime = await loadClass(
    '../gnome-shell/vliq@wonderer.tech/orbThemeRuntime.js',
    'VLIQRuntime', {
        Extension: class {},
        GLib: {get_monotonic_time: () => 1000000},
        Clutter: {AnimationMode: {EASE_OUT_QUAD: 1, EASE_IN_QUAD: 2}},
        collectOrbApps: () => sourceApps,
        effectiveRingGap: (_, gap) => gap,
        arcForPosition: () => 90,
        // Only one ring fits: monitor-safe geometry removed the outer 3.
        slotsForGeometry: () => [slots],
        totalCapacity: lengths => lengths.reduce((a, b) => a + b, 0),
        allocateAcrossRings: n => [n],
        selectGeometrySlots: (ring, n) => {
            assert.ok(Array.isArray(ring), 'never index a discarded ring');
            return ring.slice(0, n);
        },
        clamp: (n, low, high) => Math.max(low, Math.min(high, n)),
    }
);
const cornerRuntime = createRuntime();
Object.setPrototypeOf(cornerRuntime, CornerRuntime.prototype);
const oldGetString = cornerRuntime._settings.get_string;
cornerRuntime._settings.get_string = key =>
    key === 'ring-mode' ? '4' : oldGetString(key);
cornerRuntime._openMenu();
assert.equal(cornerRuntime._radialActors.length, 3,
    'corner-fit must still render all three apps');
assert.equal(cornerRuntime._orbPageSession.rings, 1,
    'session caches actual fitted ring depth, not requested four');
assert.deepEqual(cornerRuntime._orbPageSession.capacities, [3]);

// A large All Apps library needs only a single page of fitted slots, not
// 1000 slots in a giant, squeezed 8-ring radial layout. At 63 visible
// regions per page the remaining apps are paged without oversubscribing
// OrbGlass's four 16-region shader batches.
let geometryCalls = 0;
const hugeApps = Array.from({length: 1000}, (_, i) => 'App ' + i);
const bigSlots = Array.from({length: 40}, (_, i) => ({
    x: (i % 10) * 56 + 80, y: Math.floor(i / 10) * 58 + 95,
}));
const LargeRuntime = await loadClass(
    '../gnome-shell/vliq@wonderer.tech/orbThemeRuntime.js',
    'VLIQRuntime', {
        Extension: class {},
        GLib: {get_monotonic_time: () => 1000000},
        Clutter: {AnimationMode: {EASE_OUT_QUAD: 1, EASE_IN_QUAD: 2}},
        collectOrbApps: () => hugeApps,
        effectiveRingGap: (_, gap) => gap,
        arcForPosition: () => 180,
        slotsForGeometry: (...args) => {
            geometryCalls++;
            const depth = args[5];
            return Array.from({length: depth}, (_, i) =>
                bigSlots.map(p => ({x: p.x + 5 * i, y: p.y + 5 * i})));
        },
        totalCapacity: lengths => lengths.reduce((a, b) => a + b, 0),
        allocateAcrossRings: (n, capacities) => {
            let remaining = n;
            return capacities.map(capacity => {
                const current = Math.min(remaining, capacity);
                remaining -= current;
                return current;
            });
        },
        selectGeometrySlots: (ring, n) => ring.slice(0, n),
        clamp: (n, low, high) => Math.max(low, Math.min(high, n)),
    }
);
const large = createRuntime();
Object.setPrototypeOf(large, LargeRuntime.prototype);
const sourceSetting = large._settings.get_string;
large._settings.get_string = key =>
    key === 'ring-mode' ? 'auto' : sourceSetting(key);
large._openMenu();
assert.equal(geometryCalls, 2,
    'auto depth stops once 63 usable page slots exist');
assert.equal(large._radialActors.length, 63,
    'one page must never exceed four 16-region glass batches');
assert.equal(large._orbPageCount, Math.ceil(1000 / 63));
assert.equal(large._orbPageSession.rings, 2);

// Check the shipped geometry planner against real monitor edges. A fitted
// shape may have fewer levels than requested, but must not drop individual
// icons outside the screen or stack them on top of each other.
const geometrySource = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/geometry.js', import.meta.url
), 'utf8');
const geometry = new Function(
    geometrySource.replace(/^export\s+/gm, '') +
    '\nreturn {slotsForGeometry, arcForPosition, effectiveRingGap};'
)();
const monitors = [
    {x: 0, y: 0, width: 1366, height: 768},
    {x: 0, y: 0, width: 800, height: 600},
    {x: 1366, y: 0, width: 1920, height: 1080},
];
let fittedCases = 0;
for (const monitor of monitors) {
    const points = [
        [monitor.x + 8, monitor.y + 8],
        [monitor.x + monitor.width - 60, monitor.y + 8],
        [monitor.x + 8, monitor.y + monitor.height - 60],
        [monitor.x + monitor.width - 60, monitor.y + monitor.height - 60],
        [monitor.x + monitor.width / 2 - 25,
            monitor.y + monitor.height / 2 - 25],
    ];
    for (const [orbX, orbY] of points) {
        for (const shape of ['orbit', 'star', 'molecule',
            'spiral', 'petal']) {
            const orbSize = 54, iconSize = 40, iconGap = 6, depth = 8;
            const spacing = geometry.effectiveRingGap(iconSize, 20);
            const cx = orbX + orbSize / 2;
            const cy = orbY + orbSize / 2;
            const arc = geometry.arcForPosition(cx, cy,
                orbSize / 2 + depth * spacing, iconSize, monitor);
            const groups = geometry.slotsForGeometry(
                shape, cx, cy, orbSize, spacing, depth, arc,
                iconSize, iconGap, monitor, 8);
            assert.ok(groups.length <= depth,
                shape + ': fitted depth cannot exceed requested depth');
            const positions = groups.flat();
            for (const p of positions) {
                assert.ok(p.x >= monitor.x + 7 &&
                    p.y >= monitor.y + 7 &&
                    p.x + iconSize <= monitor.x + monitor.width - 7 &&
                    p.y + iconSize <= monitor.y + monitor.height - 7,
                    shape + ': icon escaped monitor bounds');
            }
            for (let i = 0; i < positions.length; i++) {
                for (let j = i + 1; j < positions.length; j++) {
                    assert.ok(Math.hypot(
                        positions[i].x - positions[j].x,
                        positions[i].y - positions[j].y
                    ) >= iconSize * 0.7,
                    shape + ': overlapping icon centres');
                }
            }
            fittedCases++;
        }
    }
}
assert.equal(fittedCases, 75, '75 shape/monitor/position combinations');

// Orb pan regression: test the shipped drag signal wiring with a moving
// native Orb actor, including hidden-edge reveal, reversal and stage clamps.
// The glass card is drawn in another layer and must follow the very same
// native actor position, without an in-flight auto-hide ease animation.
const orbSource = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/orbThemeRuntime.js',
    import.meta.url
), 'utf8');
const dragStart = orbSource.indexOf(
    '        this._panGesture = new Clutter.PanGesture();');
const dragEnd = orbSource.indexOf(
    '    _setOrbVisualPseudoClass(name, enabled) {', dragStart);
assert.ok(dragStart >= 0 && dragEnd > dragStart);
const actualDragWiring = orbSource.slice(dragStart, dragEnd);
class MockPan {
    constructor() {this.handlers = new Map(); this.pointer = null;}
    set_required_button() {}
    set_begin_threshold() {}
    connect(event, callback) {this.handlers.set(event, callback);}
    emit(event) {return this.handlers.get(event)?.(this);}
    get_centroid_abs() {
        if (this.pointer === null)
            return null;
        return {
            get_x: () => this.pointer[0],
            get_y: () => this.pointer[1],
        };
    }
    get_delta_abs() {
        return {
            get_x: () => this.dx,
            get_y: () => this.dy,
        };
    }
}
const Grab = {dismissed: false, dismiss() {this.dismissed = true;}};
const Wiring = new Function('Clutter', 'GLib', 'global',
    'return class Wiring { _wire() {\n' +
    actualDragWiring + '\n}'
)({
    PanGesture: MockPan, BUTTON_PRIMARY: 1, EVENT_STOP: 1,
}, {get_monotonic_time: () => 1000000}, {
    stage: {grab: () => Grab},
});
function makePanRuntime(hidden = false) {
    const o = new Wiring();
    let px = hidden ? -42 : 80;
    let py = hidden ? 180 : 90;
    o._orb = {
        get_position() {return [px, py];},
        set_position(x, y) {px = x; py = y;},
        remove_all_transitions() {this.transitionsCancelled = true;},
        fake_release() {},
        add_action(action) {this.action = action;},
    };
    o._orbHidden = hidden;
    o._settings = {get_int: () => 50};
    o._dragging = false;
    o._liquidGlassIntegration = {
        states: [],
        setOrbDragging(active) {this.states.push(active);},
    };
    o._clampPositionToVisibleMonitor = (x, y) => [
        Math.max(0, Math.min(590, x)),
        Math.max(0, Math.min(350, y)),
    ];
    o._clampOrbToStage = function() {
        const [x, y] = this._orb.get_position();
        this._orb.set_position(
            ...this._clampPositionToVisibleMonitor(x, y)
        );
    };
    o._storeOrbPosition = function() {this.stored = this._orb.get_position();};
    o._syncOrbFromSettings = () => {
        throw new Error('must not teleport hidden handle to saved position');
    };
    for (const method of [
        '_cancelOpenTimer', '_cancelCloseTimer',
        '_cancelOrbAutoHideTimer', '_cancelOrbAutoFadeTimer',
        '_restoreOrbOpacity', '_closeMenu', '_setOrbVisualPseudoClass',
        '_scheduleOrbAutoHide', '_scheduleOrbAutoFade',
    ])
        o[method] = () => {};
    o._wire();
    return o;
}
const drag = makePanRuntime();
drag._panGesture.pointer = [230, 240];
drag._panGesture.emit('recognize');
assert.deepEqual(drag._liquidGlassIntegration.states, [true]);
assert.equal(drag._orb.transitionsCancelled, true);
drag._panGesture.pointer = [250, 263];
drag._panGesture.emit('pan-update');
assert.deepEqual(drag._orb.get_position(), [100, 113]);
drag._panGesture.pointer = [260, 292];
drag._panGesture.emit('pan-update');
assert.deepEqual(drag._orb.get_position(), [110, 142]);
drag._panGesture.pointer = [1000, 1200];
drag._panGesture.emit('pan-update');
assert.deepEqual(drag._orb.get_position(), [590, 350]);
drag._panGesture.pointer = [240, 243];
drag._panGesture.emit('pan-update');
assert.deepEqual(drag._orb.get_position(), [90, 93],
    'reversing from a clamped edge must use original pointer anchor');
drag._panGesture.emit('end');
assert.deepEqual(drag._liquidGlassIntegration.states, [true, false]);
assert.deepEqual(drag.stored, [90, 93]);
assert.equal(Grab.dismissed, true);

const hiddenDrag = makePanRuntime(true);
hiddenDrag._panGesture.pointer = [4, 205];
hiddenDrag._panGesture.emit('recognize');
assert.deepEqual(hiddenDrag._orb.get_position(), [0, 180],
    'hidden handle expands in place; no jump to saved settings');
assert.equal(hiddenDrag._orbHidden, false);
hiddenDrag._panGesture.pointer = [22, 235];
hiddenDrag._panGesture.emit('pan-update');
assert.deepEqual(hiddenDrag._orb.get_position(), [18, 210]);
hiddenDrag._panGesture.emit('cancel');
assert.deepEqual(hiddenDrag._liquidGlassIntegration.states, [true, false]);

const legacyDrag = makePanRuntime();
legacyDrag._panGesture.pointer = null;
legacyDrag._panGesture.emit('recognize');
legacyDrag._panGesture.dx = 7;
legacyDrag._panGesture.dy = -4;
legacyDrag._panGesture.emit('pan-update');
assert.deepEqual(legacyDrag._orb.get_position(), [87, 86],
    'GNOME legacy per-event delta fallback remains incremental');
legacyDrag._panGesture.emit('end');

// Check that the native Overview shader radius does not toggle while the
// first Apps grid is opening or when switching between Overview states.
const Backdrop = await loadClass(
    '../gnome-shell/vliq@wonderer.tech/appGridBackdrop.js',
    'AppGridBackdropManager', {
        Main: {
            layoutManager: {overviewGroup: {
                visible: true, mapped: true,
                add_style_class_name() {}, remove_style_class_name() {},
            }},
            overview: {visible: true},
        },
    }
);
const backdrop = new Backdrop();
const blurChanges = [];
backdrop._enabled = true;
backdrop._layer = {
    visible: false, show() {this.visible = true;},
    hide() {this.visible = false;},
};
backdrop._updateBlur = radius => blurChanges.push(radius);
for (const phase of ['showing', 'shown', null, 'hiding']) {
    backdrop._syncVisibility(phase);
    assert.equal(backdrop._layer.visible, true);
}
assert.deepEqual(blurChanges, [], 'no mid-transition blur invalidation');

// Expanding an All Apps page must initialize only its new shader batches;
// previously the first new batch re-applied appearance to the already visible
// Orb face, invalidating its texture on the very frame the menu appeared.
let clock = 5000000;
const updatedEffects = [];
const OrbGlass = await loadClass(
    '../gnome-shell/vliq@wonderer.tech/orbGlass.js',
    'OrbGlassManager', {
        GLib: {get_monotonic_time: () => clock},
        frameDue: (now, last, fps) =>
            !last || now < last || now - last >= 1000000 / fps,
        VLIQ_GLASS_ROLES: {orbCard: {tintStrength: 0}},
        VLIQ_GLASS_ADAPTERS: {orb: {multiRegion: true}},
        applyVLIQGlassRole: effect => updatedEffects.push(effect.id),
        global: {stage: {width: 1280, height: 720}},
    }
);
const glass = new OrbGlass({
    vendor: {setSizeIfChanged() {this.writes++;}, writes: 0},
    settings: {get_double: () => 1},
    readAppearance: () => ({r: 255, g: 255, b: 255, blur: 7}),
});
glass._appearance = {r: 255, g: 255, b: 255, blur: 7};
glass._root = {visible: true, queue_redraw() {}, hide() {this.visible = false;}};
glass._batches = [{effect: {id: 0}}];
glass._createBatch = function(index) {
    const batch = {effect: {id: index}};
    this._batches.push(batch);
    return batch;
};
glass._ensureBatchCount(4);
assert.deepEqual(updatedEffects, [1, 2, 3], 'do not reset visible glass batch');
updatedEffects.length = 0;
glass.updateAppearance();
assert.deepEqual(updatedEffects, [0, 1, 2, 3], 'appearance settings still refresh every batch');

// For a moving expanded grid, bypass the stationary 30 FPS budget.
glass._lastRegionPassUs = clock;
glass._expandedRegionsActive = true;
glass._regionMotionActive = false;
glass._buttons = new Set();
glass._orbFace = null;
glass._syncRegions();
assert.equal(glass._vendor.writes, 0, 'stationary grid skips extra scan');
glass._regionMotionActive = true;
glass._syncRegions();
assert.equal(glass._vendor.writes, 1, 'moving grid runs on this frame');
// Moving Orb capture should use a stable overscanned cull region. The
// previous exact-pixel clip changed every pan event while the texture
// compositor could still be rendering the preceding offscreen snapshot.
const glassDragging = new OrbGlass({
    vendor: {}, settings: {}, readAppearance: () => ({}),
});
glassDragging._batches = [{lastCullRect: [1, 1, 1, 1]}];
const queued = [];
glassDragging._root = {queue_redraw() {queued.push(true);}};
glassDragging.setDragActive(true);
assert.equal(glassDragging._dragActive, true);
assert.equal(glassDragging._batches[0].lastCullRect, null);
const cull1 = glassDragging._captureCullRect(
    100, 100, 180, 180, 1280, 720, 0);
const cull2 = glassDragging._captureCullRect(
    110, 120, 190, 200, 1280, 720, 0);
assert.deepEqual(cull1, cull2, 'capture clip stable for small drag');
assert.deepEqual(glassDragging._captureCullRect(
    100, 100, 180, 180, 1280, 720, 1), [100, 100, 80, 80],
'only Orb batch uses stable drag capture');
glassDragging.setDragActive(false);
assert.equal(glassDragging._dragActive, false);
assert.equal(glassDragging._glyphSampleDirty, true);
assert.deepEqual(glassDragging._captureCullRect(
    100, 100, 180, 180, 1280, 720, 0), [100, 100, 80, 80],
'stopped drag returns to efficient exact capture');
assert.equal(queued.length, 2);


console.log('Orb native transitions, glass expansion, and Overview blur tests passed.');
