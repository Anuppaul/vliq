import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the exact production source without GJS/Clutter availability.
const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const src = await readFile(new URL('fullscreenPanelGuard.js', root), 'utf8');
const integrator = await readFile(new URL('liquidGlassDock.js', root), 'utf8');
const installer = await readFile(
    new URL('../gnome-shell/install.sh', import.meta.url), 'utf8'
);
const builder = await readFile(
    new URL('../tools/build_ego_release.py', import.meta.url), 'utf8'
);
const {FullscreenPanelChromeGuard, primaryPanelIsFullscreen} =
    new Function(src.replaceAll(/^export /gm, '') +
        '\nreturn {FullscreenPanelChromeGuard, primaryPanelIsFullscreen};')();

class Signals {
    constructor() {this.handlers = new Map(); this.lastId = 0;}
    connect(name, fn) {
        const id = ++this.lastId;
        this.handlers.set(id, {name, fn});
        return id;
    }
    disconnect(id) {
        assert.ok(this.handlers.delete(id), 'disconnect only owned signals');
    }
    emit(name, ...args) {
        for (const {name: n, fn} of [...this.handlers.values()]) {
            if (n === name)
                fn(this, ...args);
        }
    }
    get count() {return this.handlers.size;}
}
class PanelBox extends Signals {
    constructor() {
        super();
        this._visible = true;
        this.visibilityWrites = 0;
    }
    get visible() {return this._visible;}
    set visible(value) {
        if (this._visible === value)
            return;
        this.visibilityWrites++;
        this._visible = value;
        this.emit('notify::visible');
    }
}
class Panel extends Signals {
    constructor() {
        super();
        this._mapped = true;
        this.visible = true;
        this.opacity = 240;
    }
    get mapped() {return this._mapped;}
    set mapped(value) {
        if (this._mapped === value)
            return;
        this._mapped = value;
        this.emit('notify::mapped');
    }
    get_paint_opacity() {return this.opacity;}
}
class Display extends Signals {
    constructor() {
        super();
        this.fullscreen = new Map();
        this.focus_window = null;
    }
    get_monitor_in_fullscreen(index) {
        return this.fullscreen.get(index) ?? false;
    }
    setFullscreen(index, fullscreen) {
        this.fullscreen.set(index, fullscreen);
        this.emit('in-fullscreen-changed');
    }
}
function fixture() {
    const display = new Display();
    const panelBox = new PanelBox();
    const panel = new Panel();
    const layout = {
        panelBox,
        primaryIndex: 0,
        primaryMonitor: {index: 0},
        uiGroup: {redraws: 0, queue_redraw() {this.redraws++;}},
        restored: 0,
        _updateVisibility() {
            this.restored++;
            this.panelBox.visible =
                !display.get_monitor_in_fullscreen(this.primaryIndex);
        },
    };
    const manager = {
        bgActor: {
            opacity: 255,
            redraws: 0,
            queue_redraw() {this.redraws++;},
        },
        setVisibilityGate(fn) {
            this.gate = fn;
            if (fn && !fn())
                this.bgActor.opacity = 0;
        },
    };
    return {
        display, panelBox, panel, layout, manager,
        guard: new FullscreenPanelChromeGuard({
            layout, display, panel, panelManager: manager,
        }),
    };
}

{
    const f = fixture();
    f.guard.setup();
    assert.equal(f.panelBox.visible, true);
    assert.equal(f.manager.bgActor.opacity, 255);
    assert.equal(f.manager.gate(), true);

    f.display.setFullscreen(1, true);  // only secondary monitor fullscreen
    assert.equal(f.panelBox.visible, true,
        'primary top bar is not hidden for a secondary fullscreen window');
    assert.equal(f.manager.bgActor.opacity, 255);

    f.display.setFullscreen(0, true);
    assert.equal(f.panelBox.visible, false, 'native GNOME panel must hide');
    assert.equal(f.manager.bgActor.opacity, 0,
        'independent VLIQ glass must vanish with native panel');
    assert.equal(f.manager.gate(), false,
        'DashManager must not repaint its glass while fullscreen');
    assert.equal(f.guard._forcedNativeHide, true);
    assert.equal(f.layout.uiGroup.redraws, 2,
        'brightness offscreen scene invalidated on each primary mode change');

    f.guard.sync();
    assert.equal(f.layout.uiGroup.redraws, 2,
        'no redundant compositor invalidation per frame');

    f.display.setFullscreen(0, false);
    assert.equal(f.panelBox.visible, true,
        'restore native panel visibility after leaving fullscreen');
    assert.equal(f.manager.bgActor.opacity, 240,
        'glass must return at native panel paint opacity');
    assert.equal(f.manager.gate(), true);
    assert.ok(f.layout.restored > 0);

    f.guard.cleanup();
    assert.equal(f.display.count, 0);
    assert.equal(f.panelBox.count, 0);
    assert.equal(f.panel.count, 0);
    assert.equal(f.manager.gate, null,
        'no stale vendor callback after VLIQ hot-swap');
}

{
    const f = fixture();
    f.guard.setup();
    // Native GNOME tracks panelBox itself: this scenario fires after it
    // already handled in-fullscreen-changed, so guard cannot take credit.
    f.display.fullscreen.set(0, true);
    f.panelBox.visible = false;
    assert.equal(f.guard._forcedNativeHide, false,
        'do not claim ownership of native GNOME fullscreen visibility');
    assert.equal(f.manager.bgActor.opacity, 0,
        'hide only VLIQ glass if native panel already hidden');
    f.guard.cleanup();
    assert.equal(f.panelBox.visible, false,
        'cleanup must not show native panel during fullscreen');
}

{
    const f = fixture();
    f.guard.setup();
    f.panel.mapped = false;
    assert.equal(f.manager.bgActor.opacity, 0,
        'glass must not survive unmapping of the panel');
    f.panel.mapped = true;
    assert.equal(f.manager.bgActor.opacity, 240);
    f.guard.cleanup();
}

{
    const f = fixture();
    f.guard.setup();
    f.display.setFullscreen(0, true);
    f.guard.cleanup();
    assert.equal(f.panelBox.visible, false,
        'hot-swap while fullscreen keeps native panel hidden');
    assert.equal(f.manager.gate, null);
    assert.equal(f.display.count, 0);
}

{
    const f = fixture();
    f.guard.setup();
    // GNOME layout may omit helper on old or downstream forks:
    // restore only what our guard hid, never unrelated native state.
    f.layout._updateVisibility = undefined;
    f.display.setFullscreen(0, true);
    assert.equal(f.panelBox.visible, false);
    f.display.setFullscreen(0, false);
    assert.equal(f.panelBox.visible, true);
    f.guard.cleanup();
}

{
    const f = fixture();
    f.layout.primaryIndex = 1;
    f.layout.primaryMonitor.index = 1;
    f.guard.setup();
    f.display.setFullscreen(0, true);
    assert.equal(f.panelBox.visible, true);
    f.display.setFullscreen(1, true);
    assert.equal(f.panelBox.visible, false);
    f.guard.cleanup();
}

// Split Top Bar has three PanelGlassSurface instances rather than one
// DashManager.bgActor. Guard signals must hide/reveal them synchronously,
// before the next stage frame (no fullscreen-video flash).
{
    const f = fixture();
    const splitManager = {
        syncCalls: 0,
        setVisibilityGate(fn) {this.gate = fn;},
        sync() {this.syncCalls++; this.visible = this.gate?.() ?? true;},
    };
    f.guard = new FullscreenPanelChromeGuard({
        layout: f.layout, display: f.display, panel: f.panel,
        panelManager: splitManager,
    });
    f.guard.setup();
    assert.equal(splitManager.visible, true);
    const initialCalls = splitManager.syncCalls;
    f.display.setFullscreen(0, true);
    assert.equal(f.panelBox.visible, false);
    assert.equal(splitManager.visible, false,
        'islands must hide immediately on fullscreen signal');
    assert.ok(splitManager.syncCalls > initialCalls);
    f.display.setFullscreen(0, false);
    assert.equal(splitManager.visible, true,
        'islands must restore immediately on fullscreen exit');
    f.guard.cleanup();
    assert.equal(splitManager.gate, null);
}

assert.equal(primaryPanelIsFullscreen(null, new Display()), false);
assert.equal(primaryPanelIsFullscreen({}, null), false);
assert.match(integrator, /new FullscreenPanelChromeGuard\(/);
assert.match(integrator, /this\._fullscreenPanelChromeGuard\?\.cleanup\(\)/);
assert.match(integrator, /monitor\?\.inFullscreen !== true/,
    'native Dock Panel glass must not linger over fullscreen video');
assert.match(installer, /"fullscreenPanelGuard\.js"/);
assert.match(builder, /"fullscreenPanelGuard\.js"/);
assert.doesNotMatch(src,
    /global\.stage\.(add_effect|set_opacity)|disable_unredirect|enable_unredirect|GLib\.timeout_add/,
    'fullscreen guard never changes brightness, scanout or stage opacity');
console.log(
    'Fullscreen Chrome: GNOME top-panel hide and liquid-glass suppression, ' +
    'secondary monitor isolation, native visibility ownership, ' +
    'restore, hot-swap cleanup PASS.'
);
