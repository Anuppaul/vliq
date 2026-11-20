import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    VLIQ_GLASS_ADAPTERS,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';

const REGION_CLASS = 'vliq-overview-search-glass-region';
const TARGET_CLASS = 'search-section-content';
const DEFAULT_RADIUS = 24;
const SCENE_MARGIN_MIN = 56;
const SCENE_MARGIN_MAX = 144;

function finiteRect(rect) {
    return (
        Array.isArray(rect) &&
        rect.length >= 4 &&
        rect.every(Number.isFinite) &&
        rect[2] > 1 &&
        rect[3] > 1
    );
}

function actorClasses(actor) {
    return String(
        actor?.get_style_class_name?.() ??
        actor?.style_class ??
        ''
    ).split(/\s+/).filter(Boolean);
}

function readRadius(actor) {
    try {
        actor?.ensure_style?.();
        const node = actor?.get_theme_node?.();
        const values = [
            St.Corner.TOPLEFT,
            St.Corner.TOPRIGHT,
            St.Corner.BOTTOMRIGHT,
            St.Corner.BOTTOMLEFT,
        ].map(corner =>
            node?.get_border_radius?.(corner) ?? 0
        );
        const radius = Math.max(...values);
        if (Number.isFinite(radius) && radius > 0)
            return radius;
    } catch {
        // Use the conservative fallback.
    }

    return DEFAULT_RADIUS;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * One shared multi-region LiquidEffect for GNOME Overview search providers.
 *
 * Search providers are created/destroyed while every keystroke changes the
 * result set. A LiquidEffect per provider causes repeated full-scene FBO
 * allocation and clone churn. This manager keeps exactly one effect and one
 * WindowCloneManager; provider cards are only lightweight region records.
 */
export class OverviewSearchGlassManager {
    constructor(params) {
        this._vendor = params.vendor;
        this._settings = params.settings;
        this._readAppearance = params.readAppearance;

        this._overview = null;
        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._effect = null;

        this._appearance = null;
        this._targets = [];
        this._stageId = 0;
        this._overviewSignals = [];
        this._enabled = false;

        this._lastScanUs = 0;
        this._lastSceneSyncUs = 0;
        this._lastRegionKey = '';
        this._lastRegionGeometry = [];
        this._lastRootW = 0;
        this._lastRootH = 0;
        this._lastCaptureRect = null;
    }

    setup() {
        if (this._enabled)
            return;

        const overview = Main.layoutManager.overviewGroup;
        if (!overview)
            throw new Error('GNOME overviewGroup is unavailable');

        this._enabled = true;
        this._overview = overview;
        this._appearance = this._readAppearance();

        this._createMaterial();
        this._scanTargets(true);

        this._setupOverviewFrameLoop();

        console.log(
            '[VLIQ][OverviewSearchGlass] shared multi-region material active'
        );
    }

    _ensureStageSync() {
        if (!this._enabled || this._stageId)
            return;

        this._stageId = global.stage.connect(
            'before-update',
            () => this._tick()
        );
    }

    _stopStageSync() {
        if (!this._stageId)
            return;

        try {
            global.stage.disconnect(this._stageId);
        } catch {}
        this._stageId = 0;
    }

    _setupOverviewFrameLoop() {
        const stop = () => {
            this._root?.hide?.();
            this._stopStageSync();
            this._lastCaptureRect = null;
        };

        const sync = () => {
            const searchActive =
                Boolean(
                    Main.overview
                        ?.searchController
                        ?.searchActive
                );

            if (
                this._enabled &&
                Main.overview?.visible &&
                this._overview?.visible &&
                searchActive
            ) {
                this._ensureStageSync();
            } else {
                stop();
            }
        };

        try {
            this._overviewSignals.push({
                object: Main.overview,
                id: Main.overview.connect(
                    'showing',
                    sync
                ),
            });
            this._overviewSignals.push({
                object: Main.overview,
                id: Main.overview.connect(
                    'hidden',
                    stop
                ),
            });
        } catch {
            // Overview lifecycle signals vary slightly across Shell builds.
        }

        try {
            const searchController =
                Main.overview?.searchController;
            if (searchController) {
                this._overviewSignals.push({
                    object: searchController,
                    id: searchController.connect(
                        'notify::search-active',
                        sync
                    ),
                });
            }
        } catch {}

        try {
            this._overviewSignals.push({
                object: this._overview,
                id: this._overview.connect(
                    'notify::visible',
                    sync
                ),
            });
        } catch {}

        sync();
    }

    _createMaterial() {
        const root = new this._vendor.UnpickableActor({
            name: 'vliq-overview-search-material-root',
            reactive: false,
        });
        root.set_no_layout?.(true);
        root.set_clip_to_allocation(true);
        root.set_position(0, 0);
        root.set_size(1, 1);
        root.hide();

        const liquidBox = new this._vendor.UnpickableActor({
            name: 'vliq-overview-search-liquid-box',
            reactive: false,
        });
        liquidBox.set_no_layout?.(true);
        liquidBox.set_clip_to_allocation(true);
        liquidBox.set_position(0, 0);
        liquidBox.set_size(1, 1);
        root.add_child(liquidBox);

        const sceneRoot = new this._vendor.UnpickableActor({
            name: 'vliq-overview-search-scene',
            reactive: false,
        });
        sceneRoot.set_no_layout?.(true);
        sceneRoot.set_position(0, 0);
        sceneRoot.set_size(1, 1);
        liquidBox.add_child(sceneRoot);

        const sceneManager =
            new this._vendor.WindowCloneManager(
                sceneRoot,
                null,
                'vliq-overview-search'
            );

        const breaker = new this._vendor.UnpickableActor({
            name: 'vliq-overview-search-breaker',
            reactive: false,
        });
        breaker.set_no_layout?.(true);
        breaker.set_size(1, 1);
        breaker.set_opacity(0);
        liquidBox.add_child(breaker);

        const effect = new this._vendor.LiquidEffect({
            extensionPath: this._vendor.shaderRoot ?? this._vendor.root,
            settings: this._settings,
            owner: 'vliq-overview-search',
        });
        effect.setPadding?.(
            VLIQ_GLASS_ADAPTERS.overviewSearch.regionPadding ?? 20
        );
        effect.setIsDock?.(false);
        effect.setMultiRegionMode?.(true);
        liquidBox.add_effect(effect);

        // overviewGroup paints its own system-base background first. Index 0
        // places our material above that paint but below all Overview content.
        this._overview.insert_child_at_index?.(root, 0);

        this._root = root;
        this._liquidBox = liquidBox;
        this._sceneRoot = sceneRoot;
        this._sceneManager = sceneManager;
        this._effect = effect;

        this._applyAppearance();
    }

    _scanTargets(force = false) {
        if (!this._overview)
            return;

        const nowUs = GLib.get_monotonic_time();
        if (
            !force &&
            nowUs - this._lastScanUs < 120000
        ) {
            return;
        }
        this._lastScanUs = nowUs;

        const found = [];
        const walk = actor => {
            if (!actor)
                return;

            const name = actor.get_name?.() ?? '';
            if (name.startsWith('vliq-overview-search-'))
                return;

            if (actorClasses(actor).includes(TARGET_CLASS)) {
                found.push(actor);
                return;
            }

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };
        walk(this._overview);

        const next = new Set(found);
        for (const actor of this._targets) {
            if (!next.has(actor)) {
                try {
                    actor.remove_style_class_name?.(REGION_CLASS);
                } catch {}
            }
        }

        for (const actor of found) {
            try {
                if (!actorClasses(actor).includes(REGION_CLASS))
                    actor.add_style_class_name?.(REGION_CLASS);
            } catch {}
        }

        this._targets = found;
    }

    _visibleTargets() {
        const targets = [];

        for (const actor of this._targets) {
            if (
                !actor?.mapped ||
                !actor?.visible ||
                (actor.get_paint_opacity?.() ??
                    actor.opacity ??
                    255) <= 0
            ) {
                continue;
            }

            const rect =
                this._vendor.getTransformedRect(actor);
            if (!finiteRect(rect))
                continue;

            targets.push({actor, rect});
        }

        targets.sort((a, b) =>
            (a.rect[1] - b.rect[1]) ||
            (a.rect[0] - b.rect[0])
        );

        return targets;
    }

    _applyAppearance(
        state = this._appearance ?? this._readAppearance()
    ) {
        if (!this._effect || !state)
            return;

        this._appearance = state;

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
            // Shared role defaults remain valid.
        }

        applyVLIQGlassRole(
            this._effect,
            VLIQ_GLASS_ROLES.overviewSearchCard,
            {
                tintColor: [
                    (state.r ?? 255) / 255,
                    (state.g ?? 255) / 255,
                    (state.b ?? 255) / 255,
                ],
                tintStrength:
                    state.opacity ??
                    VLIQ_GLASS_ROLES.overviewSearchCard
                        .tintStrength,
                baseBlur: state.blur ?? 7,
                cornerRadius: DEFAULT_RADIUS,
                brightness,
                contrast,
                saturation,
                multiRegion: true,
            }
        );

        this._root?.queue_redraw?.();
    }

    updateAppearance(
        state = this._readAppearance()
    ) {
        this._appearance = state;
        this._applyAppearance(state);
        this._lastRegionKey = '';
    }

    _tick() {
        if (
            !this._enabled ||
            !this._overview ||
            !this._root ||
            !this._effect
        ) {
            return;
        }

        if (
            !this._overview.visible ||
            !this._overview.mapped ||
            !Main.overview?.visible ||
            !Main.overview
                ?.searchController
                ?.searchActive
        ) {
            if (this._root.visible)
                this._root.hide?.();
            return;
        }

        this._scanTargets(false);
        const visible = this._visibleTargets();

        if (!visible.length) {
            if (this._root.visible)
                this._root.hide?.();
            return;
        }

        const overviewRect =
            this._vendor.getTransformedRect(
                this._overview
            );
        if (!finiteRect(overviewRect))
            return;

        const [groupX, groupY, groupTW, groupTH] =
            overviewRect;
        const rootW = Math.max(
            1,
            this._overview.width ?? groupTW
        );
        const rootH = Math.max(
            1,
            this._overview.height ?? groupTH
        );
        const scaleX = Math.max(
            groupTW / rootW,
            0.001
        );
        const scaleY = Math.max(
            groupTH / rootH,
            0.001
        );

        if (
            this._lastRootW !== rootW ||
            this._lastRootH !== rootH
        ) {
            this._lastRootW = rootW;
            this._lastRootH = rootH;

            this._vendor.setSizeIfChanged(
                this._root,
                rootW,
                rootH
            );
            this._vendor.setSizeIfChanged(
                this._liquidBox,
                rootW,
                rootH
            );
            this._effect.setResolution?.(
                rootW,
                rootH
            );
        }

        // WindowCloneManager clones live in stage coordinates. Cancel the
        // overviewGroup transform so they align with the same screen pixels
        // represented by the local multi-region coordinates below.
        this._vendor.setSizeIfChanged(
            this._sceneRoot,
            global.stage.width,
            global.stage.height
        );

        const invX = 1 / scaleX;
        const invY = 1 / scaleY;
        if (
            this._sceneRoot.scale_x !== invX ||
            this._sceneRoot.scale_y !== invY
        ) {
            this._sceneRoot.set_scale(invX, invY);
        }
        this._vendor.setTranslationIfChanged(
            this._sceneRoot,
            -groupX / scaleX,
            -groupY / scaleY
        );

        const adapter =
            VLIQ_GLASS_ADAPTERS.overviewSearch;
        const pad =
            adapter.regionPadding ?? 20;
        const maxRegions =
            adapter.maxRegions ?? 16;
        const baseStrength = clamp(
            (this._appearance?.opacity ?? 0) *
                (adapter.tintScale ?? 2.2),
            0,
            adapter.tintMax ?? 0.075
        );

        const radii = [];
        const regions = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const {actor, rect} of visible) {
            const [absX, absY, width, height] = rect;
            minX = Math.min(minX, absX);
            minY = Math.min(minY, absY);
            maxX = Math.max(maxX, absX + width);
            maxY = Math.max(maxY, absY + height);

            if (regions.length >= maxRegions)
                continue;

            const localX =
                (absX - groupX) / scaleX;
            const localY =
                (absY - groupY) / scaleY;
            const localW = width / scaleX;
            const localH = height / scaleY;

            regions.push({
                x: localX - pad,
                y: localY - pad,
                w: localW + pad * 2,
                h: localH + pad * 2,
                tintR:
                    (this._appearance?.r ?? 255) / 255,
                tintG:
                    (this._appearance?.g ?? 255) / 255,
                tintB:
                    (this._appearance?.b ?? 255) / 255,
                baseStrength,
                response: 0,
            });

            radii.push(readRadius(actor));
        }

        let regionsChanged =
            this._lastRegionGeometry.length !==
            regions.length * 4;

        if (!regionsChanged) {
            let index = 0;
            for (const region of regions) {
                const x = Math.round(region.x);
                const y = Math.round(region.y);
                const w = Math.round(region.w);
                const h = Math.round(region.h);

                if (
                    this._lastRegionGeometry[index++] !== x ||
                    this._lastRegionGeometry[index++] !== y ||
                    this._lastRegionGeometry[index++] !== w ||
                    this._lastRegionGeometry[index++] !== h
                ) {
                    regionsChanged = true;
                    break;
                }
            }
        }

        if (regionsChanged) {
            const nextGeometry =
                new Array(regions.length * 4);
            let index = 0;
            for (const region of regions) {
                nextGeometry[index++] = Math.round(region.x);
                nextGeometry[index++] = Math.round(region.y);
                nextGeometry[index++] = Math.round(region.w);
                nextGeometry[index++] = Math.round(region.h);
            }
            this._lastRegionGeometry = nextGeometry;
            this._effect.setGlassRegions?.(regions);

            const cleanRadii =
                radii
                    .filter(Number.isFinite)
                    .sort((a, b) => a - b);
            if (cleanRadii.length) {
                const radius =
                    cleanRadii[
                        Math.floor(cleanRadii.length / 2)
                    ];
                this._effect.setCornerRadius?.(
                    clamp(radius, 10, 36)
                );
            }
        }

        const blur = Math.max(
            0,
            this._appearance?.blur ?? 0
        );
        const margin = clamp(
            Math.round(blur * 3 + 40),
            SCENE_MARGIN_MIN,
            SCENE_MARGIN_MAX
        );
        const captureRect = [
            minX - margin,
            minY - margin,
            (maxX - minX) + margin * 2,
            (maxY - minY) + margin * 2,
        ];

        const nowUs = GLib.get_monotonic_time();
        const sceneFps = Math.max(
            15,
            Math.min(
                adapter.sceneFpsCap ?? 20,
                this._appearance?.sceneFps ?? 30
            )
        );
        const sceneIntervalUs =
            1000000 / sceneFps;

        if (
            this._lastSceneSyncUs === 0 ||
            nowUs - this._lastSceneSyncUs >=
                sceneIntervalUs
        ) {
            // The background scene stays live at its usual FPS; capture
            // bounds only need to change when provider geometry moves.
            const previous =
                this._lastCaptureRect;
            if (
                !previous ||
                captureRect.some(
                    (value, index) =>
                        value !== previous[index]
                )
            ) {
                this._sceneManager?.setCullRect?.(
                    captureRect
                );
                this._sceneManager?.applyBgCloneClip?.(
                    captureRect
                );
                this._lastCaptureRect = captureRect;
            }
            this._sceneManager?.sync?.();
            this._lastSceneSyncUs = nowUs;
        }

        if (!this._root.visible)
            this._root.show?.();
    }

    cleanup() {
        if (!this._enabled)
            return;
        this._enabled = false;

        this._stopStageSync();

        for (const {object, id} of this._overviewSignals) {
            try {
                object?.disconnect?.(id);
            } catch {}
        }
        this._overviewSignals = [];

        for (const actor of this._targets) {
            try {
                actor.remove_style_class_name?.(
                    REGION_CLASS
                );
            } catch {}
        }
        this._targets = [];

        try {
            this._sceneManager?.destroy?.();
        } catch {}
        this._sceneManager = null;

        try {
            this._root?.destroy?.();
        } catch {}

        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._effect = null;
        this._overview = null;
        this._appearance = null;
        this._lastRegionKey = '';
        this._lastRegionGeometry = [];
        this._lastSceneSyncUs = 0;
        this._lastCaptureRect = null;

        console.log(
            '[VLIQ][OverviewSearchGlass] stopped'
        );
    }
}
