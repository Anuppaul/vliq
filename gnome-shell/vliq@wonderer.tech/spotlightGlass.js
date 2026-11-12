import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    VLIQ_GLASS_ADAPTERS,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';

export const SPOTLIGHT_GLASS_ENTRY_CLASS =
    'vliq-spotlight-glass-entry';
export const SPOTLIGHT_GLASS_RESULTS_CLASS =
    'vliq-spotlight-glass-results';

const PAD = 20;
// The search field is a native dark rounded rectangle, not a shader pill.
// The optical material remains only behind the independently rendered
// results panel, whose corners are a restrained rounded rectangle.
const SHARED_RADIUS = 18;
// Covers the shader's 96px edge-lens reach plus blur/filter sampling slack.
// The scene clone cull must be larger than the visible pill or the refraction
// samples the clipped edge and recreates the horizontal streak we removed.
const SCENE_CAPTURE_MARGIN = 160;

function finiteRect(rect) {
    return (
        Array.isArray(rect) &&
        rect.length >= 4 &&
        rect.every(Number.isFinite) &&
        rect[2] > 1 &&
        rect[3] > 1
    );
}

export class SpotlightGlassManager {
    constructor(params) {
        this._vendor = params.vendor;
        this._settings = params.settings;
        this._readAppearance =
            params.readAppearance;

        this._enabled = false;
        this._target = null;
        this._resultsTarget = null;
        this._hostLayer = null;

        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._effect = null;

        this._appearance = null;
        this._signals = [];
        this._stageId = 0;

        this._lastRegionKey = '';
        this._lastSceneSyncUs = 0;
        this._lastCullKey = '';
    }

    setup() {
        if (this._enabled)
            return;

        this._enabled = true;
        this._appearance =
            this._readAppearance?.() ?? null;
    }

    attach(target, resultsTarget, hostLayer) {
        if (
            !this._enabled ||
            !target ||
            !hostLayer
        ) {
            return false;
        }

        this._detachTarget();

        this._target = target;
        this._resultsTarget =
            resultsTarget ?? null;
        this._hostLayer = hostLayer;

        try {
            target.add_style_class_name?.(
                SPOTLIGHT_GLASS_ENTRY_CLASS
            );
            this._resultsTarget
                ?.add_style_class_name?.(
                    SPOTLIGHT_GLASS_RESULTS_CLASS
                );
        } catch {}

        if (!this._root)
            this._createLayer();
        else
            this._placeBelowHost();

        const sync = () =>
            this._syncLoopState();

        for (const [obj, signal] of [
            [target, 'notify::visible'],
            [target, 'notify::mapped'],
            [this._resultsTarget, 'notify::visible'],
            [this._resultsTarget, 'notify::mapped'],
            [hostLayer, 'notify::visible'],
            [hostLayer, 'notify::mapped'],
        ]) {
            if (!obj)
                continue;

            try {
                this._signals.push({
                    obj,
                    id: obj.connect(
                        signal,
                        sync
                    ),
                });
            } catch {}
        }

        try {
            this._signals.push({
                obj: target,
                id: target.connect(
                    'destroy',
                    () => {
                        this._detachTarget();
                        this._syncLoopState();
                    }
                ),
            });
        } catch {}

        try {
            if (this._resultsTarget) {
                this._signals.push({
                    obj: this._resultsTarget,
                    id: this._resultsTarget.connect(
                        'destroy',
                        () => {
                            this._resultsTarget = null;
                            this._lastRegionKey = '';
                            this._lastCullKey = '';
                        }
                    ),
                });
            }
        } catch {}

        this._applyAppearance();
        this._lastRegionKey = '';
        this._lastCullKey = '';
        this._syncLoopState();

        return true;
    }

    _createLayer() {
        const root =
            new this._vendor.UnpickableActor({
                name:
                    'vliq-spotlight-glass-root',
                reactive: false,
            });
        root.set_no_layout?.(true);
        root.set_position(0, 0);
        root.set_size(
            global.stage.width,
            global.stage.height
        );
        root.hide();

        const liquidBox =
            new this._vendor.UnpickableActor({
                name:
                    'vliq-spotlight-glass-box',
                reactive: false,
            });
        liquidBox.set_no_layout?.(true);
        liquidBox.set_position(0, 0);
        liquidBox.set_size(
            global.stage.width,
            global.stage.height
        );
        liquidBox.set_clip_to_allocation(
            true
        );
        root.add_child(liquidBox);

        const sceneRoot =
            new this._vendor.UnpickableActor({
                name:
                    'vliq-spotlight-glass-scene',
                reactive: false,
            });
        sceneRoot.set_no_layout?.(true);
        sceneRoot.set_position(0, 0);
        sceneRoot.set_size(
            global.stage.width,
            global.stage.height
        );
        liquidBox.add_child(sceneRoot);

        const sceneManager =
            new this._vendor.WindowCloneManager(
                sceneRoot,
                null,
                'vliq-spotlight-glass-scene'
            );

        const breaker =
            new this._vendor.UnpickableActor({
                name:
                    'vliq-spotlight-glass-breaker',
                reactive: false,
            });
        breaker.set_no_layout?.(true);
        breaker.set_size(1, 1);
        breaker.set_opacity(0);
        liquidBox.add_child(breaker);

        const effect =
            new this._vendor.LiquidEffect({
                extensionPath:
                    this._vendor.root,
                settings: this._settings,
                owner:
                    'vliq-spotlight-search',
            });

        effect.setPadding?.(PAD);
        effect.setIsDock?.(false);
        effect.setMultiRegionMode?.(
            true
        );
        effect.setShadowMaxRadius?.(0);
        effect.setLiveGeometryHook?.(
            () =>
                this._syncEffectRegion()
        );

        liquidBox.add_effect(effect);

        this._root = root;
        this._liquidBox = liquidBox;
        this._sceneRoot = sceneRoot;
        this._sceneManager = sceneManager;
        this._effect = effect;

        this._placeBelowHost();
        this._applyAppearance();
    }

    _placeBelowHost() {
        if (
            !this._root ||
            !this._hostLayer
        ) {
            return;
        }

        try {
            if (!this._root.get_parent?.()) {
                Main.uiGroup.insert_child_below(
                    this._root,
                    this._hostLayer
                );
            } else if (
                this._root.get_parent?.() ===
                    Main.uiGroup &&
                this._hostLayer.get_parent?.() ===
                    Main.uiGroup
            ) {
                Main.uiGroup
                    .set_child_below_sibling?.(
                        this._root,
                        this._hostLayer
                    );
            }
        } catch {
            try {
                if (!this._root.get_parent?.())
                    Main.uiGroup.add_child(
                        this._root
                    );
            } catch {}
        }
    }

    _isActive() {
        return Boolean(
            this._enabled &&
            this._target &&
            this._hostLayer &&
            this._target.visible &&
            this._target.mapped &&
            this._hostLayer.visible &&
            this._hostLayer.mapped
        );
    }

    _ensureStageLoop() {
        if (
            this._stageId ||
            !this._enabled
        ) {
            return;
        }

        this._stageId =
            global.stage.connect(
                'before-update',
                () => this._tick()
            );
    }

    _stopStageLoop() {
        if (!this._stageId)
            return;

        try {
            global.stage.disconnect(
                this._stageId
            );
        } catch {}
        this._stageId = 0;
    }

    _syncLoopState() {
        if (!this._isActive() || this._appearance?.milky) {
            this._stopStageLoop();
            this._root?.hide?.();
            this._lastSceneSyncUs = 0;
            this._lastCullKey = '';
            return; // Native Spotlight input/results paint Milky directly.
        }

        // Empty query: native search entry is the ONLY visible surface.
        // No unnecessary frame callback, full-stage capture or cached
        // previous results shader may be painted behind the dark bar.
        if (this._regions().length === 0) {
            this._stopStageLoop();
            this._root?.hide?.();
            this._lastRegionKey = '';
            this._lastSceneSyncUs = 0;
            this._lastCullKey = '';
            return;
        }

        this._placeBelowHost();
        this._syncActors();
        this._syncEffectRegion();
        this._syncScene(true);

        if (!this._root?.visible)
            this._root?.show?.();

        this._ensureStageLoop();
    }

    _syncActors() {
        const width =
            global.stage.width;
        const height =
            global.stage.height;

        this._vendor.setSizeIfChanged(
            this._root,
            width,
            height
        );
        this._vendor.setSizeIfChanged(
            this._liquidBox,
            width,
            height
        );
        this._vendor.setSizeIfChanged(
            this._sceneRoot,
            width,
            height
        );

        const opacity =
            this._hostLayer?.opacity ??
            255;
        if (
            this._root &&
            this._root.opacity !== opacity
        ) {
            this._root.opacity =
                opacity;
        }
    }

    _regionFor(target, interactive = false) {
        if (
            !target ||
            !target.visible ||
            !target.mapped ||
            (target.get_paint_opacity?.() ??
                target.opacity ??
                255) <= 0
        ) {
            return null;
        }

        const rect =
            this._vendor
                .getTransformedRect(
                    target
                );

        if (!finiteRect(rect))
            return null;

        const [x, y, w, h] = rect;
        const adapter =
            VLIQ_GLASS_ADAPTERS
                .spotlight;

        let focused = false;
        if (interactive) {
            try {
                const keyFocus =
                    global.stage.get_key_focus?.() ??
                    null;
                focused =
                    keyFocus === target ||
                    Boolean(
                        keyFocus &&
                        target.contains?.(
                            keyFocus
                        )
                    );
            } catch {}
        }

        const response =
            interactive &&
            target.get_hover?.()
                ? (
                    adapter
                        .hoverResponse ??
                    0.32
                )
                : interactive &&
                    focused
                    ? (
                        adapter
                            .focusResponse ??
                        0.16
                    )
                    : 0.0;

        return {
            x: x - PAD,
            y: y - PAD,
            w: w + PAD * 2,
            h: h + PAD * 2,
            tintR: 1.0,
            tintG: 1.0,
            tintB: 1.0,
            baseStrength: 0.0,
            response,
        };
    }

    _regions() {
        // Spotlight's search field is permanently dark native CSS in ALL
        // Appearance modes. Rendering a LiquidEffect under it makes the
        // background brighten/refract and can recreate a pill silhouette.
        // Keep the existing live shader only for visible search results.
        const resultsRegion = this._regionFor(this._resultsTarget, false);
        return resultsRegion ? [resultsRegion] : [];
    }

    _syncEffectRegion() {
        if (
            !this._effect ||
            !this._isActive()
        ) {
            return;
        }

        const regions = this._regions();
        if (!regions.length)
            return;

        const width =
            global.stage.width;
        const height =
            global.stage.height;

        const key = [
            width,
            height,
            ...regions.flatMap(region => [
                Math.round(region.x * 10) /
                    10,
                Math.round(region.y * 10) /
                    10,
                Math.round(region.w * 10) /
                    10,
                Math.round(region.h * 10) /
                    10,
                region.response,
            ]),
        ].join(':');

        if (
            key ===
            this._lastRegionKey
        ) {
            return;
        }

        this._lastRegionKey = key;
        this._effect.setResolution?.(
            width,
            height
        );
        this._effect.setCornerRadius?.(
            SHARED_RADIUS
        );
        this._effect.setGlassRegions?.(
            regions
        );
    }

    _syncScene(force = false) {
        if (
            !this._sceneManager ||
            !this._isActive()
        ) {
            return;
        }

        const regions = this._regions();
        if (!regions.length)
            return;

        const adapter =
            VLIQ_GLASS_ADAPTERS
                .spotlight;
        const nowUs =
            GLib.get_monotonic_time();

        const sceneFps = Math.max(
            15,
            Math.min(
                adapter.sceneFpsCap ??
                    24,
                this._appearance
                    ?.sceneFps ??
                    30
            )
        );

        const intervalUs =
            1000000 / sceneFps;
        if (
            !force &&
            this._lastSceneSyncUs > 0 &&
            nowUs -
                this._lastSceneSyncUs <
                intervalUs
        ) {
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const region of regions) {
            minX = Math.min(
                minX,
                region.x
            );
            minY = Math.min(
                minY,
                region.y
            );
            maxX = Math.max(
                maxX,
                region.x + region.w
            );
            maxY = Math.max(
                maxY,
                region.y + region.h
            );
        }

        const left = Math.max(
            0,
            minX -
                SCENE_CAPTURE_MARGIN
        );
        const top = Math.max(
            0,
            minY -
                SCENE_CAPTURE_MARGIN
        );
        const right = Math.min(
            global.stage.width,
            maxX +
                SCENE_CAPTURE_MARGIN
        );
        const bottom = Math.min(
            global.stage.height,
            maxY +
                SCENE_CAPTURE_MARGIN
        );

        const cullRect = [
            left,
            top,
            Math.max(1, right - left),
            Math.max(1, bottom - top),
        ];
        const cullKey =
            cullRect
                .map(value =>
                    Math.round(value)
                )
                .join(':');

        if (
            force ||
            cullKey !==
                this._lastCullKey
        ) {
            this._lastCullKey =
                cullKey;
            this._sceneManager
                .setCullRect?.(
                    cullRect
                );
            this._sceneManager
                .applyBgCloneClip?.(
                    cullRect
                );
        }

        this._sceneManager.sync?.();
        this._lastSceneSyncUs =
            nowUs;
    }

    _tick() {
        if (!this._isActive()) {
            this._syncLoopState();
            return;
        }

        this._syncActors();
        this._syncEffectRegion();
        this._syncScene(false);
    }

    _applyAppearance(
        state =
            this._appearance ??
            this._readAppearance?.()
    ) {
        if (
            !this._effect ||
            !state
        ) {
            return;
        }

        this._appearance = state;

        const role =
            VLIQ_GLASS_ROLES
                .innerCard;

        let brightness = null;
        let contrast = null;
        let saturation = null;

        try {
            brightness =
                this._settings.get_double(
                    'menu-brightness'
                );
            contrast =
                this._settings.get_double(
                    'menu-contrast'
                );
            saturation =
                this._settings.get_double(
                    'menu-saturation'
                );
        } catch {}

        applyVLIQGlassRole(
            this._effect,
            role,
            {
                tintColor: [
                    (state.r ?? 255) /
                        255,
                    (state.g ?? 255) /
                        255,
                    (state.b ?? 255) /
                        255,
                ],
                tintStrength:
                    state.opacity ??
                    role.tintStrength,
                baseBlur:
                    state.blur ?? 7,
                cornerRadius:
                    SHARED_RADIUS,
                brightness,
                contrast,
                saturation,
                multiRegion: true,
            }
        );

        this._lastRegionKey = '';
        this._effect.queue_repaint?.();
    }

    updateAppearance(
        state =
            this._readAppearance?.()
    ) {
        this._applyAppearance(state);
        this._syncLoopState();
    }

    refresh() {
        this._lastRegionKey = '';
        this._lastCullKey = '';
        this._syncLoopState();
    }

    _detachTarget() {
        for (const {obj, id} of
            this._signals) {
            try {
                obj?.disconnect?.(id);
            } catch {}
        }
        this._signals = [];

        try {
            this._target
                ?.remove_style_class_name?.(
                    SPOTLIGHT_GLASS_ENTRY_CLASS
                );
            this._resultsTarget
                ?.remove_style_class_name?.(
                    SPOTLIGHT_GLASS_RESULTS_CLASS
                );
        } catch {}

        this._target = null;
        this._resultsTarget = null;
        this._hostLayer = null;
        this._stopStageLoop();
        this._root?.hide?.();
        this._lastRegionKey = '';
        this._lastSceneSyncUs = 0;
        this._lastCullKey = '';
    }

    cleanup() {
        if (!this._enabled)
            return;

        this._enabled = false;
        this._detachTarget();

        try {
            this._effect
                ?.setLiveGeometryHook?.(
                    null
                );
        } catch {}

        try {
            this._sceneManager
                ?.destroy?.();
        } catch {}

        try {
            this._root?.destroy?.();
        } catch {}

        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._effect = null;
        this._appearance = null;
        this._vendor = null;
        this._settings = null;
        this._readAppearance = null;
    }
}
