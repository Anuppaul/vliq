import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the shipped GNOME 50 three-island panel manager without a display.
// Keep the real GNOME boxes and buttons in place: only paint bounded, rounded
// PanelGlassSurface actors below Main.layoutManager.panelBox.
const source = (await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/topBarIslands.js', import.meta.url
), 'utf8')).replace(/^import[^\n]*\n/gm, '')
    .replace('export class TopBarIslands', 'class TopBarIslands');

let nextSignal = 1;
let stageTimeUs = 1000000;
const stageSignals = new Map();
const stage = {
    connect(signal, fn) {
        assert.equal(signal, 'before-update');
        const id = nextSignal++;
        stageSignals.set(id, fn);
        return id;
    },
    disconnect(id) {stageSignals.delete(id);},
    tick(elapsedUs = 50000) {
        stageTimeUs += elapsedUs;
        for (const fn of [...stageSignals.values()]) fn();
    },
};

class Actor {
    constructor({x = 0, y = 0, width = 0, height = 0, children = []} = {}) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.children = children;
        this.parent = null;
        this.visible = true;
        this.mapped = true;
        this.opacity = 255;
        this.classes = new Set();
        this.signals = new Map();
    }
    add_child(actor) {
        actor.parent?.remove_child(actor);
        actor.parent = this;
        this.children.push(actor);
    }
    insert_child_below(actor, sibling) {
        const index = this.children.indexOf(sibling);
        assert.ok(index >= 0);
        actor.parent?.remove_child(actor);
        actor.parent = this;
        this.children.splice(index, 0, actor);
    }
    remove_child(actor) {
        this.children = this.children.filter(x => x !== actor);
        if (actor.parent === this) actor.parent = null;
    }
    get_parent() {return this.parent;}
    get_children() {return this.children;}
    get_transformed_position() {
        const [px, py] = this.parent?.get_transformed_position?.() ?? [0, 0];
        return [this.x + px, this.y + py];
    }
    get_transformed_size() {return [this.width, this.height];}
    get_paint_opacity() {return this.opacity;}
    add_style_class_name(name) {this.classes.add(name);}
    remove_style_class_name(name) {this.classes.delete(name);}
    connect(signal, handler) {
        const id = nextSignal++;
        this.signals.set(id, {signal, handler});
        return id;
    }
    disconnect(id) {this.signals.delete(id);}
    emit(signal) {
        for (const entry of [...this.signals.values()])
            if (entry.signal === signal) entry.handler(this);
    }
}
const glassSurfaces = [];
let failNextGlassAttach = false;
class MockPanelGlassSurface {
    constructor(vendor, settings, appearance, options) {
        this.vendor = vendor;
        this.settings = settings;
        this.appearance = appearance;
        this.options = options;
        this._ready = false;
        this.visible = true;
        this.updates = 0;
        this.boundsWrites = 0;
        this.sceneSyncChecks = 0;
        glassSurfaces.push(this);
    }
    attach(host, root) {
        if (failNextGlassAttach) {
            failNextGlassAttach = false;
            return false;
        }
        this.material = new Actor();
        this.host = host;
        host.insert_child_below(this.material, root);
        return true;
    }
    setBounds(x, y, w, h, opacity) {
        this.boundsWrites++;
        this.bounds = {x, y, w, h, opacity};
        this.visible = true;
    }
    syncFrame() {this.sceneSyncChecks++;}
    hide() {this.visible = false;}
    get ready() {return this._ready;}
    updateAppearance() {this.updates++;}
    destroy() {
        this.host?.remove_child(this.material);
        this.destroyed = true;
    }
}
const uiGroup = new Actor({x: 0, y: 0, width: 1920, height: 1080});
const panelBox = new Actor({x: 0, y: 0, width: 1920, height: 36});
uiGroup.add_child(panelBox);
const panel = new Actor({x: 0, y: 0, width: 1920, height: 36});
panelBox.add_child(panel);
panel._leftBox = new Actor({x: 0, y: 0, width: 122, height: 36,
    children: [{role: 'Activities'}]});
panel._centerBox = new Actor({x: 900, y: 0, width: 120, height: 36,
    children: [{role: 'DateMenu'}]});
panel._rightBox = new Actor({x: 1650, y: 0, width: 270, height: 36,
    children: [{role: 'QuickSettings'}, {role: 'Network'}, {role: 'Battery'}]});
for (const actor of [panel._leftBox, panel._centerBox, panel._rightBox])
    panel.add_child(actor);
const controls = [
    [...panel._leftBox.children], [...panel._centerBox.children],
    [...panel._rightBox.children],
];
const monitor = {index: 0, x: 0, y: 0, width: 1920, height: 1080};
const layout = new Actor();
layout.uiGroup = uiGroup;
layout.panelBox = panelBox;
layout.primaryMonitor = monitor;
const display = new Actor();
let fullscreen = false;
const TopBarIslands = new Function(
    'Main', 'global', 'PanelGlassSurface', 'primaryPanelIsFullscreen',
    'console', 'GLib', 'frameDue',
    source + '\nreturn TopBarIslands;'
)(
    {panel, layoutManager: layout},
    {stage, display},
    MockPanelGlassSurface,
    () => fullscreen,
    {log() {}, warn() {}},
    {get_monotonic_time: () => stageTimeUs},
    (now, last, fps) =>
        !last || now < last || now - last >= 1000000 / fps
);
const instance = new TopBarIslands({
    vendor: {}, settings: {}, readAppearance: () => ({opacity: 0.05}),
    panel, layout, display,
});
assert.equal(instance.setup(), true);
assert.equal(glassSurfaces.length, 3);
assert.equal(stageSignals.size, 1, 'one stage sync for all three islands');
assert.equal(instance._regions.length, 3);
assert.ok(panel.classes.has('vliq-three-islands'));
assert.equal(instance.setup(), true, 'repeated setup is idempotent');
assert.equal(stageSignals.size, 1, 'repeated setup never adds a frame callback');
assert.equal(glassSurfaces.length, 3,
    'repeated setup never creates duplicate glass actors');
for (let i = 0; i < 3; i++) {
    const region = instance._regions[i];
    const group = [panel._leftBox, panel._centerBox, panel._rightBox][i];
    assert.equal(region.actor, group);
    assert.ok(group.classes.has('vliq-panel-island'));
    assert.equal(region.surface.options.cornerRadius, 16);
    assert.equal(region.surface.material.parent, uiGroup);
    assert.ok(uiGroup.children.indexOf(region.surface.material) <
        uiGroup.children.indexOf(panelBox),
    'Glass must be BEHIND the native panel and must never intercept input');
    assert.ok(region.surface.bounds.w < 500,
        'island must not become a full-width backplate');
    assert.ok(region.surface.bounds.h < 36,
        'island must float inside the native top-bar height');
    assert.deepEqual(group.children, controls[i],
        'GNOME native panel controls must never be reparented');
}
const [left, center, right] = instance._regions;

// A fixed top bar formerly repeated setBounds() for all 3 regions every
// compositor frame, causing redundant GObject reads and scene relayout.
const initialBoundsWrites = glassSurfaces.map(x => x.boundsWrites);
stage.tick();
assert.deepEqual(glassSurfaces.map(x => x.boundsWrites),
    initialBoundsWrites, 'idle stage frame cannot rewrite stable bounds');
assert.ok(glassSurfaces.every(x => x.sceneSyncChecks > 0),
    'stable glass still receives damage-bounded scene synchronization');

// Simulate a 60 FPS session for two seconds. Geometry sampling and scene
// sync are capped at the established 24 FPS material budget; mandatory
// fullscreen/indicator signal callbacks bypass that budget immediately.
const checksBefore = glassSurfaces.map(x => x.sceneSyncChecks);
for (let i = 0; i < 120; i++)
    stage.tick(16667);
const checks = glassSurfaces.map((x, i) =>
    x.sceneSyncChecks - checksBefore[i]);
assert.ok(checks.every(n => n >= 35 && n <= 52),
    '60 FPS should perform approximately 24 geometry/scene checks per second');
assert.deepEqual(glassSurfaces.map(x => x.boundsWrites),
    initialBoundsWrites, 'two seconds of idle paint must not duplicate bounds writes');

assert.ok(center.surface.bounds.x > left.surface.bounds.x +
    left.surface.bounds.w + 100, 'left and center are separate');
assert.ok(right.surface.bounds.x > center.surface.bounds.x +
    center.surface.bounds.w + 100, 'center and right are separate');

// The native CSS fallback stays until each GPU material has actually
// composited, then independently disappears for that single island.
left.surface._ready = true;
instance.sync();
assert.ok(left.actor.classes.has('vliq-panel-island-ready'));
assert.ok(!center.actor.classes.has('vliq-panel-island-ready'));
center.surface._ready = true;
right.surface._ready = true;
stage.tick();
assert.ok(center.actor.classes.has('vliq-panel-island-ready'));
assert.ok(right.actor.classes.has('vliq-panel-island-ready'));

// A late indicator and monitor width adjustment must be accounted for
// without a destructive rebuild or changing click ownership.
panel._rightBox.width += 36;
panel._rightBox.x -= 36;
panel._rightBox.add_child({role: 'late-system-indicator'});
panel._rightBox.emit('child-added');
assert.ok(right.surface.bounds.w > 270);
assert.deepEqual(panel._leftBox.children, controls[0]);
assert.equal(glassSurfaces.length, 3, 'no new shader on indicator changes');
layout.primaryMonitor.width = 1680;
panel._rightBox.x = 1440;
panel._rightBox.width = 240;
layout.emit('monitors-changed');
assert.ok(right.surface.bounds.x + right.surface.bounds.w <= 1674,
    'right island must fit within resized monitor');

// Individual empty boxes hide only their own material.
panel._centerBox.children = [];
stage.tick();
assert.equal(center.surface.visible, false);
assert.ok(center.actor.classes.has('vliq-panel-island-inactive'),
    'empty indicator group must not keep a CSS glass fallback');
assert.equal(left.surface.visible, true);
panel._centerBox.children = [...controls[1]];
stage.tick();
assert.equal(center.surface.visible, true);
assert.ok(!center.actor.classes.has('vliq-panel-island-inactive'),
    'repopulated native controls restore only their own island');

// Narrow displays and third-party indicators can make *glass padding*
// overlap while the native GNOME controls remain independent. Keep a true
// visible wallpaper gap without moving/click-blocking any controls.
const originalCenter = {x: panel._centerBox.x, y: panel._centerBox.y,
    width: panel._centerBox.width, height: panel._centerBox.height};
const originalRight = {x: panel._rightBox.x, width: panel._rightBox.width};
panel._centerBox.x = 1140;
panel._centerBox.width = 170;
panel._rightBox.x = 1250;
panel._rightBox.width = 290;
stage.tick();
assert.ok(
    right.surface.bounds.x -
    (center.surface.bounds.x + center.surface.bounds.w) >= 7.99,
    'overlapping native group allocations must keep an 8px glass gap'
);
assert.deepEqual(panel._centerBox.children, controls[1],
    'overlap repair must not mutate native Date Menu controls');
panel._centerBox.x = originalCenter.x;
panel._centerBox.width = originalCenter.width;
panel._rightBox.x = originalRight.x;
panel._rightBox.width = originalRight.width;

// A hidden GNOME indicator remains parented during session transitions.
// Do not leave a floating orphan-glass island behind invisible controls.
const dateControl = controls[1][0];
dateControl.visible = false;
stage.tick();
assert.equal(center.surface.visible, false,
    'hidden native controls must hide their glass immediately');
assert.ok(center.actor.classes.has('vliq-panel-island-inactive'),
    'hidden controls must clear their own painted fallback');
delete dateControl.visible;
stage.tick();
assert.equal(center.surface.visible, true);
assert.ok(!center.actor.classes.has('vliq-panel-island-inactive'));

// GNOME can stretch a panel box when adding status indicators. Fit the
// optical card to the real visible child allocation, not the empty box.
const dateActor = new Actor({x: 8, y: 8, width: 120, height: 20});
panel._centerBox.width = 410;
panel._centerBox.add_child(dateActor);
stage.tick();
assert.ok(center.surface.bounds.w <= 150,
    'glass should tightly fit the visible child, not a wide GNOME box');
assert.equal(center.surface.bounds.h, 32,
    'all three islands retain the native 36px panel height minus 2px inset');
panel._centerBox.remove_child(dateActor);
panel._centerBox.width = originalCenter.width;
stage.tick();

// Broken extensions sometimes report content extending below the panel.
// Never let a 3-island glass material bleed onto the desktop underneath.
panel._centerBox.y = -10;
panel._centerBox.height = 90;
stage.tick();
assert.ok(center.surface.bounds.h <= panelBox.height,
    'glass must be clipped to the real native top-panel height');
assert.ok(center.surface.bounds.y >= 0);
panel._centerBox.y = originalCenter.y;
panel._centerBox.height = originalCenter.height;
stage.tick();

instance.updateAppearance();
assert.deepEqual(glassSurfaces.map(s => s.updates), [1, 1, 1]);

// A fullscreen movie on the primary monitor must hide all islands; an
// independent visibility gate is honored even when the panel is mapped.
fullscreen = true;
display.emit('in-fullscreen-changed');
assert.ok(glassSurfaces.every(s => !s.visible));
fullscreen = false;
instance.setVisibilityGate(() => false);
assert.ok(glassSurfaces.every(s => !s.visible));
instance.setVisibilityGate(() => true);
assert.ok(glassSurfaces.every(s => s.visible));
panelBox.visible = false;
stage.tick();
assert.ok(glassSurfaces.every(s => !s.visible));
panelBox.visible = true;
stage.tick();
assert.ok(glassSurfaces.every(s => s.visible));

instance.cleanup();
assert.equal(stageSignals.size, 0);
assert.ok(glassSurfaces.every(s => s.destroyed));
assert.equal(uiGroup.children.filter(x => x !== panelBox).length, 0,
    'hot unload must remove all three glass actors');
for (const [index, group] of [
    panel._leftBox, panel._centerBox, panel._rightBox,
].entries()) {
    assert.ok(!group.classes.has('vliq-panel-island'));
    assert.ok(!group.classes.has('vliq-panel-island-inactive'),
        'no stale inactive glass class after hot-reload');
    assert.equal(group.children.length,
        controls[index].length + (index === 2 ? 1 : 0));
    for (let j = 0; j < controls[index].length; j++) {
        assert.equal(group.children[j], controls[index][j],
            'original GNOME panel input actors keep their identities');
    }
    if (index === 2)
        assert.equal(group.children.at(-1).role, 'late-system-indicator');
    assert.equal(group.signals.size, 0,
        'hot reload must not leak native actor signal handlers');
}
assert.ok(!panel.classes.has('vliq-three-islands'));
assert.equal(panel.signals.size, 0);
assert.equal(display.signals.size, 0);
assert.equal(layout.signals.size, 0);

// Every hot reload must release old effects and frame hooks before a new
// runtime starts, or the same three glass cards render multiple times.
assert.equal(instance.setup(), true, 'fresh setup after cleanup must succeed');
assert.equal(glassSurfaces.length, 6,
    'each live runtime owns exactly three material actors');
assert.equal(stageSignals.size, 1,
    'hot reload must leave only one active top-bar frame callback');
instance.cleanup();
assert.equal(stageSignals.size, 0, 'second cleanup removes last frame hook');
assert.equal(uiGroup.children.filter(x => x !== panelBox).length, 0,
    'no duplicate glass actors survive multiple enable/disable cycles');

// FULL Header is a single panel-height square glass surface, selectable
// via canonical VLIQ Settings while GNOME's native controls stay in place.
const layoutSettings = new Actor();
layoutSettings.mode = 'full';
layoutSettings.status = 'Not initialized';
layoutSettings.get_string = key => {
    if (key === 'top-header-runtime-status')
        return layoutSettings.status;
    assert.equal(key, 'top-header-layout');
    return layoutSettings.mode;
};
layoutSettings.set_string = (key, next) => {
    if (key === 'top-header-runtime-status') {
        layoutSettings.status = next;
        return;
    }
    assert.equal(key, 'top-header-layout');
    layoutSettings.mode = next;
    layoutSettings.emit('changed::top-header-layout');
};
const beforeFull = glassSurfaces.length;
const bottomSessions = [];
const dockModeUpdates = [];
const configurable = new TopBarIslands({
    vendor: {}, settings: {},
    layoutSettings, readAppearance: () => ({opacity: 0.05}),
    panel, layout, display,
    onLayoutChanged(mode) {dockModeUpdates.push(mode);},
    bottomTaskbarFactory(options) {
        const session = {
            options,
            active: false,
            setup() {
                this.active = true;
                panelBox.y = layout.primaryMonitor.y +
                    layout.primaryMonitor.height - panelBox.height;
                return true;
            },
            cleanup() {
                this.active = false;
                panelBox.y = layout.primaryMonitor.y;
            },
            setLauncherCallback(callback) {this.callback = callback;},
        };
        bottomSessions.push(session);
        return session;
    },
});
assert.equal(configurable.setup(), true);
assert.equal(configurable._layoutMode, 'full');
assert.equal(layoutSettings.status, 'Full Header active');
assert.equal(configurable._regions.length, 1);
assert.equal(glassSurfaces.length, beforeFull + 1,
    'Full Header creates exactly one bounded glass effect');
assert.equal(stageSignals.size, 1,
    'switchable header keeps exactly one stage callback');
assert.ok(panel.classes.has('vliq-full-header'));
assert.ok(!panel.classes.has('vliq-three-islands'));
const full = configurable._regions[0];
assert.equal(full.surface.options.cornerRadius, 0,
    'Full Header uses square native-panel corners');
assert.ok(full.surface.bounds.w > 1000 &&
    full.surface.bounds.w <= layout.primaryMonitor.width,
    'Full Header spans the native primary panel and no desktop area');
assert.equal(full.surface.bounds.h, panelBox.height);
for (const [actor, children] of [
    [panel._leftBox, controls[0]], [panel._centerBox, controls[1]],
    [panel._rightBox, controls[2]],
]) {
    for (let i = 0; i < children.length; i++)
        assert.equal(actor.children[i], children[i],
            'Header layouts must preserve native child actor identity');
}
full.surface._ready = true;
configurable.sync();
assert.ok(panel.classes.has('vliq-top-header-ready'),
    'native fallback vanishes only after one actual glass composite');
layoutSettings.set_string('top-header-layout', 'split');
assert.equal(full.surface.destroyed, true,
    'switching to 3-Part must remove full-width shader');
assert.equal(configurable._regions.length, 3);
assert.ok(!panel.classes.has('vliq-full-header'));
assert.ok(!panel.classes.has('vliq-top-header-ready'));
assert.ok(panel.classes.has('vliq-three-islands'));
assert.ok(configurable._regions.every(r =>
    r.surface.options.cornerRadius === 16));
assert.equal(stageSignals.size, 1, 'mode switch cannot duplicate frame loop');
const previousIslands = [...configurable._regions];
layoutSettings.set_string('top-header-layout', 'full');
assert.ok(previousIslands.every(r => r.surface.destroyed),
    'three old shader actors must be destroyed on Full switch');
assert.ok([panel._leftBox, panel._centerBox, panel._rightBox]
    .every(actor => !actor.classes.has('vliq-panel-island')));
assert.equal(configurable._regions.length, 1);
assert.equal(stageSignals.size, 1);
const fullAgain = configurable._regions[0];
assert.equal(fullAgain.surface.bounds.h, panelBox.height);
// Full Header retains the same synchronous native fullscreen semantics.
fullscreen = true;
display.emit('in-fullscreen-changed');
assert.equal(fullAgain.surface.visible, false,
    'Full Header must hide during fullscreen');
fullscreen = false;
display.emit('in-fullscreen-changed');
assert.equal(fullAgain.surface.visible, true,
    'Full Header must reappear with the native panel');
fullAgain.surface._ready = true;
configurable.sync();
assert.ok(panel.classes.has('vliq-top-header-ready'));
const originalPanelWidth = panelBox.width;
panelBox.width = 0;
configurable.sync();
assert.equal(fullAgain.surface.visible, false,
    'invalid native allocation cannot draw a desktop-wide glass layer');
assert.ok(!panel.classes.has('vliq-top-header-ready'),
    'hide must restore native fallback even at invalid bounds');
panelBox.width = originalPanelWidth;
configurable.sync();
assert.equal(fullAgain.surface.visible, true);
const beforeTickWrites = fullAgain.surface.boundsWrites;
stage.tick();
assert.equal(fullAgain.surface.boundsWrites, beforeTickWrites,
    'stationary full header should not rewrite glass bounds');
// Switch from Full to Bottom and back without remounting native controls.
layoutSettings.set_string('top-header-layout', 'bottom');
assert.equal(configurable._layoutMode, 'bottom');
assert.equal(layoutSettings.status,
    'Bottom Taskbar active (Liquid Glass)');
assert.ok(dockModeUpdates.includes('bottom'),
    'native Dock painters are reconciled on bottom mode activation');
assert.equal(configurable.isBottomTaskbarActive(), true,
    'mode only reports active after native taskbar setup');
assert.equal(configurable._regions.length, 1);
assert.ok(panel.classes.has('vliq-bottom-taskbar'));
assert.ok(panel.classes.has('vliq-full-header'));
assert.ok(!panel.classes.has('vliq-three-islands'));
assert.equal(bottomSessions.length, 1);
assert.equal(bottomSessions[0].active, true);
assert.equal(configurable._regions[0].surface.options.cornerRadius, 0);
assert.equal(configurable._regions[0].surface.bounds.h, panelBox.height);
assert.equal(configurable._regions[0].surface.bounds.y,
    layout.primaryMonitor.y + layout.primaryMonitor.height - panelBox.height,
    'bottom optical header follows moved native panel allocation');
assert.equal(stageSignals.size, 1);
const oldBottomSurface = configurable._regions[0].surface;
layoutSettings.set_string('top-header-layout', 'bottom');
assert.equal(configurable._regions[0].surface, oldBottomSurface,
    'repeating current layout must not recreate GPU material');
layoutSettings.set_string('top-header-layout', 'full');
assert.equal(bottomSessions[0].active, false,
    'exit restores original GNOME panel and Dock state');
assert.equal(dockModeUpdates.at(-1), 'full',
    'native Dock appearance is restored upon return to Full Header');
assert.equal(layoutSettings.status, 'Full Header active');
assert.equal(configurable.isBottomTaskbarActive(), false);
assert.equal(panelBox.y, layout.primaryMonitor.y);
assert.equal(oldBottomSurface.destroyed, true);
assert.equal(configurable._regions.length, 1);
assert.ok(!panel.classes.has('vliq-bottom-taskbar'));
assert.equal(configurable._regions[0].surface.bounds.y, 0);
assert.equal(stageSignals.size, 1);
configurable.cleanup();
assert.equal(stageSignals.size, 0);
assert.equal(layoutSettings.signals.size, 0,
    'layout GSettings handler must be disconnected on hot reload');
assert.equal(uiGroup.children.filter(x => x !== panelBox).length, 0,
    'no full-width glass left behind after cleanup');
assert.ok(!panel.classes.has('vliq-full-header'));

// Regression for a compositor/GPU allocation failure. A missing glass FBO
// must not silently revert the entire native bottom taskbar to 3-Part.
layoutSettings.mode = 'bottom';
failNextGlassAttach = true;
const cssFallback = new TopBarIslands({
    vendor: {}, settings: {},
    layoutSettings, readAppearance: () => ({opacity: 0.05}),
    panel, layout, display,
    bottomTaskbarFactory(options) {
        const session = {
            active: false,
            setup() {
                this.active = true;
                panelBox.y = layout.primaryMonitor.height - panelBox.height;
                return true;
            },
            cleanup() {
                this.active = false;
                panelBox.y = layout.primaryMonitor.y;
            },
        };
        bottomSessions.push(session);
        return session;
    },
});
assert.equal(cssFallback.setup(), true,
    'Bottom remains active when native glass attach is unavailable');
assert.equal(cssFallback._layoutMode, 'bottom');
assert.equal(layoutSettings.status,
    'Bottom Taskbar active (CSS fallback)');
assert.equal(cssFallback.isBottomTaskbarActive(), true,
    'CSS-only fallback is still a functional native taskbar');
assert.equal(cssFallback._regions.length, 0,
    'no invalid GPU surface left alive after failed attach');
assert.ok(panel.classes.has('vliq-bottom-taskbar'));
assert.equal(panelBox.y, 1044, 'native panel is still at bottom');
assert.equal(stageSignals.size, 1);
cssFallback.cleanup();
assert.equal(stageSignals.size, 0);
assert.equal(bottomSessions.at(-1).active, false);
assert.equal(panelBox.y, 0);
layoutSettings.mode = 'split';

// Native bottom setup failures now restore the *GSettings selection*
// to Split, instead of hiding the Orb while leaving a top panel visible.
const failedBottom = new TopBarIslands({
    vendor: {}, settings: {},
    layoutSettings, readAppearance: () => ({}),
    panel, layout, display,
    bottomTaskbarFactory() {
        return {setup: () => false, cleanup() {}};
    },
});
assert.equal(failedBottom.setup(), true);
layoutSettings.set_string('top-header-layout', 'bottom');
assert.equal(failedBottom._layoutMode, 'split');
assert.equal(layoutSettings.mode, 'split',
    'failed bottom activation reverts stored preference to actual layout');
assert.match(layoutSettings.status, /Error activating bottom/,
    'visible Settings status explains why bottom mode could not start');
assert.equal(failedBottom.isBottomTaskbarActive(), false);
assert.equal(stageSignals.size, 1);
failedBottom.cleanup();
assert.equal(stageSignals.size, 0);

const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');
assert.match(css, /#panel\.vliq-liquid-top-panel\.vliq-three-islands/);
assert.match(css, /#panel\.vliq-liquid-top-panel\.vliq-full-header/);
assert.match(css, /#panel\.vliq-liquid-top-panel\.vliq-bottom-taskbar/);
assert.match(css, /\.vliq-taskbar-app-button/);
assert.match(css, /#panel\.vliq-liquid-top-panel\.vliq-full-header\.vliq-top-header-ready/);
assert.match(css, /#panelLeft\.vliq-panel-island/);
assert.match(css, /#panelCenter\.vliq-panel-island/);
assert.match(css, /#panelRight\.vliq-panel-island/);
assert.match(css, /#panelLeft\.vliq-panel-island-ready/);
assert.match(css, /vliq-panel-island\.vliq-panel-island-inactive/,
    'inactive native glass islands need a transparent fallback');
for (const id of ['panelLeft', 'panelCenter', 'panelRight']) {
    const override = '#panel.vliq-three-islands #' + id +
        '.vliq-panel-island.vliq-panel-island-inactive';
    assert.ok(css.includes(override),
        'hidden island must outrank native fallback via both ID selectors: ' + id);
}

const integration = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/liquidGlassDock.js',
    import.meta.url
), 'utf8');
const begin = integration.indexOf('    _setupTopPanelGlass() {');
const finish = integration.indexOf('    _setupNativeNotificationStyler() {', begin);
assert.ok(begin >= 0 && finish > begin);
const topSetup = integration.slice(begin, finish);
assert.match(topSetup, /layoutSettings: this\._vliqSettings/,
    'full/split setting must come from canonical VLIQ schema');
assert.match(topSetup, /new TopBarIslands\(/,
    'new top bar must use the three-island manager');
assert.doesNotMatch(topSetup, /new this\._vendor\.DashManager\(/,
    'do not recreate the old single full-width glass strip');
assert.match(integration, /this\._topPanelIslands\?\.updateAppearance\(\)/,
    'global Material Appearance must refresh all three island shaders');
const dynamicPanel = integration.indexOf(
    "'#panel.vliq-liquid-top-panel {"
);
assert.ok(dynamicPanel >= 0);
const dynamicPanelCss = integration.slice(dynamicPanel, dynamicPanel + 275);
assert.match(dynamicPanelCss, /background-color: transparent !important/,
    'dynamic CSS must keep the native full-width panel transparent');
assert.doesNotMatch(dynamicPanelCss, /background-color: rgba/,
    'global Appearance updates cannot repaint a full-width tint');

const schema = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/schemas/org.gnome.shell.extensions.vliq.gschema.xml',
    import.meta.url
), 'utf8');
const prefs = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/prefs.js', import.meta.url
), 'utf8');
assert.match(schema, /name="top-header-layout" type="s"/);
assert.match(schema, /<default>'split'<\/default>/,
    'original three-part look is default');
assert.match(prefs, /'Desktop Panel Position'/);
assert.match(prefs, /'Desktop Layout',/,
    'layout selector has a dedicated desktop layout page');
assert.match(prefs, /headerPage.add\(topHeader\)/,
    'Header layout controls belong in the Top Header page');
assert.match(prefs, /'Full Header'/);
assert.match(prefs, /'3-Part Header'/);
assert.match(prefs, /'Bottom Taskbar'/);
assert.match(schema, /name="top-header-runtime-status" type="s"/);
assert.match(prefs, /'Active desktop layout'/,
    'Preferences displays effective Shell mode, not only user selection');
assert.match(schema, /<choice value="bottom"\s*\/>/,
    'bottom layout persisted in canonical schema');

const installer = await readFile(new URL(
    '../gnome-shell/install.sh', import.meta.url
), 'utf8');
assert.match(installer, /"topBarIslands\.js"/,
    'split top bar must be included in hot-reload and Store ZIP packaging');
console.log('Top Bar: 3 rounded native glass islands, geometry, fullscreen, input ownership and teardown PASS.');
