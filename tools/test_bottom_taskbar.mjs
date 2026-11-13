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
let nowUs = 1_000_000;
const glib = {get_monotonic_time: () => nowUs};
const stageSignals = new Map();
const stage = {
    connect(_name, cb) {const id = ++nextId; stageSignals.set(id, cb); return id;},
    disconnect(id) {stageSignals.delete(id);},
    tick(advanceUs = 16_666) {
        nowUs += advanceUs;
        for (const cb of [...stageSignals.values()]) cb();
    },
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
    set_child_at_index(a, i) {
        const old = this.children.indexOf(a);
        assert.ok(old >= 0, 'reorder only existing children');
        this.children.splice(old, 1);
        this.children.splice(i, 0, a);
    }
    remove_child(a) {
        this.children = this.children.filter(x => x !== a);
        if (a.parent === this) a.parent = null;
    }
    get_children() {return this.children;}
    get_parent() {return this.parent;}
    get_position() {return [this.x ?? 0, this.y ?? 0];}
    set_position(x, y) {this.x = x; this.y = y;}
    hide() {
        this.visible = false;
        this.emit('notify::visible');
    }
    show() {
        this.visible = true;
        this.emit('notify::visible');
    }
    get_hover() {return this.hover ?? false;}
    set_hover(value) {
        this.hover = value;
        this.emit('notify::hover');
    }
    destroy() {
        this.parent?.remove_child(this);
        for (const c of [...this.children]) c.destroy?.();
        this.destroyed = true;
    }
    connect(name, callback) {const id = ++nextId; this.handlers.set(id, {name, callback});return id;}
    disconnect(id) {this.handlers.delete(id);}
    emit(name, ...args) {
        for (const h of this.handlers.values())
            if (h.name === name) h.callback(this, ...args);
    }
}
class Button extends Actor {
    constructor(properties) {super(properties);if (properties.child) this.add_child(properties.child);}
}
const St = {Icon: Actor, Widget: Actor, BoxLayout: Actor, Button, Label: Actor,
    Side: {TOP: 0, BOTTOM: 1}};
const Clutter = {ActorAlign: {CENTER: 1, END: 2, START: 3},
    BinLayout: class {}};
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
// Mirror GNOME 50 LayoutManager._updateBoxes(): every monitor update
// unconditionally puts panelBox back at the top before VLIQ can draw.
let nativeRelayouts = 0;
const originalUpdateBoxes = function () {
    nativeRelayouts++;
    this.panelBox.set_position(
        this.primaryMonitor.x, this.primaryMonitor.y);
};
layout._updateBoxes = originalUpdateBoxes;
let regionUpdates = 0;
layout._queueUpdateRegions = () => {regionUpdates++;};
layout.primaryMonitor = {index: 0, x: 0, y: 0, width: 1920, height: 1080};
let reservedLeft = 64, reservedRight = 0;
layout.getWorkAreaForMonitor = () => ({
    x: layout.primaryMonitor.x + reservedLeft,
    width: layout.primaryMonitor.width - reservedLeft - reservedRight,
});
const display = new Actor();
const dock = new Actor();
const dockGlass = new Actor();
// Native Ubuntu Dock root owns a sibling .dash-background, the black
// capsule captured in the visual bug report. Hiding DockDash icons alone
// does NOT unmap this separate actor or release its hit-test region.
const uiGroup = new Actor();
layout.uiGroup = uiGroup;
uiGroup.add_child(panelBox);
const nativeDockRoot = new Actor();
uiGroup.add_child(nativeDockRoot);
nativeDockRoot.add_child(dock);
const nativeBlackPill = new Actor({style_class: 'dash-background'});
nativeDockRoot.add_child(nativeBlackPill);
const unrelatedChrome = new Actor();
uiGroup.add_child(unrelatedChrome);
// Ubuntu Dock Panel Mode owns a SECOND stage-level glass actor; hiding only
// dock.container and manager.bgActor leaves a visible 6-10px fringe.
const dockPanelSurface = {
    visible: true, hideCalls: 0,
    hide() {this.visible = false;this.hideCalls++;},
};
const dockEntries = [{
    container: dock,
    manager: {bgActor: dockGlass},
    panelBackgroundActor: nativeBlackPill,
    panelLiquidSurface: dockPanelSurface,
}];
let launches = 0;
let activatedWindow = null;
const notificationTray = new Actor();
notificationTray.sources = [];
notificationTray.getSources = () => notificationTray.sources;
const Main = {panel, layoutManager: layout, messageTray: notificationTray,
    overview: {showApps() {launches++;}},
    activateWindow(window) {
        activatedWindow = window;
        window.activate();
    },
};
class MockTaskbarPreview {
    constructor() {
        this.hovers = [];
        this.closed = 0;
        this.removed = [];
        this.destroyed = false;
    }
    onButtonHover(item, hover) {this.hovers.push([item, hover]);}
    closeForItem(item) {this.removed.push(item);}
    close() {this.closed++;}
    destroy() {this.destroyed = true;this.close();}
}
const BottomTaskbar = new Function(
    'St','Clutter','Gio','GLib','Shell','Main','global','console',
    'BottomTaskbarPreview',
    source + '\nreturn BottomTaskbar;'
)(St,Clutter,{Settings: class extends Actor {}},glib,
    {AppSystem: {get_default: () => appSystem}},Main,
    {stage, display}, {warn() {}, log() {}}, MockTaskbarPreview);
const taskbar = new BottomTaskbar({
    panel, layout, appSystem, shellSettings,
    getDockEntries: () => dockEntries,
    onLauncherClick: () => launches++,
});
assert.equal(taskbar.setup(), true);
assert.ok(taskbar._previewManager instanceof MockTaskbarPreview,
    'native window-preview handler must be installed before app icons');
assert.equal(taskbar.isActive(), true);
assert.equal(taskbar.ownsChrome(), true,
    'single-paint owner remains active independently of geometry');
assert.equal(taskbar._dockRootCache.get(dock)?.root, nativeDockRoot,
    'native Dock root is cached for stage-frame concealment');
// The normal paint-frame path must not re-walk every Dock ancestor or
// rescan every menu. These are source-level work counters, not FPS claims.
let arrowScans = 0;
const originalSyncArrows = taskbar._syncMenuArrows.bind(taskbar);
taskbar._syncMenuArrows = function () {
    arrowScans++;
    return originalSyncArrows();
};
for (let i = 0; i < 12; i++)
    stage.tick();
assert.equal(arrowScans, 0,
    'stationary frames must avoid redundant statusArea menu scans');
stage.tick(400_000);
assert.equal(arrowScans, 1,
    'menu scan fallback runs after bounded delay');
assert.equal(taskbar._dockRootCache.get(dock)?.root, nativeDockRoot,
    'cached native Dock root remains valid across painted frames');
// Native relayout must invalidate old ancestry before attaching a new
// dock root, rather than caching an unrelated GNOME chrome actor.
assert.notEqual(layout._updateBoxes, originalUpdateBoxes,
    'bottom mode must intercept GNOME 50 native top-panel relayout');
assert.ok(regionUpdates >= 1,
    'panel move must queue a native chrome/strut work-area update');
layout._updateBoxes();
assert.equal(nativeRelayouts, 1,
    'delegate GNOME native monitor logic exactly once');
assert.deepEqual(panelBox.get_position(), [0, 1044],
    'GNOME native _updateBoxes cannot leave the taskbar at the top');
assert.equal(taskbar.setup(), true, 'setup idempotent');
assert.equal(stageSignals.size, 1);
assert.deepEqual(panelBox.get_position(), [0, 1044],
    'GNOME native panel goes to bottom of primary monitor');
// A native GNOME monitor relayout can place panelBox at the old top edge
// AFTER our first paint; the allocation signal reanchors it synchronously.
panelBox.set_position(0, 0);
assert.equal(taskbar.isActive(), false,
    'effective activation must detect a panel still at the top');
assert.equal(taskbar.ownsChrome(), true,
    'transient top placement must NOT restore a second Dock painter');
panelBox.emit('notify::allocation');
assert.deepEqual(panelBox.get_position(), [0, 1044],
    'native allocation reanchoring prevents a top-bar flash');
assert.equal(taskbar.isActive(), true);
assert.equal(panel._centerBox.translation_x, -32,
    'cancel GNOME workarea center drift from a left Ubuntu Dock strut');
reservedLeft = 0; reservedRight = 64;
display.emit('workareas-changed');
assert.equal(panel._centerBox.translation_x, 32,
    'right-side reserved workarea must also leave Start/apps centered');
reservedLeft = 64; reservedRight = 0;
display.emit('workareas-changed');
assert.equal(panel._centerBox.translation_x, -32);
assert.equal(activities.visible, true,
    'native GNOME workspace/screen toggle must show on the left');
assert.equal(activities.get_parent(), panel._leftBox,
    'workspace toggle must keep its native GNOME click/scroll ownership');
assert.equal(panel._leftBox.get_children()[0], activities,
    'center Start must not displace native left workspace toggle');
assert.equal(panel._centerBox.get_children()[0], taskbar._centerGroup,
    'one native center allocation for Start and application icons');
assert.equal(taskbar._centerGroup.get_children()[0], taskbar._start,
    'VLIQ Start centered with pinned apps');
assert.equal(taskbar._centerGroup.get_children()[1], taskbar._appStrip);
assert.equal(taskbar._centerGroup.reactive, false,
    'center group must not swallow native child input');
assert.equal(taskbar._start.reactive, true);
assert.equal(taskbar._appStrip.get_children()[0].reactive, true);
const firstPreviewButton = taskbar._appStrip.get_children()[1];
firstPreviewButton.set_hover(true);
assert.equal(taskbar._previewManager.hovers.at(-1)[0].app, appBeta,
    'running app hover is routed to live native window previews');
assert.equal(taskbar._previewManager.hovers.at(-1)[1], true);
firstPreviewButton.set_hover(false);
assert.equal(taskbar._previewManager.hovers.at(-1)[1], false,
    'leaving a running app initiates preview dismissal');
assert.equal(date.get_parent(), panel._rightBox);
assert.equal(panel._rightBox.get_children().at(-1), date,
    'Date/Clock stays rightmost after Quick Settings');
assert.equal(taskbar._appStrip.get_children().length, 3,
    'favorite and running apps deduplicated in one taskbar');
// The marker under each app is a centered circular DOT, never a dash.
// Pinned/stopped apps reserve the same geometry with invisible dots.
const runningDots = taskbar._appStrip.get_children().map(button =>
    button.get_children()[0].get_children()[1]);
assert.equal(runningDots.length, 3);
for (const dot of runningDots) {
    assert.equal(dot.width, 5, 'running indicator has circular 5px width');
    assert.equal(dot.height, 5, 'running indicator has circular 5px height');
    assert.equal(dot.x_align, Clutter.ActorAlign.CENTER,
        'running indicator centers beneath its app icon');
    assert.equal(dot.reactive, false, 'dot must not steal app clicks');
}
assert.equal(runningDots[0].opacity, 0,
    'pinned-but-stopped app dot remains invisible');
assert.equal(runningDots[1].opacity, 255,
    'running pinned app shows its dot');
assert.equal(runningDots[2].opacity, 255,
    'running unpinned app shows its dot');
// Ubuntu Dock-style numeric badges reflect GNOME notifications (e.g. a
// completed Terminal command), NEVER how many app windows are open.
const betaItem = taskbar._appItems.get('beta.desktop');
const betaBadge = betaItem.badge;
const betaButton = betaItem.button;
assert.ok(betaBadge, 'the app icon owns one notification overlay');
assert.equal(betaBadge.visible, false,
    'no notification means no numeric badge, even for running apps');
assert.equal(betaBadge.reactive, false,
    'badge cannot intercept app-icon click/hover');
assert.equal(betaBadge.x_align, Clutter.ActorAlign.END);
assert.equal(betaBadge.y_align, Clutter.ActorAlign.START);
assert.equal(betaBadge.width, 16, 'single-digit count uses a 16px circle');
assert.equal(betaBadge.height, 16, 'badge width and height match');
assert.equal(betaBadge.translation_x, 6,
    'badge is shifted right of the icon, not centered');
assert.equal(betaBadge.translation_y, -6,
    'badge overlaps the icon top edge');
assert.equal(betaBadge.get_parent().clip_to_allocation, false,
    'top-right badge is not clipped by its 24px icon holder');
assert.equal(betaBadge.get_parent().get_children()[0].get_parent(),
    betaBadge.get_parent(),
    'badge shares an icon overlay rather than a separate taskbar slot');
assert.equal(betaBadge.get_parent().get_parent().get_children()[1],
    runningDots[1], 'white running dot remains directly beneath icon');

const betaNotifications = new Actor();
betaNotifications.app = appBeta;
betaNotifications.notifications = [];
notificationTray.sources.push(betaNotifications);
notificationTray.emit('source-added', betaNotifications);
assert.equal(betaBadge.visible, false);
const notificationActors = [];
for (let expected = 1; expected <= 3; expected++) {
    const notification = new Actor({resident: false});
    notificationActors.push(notification);
    betaNotifications.notifications.push(notification);
    betaNotifications.emit('notification-added', notification);
    betaNotifications.emit('notify::count');
    assert.equal(betaBadge.visible, true);
    assert.equal(betaBadge.text, String(expected),
        'task completion increments app notification badge');
    assert.equal(taskbar._appItems.get('beta.desktop').button, betaButton,
        'notifications must never rebuild hovered icons');
    assert.equal(runningDots[1].opacity, 255,
        'task completion cannot replace running indicator');
}
// Counts of different lengths must remain circles at the same corner.
betaNotifications.notifications.push(...Array.from({length: 7},
    () => new Actor({resident: false})));
betaNotifications.emit('count-updated');
assert.equal(betaBadge.text, '10');
assert.equal(betaBadge.width, 21);
assert.equal(betaBadge.height, 21);
assert.equal(betaBadge.translation_x, 8);
assert.equal(betaBadge.translation_y, -8);
betaNotifications.notifications.push(...Array.from({length: 90},
    () => new Actor({resident: false})));
betaNotifications.emit('count-updated');
assert.equal(betaBadge.text, '99+');
assert.equal(betaBadge.width, 26);
assert.equal(betaBadge.height, 26);
assert.equal(betaBadge.translation_x, 11);
assert.equal(betaBadge.translation_y, -11);
betaNotifications.notifications.length = 3;
betaNotifications.emit('count-updated');
assert.equal(betaBadge.text, '3');
assert.equal(betaBadge.width, 16);
assert.equal(betaBadge.height, 16);
const gammaNotifications = new Actor();
gammaNotifications.appId = 'gamma.desktop';
gammaNotifications.notifications = [new Actor({resident: false})];
notificationTray.sources.push(gammaNotifications);
notificationTray.emit('source-added', gammaNotifications);
assert.equal(taskbar._appItems.get('gamma.desktop').badge.text, '1',
    'notification count is scoped to originating app');
assert.equal(taskbar._appItems.get('alpha.desktop').badge.visible, false,
    'pinned stopped app has no notification badge');
assert.equal(betaBadge.text, '3',
    'unrelated notifications do not increment Beta count');
const resident = new Actor({resident: true});
betaNotifications.notifications.push(resident);
betaNotifications.emit('notification-added', resident);
assert.equal(betaBadge.text, '3', 'resident media notifications are excluded');
// GNOME removes the cleared notification from the Source's array, then
// count-updated notifies VLIQ. Never use a monotonically increasing counter.
betaNotifications.notifications.shift();
notificationActors[0].emit('destroy');
betaNotifications.emit('count-updated');
assert.equal(betaBadge.text, '2');
betaNotifications.notifications = [];
betaNotifications.emit('count-updated');
assert.equal(betaBadge.visible, false,
    'clearing notifications also clears the number');
notificationTray.sources =
    notificationTray.sources.filter(src => src !== gammaNotifications);
notificationTray.emit('source-removed', gammaNotifications);
assert.equal(taskbar._appItems.get('gamma.desktop').badge.visible, false,
    'destroyed GNOME Source clears its badge');
assert.equal(gammaNotifications.handlers.size, 0,
    'removed Source signal subscriptions are released');

// The source remains alive during a long Terminal session. Removed or
// destroyed notifications must not accumulate in its tracking registry.
const betaRegistry = taskbar._notificationSources.get(betaNotifications);
assert.equal(betaRegistry.notifications.size, 0,
    'clearing the tray removes all earlier notification references');
for (let i = 0; i < 100; i++) {
    const notification = new Actor({resident: false});
    betaNotifications.notifications.push(notification);
    betaNotifications.emit('notification-added', notification);
    assert.equal(betaRegistry.notifications.size, 1);
    betaNotifications.notifications.pop();
    notification.emit('destroy');
    betaNotifications.emit('notification-removed', notification);
    assert.equal(notification.handlers.size, 0,
        'destroy must disconnect the notification listener');
    assert.equal(betaRegistry.notifications.size, 0,
        'no cleared Terminal notification may be retained');
}
const countOnly = new Actor({resident: false});
betaNotifications.notifications.push(countOnly);
betaNotifications.emit('notification-added', countOnly);
betaNotifications.notifications.pop();
betaNotifications.emit('count-updated');
assert.equal(betaRegistry.notifications.size, 0,
    'providers without destroy/removal events are reconciled on count change');
assert.equal(countOnly.handlers.size, 0);
assert.equal(betaBadge.visible, false);

// A single notification update should inspect each source once, regardless
// of how many pinned/running app slots currently exist.
const originalNotificationId = taskbar._sourceNotificationAppId;
let sourceLookupCount = 0;
taskbar._sourceNotificationAppId = function (source) {
    sourceLookupCount++;
    return originalNotificationId.call(this, source);
};
taskbar._refreshNotificationBadges();
assert.equal(sourceLookupCount, taskbar._notificationSources.size,
    'badge refresh must aggregate source counts in one pass');
taskbar._sourceNotificationAppId = originalNotificationId;

// Multiple GNOME notification sources for one application must still add up.
const anotherBeta = new Actor();
anotherBeta.appId = 'beta.desktop';
anotherBeta.notifications = [
    new Actor({resident: false}),
    new Actor({resident: true}),
    new Actor({resident: false}),
];
notificationTray.sources.push(anotherBeta);
notificationTray.emit('source-added', anotherBeta);
assert.equal(betaBadge.text, '2',
    'multiple same-app sources aggregate nonresident counts');
anotherBeta.notifications = [];
anotherBeta.emit('count-updated');
assert.equal(betaBadge.visible, false);
notificationTray.sources = notificationTray.sources.filter(
    source => source !== anotherBeta);
notificationTray.emit('source-removed', anotherBeta);

// An app becoming stopped must hide the dot; reopening must restore it.
const originalBetaWindows = appBeta.get_windows;
appBeta.get_windows = () => [];
appSystem.emit('app-state-changed');
const stoppedBetaButton = taskbar._appStrip.get_children()[1];
const stoppedBetaDot = stoppedBetaButton.get_children()[0].get_children()[1];
assert.equal(stoppedBetaDot.opacity, 0,
    'closing a running app hides its dot immediately');
assert.equal(stoppedBetaButton, taskbar._appItems.get('beta.desktop').button,
    'stopping app must preserve its button');
assert.equal(stoppedBetaDot, runningDots[1],
    'stopping app must preserve its dot');
appBeta.get_windows = originalBetaWindows;
appSystem.emit('app-state-changed');
const restartedBetaButton = taskbar._appStrip.get_children()[1];
const restartedBetaDot = restartedBetaButton.get_children()[0].get_children()[1];
assert.equal(restartedBetaDot.opacity, 255,
    'reopening the app restores the dot');
assert.equal(restartedBetaButton, stoppedBetaButton,
    'start/stop must never destroy or recreate hovered button');
assert.equal(restartedBetaDot, stoppedBetaDot,
    'start/stop must only update dot opacity');
assert.equal(dateMenu._boxPointer._userArrowSide, St.Side.BOTTOM);
assert.equal(quickMenu._boxPointer._userArrowSide, St.Side.BOTTOM);
assert.equal(dock.visible, false, 'legacy Ubuntu Dock is hidden');
assert.equal(dock.opacity, 0);
assert.equal(dock.reactive, false);
assert.equal(nativeDockRoot.visible, false,
    'entire native Dock root, not only icon container, must unmap');
assert.equal(nativeDockRoot.reactive, false,
    'root cannot steal hover/click input from VLIQ taskbar');
assert.equal(nativeBlackPill.visible, false,
    'black dash-background sibling must be hidden');
assert.equal(nativeBlackPill.opacity, 0,
    'black pill may not paint above live app buttons');
assert.equal(dockGlass.opacity, 0);
assert.equal(unrelatedChrome.visible, true,
    'do not hide unrelated GNOME chrome');
assert.equal(dockPanelSurface.visible, false,
    'independent Ubuntu Dock Panel Mode glass must hide too');
assert.ok(dockPanelSurface.hideCalls >= 1);
taskbar._start.emit('clicked');
assert.equal(launches, 1, 'VLIQ Start opens applications');
// Pinned/stopped app launches; running/minimized app restores and raises.
const clickedPinnedButton = taskbar._appStrip.get_children()[0];
const clickedPinnedDot = clickedPinnedButton.get_children()[0].get_children()[1];
const originalAlphaActivate = appAlpha.activate;
const originalAlphaWindows = appAlpha.get_windows;
// Native Shell can emit app-state-changed synchronously DURING clicked.
appAlpha.activate = function () {
    originalAlphaActivate.call(this);
    this.get_windows = () => [{id: 'alpha-window'}];
    appSystem.emit('app-state-changed');
};
clickedPinnedButton.emit('clicked');
assert.equal(appAlpha.launches, 1, 'pinned app launches on click');
assert.equal(taskbar._appStrip.get_children()[0], clickedPinnedButton,
    'click-induced state change must not destroy clicked icon');
assert.equal(clickedPinnedDot.opacity, 255,
    'click-induced RUNNING only reveals the original dot');
assert.equal(clickedPinnedButton.get_children()[0].get_children()[1],
    clickedPinnedDot, 'clicked dot actor identity remains stable');
appAlpha.activate = originalAlphaActivate;
appAlpha.get_windows = originalAlphaWindows;
appSystem.emit('app-state-changed');
assert.equal(taskbar._appStrip.get_children()[0], clickedPinnedButton);
assert.equal(clickedPinnedDot.opacity, 0);
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
const previousBetaButton = taskbar._appStrip.get_children()[1];
const previousGammaButton = taskbar._appStrip.get_children()[2];
stage.tick();
const originalGetAppChildren = taskbar._appStrip.get_children.bind(taskbar._appStrip);
let redundantLayoutReads = 0;
taskbar._appStrip.get_children = function () {
    redundantLayoutReads++;
    return originalGetAppChildren();
};
appSystem.emit('app-state-changed');
assert.equal(redundantLayoutReads, 0,
    'running-state-only updates avoid Clutter child-order queries');
taskbar._appStrip.get_children = originalGetAppChildren;
assert.equal(taskbar._appStrip.get_children()[0], previousButton,
    'unchanged state signal must not rebuild icons');
favorites = ['beta.desktop', 'alpha.desktop'];
shellSettings.emit('changed::favorite-apps');
assert.deepEqual(taskbar._appStrip.get_children(),
    [previousBetaButton, previousButton, previousGammaButton],
    'favorites reorder must preserve all existing icon actors');
favorites = ['alpha.desktop', 'beta.desktop'];
shellSettings.emit('changed::favorite-apps');
assert.deepEqual(taskbar._appStrip.get_children(),
    [previousButton, previousBetaButton, previousGammaButton]);
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
nativeDockRoot.show();
assert.equal(nativeDockRoot.visible, false,
    'native Dock must be hidden synchronously on show(), before any frame');
nativeDockRoot.opacity = 255;
nativeDockRoot.emit('notify::opacity');
assert.equal(nativeDockRoot.opacity, 0,
    'native Dock opacity resets synchronously when the theme changes it');
nativeDockRoot.reactive = true;
nativeBlackPill.show();
assert.equal(nativeBlackPill.visible, false,
    'sibling Dock background cannot paint even one frame after show()');
nativeBlackPill.opacity = 255;
nativeBlackPill.emit('notify::opacity');
assert.equal(nativeBlackPill.opacity, 0);
nativeBlackPill.reactive = true;
stage.tick();
assert.equal(nativeDockRoot.visible, false,
    'native Dock cannot repaint its root during compositor frame');
assert.equal(nativeBlackPill.visible, false,
    'late native background show must be suppressed');
assert.equal(nativeDockRoot.reactive, false);
assert.equal(dock.opacity, 0);
assert.equal(dock.visible, false);
assert.equal(dock.reactive, false, 'native Dock must not steal clicks');
assert.ok(dockPanelSurface.hideCalls >= 2,
    'native Dock glass remains hidden across repeated compositor frames');

// Dock may recreate its actors on a native settings change. Disposed
// roots must not accumulate retained GObject references in VLIQ Maps.
const dockWatchersBefore = taskbar._dockVisibilityWatchers.size;
const dockPaintBefore = taskbar._dockPaint.size;
for (let i = 0; i < 80; i++) {
    const transient = new Actor({visible: true, opacity: 255});
    taskbar._concealDockActor(transient);
    assert.equal(taskbar._dockPaint.has(transient), true);
    assert.equal(taskbar._dockVisibilityWatchers.has(transient), true);
    transient.emit('destroy');
    assert.equal(taskbar._dockPaint.has(transient), false);
    assert.equal(taskbar._dockVisibilityWatchers.has(transient), false);
    assert.equal(taskbar._dockConcealingActors.has(transient), false);
}
assert.equal(taskbar._dockPaint.size, dockPaintBefore,
    'disposed Dock roots must not grow the restoration registry');
assert.equal(taskbar._dockVisibilityWatchers.size, dockWatchersBefore,
    'disposed Dock roots must not grow signal-handler registry');
layout.primaryMonitor = {x: 1920, y: 0, width: 1280, height: 720};
const previousRootCache = taskbar._dockRootCache;
layout.emit('monitors-changed');
assert.notEqual(taskbar._dockRootCache, previousRootCache,
    'monitor geometry rebuild invalidates native Dock root cache');
stage.tick();
assert.equal(taskbar._dockRootCache.get(dock)?.root, nativeDockRoot,
    'next frame safely repopulates Dock root cache');
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
const beforeExitButtons = taskbar._appStrip.get_children().slice(0, 2);
running = [appBeta];
appSystem.emit('app-state-changed');
assert.equal(taskbar._appStrip.get_children().length, 2,
    'running-only icon disappears when app exits');
assert.equal(taskbar._appStrip.get_children()[0], beforeExitButtons[0],
    'unrelated running icon exit must preserve pinned icon 1');
assert.equal(taskbar._appStrip.get_children()[1], beforeExitButtons[1],
    'unrelated running icon exit must preserve pinned icon 2');
const extraMenu = menu();
panel.statusArea.newExtension = {menu: extraMenu};
// A new indicator that bypassed child-added is repaired by the
// low-frequency fallback; do not force a complete stage-tree scan.
stage.tick(400_000);
assert.equal(extraMenu._boxPointer._userArrowSide, St.Side.BOTTOM,
    'late panel extension popup opens above taskbar');
const previewBeforeCleanup = taskbar._previewManager;
taskbar.cleanup();
assert.equal(notificationTray.handlers.size, 0,
    'unhook notification tray events on layout change/hot reload');
assert.equal(betaNotifications.handlers.size, 0,
    'unhook native notification sources on teardown');
for (const notification of notificationActors)
    assert.equal(notification.handlers.size, 0,
        'notification destroy signals cannot leak after cleanup');
assert.equal(previewBeforeCleanup.destroyed, true,
    'hot reload destroys live window previews and pending hover timers');
assert.equal(taskbar._previewManager, null);
assert.equal(taskbar._dockVisibilityWatchers.size, 0,
    'native Dock visual-guard signals are disconnected on teardown');
assert.equal(taskbar.ownsChrome(), false,
    'paint ownership releases during cleanup');
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
assert.equal(nativeDockRoot.visible, true,
    'original dock root visibility restored on layout exit');
assert.equal(nativeDockRoot.opacity, 255);
assert.equal(nativeDockRoot.reactive, true,
    'native dock receives hover events again after Bottom mode');
assert.equal(nativeBlackPill.visible, true,
    'native dock background restored on layout exit');
assert.equal(nativeBlackPill.opacity, 255);
assert.equal(nativeBlackPill.reactive, true);
assert.equal(unrelatedChrome.visible, true);
assert.equal(quickMenu._boxPointer._userArrowSide, St.Side.TOP);
assert.equal(extraMenu._boxPointer._userArrowSide, St.Side.TOP);
assert.deepEqual(panelBox.get_position(), [1920, 0],
    'native GNOME top bar restored after bottom mode');
assert.equal(layout._updateBoxes, originalUpdateBoxes,
    'the original GNOME layout function is restored on disable');
const priorRelayouts = nativeRelayouts;
layout._updateBoxes();
assert.equal(nativeRelayouts, priorRelayouts + 1);
assert.deepEqual(panelBox.get_position(), [1920, 0],
    'native header remains at top after the hook is removed');
assert.equal(panel._centerBox.translation_x, 0,
    'top header restores native GNOME center alignment on exit');
assert.ok(!panel._leftBox.get_children().includes(taskbar._start));
assert.equal(taskbar._centerGroup, null,
    'no invisible centered group remains after hot-unload');
assert.equal(taskbar._appItems.size, 0,
    'hot unload clears cached app actors');
assert.equal(taskbar._dockRootCache.get(dock), undefined,
    'hot unload clears cached native Dock roots');
assert.equal(taskbar._lastMenuReconcileUs, 0,
    'hot unload stops menu scan bookkeeping');
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
activities.hide();
const degraded = new BottomTaskbar({
    panel, layout, appSystem, shellSettings,
    getDockEntries: () => dockEntries,
});
assert.equal(degraded.setup(), true,
    'native bottom placement survives optional Start icon failure');
assert.notEqual(layout._updateBoxes, originalUpdateBoxes);
layout._updateBoxes();
assert.deepEqual(panelBox.get_position(), [1920, 684],
    'even degraded Start icon mode survives native monitor relayout');
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
assert.equal(activities.visible, false,
    'native initially-hidden Activities state must restore on teardown');
activities.show();
assert.equal(layout._updateBoxes, originalUpdateBoxes);
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
const runningDotStyle = runtimeCSS.match(
    /#panel\.vliq-bottom-taskbar \.vliq-taskbar-running-dot\s*\{([^}]*)\}/
)?.[1] ?? '';
assert.match(runningDotStyle, /min-width:\s*5px\s*;/,
    'running dot is 5px wide, not a dash');
assert.match(runningDotStyle, /min-height:\s*5px\s*;/,
    'running dot has equal 5px height');
assert.match(runningDotStyle, /border-radius:\s*999px\s*;/,
    'running indicator is circular');
const notificationBadgeStyle = runtimeCSS.match(
    /#panel\.vliq-bottom-taskbar \.vliq-taskbar-notification-badge\s*\{([^}]*)\}/
)?.[1] ?? '';
assert.match(notificationBadgeStyle, /border-radius:\s*999px\s*!important\s*;/,
    'top-right task notification count uses circular corners');
assert.match(notificationBadgeStyle, /min-width:\s*16px\s*;/);
assert.match(notificationBadgeStyle, /min-height:\s*16px\s*;/);
assert.match(notificationBadgeStyle, /padding:\s*0\s*;/,
    'badges do not become horizontal pills because of padding');
assert.match(notificationBadgeStyle, /text-align:\s*center\s*;/);
assert.match(notificationBadgeStyle, /font-size:\s*10px\s*;/);
assert.match(notificationBadgeStyle, /color:\s*#ffffff\s*!important/);
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar #panelCenter,'),
    'GNOME inherited center-pill background must be neutralised');
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:hover'),
    'hover highlights individual clickable app buttons');
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:active'),
    'mouse press has immediate native button feedback');
assert.ok(runtimeCSS.includes(
    '#panel.vliq-liquid-top-panel.vliq-bottom-taskbar'));
assert.match(runtimeCSS, /min-height:\s*44px;/,
    'bottom bar must occupy a Windows-style full-height panel');
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar #panelLeft #panelActivities'),
    'Bottom left native workspace toggle has scoped styling');
const nativeWorkspaceBase = runtimeCSS.match(
    /#panel\.vliq-bottom-taskbar #panelLeft #panelActivities\s*\{([^}]+)\}/
)?.[1] ?? '';
const nativeWorkspaceHover = runtimeCSS.match(
    /#panel\.vliq-bottom-taskbar #panelLeft #panelActivities:hover,[^{]*\{([^}]+)\}/
)?.[1] ?? '';
const nativeWorkspacePressed = runtimeCSS.match(
    /#panel\.vliq-bottom-taskbar #panelLeft #panelActivities:active,[^{]*\{([^}]+)\}/
)?.[1] ?? '';
assert.match(nativeWorkspaceBase, /background-color:\s*transparent\s*!important/,
    'workspace switcher stays visually clear without hover');
assert.match(nativeWorkspaceBase, /border-radius:\s*11px/,
    'workspace hover matches Quick Menu premium card roundness');
assert.match(nativeWorkspaceHover,
    /background-color:\s*rgba\(219, 223, 229, 0\.18\)\s*!important/,
    'workspace hover uses exact Quick Menu soft gray-white');
assert.match(nativeWorkspaceHover,
    /inset 0 0 0 1px rgba\(220, 225, 232, 0\.15\)/,
    'workspace hover uses the same single Quick Menu inset rim');
assert.match(nativeWorkspacePressed,
    /background-color:\s*rgba\(219, 223, 229, 0\.27\)\s*!important/,
    'workspace pressed state uses same stronger gray');
assert.ok(!nativeWorkspaceBase.includes('padding:'),
    'workspace native input geometry stays unchanged');
assert.ok(runtimeCSS.includes(
    '#panel.vliq-bottom-taskbar .panel-corner'),
    'Bottom mode suppresses native panel corner borders');

// Regression for the real VLIQ native-Dock glass *producer*. Ubuntu Dock
// Panel Mode uses a stage-level PanelGlassSurface outside dock.container.
// The bottom taskbar's own glass is the sole permitted visible panel FBO.
const integrationSource = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/liquidGlassDock.js',
    import.meta.url), 'utf8');
const nativePanelMethod = integrationSource.match(
    /^    _syncPanelBackdropGeometry\(entry\) \{[\s\S]*?(?=^    _setPanelLiquidReady\(entry, ready\) \{)/m
)?.[0];
assert.ok(nativePanelMethod,
    'shipped Dock panel-glass geometry producer must exist');
const nativeLayout = {
    findIndexForActor: () => 0,
    monitors: [{x: 0, y: 0, width: 1920, height: 1080,
        inFullscreen: false}],
    primaryIndex: 0,
    primaryMonitor: {x: 0, y: 0, width: 1920, height: 1080},
    uiGroup: {get_transformed_position: () => [0, 0]},
};
const drawNativeBackdrop = new Function('Main', 'global',
    'return ({' + nativePanelMethod +
    '})._syncPanelBackdropGeometry;'
)({layoutManager: nativeLayout}, {stage});
let oldGlassDraws = 0;
let oldGlassHides = 0;
let oldGlassSyncs = 0;
let nativeReady = false;
let panelSourceX = 0;
let panelOpacity = 255;
const oldDockGlass = {
    ready: true,
    hide() {oldGlassHides++;},
    setBounds() {oldGlassDraws++;},
    syncFrame() {oldGlassSyncs++;},
};
const nativeBackdropEntry = {
    panelLiquidSurface: oldDockGlass,
    panelBackdropSource: {
        get_transformed_position: () => [panelSourceX, 1044],
        get_transformed_size: () => [1920, 36],
        get_stage: () => stage,
        mapped: true, visible: true,
        get_paint_opacity: () => panelOpacity,
    },
};
let isBottom = true;
const nativeDockContext = {
    // Simulate temporary geometry false during app focus: the Bottom
    // session still owns Dock paint and MUST suppress old Panel glass.
    isBottomTaskbarActive: () => false,
    ownsBottomTaskbarChrome: () => isBottom,
    _dockIsPanelMode: () => true,
    _setPanelLiquidReady(_entry, ready) {nativeReady = ready;},
};
for (let i = 0; i < 120; i++)
    drawNativeBackdrop.call(nativeDockContext, nativeBackdropEntry);
assert.equal(oldGlassDraws, 0,
    'OLD Ubuntu Dock panel shader cannot repaint below/above the taskbar');
assert.equal(oldGlassHides, 120,
    'its independent glass is hidden on each scene update');
assert.equal(nativeReady, false,
    'old glass cannot keep a stale ready-state CSS seam');
isBottom = false;
drawNativeBackdrop.call(nativeDockContext, nativeBackdropEntry);
assert.equal(oldGlassDraws, 1,
    'old Dock glass resumes normally when bottom mode is disabled');
assert.equal(nativeReady, true,
    'returning to ordinary Ubuntu Dock restores native glass paint');
for (let i = 0; i < 120; i++)
    drawNativeBackdrop.call(nativeDockContext, nativeBackdropEntry);
assert.equal(oldGlassDraws, 1,
    'stationary panel must not rewrite identical glass geometry every frame');
assert.equal(oldGlassSyncs, 120,
    'unchanged panel must retain bounded live scene refresh');
panelSourceX = 3;
drawNativeBackdrop.call(nativeDockContext, nativeBackdropEntry);
assert.equal(oldGlassDraws, 2,
    'panel movement triggers an immediate geometry update');
panelOpacity = 180;
drawNativeBackdrop.call(nativeDockContext, nativeBackdropEntry);
assert.equal(oldGlassDraws, 3,
    'native panel opacity changes must bypass the stable-geometry cache');
isBottom = true;
drawNativeBackdrop.call(nativeDockContext, nativeBackdropEntry);
assert.equal(nativeBackdropEntry.panelBackdropLastBounds, null,
    'bottom taskbar must invalidate hidden native-Dock glass geometry');
isBottom = false;
drawNativeBackdrop.call(nativeDockContext, nativeBackdropEntry);
assert.equal(oldGlassDraws, 4,
    'old Dock glass repaints immediately after Bottom mode exits');

// The Ubuntu Dock panel-background style watcher must NOT resurrect
// native paint while Bottom owns the panel, even if Ubuntu Panel Mode
// remains selected or a previously active Dock paint flag is still set.
const paintPolicyStart = integrationSource.indexOf(
    '    _dockPanelPaintShouldOwn(entry) {');
const paintPolicyEnd = integrationSource.indexOf(
    '\n    _disconnectDockPanelBackgroundWatcher(entry) {',
    paintPolicyStart);
assert.ok(paintPolicyStart >= 0 && paintPolicyEnd > paintPolicyStart);
const paintPolicy = new Function('return ({' +
    integrationSource.slice(paintPolicyStart, paintPolicyEnd) +
    '\n})._dockPanelPaintShouldOwn;')();
let bottomOwnsPaint = true;
const dockPaintPolicyContext = {
    ownsBottomTaskbarChrome: () => bottomOwnsPaint,
    _dockIsPanelMode: () => true,
    _dockModeTransitionTarget: false,
    _dockHandoffActive: true,
};
assert.equal(paintPolicy.call(dockPaintPolicyContext,
    {panelPaintActive: true}), false,
'GNOME theme changes must not repaint old Dock background during Bottom');
bottomOwnsPaint = false;
assert.equal(paintPolicy.call(dockPaintPolicyContext,
    {panelPaintActive: true}), true,
'old Dock theme ownership resumes on leaving Bottom mode');

// Test the native Ubuntu Dock Panel Mode *owner* too: bottom mode must
// remove its CSS background and shader, not just hide a stale snapshot.
const modeStart = integrationSource.indexOf(
    '    _syncNativeDashEntryMode(entry) {');
const modeEnd = integrationSource.indexOf('\n    _', modeStart + 8);
assert.ok(modeStart >= 0 && modeEnd > modeStart);
const syncNativeDock = new Function('return ({' +
    integrationSource.slice(modeStart, modeEnd) +
    '\n})._syncNativeDashEntryMode;')();
const retired = [];
const nativeDockCtx = {
    isBottomTaskbarActive: () => false,
    ownsBottomTaskbarChrome: () => true,
    _dockIsPanelMode: () => true,
    _syncNativeDockBinding() {retired.push('native-binding');},
    _applyDockVerticalOffset() {},
    _watchDockPanelBackground() {},
    _syncDockGlassBackgroundClass(_entry, enabled) {
        retired.push('glass:' + enabled);
    },
    _setDockPanelModeClass(_entry, enabled) {
        retired.push('panel-class:' + enabled);
    },
    _applyDockPanelPaint(_entry, enabled) {
        retired.push('panel-paint:' + enabled);
    },
    _cleanupNativeDashManager() {retired.push('manager-cleanup');},
};
assert.equal(syncNativeDock.call(nativeDockCtx, {container: {}}), true);
assert.deepEqual(retired, [
    'native-binding', 'glass:false', 'panel-class:false',
    'panel-paint:false', 'manager-cleanup',
], 'Bottom mode retires every old Ubuntu Dock panel background layer');

console.log('Bottom Taskbar: Windows 11 centered Start/apps, running-window focus/restore/minimize, native tray spacing, Dock recovery and hot-swap PASS.');
