import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {readWallpaperProfile} from './wallpaperAtmosphereConfig.js';


// GNOME Shell 50: paint one fixed native Clutter color quad instead of
// rasterizing St CSS on the first visible frame. Use 8-bit alpha parity
// with the existing CSS rgba(245,249,255,0.24) Milky hover shade.
const TINT_COLOR = new Cogl.Color({
    red: 245, green: 249, blue: 255, alpha: Math.round(255 * 0.24),
});
const CLEAR_COLOR = new Cogl.Color({
    red: 245, green: 249, blue: 255, alpha: 0,
});
const VENDOR_MIRROR_NAME = 'lg-bg-mirror-source';

/**
 * One fixed Milky White tint on each physical wallpaper paint source:
 *
 * (1) original GNOME desktop Meta.BackgroundActors;
 * (2) Meta.BackgroundActors in Liquid Glass's SHARED wallpaper mirror;
 * (3) the independent wallpaper actors of VLIQ's native App Grid blur.
 *
 * The three sources share the original Meta.Background image and stay
 * independent as actors; each gets one compositor-native paint-only tint
 * sibling, without CSS theme resolution or first-use GLSL compilation. We never tint
 * uiGroup, OverviewGroup, popups, windows or the final glass output, so
 * Browser pages and native app icons are not recolored.
 */
export class WallpaperAtmosphereManager {
    constructor(settings) {
        this._settings = settings;
        this._enabled = false;
        this._containers = new Map();
        this._actors = new Map();
        this._profile = readWallpaperProfile(settings);
        this._settingsId = 0;
        this._uiGroup = null;
        this._uiAddedId = 0;
        this._uiRemovedId = 0;
        this._statusUpdateId = 0;
        this._paintProbeId = 0;
        this._lastStatus = null;
        this._warnings = new Set();
    }

    setup() {
        if (this._enabled)
            return;
        this._enabled = true;

        // Hook original GNOME wallpaper before the other VLIQ glass
        // managers start. No wallpaper image is loaded or copied here.
        this.watchContainer(Main.layoutManager?._backgroundGroup);

        this._uiGroup = Main.layoutManager?.uiGroup ?? null;
        if (this._uiGroup) {
            // The shared mirror is created lazily by the vendored glass
            // pipeline. Hook its source once, not every window clone.
            this._uiAddedId = this._uiGroup.connect(
                'child-added', (_group, child) => {
                    if (child?.get_name?.() === VENDOR_MIRROR_NAME)
                        this.watchContainer(child);
                }
            );
            this._uiRemovedId = this._uiGroup.connect(
                'child-removed', (_group, child) => {
                    if (this._containers.has(child) &&
                        child?.get_name?.() === VENDOR_MIRROR_NAME)
                        this.unwatchContainer(child);
                }
            );
            for (const actor of this._uiGroup.get_children?.() ?? []) {
                if (actor?.get_name?.() === VENDOR_MIRROR_NAME)
                    this.watchContainer(actor);
            }
        }

        const onChange = (_settings, key) => {
            if (key !== 'wallpaper-style')
                return;
            // A wallpaper style toggle affects only a few lightweight
            // paint actors. Apply in the GSettings callback, not a
            // PRIORITY_DEFAULT_IDLE source that can run after a busy frame.
            const started = GLib.get_monotonic_time();
            this._applyNow();
            // This measures actual compositor frame scheduling rather than
            // only the JS setter. It is a one-shot GNOME Stage signal, never
            // a permanent repaint hook or polling timer.
            this._probeNextPaint(key, started);
            const elapsedMs =
                (GLib.get_monotonic_time() - started) / 1000;
            console.log(
                '[VLIQ][Wallpaper] style=' + this._profile.style +
                ' applied in ' + elapsedMs.toFixed(2) +
                ' ms (compositor paint not measured)'
            );
        };
        this._settingsId = this._settings?.connect?.(
            'changed', onChange
        ) ?? 0;
        this._applyNow();
        this._queueStatus();
    }

    _disconnectPaintProbe() {
        if (!this._paintProbeId)
            return;
        try {
            global.stage?.disconnect?.(this._paintProbeId);
        } catch {}
        this._paintProbeId = 0;
    }

    _probeNextPaint(_key, startedUs) {
        this._disconnectPaintProbe();
        const stage = global.stage;
        if (!stage?.connect)
            return;
        const style = this._profile.style;
        try {
            this._paintProbeId = stage.connect('after-paint', () => {
                this._disconnectPaintProbe();
                if (!this._enabled)
                    return;

                let attached = 0;
                let mapped = 0;
                let visible = 0;
                for (const record of this._actors.values()) {
                    const overlay = record.overlay;
                    if (!overlay)
                        continue;
                    attached++;
                    if (overlay.mapped)
                        mapped++;
                    if (overlay.visible)
                        visible++;
                }
                const ms = (GLib.get_monotonic_time() - startedUs) / 1000;
                // Stage after-paint means a compositor frame completed.
                // It does NOT prove these overlay pixels were visible.
                console.log(
                    '[VLIQ][Wallpaper][PaintProbe] style=' + style +
                    ' stage-after-paint=' + ms.toFixed(2) + ' ms' +
                    ' overlay=' + attached +
                    ' mapped=' + mapped +
                    ' visible=' + visible +
                    ' (pixel output unverified)'
                );
            });
        } catch (error) {
            this._paintProbeId = 0;
            this._warnOnce('after-paint diagnostic unavailable', error);
        }
    }

    _warnOnce(phase, error) {
        if (this._warnings.has(phase))
            return;
        this._warnings.add(phase);
        console.warn(
            '[VLIQ][Wallpaper] ' + phase + ': ' + error
        );
    }

    _isWallpaperActor(actor) {
        if (!actor)
            return false;
        try {
            // Filter only real GNOME/Mutter wallpaper surfaces, never UI
            // widgets that may happen to be children of a known container.
            if (!(actor instanceof Meta.BackgroundActor))
                return false;
            const content = actor.content ?? actor.get_content?.();
            return Boolean(content instanceof Meta.BackgroundContent);
        } catch {
            return false;
        }
    }

    _track(actor) {
        if (!this._isWallpaperActor(actor) ||
            this._actors.has(actor))
            return;

        const content = actor.content ?? actor.get_content?.();
        const record = {
            overlay: null,
            tinted: null,
            bindings: [],
            fallbackSignalIds: [],
            destroyId: 0,
            backgroundId: 0,
            content,
        };
        this._actors.set(actor, record);

        try {
            record.destroyId = actor.connect(
                'destroy', () => this._untrack(actor)
            );
        } catch {}

        try {
            // Meta.BackgroundActor can be added BEFORE it receives a
            // background; do NOT trigger its offscreen paint at that
            // moment. Mutter 50 can crash while drawing a null BG.
            record.backgroundId = content.connect(
                'notify::background',
                () => {
                    this._syncActor(actor);
                    this._queueStatus();
                }
            );
        } catch {}

        this._syncActor(actor);
        this._queueStatus();
    }

    _hasLoadedBackground(record) {
        try {
            return Boolean(record?.content?.background);
        } catch {
            return false;
        }
    }

    _syncOverlayColor(record) {
        const overlay = record?.overlay;
        if (!overlay)
            return;

        // Original remains an exact transparent color quad. The
        // actor stays allocated/mapped across mode changes, so switching
        // to Milky changes only a native paint color, never CSS, shader
        // compilation, actor visibility or compositor capture allocation.
        const tinted = this._enabled && this._profile.active;
        if (record.tinted === tinted)
            return;
        record.tinted = tinted;
        overlay.set_background_color(tinted ? TINT_COLOR : CLEAR_COLOR);
    }

    _syncActor(actor) {
        const record = this._actors.get(actor);
        if (!record)
            return;

        if (!this._enabled) {
            this._detachActor(actor, record);
            return;
        }

        if (record.overlay) {
            this._syncOverlayColor(record);
            return;
        }

        // Create native Cogl quad immediately on background actor discovery.
        // Inactive Original still has a transparent cached layer, so a
        // later Milky toggle cannot trigger CSS first-paint initialization.
        const parent = actor.get_parent?.();
        if (!parent)
            return;

        try {
            const overlay = new Clutter.Actor({
                name: 'vliq-wallpaper-milky-tint',
                reactive: false,
                background_color: this._profile.active ?
                    TINT_COLOR : CLEAR_COLOR,
            });
            overlay.add_constraint(new Clutter.BindConstraint({
                source: actor,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            parent.insert_child_above(overlay, actor);
            record.overlay = overlay;
            record.tinted = this._profile.active;

            // Mutter owns actor fades. Native GObject property bindings
            // mirror those fades without JavaScript work on every frame.
            for (const property of ['opacity', 'visible']) {
                try {
                    const binding = actor.bind_property(
                        property, overlay, property,
                        GObject.BindingFlags.SYNC_CREATE
                    );
                    if (binding) {
                        record.bindings.push(binding);
                        continue;
                    }
                } catch {}

                // A small fallback for a backend without native binding.
                // Only attach a property-notify callback when necessary.
                try {
                    const sync = () => {
                        overlay[property] = actor[property];
                    };
                    sync();
                    const id = actor.connect('notify::' + property, sync);
                    record.fallbackSignalIds.push(id);
                } catch {}
            }
        } catch (error) {
            this._warnOnce('native wallpaper tint unavailable', error);
            this._detachActor(actor, record);
        }
        this._queueStatus();
    }

    _detachActor(actor, record) {
        const overlay = record?.overlay ?? null;
        if (!overlay)
            return;
        record.overlay = null;
        record.tinted = null;
        for (const id of record.fallbackSignalIds) {
            try { actor.disconnect(id); } catch {}
        }
        record.fallbackSignalIds = [];
        for (const binding of record.bindings) {
            try { binding.unbind?.(); } catch {}
        }
        record.bindings = [];
        try { overlay.destroy?.(); } catch {}
        // The wallpaper actor and its original Meta.BackgroundContent
        // always remain owned by GNOME.
    }

    _untrack(actor) {
        const record = this._actors.get(actor);
        if (!record)
            return;
        this._actors.delete(actor);
        this._detachActor(actor, record);
        this._queueStatus();
        if (record.destroyId) {
            try {
                actor.disconnect(record.destroyId);
            } catch {}
        }
        if (record.backgroundId && record.content) {
            try {
                record.content.disconnect(record.backgroundId);
            } catch {}
        }
    }

    watchContainer(container) {
        if (!this._enabled || !container ||
            this._containers.has(container))
            return false;

        const record = {addedId: 0, removedId: 0, destroyId: 0};
        this._containers.set(container, record);

        try {
            record.addedId = container.connect(
                'child-added', (_parent, actor) => this._track(actor)
            );
        } catch {}
        try {
            record.removedId = container.connect(
                'child-removed', (_parent, actor) => this._untrack(actor)
            );
        } catch {}
        try {
            record.destroyId = container.connect(
                'destroy', () => this.unwatchContainer(container)
            );
        } catch {}

        for (const actor of container.get_children?.() ?? [])
            this._track(actor);
        return true;
    }

    unwatchContainer(container) {
        const record = this._containers.get(container);
        if (!record)
            return false;
        this._containers.delete(container);

        for (const [signal, id] of [
            ['added', record.addedId],
            ['removed', record.removedId],
            ['destroy', record.destroyId],
        ]) {
            if (!id)
                continue;
            try {
                container.disconnect(id);
            } catch {}
        }

        // A wallpaper may have an overlay sibling; use the tracked actor
        // registry rather than relying on an array mutated by destroy().
        for (const actor of [...(container.get_children?.() ?? [])])
            this._untrack(actor);
        return true;
    }

    _queueStatus() {
        if (!this._enabled || this._statusUpdateId)
            return;
        this._statusUpdateId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._statusUpdateId = 0;
                if (this._enabled)
                    this._publishStatus();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _publishStatus() {
        if (!this._settings)
            return;
        let loaded = 0;
        let attached = 0;
        for (const record of this._actors.values()) {
            if (this._hasLoadedBackground(record))
                loaded++;
            if (record.overlay)
                attached++;
        }
        // Attachment status is diagnostic; it cannot prove GPU pixel output.
        const message = !this._profile.active
            ? 'Original: no VLIQ wallpaper tint attached'
            : attached > 0
                ? 'Native Milky White tint allocated on ' + attached +
                    '/' + this._actors.size + ' wallpaper actors (' +
                    loaded + ' backgrounds loaded; visual check required)'
                : this._actors.size === 0
                    ? 'Waiting for GNOME wallpaper actors'
                    : 'Tint not attached: inspect GNOME Shell logs';

        if (this._lastStatus === message)
            return;
        this._lastStatus = message;
        try {
            if (this._settings.get_string('wallpaper-runtime-status') !==
                message) {
                this._settings.set_string(
                    'wallpaper-runtime-status', message
                );
            }
            console.log('[VLIQ][Wallpaper] ' + message);
        } catch (error) {
            this._warnOnce('runtime status unavailable', error);
        }
    }

    _applyNow() {
        const profile = readWallpaperProfile(this._settings);
        if (this._profile.active === profile.active)
            return;
        this._profile = profile;
        for (const actor of this._actors.keys())
            this._syncActor(actor);
        this._queueStatus();
    }

    cleanup() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this._disconnectPaintProbe();

        if (this._statusUpdateId) {
            try {
                GLib.source_remove(this._statusUpdateId);
            } catch {}
            this._statusUpdateId = 0;
        }
        if (this._settingsId) {
            try {
                this._settings?.disconnect(this._settingsId);
            } catch {}
            this._settingsId = 0;
        }
        if (this._uiGroup) {
            for (const id of [this._uiAddedId, this._uiRemovedId]) {
                if (!id)
                    continue;
                try {
                    this._uiGroup.disconnect(id);
                } catch {}
            }
        }
        this._uiAddedId = 0;
        this._uiRemovedId = 0;
        this._uiGroup = null;

        for (const container of [...this._containers.keys()])
            this.unwatchContainer(container);
        // Destroyed background actors are pruned by their own signals;
        // safety cleanup handles any that were detached unexpectedly.
        for (const actor of [...this._actors.keys()])
            this._untrack(actor);
        try {
            this._settings?.set_string?.(
                'wallpaper-runtime-status',
                'Inactive: VLIQ wallpaper tint stopped'
            );
        } catch {}
        this._settings = null;
    }
}
