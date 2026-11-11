import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the shipped GNOME 50 bottom-taskbar implementation with native
// panel and Ubuntu Dock mocks. No arbitrary actor reparenting, duplicated
// Dock, leaked stage callback, or permanently modified user preferences.
const source = (await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/bottomTaskbar.js',
    import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');

let nextId = 0;
const stageSignals = new Map();
const stage = {
    connect(_name, cb) {const id = ++nextId; stageSignals.set(id, cb); return id;},
    disconnect(id) {stageSignals.delete(id);},
    tick() {for (const cb of [...stageSignals.values()]) cb();},
};
class Actor {
    constructor(properties = {}) {
        Object.assign(this, properties);
        this.children = [];
        this.parent = null;
        this.handlers = new Map();
        this.visible = true;
        this.mapped = true;
        this.opacity = properties.opacity ?? 255;
        this.reactive = properties.reactive ?? true;
    }
    insert_child_at_index(a, i) {
        a.parent?.remove_child(a);
        this.children.splice(i, 0, a);
        a.parent = this;
    }
    add_child(a) {this.insert_child_at_index(a, this.children.length);}
    remove_child(a) {
        this.children = this.children.filter(x => x !== a);
        if (a.parent === this) a.parent = null;
    }
    get_children() {return this.children;}
    get_parent() {return this.parent;}
    get_position() {return [this.x ?? 0, this.y ?? 0];}
    set_position(x, y) {this.x = x; this.y = y;}
    hide() {this.visible = false;}
    show() {this.visible = true;}
    destroy() {
        this.parent?.remove_child(this);
        for (const c of [...this.children]) c.destroy?.();
        this.destroyed = true;
    }
    connect(name, callback) {const id = ++nextId; this.handlers.set(id, {name, callback});return id;}
    disconnect(id) {this.handlers.delete(id);}
    emit(name) {for (const h of this.handlers.values()) if (h.name === name) h.callback();}
}
class Button extends Actor {
    constructor(properties) {super(properties);if (properties.child) this.add_child(properties.child);}
}
const St = {Icon: Actor, Widget: Actor, BoxLayout: Actor, Button,
    Side: {TOP: 0, BOTTOM: 1}};
const Clutter = {ActorAlign: {CENTER: 1}};
const appAlpha = {
    get_id: () => 'alpha.desktop', get_name: () => 'Alpha',
    get_windows: () => [], create_icon_texture: () => new Actor(),
    activate() {this.launches = (this.launches ?? 0) + 1;},
};
const betaWindow = {
    minimized: true,
    focused: false,
    raised: 0,
    unminimized: 0,
    minimizedCount: 0,
    get_user_time() {return 123;},
    has_focus() {return this.focused;},
    activate() {this.raised++;},
    unminimize() {this.minimized = false; this.unminimized++;},
    minimize() {this.minimized = true; this.minimizedCount++;},
};
const appBeta = {
    get_id: () => 'beta.desktop', get_name: () => 'Beta',
    get_windows: () => [betaWindow], create_icon_texture: () => new Actor(),
    activate() {this.launches = (this.launches ?? 0) + 1;},
};
const appGamma = {
    get_id: () => 'gamma.desktop', get_name: () => 'Gamma',
    get_windows: () => [99], create_icon_texture: () => new Actor(),
    activate() {this.launches = (this.launches ?? 0) + 1;},
};
let running = [appBeta, appGamma];
const appRegistry = {alpha:appAlpha,beta:appBeta,gamma:appGamma};
const appSystem = new Actor();
appSystem.get_running = () => running;
appSystem.lookup_app = id => appRegistry[id.replace('.desktop', '')] ?? null;
const shellSettings = new Actor();
let favorites = ['alpha.desktop','beta.desktop'];
shellSettings.get_strv = key => {
    assert.equal(key, 'favorite-apps');
    return favorites;
};
const panel = new Actor();
panel._leftBox = new Actor();
panel._centerBox = new Actor();
panel._rightBox = new Actor();
panel.add_child(panel._leftBox);
panel.add_child(panel._centerBox);
panel.add_child(panel._rightBox);
const activities = new Actor();
const date = new Actor();
panel._leftBox.add_child(activities);
panel._centerBox.add_child(date);
const arrows = [];
function menu() {
    return {_boxPointer: {
        _userArrowSide: St.Side.TOP,
        updateArrowSide(side) {this._userArrowSide = side;arrows.push(side);},
    }};
}
const dateMenu = menu(), quickMenu = menu();
panel.statusArea = {activities: {container: activities},
    dateMenu: {container: date, menu: dateMenu},
    quickSettings: {menu: quickMenu}};
panel._rightBox.add_child(new Actor());
panel._rightBox.get_preferred_width = () => [240, 240];
const panelBox = new Actor({x: 0, y: 0, width: 1920, height: 36});
const layout = new Actor();
layout.panelBox = panelBox;
layout.primaryMonitor = {index: 0, x: 0, y: 0, width: 1920, height: 1080};
let reservedLeft = 64, reservedRight = 0;
layout.getWorkAreaForMonitor = () => ({
    x: layout.primaryMonitor.x + reservedLeft,
    width: layout.primaryMonitor.width - reservedLeft - reservedRight,
});
const display = new Actor();
const dock = new Actor();
const dockGlass = new Actor();
const dockEntries = [{container: dock, manager: {bgActor: dockGlass}}];
let launches = 0;
let activatedWindow = null;
const Main = {panel, layoutManager: layout,
    overview: {showApps() {launches++;}},
    activateWindow(window) {
        activatedWindow = window;
        window.activate();
    },
};
const BottomTaskbar = new Function(
    'St','Clutter','Gio','Shell','Main','global','console',
    source + '\nreturn BottomTaskbar;'
)(St,Clutter,{Settings: class extends Actor {}},
    {AppSystem: {get_default: () => appSystem}},Main,
    {stage, display}, {warn() {}, log() {}});
const taskbar = new BottomTaskbar({
    panel, layout, appSystem, shellSettings,
    getDockEntries: () => dockEntries,
    onLauncherClick: () => launches++,
});
assert.equal(taskbar.setup(), true);
assert.equal(taskbar.isActive(), true);
assert.equal(taskbar.setup(), true, 'setup idempotent');
assert.equal(stageSignals.size, 1);
assert.deepEqual(panelBox.get_position(), [0, 1044],
    'GNOME native panel goes to bottom of primary monitor');
assert.equal(panel._centerBox.translation_x, -32,
    'cancel GNOME workarea center drift from a left Ubuntu Dock strut');
reservedLeft = 0; reservedRight = 64;
display.emit('workareas-changed');
assert.equal(panel._centerBox.translation_x, 32,
    'right-side reserved workarea must also leave Start/apps centered');
reservedLeft = 64; reservedRight = 0;
display.emit('workareas-changed');
assert.equal(panel._centerBox.translation_x, -32);
assert.equal(activities.visible, false);
assert.equal(panel._leftBox.get_children()[0], activities,
    'no Windows 10-style Start anchored at the left');
assert.equal(panel._centerBox.get_children()[0], taskbar._centerGroup,
    'one native center allocation for Start and application icons');
assert.equal(taskbar._centerGroup.get_children()[0], taskbar._start,
    'VLIQ Start centered with pinned apps');
assert.equal(taskbar._centerGroup.get_children()[1], taskbar._appStrip);
assert.equal(taskbar._centerGroup.reactive, false,
    'center group must not swallow native child input');
assert.equal(taskbar._start.reactive, true);
assert.equal(taskbar._appStrip.get_children()[0].reactive, true);
assert.equal(date.get_parent(), panel._rightBox);
assert.equal(panel._rightBox.get_children().at(-1), date,
    'Date/Clock stays rightmost after Quick Settings');
assert.equal(taskbar._appStrip.get_children().length, 3,
    'favorite and running apps deduplicated in one taskbar');
assert.equal(dateMenu._boxPointer._userArrowSide, St.Side.BOTTOM);
assert.equal(quickMenu._boxPointer._userArrowSide, St.Side.BOTTOM);
assert.equal(dock.visible, false, 'legacy Ubuntu Dock is hidden');
assert.equal(dock.opacity, 0);
assert.equal(dock.reactive, false);
assert.equal(dockGlass.opacity, 0);
taskbar._start.emit('clicked');
assert.equal(launches, 1, 'VLIQ Start opens applications');
// Pinned/stopped app launches; running/minimized app restores and raises.
taskbar._appStrip.get_children()[0].emit('clicked');
assert.equal(appAlpha.launches, 1, 'pinned app launches on click');
taskbar._appStrip.get_children()[1].emit('clicked');
assert.equal(activatedWindow, betaWindow,
    'running app selects its actual Meta.Window');
assert.equal(betaWindow.raised, 1, 'click raises running app window');
assert.equal(betaWindow.unminimized, 1,
    'minimized running window is restored before focusing');
assert.equal(appBeta.launches ?? 0, 0,
    'do not launch duplicate process for running app');
betaWindow.focused = true;
taskbar._appStrip.get_children()[1].emit('clicked');
assert.equal(betaWindow.minimizedCount, 1,
    'Windows 11 second click minimizes a focused window');
betaWindow.focused = false;
taskbar._appStrip.get_children()[2].emit('clicked');
assert.equal(appGamma.launches, 1,
    'apps with no activatable Meta.Window fall back to app.activate');
// Shell focus API errors must fall back to Shell.App rather than do nothing.
const activate = Main.activateWindow;
Main.activateWindow = () => {throw new Error('temporary focus failure');};
taskbar._appStrip.get_children()[1].emit('clicked');
assert.equal(appBeta.launches, 1, 'failed focus retries app.activate');
Main.activateWindow = activate;
const previousButton = taskbar._appStrip.get_children()[0];
stage.tick();
assert.equal(taskbar._appStrip.get_children()[0], previousButton,
    'stable taskbar does not rebuild app icons every compositor frame');
// Running-only apps must not disappear behind a long pinned-app list.
for (let i = 0; i < 14; i++) {
    const id = 'extra' + i + '.desktop';
    appRegistry['extra' + i] = {
        get_id: () => id, get_name: () => id,
        get_windows: () => [], create_icon_texture: () => new Actor(),
    };
    favorites.push(id);
}
shellSettings.emit('changed::favorite-apps');
const names = taskbar._appStrip.get_children().map(x => x.accessible_name);
assert.ok(names.includes('Gamma'),
    'running-only Gamma must retain a taskbar slot despite 14 extra favorites');
assert.ok(names.length <= 11, 'wide taskbar respects maximum icon capacity');
favorites = ['alpha.desktop','beta.desktop'];
shellSettings.emit('changed::favorite-apps');
dock.opacity = 255; dock.show();dock.reactive = true;
stage.tick();
assert.equal(dock.opacity, 0);
assert.equal(dock.visible, false);
assert.equal(dock.reactive, false, 'native Dock must not steal clicks');
layout.primaryMonitor = {x: 1920, y: 0, width: 1280, height: 720};
layout.emit('monitors-changed');
assert.deepEqual(panelBox.get_position(), [1920, 684],
    'panel follows primary monitor changes');
// GNOME can reconstruct its panel placements during session-mode changes.
panel._rightBox.remove_child(date);
panel._centerBox.add_child(date);
stage.tick();
assert.equal(date.get_parent(), panel._rightBox,
    'Date Menu returns to taskbar after GNOME native panel rebuild');
// Narrow displays must limit central icons without covering Quick Settings.
layout.primaryMonitor = {x: 1920, y: 0, width: 340, height: 720};
layout.emit('monitors-changed');
assert.equal(taskbar._appStrip.get_children().length, 0,
    'when side controls consume screen width, omit icons rather than overlap');
assert.equal(taskbar._centerGroup.get_children()[0], taskbar._start,
    'Start remains reachable when the screen is extremely narrow');
layout.primaryMonitor = {x: 1920, y: 0, width: 1280, height: 720};
layout.emit('monitors-changed');
assert.equal(taskbar._appStrip.get_children().length, 3,
    'full app strip returns on wider monitor');
running = [appBeta];
appSystem.emit('app-state-changed');
assert.equal(taskbar._appStrip.get_children().length, 2,
    'running-only icon disappears when app exits');
const extraMenu = menu();
panel.statusArea.newExtension = {menu: extraMenu};
stage.tick();
assert.equal(extraMenu._boxPointer._userArrowSide, St.Side.BOTTOM,
    'late panel extension popup opens above taskbar');
taskbar.cleanup();
assert.equal(stageSignals.size, 0);
assert.equal(taskbar._signals.length, 0);
assert.equal(date.get_parent(), panel._centerBox);
assert.equal(panel._centerBox.get_children()[0], date);
assert.equal(activities.visible, true);
assert.equal(dock.visible, true);
assert.equal(dock.reactive, true);
assert.equal(dock.opacity, 255);
assert.equal(dockGlass.opacity, 255,
    'original Ubuntu Dock glass opacity restored on mode exit');
assert.equal(quickMenu._boxPointer._userArrowSide, St.Side.TOP);
assert.equal(extraMenu._boxPointer._userArrowSide, St.Side.TOP);
assert.deepEqual(panelBox.get_position(), [1920, 0],
    'native GNOME top bar restored after bottom mode');
assert.equal(panel._centerBox.translation_x, 0,
    'top header restores native GNOME center alignment on exit');
assert.ok(!panel._leftBox.get_children().includes(taskbar._start));
assert.equal(taskbar._centerGroup, null,
    'no invisible centered group remains after hot-unload');
assert.equal(panel._centerBox.get_children().length, 1,
    'native Date Menu is sole restored center child');
assert.equal(shellSettings.handlers.size, 0);
assert.equal(appSystem.handlers.size, 0);
taskbar.cleanup();
assert.equal(taskbar.isActive(), false);
// Missing optional shell icon theme must not disable the entire taskbar.
// This was previously caught by setup() and silently reverted to split.
const oldIcon = St.Icon;
St.Icon = class BrokenIcon {
    constructor() {throw new Error('icon theme unavailable');}
};
panel._centerBox.translation_x = 13;
const degraded = new BottomTaskbar({
    panel, layout, appSystem, shellSettings,
    getDockEntries: () => dockEntries,
});
assert.equal(degraded.setup(), true,
    'native bottom placement survives optional Start icon failure');
assert.equal(degraded.isActive(), true);
assert.deepEqual(panelBox.get_position(), [1920, 684]);
assert.equal(panel._centerBox.translation_x, -19,
    'center correction adds to, not replaces, earlier custom offset');
assert.equal(degraded._start, null, 'no half-created launcher retained');
assert.equal(activities.visible, true,
    'Activities is not hidden if replacement Start failed');
assert.ok(degraded._appStrip, 'running apps still shown without Start');
assert.equal(degraded._appStrip.get_parent(), degraded._centerGroup,
    'even degraded layout keeps apps centered');
degraded.cleanup();
St.Icon = oldIcon;
assert.deepEqual(panelBox.get_position(), [1920, 0]);
assert.equal(panel._centerBox.translation_x, 13,
    'original custom center translation is fully restored');
panel._centerBox.translation_x = 0;
assert.equal(stageSignals.size, 0);

// The visual policy must also center the same group in the actual Shell
// stylesheet; no invisible left-side CSS placeholder or second glass layer.
const runtimeCSS = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar #panelCenter .vliq-taskbar-center-group'),
    'Windows 11 center-group style must exist in shipped stylesheet');
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-apps'));
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-app-button'));
assert.ok(runtimeCSS.includes(
    '#panel.vliq-liquid-top-panel.vliq-bottom-taskbar'));

console.log('Bottom Taskbar: Windows 11 centered Start/apps, running-window focus/restore/minimize, native tray spacing, Dock recovery and hot-swap PASS.');
