import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    VLIQ_GLASS_ADAPTERS,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';

const CARD_CLASS = 'vliq-liquid-shell-card';
const PREVIEW_CARD_CLASS = 'vliq-app-preview-card';
const OPTICAL_MARGIN = 104;
const TARGET_CLASSES = new Set([
    'modal-dialog',
    'switcher-list',
    'workspace-switcher',
    'resize-popup',
    'workspace-thumbnails',
    'dash-background',
    PREVIEW_CARD_CLASS,
]);

const OVERVIEW_ONLY_CLASSES = new Set([
    'workspace-thumbnails',
    'dash-background',
]);

function classesOf(actor) {
    const value =
        actor?.get_style_class_name?.() ??
        actor?.style_class ??
        '';
    return String(value).split(/\s+/).filter(Boolean);
}

function radiusOf(actor) {
    try {
        actor.ensure_style?.();
        const node = actor.get_theme_node?.();
        return Math.max(
            node?.get_border_radius?.(St.Corner.TOPLEFT) ?? 0,
            node?.get_border_radius?.(St.Corner.TOPRIGHT) ?? 0,
            node?.get_border_radius?.(St.Corner.BOTTOMRIGHT) ?? 0,
            node?.get_border_radius?.(St.Corner.BOTTOMLEFT) ?? 0
        );
    } catch {
        return 18;
    }
}

class ShellCardSurface {
    constructor(manager, target) {
        this._manager = manager;
        this._vendor = manager._vendor;
        this._settings = manager._settings;
        this._target = target;
        this._parent = target.get_parent?.() ?? null;
        // Preview's glass must paint *inside* the native card, underneath the
        // real window clones. A sibling in the enclosing FixedLayout can have
        // stale allocation/opacity or end up behind the desktop layer, which
        // leaves only the nearly invisible fallback. Child composition follows
        // the card's native opacity/scale automatically, without double fades.
        this._previewInTarget =
            classesOf(target).includes(PREVIEW_CARD_CLASS);
        this._overlay = null;
        this._wrappedBinParent = null;
        this._material = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._wallpaperMirror = null;
        this._wallpaperOnly = false;
        this._opticalMargin =
            OPTICAL_MARGIN;
        this._effect = null;
        this._signals = [];
        this._destroyed = false;
        this._lastSceneSyncUs = 0;
        this._lastCaptureX = NaN;
        this._lastCaptureY = NaN;
        this._lastCaptureW = NaN;
        this._lastCaptureH = NaN;
        this._lastPaintWidth = NaN;
        this._lastPaintHeight = NaN;
    }

    attach() {
        if (!this._parent || !this._target || this._material)
            return false;

        const material = new this._vendor.UnpickableActor({
            name: 'vliq-shell-card-material',
            reactive: false,
        });
        material.set_no_layout?.(true);
        material.set_clip_to_allocation(true);

        const sceneRoot = new this._vendor.UnpickableActor({
            name: 'vliq-shell-card-live-scene',
            reactive: false,
        });
        sceneRoot.set_no_layout?.(true);
        material.add_child(sceneRoot);

        let wallpaperMirror = null;

        const breaker = new this._vendor.UnpickableActor({
            name: 'vliq-shell-card-breaker',
            reactive: false,
        });
        breaker.set_size(1, 1);
        breaker.set_opacity(0);
        breaker.set_no_layout?.(true);
        material.add_child(breaker);

        const effect = new this._vendor.LiquidEffect({
            extensionPath: this._vendor.root,
            settings: this._settings,
            owner: this._wallpaperOnly
                ? 'vliq-app-grid-wallpaper'
                : 'vliq-shell-card',
        });
        effect.setPadding?.(20);
        effect.setShadowMaxRadius?.(
            this._opticalMargin - 8
        );
        effect.setIsDock?.(false);
        material.add_effect(effect);

        try {
            if (this._previewInTarget) {
                // One refractive actor, painted FIRST inside the native
                // preview card. Leave Shell.WindowPreviewLayout clones above
                // it, with no new root, fullscreen pane or input blocker.
                this._target.insert_child_at_index(material, 0);
            } else if (
                this._parent instanceof St.Bin &&
                this._parent.get_child?.() === this._target
            ) {
                const overlay = new St.Widget({
                    name: 'vliq-shell-card-stack',
                    layout_manager: new Clutter.BinLayout(),
                    x_expand: true,
                    y_expand: true,
                    reactive: false,
                });

                this._parent.set_child(overlay);
                overlay.add_child(material);
                overlay.add_child(this._target);

                this._overlay = overlay;
                this._wrappedBinParent = this._parent;
            } else {
                this._parent.insert_child_below(
                    material,
                    this._target
                );
            }
        } catch {
            try {
                if (!material.get_parent?.())
                    this._parent.add_child(material);
                this._parent.set_child_below_sibling?.(
                    material,
                    this._target
                );
            } catch (error) {
                material.destroy?.();
                console.error(
                    '[VLIQ][ShellCards] attach failed: ' + error
                );
                return false;
            }
        }

        this._material = material;
        this._sceneRoot = sceneRoot;
        this._sceneManager = null;
        this._wallpaperMirror = wallpaperMirror;
        this._effect = effect;
        this._target.add_style_class_name?.(CARD_CLASS);

        // Do not call ensure_style()/get_theme_node() recursively from
        // style-changed. GNOME emits style-changed while resolving the style
        // itself, so re-entering radiusOf() here can recurse until GJS aborts.
        // Radius/material settings are refreshed by the normal appearance
        // update path and on surface creation instead.

        try {
            this._signals.push({
                obj: this._target,
                id: this._target.connect(
                    'destroy',
                    () => this.destroy(false)
                ),
            });
        } catch {}

        for (const signal of [
            'notify::visible',
            'notify::mapped',
        ]) {
            try {
                this._signals.push({
                    obj: this._target,
                    id: this._target.connect(
                        signal,
                        () => this._manager?._syncStageLoopState?.()
                    ),
                });
            } catch {
                // Some actor types may not expose every property signal.
            }
        }

        effect.setLiveGeometryHook?.(() => this._syncPaint());
        this.updateAppearance(this._manager._appearance);
        this._sync();

        console.log(
            '[VLIQ][ShellCards] attached [' +
            classesOf(this._target).join(' ') +
            ']'
        );
        return true;
    }

    updateAppearance(state) {
        if (!this._effect || !state)
            return;

        const role =
            VLIQ_GLASS_ROLES.shellCard;
        const adapter =
            VLIQ_GLASS_ADAPTERS.shellCard;
        const radius = Math.max(0, radiusOf(this._target));

        let brightness = null;
        let contrast = null;
        let saturation = null;

        try {
            brightness =
                this._settings.get_double('menu-brightness');
            contrast =
                this._settings.get_double('menu-contrast');
            saturation =
                this._settings.get_double('menu-saturation');
        } catch {
            // Shared material defaults remain valid.
        }

        applyVLIQGlassRole(
            this._effect,
            role,
            {
                tintColor: [
                    (state.r ?? 255) / 255,
                    (state.g ?? 255) / 255,
                    (state.b ?? 255) / 255,
                ],
                tintStrength:
                    adapter.inheritGlobalTint
                        ? (state.opacity ?? role.tintStrength)
                        : role.tintStrength,
                baseBlur:
                    adapter.inheritGlobalBlur
                        ? (state.blur ?? 7)
                        : 7,
                cornerRadius: radius,
                brightness,
                contrast,
                saturation,
                multiRegion: adapter.multiRegion,
            }
        );

        this._material?.queue_redraw?.();
    }

    _ensureSceneManager() {
        if (this._sceneManager || !this._sceneRoot)
            return this._sceneManager;

        this._sceneManager =
            new this._vendor.WindowCloneManager(
                this._sceneRoot,
                null,
                'vliq-shell-card-scene'
            );
        this._lastSceneSyncUs = 0;
        this._lastCaptureX = NaN;
        this._lastCaptureY = NaN;
        this._lastCaptureW = NaN;
        this._lastCaptureH = NaN;
        return this._sceneManager;
    }

    _releaseSceneManager() {
        if (!this._sceneManager)
            return;

        try {
            this._sceneManager.destroy?.();
        } catch {
            // Scene may already be tearing down.
        }
        this._sceneManager = null;
        this._lastSceneSyncUs = 0;
        this._lastCaptureX = NaN;
        this._lastCaptureY = NaN;
        this._lastCaptureW = NaN;
        this._lastCaptureH = NaN;
    }

    _sync() {
        if (
            this._destroyed ||
            !this._target ||
            !this._material
        ) {
            return;
        }

        const box = this._target.get_allocation_box?.();
        const w = box?.get_width?.() ?? this._target.width ?? 0;
        const h = box?.get_height?.() ?? this._target.height ?? 0;
        const x = box?.x1 ?? this._target.x ?? 0;
        const y = box?.y1 ?? this._target.y ?? 0;
        const opacity =
            this._target.get_paint_opacity?.() ??
            this._target.opacity ??
            255;

        // Zero paint opacity during GNOME's native close/open animation is
        // NOT equivalent to an unmapped or destroyed card. Releasing its
        // wallpaper/window clone tree here caused a cold empty capture each
        // time a hover preview changed alpha through zero.
        const unmapped = !this._target.mapped ||
            !this._target.visible;
        if (unmapped) {
            this._material.hide?.();
            this._releaseSceneManager();
            return;
        }

        const transientAllocation =
            !Number.isFinite(w) || !Number.isFinite(h) ||
            w <= 1 || h <= 1;
        if (transientAllocation || opacity <= 0) {
            // Mutter may temporarily publish an empty allocation between
            // native layouts. Like a zero-alpha transition, this must NOT
            // destroy the mapped card's live clone scene, or the next frame
            // will show an empty offscreen capture before it is populated.
            // Keep the existing actor mapped and make only its paint invisible.
            if (this._material.opacity !== 0)
                this._material.opacity = 0;
            return;
        }

        const localX = this._previewInTarget || this._overlay ? 0 : x;
        const localY = this._previewInTarget || this._overlay ? 0 : y;

        this._vendor.setPositionIfChanged(
            this._material,
            localX - this._opticalMargin,
            localY - this._opticalMargin
        );
        this._vendor.setSizeIfChanged(
            this._material,
            w + this._opticalMargin * 2,
            h + this._opticalMargin * 2
        );
        if (this._previewInTarget) {
            // The preview card owns its opening/closing opacity and scale.
            // Its glass child inherits both automatically. Copying them onto
            // the child too would square the alpha and make the material
            // disappear at the start/end of the 120 ms animation.
            if (this._material.opacity !== 255)
                this._material.opacity = 255;
            if (this._material.scale_x !== 1 ||
                this._material.scale_y !== 1)
                this._material.set_scale(1, 1);
            this._vendor.setTranslationIfChanged(
                this._material, 0, 0
            );
        } else {
            // Other GNOME Shell cards still position their material as a
            // separate sibling; preserve the accepted transform-mirroring.
            const scaleX = this._target.scale_x ?? 1;
            const scaleY = this._target.scale_y ?? 1;
            const [pivotX, pivotY] =
                this._target.get_pivot_point?.() ?? [0.5, 0.5];
            const materialW =
                w + this._opticalMargin * 2;
            const materialH =
                h + this._opticalMargin * 2;

            const desiredPivotX =
                (this._opticalMargin + pivotX * w) / materialW;
            const desiredPivotY =
                (this._opticalMargin + pivotY * h) / materialH;
            const [materialPivotX, materialPivotY] =
                this._material.get_pivot_point?.() ?? [NaN, NaN];

            if (
                Math.abs(materialPivotX - desiredPivotX) > 0.0001 ||
                Math.abs(materialPivotY - desiredPivotY) > 0.0001
            ) {
                this._material.set_pivot_point(
                    desiredPivotX,
                    desiredPivotY
                );
            }
            if (
                this._material.scale_x !== scaleX ||
                this._material.scale_y !== scaleY
            ) {
                this._material.set_scale(scaleX, scaleY);
            }
            this._vendor.setTranslationIfChanged(
                this._material,
                this._target.translation_x ?? 0,
                this._target.translation_y ?? 0
            );
            if (this._material.opacity !== opacity)
                this._material.opacity = opacity;
        }
        if (!this._material.visible)
            this._material.show?.();

        this._ensureSceneManager();
        this._syncSceneLayers();
    }

    syncFrame() {
        if (
            this._destroyed ||
            !this._target?.mapped ||
            !this._target?.visible
        ) {
            // Only a true unmap can tear down the expensive clone scene.
            this._material?.hide?.();
            this._releaseSceneManager();
            return;
        }

        this._sync();
    }

    _syncSceneLayers() {
        const material = this._material;
        const sceneRoot = this._sceneRoot;
        const sceneManager = this._ensureSceneManager();
        if (
            this._destroyed ||
            !material ||
            !sceneRoot ||
            !material.mapped
        ) {
            return;
        }

        if (!sceneManager)
            return;

        const [w, h] = material.get_size?.() ?? [0, 0];
        if (w <= 1 || h <= 1)
            return;

        const [absX, absY] =
            material.get_transformed_position?.() ?? [0, 0];
        const [tw, th] =
            material.get_transformed_size?.() ?? [w, h];
        const sx = Math.max(tw / w, .001);
        const sy = Math.max(th / h, .001);

        this._vendor.setSizeIfChanged(
            sceneRoot,
            global.stage.width,
            global.stage.height
        );
        const invScaleX = 1 / sx;
        const invScaleY = 1 / sy;
        if (
            sceneRoot.scale_x !== invScaleX ||
            sceneRoot.scale_y !== invScaleY
        ) {
            sceneRoot.set_scale(invScaleX, invScaleY);
        }
        if (sceneRoot.x !== 0 || sceneRoot.y !== 0)
            sceneRoot.set_position(0, 0);
        this._vendor.setTranslationIfChanged(
            sceneRoot,
            -absX / sx,
            -absY / sy
        );

        const captureRect = [
            absX,
            absY,
            tw,
            th,
        ];

        const captureChanged =
            this._lastCaptureX !== absX ||
            this._lastCaptureY !== absY ||
            this._lastCaptureW !== tw ||
            this._lastCaptureH !== th;

        const sceneFps = Math.max(
            15,
            Math.min(
                60,
                this._manager?._appearance?.sceneFps ?? 30
            )
        );
        const nowUs = GLib.get_monotonic_time();
        const intervalUs = 1000000 / sceneFps;
        const sceneDue =
            captureChanged ||
            this._lastSceneSyncUs === 0 ||
            nowUs - this._lastSceneSyncUs >= intervalUs;

        if (!sceneDue)
            return;

        // Stable cards still need live window-clone synchronization, but
        // unchanged capture bounds must not reconfigure clipping every
        // scheduled scene refresh.
        if (captureChanged) {
            sceneManager.setCullRect?.(captureRect);
            sceneManager.applyBgCloneClip?.(captureRect);
        }
        sceneManager.sync?.();

        this._lastCaptureX = absX;
        this._lastCaptureY = absY;
        this._lastCaptureW = tw;
        this._lastCaptureH = th;
        this._lastSceneSyncUs = nowUs;
    }

    _syncPaint() {
        const material = this._material;
        const effect = this._effect;
        if (
            this._destroyed ||
            !material ||
            !effect ||
            !material.mapped
        ) {
            return;
        }

        const [w, h] = material.get_size?.() ?? [0, 0];
        if (w <= 1 || h <= 1)
            return;

        // Geometry uniforms are local to the card's own capture, so a
        // stationary card uses the same values even while its parent moves.
        // Avoid writing all six uniforms on every paint of the same size.
        if (
            w === this._lastPaintWidth &&
            h === this._lastPaintHeight
        ) {
            return;
        }
        this._lastPaintWidth = w;
        this._lastPaintHeight = h;

        // Paint hook is uniforms-only; live scene actor writes happen before
        // update in ShellCardGlassManager.
        const glassW = Math.max(
            1,
            w - this._opticalMargin * 2
        );
        const glassH = Math.max(
            1,
            h - this._opticalMargin * 2
        );
        effect.setResolution?.(w, h);
        effect.setGlassGeometry?.(
            this._opticalMargin,
            this._opticalMargin,
            glassW,
            glassH
        );
    }

    destroy(removeClass = true) {
        if (this._destroyed)
            return;
        this._destroyed = true;

        try {
            this._effect?.setLiveGeometryHook?.(null);
        } catch {}

        for (const signal of this._signals) {
            try {
                signal.obj.disconnect(signal.id);
            } catch {}
        }
        this._signals = [];

        if (removeClass) {
            try {
                this._target?.remove_style_class_name?.(
                    CARD_CLASS
                );
            } catch {}
        }

        this._releaseSceneManager();

        let safeToDestroyOverlay = true;

        if (
            this._overlay &&
            this._wrappedBinParent &&
            this._target
        ) {
            if (removeClass) {
                try {
                    if (this._target.get_parent?.() === this._overlay)
                        this._overlay.remove_child(this._target);

                    if (!this._target.get_parent?.())
                        this._wrappedBinParent.set_child(this._target);
                } catch (error) {
                    console.error(
                        '[VLIQ][ShellCards] native Bin restore failed: ' +
                        error
                    );
                }

                safeToDestroyOverlay =
                    this._target.get_parent?.() !== this._overlay;
            } else {
                // Target is itself being destroyed. Detach it from our wrapper
                // so destroying the wrapper cannot recursively own/destroy it.
                try {
                    if (this._target.get_parent?.() === this._overlay)
                        this._overlay.remove_child(this._target);
                } catch {}
            }
        }

        if (safeToDestroyOverlay) {
            try {
                this._overlay?.destroy?.();
            } catch {}
        } else {
            try {
                this._material?.destroy?.();
            } catch {}
            console.warn(
                '[VLIQ][ShellCards] kept neutral wrapper to protect native card content'
            );
        }

        if (!this._overlay) {
            try {
                this._material?.destroy?.();
            } catch {}
        }

        this._manager?._surfaceDestroyed(this._target, this);
        this._overlay = null;
        this._wrappedBinParent = null;
        this._material = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._wallpaperMirror = null;
        this._effect = null;
        this._previewInTarget = false;
        this._target = null;
        this._parent = null;
        this._manager = null;
    }
}

export class ShellCardGlassManager {
    constructor(params) {
        this._vendor = params.vendor;
        this._settings = params.settings;
        this._readAppearance = params.readAppearance;
        // Preview cards live under VLIQ's separately managed desktop layer.
        // In manual-only mode we reuse the same effect pipeline without
        // traversing the Shell tree or installing another polling loop.
        this._manualOnly = Boolean(params.manualOnly);
        this._appearance = null;
        this._surfaces = new Map();
        this._watched = new Map();
        this._enabled = false;
        this._stageSyncId = 0;
    }

    setup() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._appearance = this._readAppearance();

        if (!this._manualOnly)
            this._watchTree(Main.uiGroup);

        this._syncStageLoopState();

        console.log(
            '[VLIQ][ShellCards] event-driven Shell card registry active'
        );
    }

    _ensureStageSync() {
        if (!this._enabled || this._stageSyncId)
            return;

        this._stageSyncId = global.stage.connect(
            'before-update',
            () => {
                if (!this._enabled)
                    return;

                for (const [actor, surface] of this._surfaces) {
                    if (
                        !surface?._target?.mapped ||
                        !surface?._target?.visible
                    ) {
                        continue;
                    }

                    try {
                        surface.syncFrame();
                    } catch (error) {
                        console.error(
                            '[VLIQ][ShellCards] frame sync failed; restoring native card: ' +
                            error +
                            '\n' +
                            (error?.stack ?? '')
                        );
                        this._surfaces.delete(actor);
                        surface.destroy(true);
                    }
                }
            }
        );
    }

    _stopStageSync() {
        if (!this._stageSyncId)
            return;

        try {
            global.stage.disconnect(this._stageSyncId);
        } catch {}
        this._stageSyncId = 0;
    }

    _syncStageLoopState() {
        if (!this._enabled) {
            this._stopStageSync();
            return;
        }

        for (const surface of this._surfaces.values()) {
            if (
                surface?._target?.mapped &&
                surface?._target?.visible
            ) {
                this._ensureStageSync();
                return;
            }
        }

        this._stopStageSync();
    }

    _watchTree(actor) {
        if (
            !this._enabled ||
            !actor ||
            actor === global.window_group ||
            this._watched.has(actor)
        ) {
            return;
        }

        const name = actor.get_name?.() ?? '';
        if (
            name.startsWith('vliq-') ||
            name.startsWith('lg-')
        ) {
            return;
        }

        this._maybeAttach(actor);

        const entry = {childId: 0, destroyId: 0};
        try {
            entry.childId = actor.connect(
                'child-added',
                (_parent, child) => this._watchTree(child)
            );
        } catch {}

        try {
            entry.destroyId = actor.connect('destroy', () => {
                this._watched.delete(actor);
                const surface = this._surfaces.get(actor);
                surface?.destroy(false);
            });
        } catch {}

        this._watched.set(actor, entry);

        for (const child of actor.get_children?.() ?? [])
            this._watchTree(child);
    }

    attachPreview(actor) {
        if (!this._enabled ||
            !classesOf(actor).includes(PREVIEW_CARD_CLASS))
            return false;
        this._maybeAttach(actor);
        return this._surfaces.has(actor);
    }

    _maybeAttach(actor) {
        if (
            this._surfaces.has(actor) ||
            !actor?.add_style_class_name
        ) {
            return;
        }

        const classes = classesOf(actor);
        const targetClass =
            classes.find(name => TARGET_CLASSES.has(name)) ?? null;
        if (!targetClass)
            return;

        // Overview-only classes can also appear in related Shell surfaces.
        // Only glassify them inside GNOME's overviewGroup, so Ubuntu Dock and
        // unrelated St actors are untouched. Search entries deliberately use
        // the dedicated lightweight Search Surface path instead.
        if (OVERVIEW_ONLY_CLASSES.has(targetClass)) {
            const overview = Main.layoutManager.overviewGroup;
            if (!overview?.contains?.(actor))
                return;
        }

        const surface = new ShellCardSurface(this, actor);
        if (surface.attach()) {
            this._surfaces.set(actor, surface);
            this._syncStageLoopState();
        }
    }

    _surfaceDestroyed(actor, surface) {
        if (this._surfaces.get(actor) === surface)
            this._surfaces.delete(actor);
        this._syncStageLoopState();
    }

    updateAppearance(state = this._readAppearance()) {
        this._appearance = state;
        for (const surface of this._surfaces.values())
            surface.updateAppearance(state);
    }

    cleanup() {
        if (!this._enabled)
            return;
        this._enabled = false;

        this._stopStageSync();

        for (const surface of [...this._surfaces.values()])
            surface.destroy(true);
        this._surfaces.clear();

        for (const [actor, entry] of this._watched) {
            try {
                if (entry.childId)
                    actor.disconnect(entry.childId);
            } catch {}
            try {
                if (entry.destroyId)
                    actor.disconnect(entry.destroyId);
            } catch {}
        }
        this._watched.clear();

        console.log('[VLIQ][ShellCards] registry stopped');
    }
}
