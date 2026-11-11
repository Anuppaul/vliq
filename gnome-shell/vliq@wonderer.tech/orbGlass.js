import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {frameDue} from './frameBudget.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    VLIQ_GLASS_ADAPTERS,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';

const ORB_FACE_CLASS = 'vliq-orb-face-v2';
const ORB_GLYPH_CLASS = 'vliq-orb-glyph-v2';
const APP_BUTTON_CLASS = 'vliq-app-button';
const PAD = 20;
const REGIONS_PER_BATCH = 16;
const MAX_GLASS_BATCHES = 4;
// Expanded All Apps uses a 24 FPS clone-scene cap; sample 30 FPS to
// preserve responsive hover while avoiding repeated 60/144 Hz actor scans.
const EXPANDED_REGION_FPS = 30;
// Deliberately larger than any Orb/app-button half extent. The shader
// clamps this per region, producing a true circle for square controls.
const SHARED_RADIUS = 128;
const TEXT_LIGHT_CLASS = 'vliq-shared-text-light';
const TEXT_DARK_CLASS = 'vliq-shared-text-dark';

function classesOf(actor) {
    return String(
        actor?.get_style_class_name?.() ??
        actor?.style_class ??
        ''
    ).split(/\s+/).filter(Boolean);
}

function finiteRect(rect) {
    return Array.isArray(rect) &&
        rect.length >= 4 &&
        rect.every(Number.isFinite) &&
        rect[2] > 1 &&
        rect[3] > 1;
}

function srgbToLinear(channel) {
    const n = channel / 255;
    return n <= 0.04045
        ? n / 12.92
        : Math.pow((n + 0.055) / 1.055, 2.4);
}

function luminance(r, g, b) {
    return (
        0.2126 * srgbToLinear(r) +
        0.7152 * srgbToLinear(g) +
        0.0722 * srgbToLinear(b)
    );
}

export class OrbGlassManager {
    constructor(params) {
        this._vendor = params.vendor;
        this._settings = params.settings;
        this._readAppearance = params.readAppearance;

        this._enabled = false;
        this._desktopLayer = null;
        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._effect = null;
        this._batches = [];
        this._appearance = null;

        this._orbFace = null;
        this._orbGlyph = null;
        this._buttons = new Set();
        this._stageId = 0;
        this._layerSignals = [];
        this._scanIdleId = 0;
        this._lastRegionKey = '';
        this._lastSceneSyncUs = 0;
        this._lastRegionPassUs = 0;
        this._expandedRegionsActive = false;
        this._regionMotionActive = false;
        this._dragActive = false;
        this._glyphSampleGeneration = 0;

        this._screenshot = null;
        this._samplePending = false;
        this._lastSampleUs = 0;
        this._glyphDark = null;
        this._glyphSampleDirty = true;
        this._glyphGeometryChangedUs = 0;
        this._lastOrbRectKey = '';
    }

    setup() {
        if (this._enabled)
            return;

        this._desktopLayer = Main.uiGroup
            ?.get_children?.()
            ?.find(actor =>
                actor.get_name?.() === 'vliq-layer'
            ) ?? null;

        if (!this._desktopLayer)
            throw new Error('VLIQ visual layer unavailable');

        this._enabled = true;
        this._appearance = this._readAppearance();
        this._createLayer();
        this._connectLayerSignals();
        this._scan();

        this._stageId = global.stage.connect(
            'before-update',
            () => this._tick()
        );

        console.log(
            '[VLIQ][OrbGlass] shared Orb/radial Liquid Glass active'
        );
    }

    _createLayer() {
        const root = new this._vendor.UnpickableActor({
            name: 'vliq-orb-glass-root',
            reactive: false,
        });
        root.set_no_layout?.(true);
        root.set_position(0, 0);
        root.set_size(global.stage.width, global.stage.height);
        root.hide();

        Main.uiGroup.insert_child_below(
            root,
            this._desktopLayer
        );

        this._root = root;
        this._batches = [];

        // Most Orb sessions need a single 16-region glass batch. Create
        // further full-screen shader/scene pairs only on demand, retaining
        // them for smooth paging once a large All Apps page has been opened.
        this._createBatch(0);

        const first = this._batches[0] ?? null;
        this._liquidBox = first?.liquidBox ?? null;
        this._sceneRoot = first?.sceneRoot ?? null;
        this._sceneManager = first?.sceneManager ?? null;
        this._effect = first?.effect ?? null;

        this._applyAppearance();
    }

    _createBatch(index) {
        if (!this._root)
            return null;

        const liquidBox = new this._vendor.UnpickableActor({
            name: `vliq-orb-glass-box-${index}`,
            reactive: false,
        });
        liquidBox.set_no_layout?.(true);
        liquidBox.set_position(0, 0);
        liquidBox.set_size(
            global.stage.width,
            global.stage.height
        );
        liquidBox.set_clip_to_allocation(true);
        liquidBox.hide?.();

        const sceneRoot = new this._vendor.UnpickableActor({
            name: `vliq-orb-glass-scene-${index}`,
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
                `vliq-orb-glass-scene-${index}`
            );

        const breaker = new this._vendor.UnpickableActor({
            name: `vliq-orb-glass-breaker-${index}`,
            reactive: false,
        });
        breaker.set_no_layout?.(true);
        breaker.set_size(1, 1);
        breaker.set_opacity(0);
        liquidBox.add_child(breaker);

        const effect = new this._vendor.LiquidEffect({
            extensionPath: this._vendor.root,
            settings: this._settings,
            owner: `vliq-orb-shared-${index}`,
        });
        effect.setPadding?.(PAD);
        effect.setIsDock?.(false);
        effect.setMultiRegionMode?.(true);
        effect.setShadowMaxRadius?.(0);
        liquidBox.add_effect(effect);

        this._root.add_child(liquidBox);

        const batch = {
            liquidBox,
            sceneRoot,
            sceneManager,
            effect,
            lastRegionKey: '',
            lastRegionGeometry: null,
            lastSceneSyncUs: 0,
            lastCullRect: null,
        };
        this._batches.push(batch);
        return batch;
    }

    _ensureBatchCount(count) {
        const wanted = Math.min(
            MAX_GLASS_BATCHES,
            Math.max(1, count)
        );
        if (this._batches.length >= wanted)
            return;

        const added = [];
        while (this._batches.length < wanted)
            added.push(this._createBatch(this._batches.length));

        // Initializing newly allocated shader batches must not re-upload
        // uniforms to the *already visible* Orb face material, which caused
        // a visible one-frame pulse on the first expanded menu open.
        this._applyAppearance(this._appearance, added);
    }

    _clearBatch(batch) {
        // Empty regions upload all fixed-size uniform arrays; do not repeat
        // that upload on every frame while a batch is already hidden.
        if (batch.liquidBox?.visible) {
            batch.effect?.setGlassRegions?.([]);
            batch.liquidBox.hide?.();
        }

        batch.lastRegionKey = '';
        batch.lastRegionGeometry = null;
        batch.lastSceneSyncUs = 0;
        batch.lastCullRect = null;
    }

    _applyAppearance(
        state = this._appearance ?? this._readAppearance(),
        targets = this._batches
    ) {
        if (!this._batches.length || !state)
            return;

        this._appearance = state;
        const role =
            VLIQ_GLASS_ROLES.orbCard;
        const adapter =
            VLIQ_GLASS_ADAPTERS.orb;

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
        } catch {}

        for (const batch of targets) {
            applyVLIQGlassRole(
                batch.effect,
                role,
                {
                    tintColor: [
                        (state.r ?? 255) / 255,
                        (state.g ?? 255) / 255,
                        (state.b ?? 255) / 255,
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
                    multiRegion:
                        adapter.multiRegion,
                }
            );

            batch.lastRegionKey = '';
            batch.lastRegionGeometry = null;
        }

        if (targets === this._batches) {
            // A user appearance change affects existing batches; creating
            // additional batches does not invalidate material already shown.
            this._lastRegionKey = '';
            this._lastRegionPassUs = 0;
            this._glyphSampleDirty = true;
            this._glyphGeometryChangedUs =
                GLib.get_monotonic_time();
            this._root?.queue_redraw?.();
        }
    }

    updateAppearance(
        state = this._readAppearance()
    ) {
        this._applyAppearance(state);
    }

    _connectLayerSignals() {
        if (!this._desktopLayer)
            return;

        const queueScan = () => this._queueScan();

        for (const signal of ['child-added', 'child-removed']) {
            try {
                this._layerSignals.push({
                    obj: this._desktopLayer,
                    id: this._desktopLayer.connect(
                        signal,
                        queueScan
                    ),
                });
            } catch {}
        }
    }

    _queueScan() {
        if (!this._enabled || this._scanIdleId)
            return;

        this._scanIdleId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._scanIdleId = 0;
                if (this._enabled)
                    this._scan();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _scan() {
        let orbFace = null;
        let orbGlyph = null;
        const buttons = new Set();

        const walk = actor => {
            if (!actor)
                return;

            // Preview glass is now a child of the native preview card.
            // Do not recursively walk the cloned wallpaper/windows inside
            // its renderer every time a hover preview opens. Only the real
            // Orb and app buttons belong in this region registry.
            const name = actor.get_name?.() ?? '';
            if (name.startsWith('vliq-shell-card-') ||
                name.startsWith('lg-'))
                return;

            const classes = classesOf(actor);
            if (classes.includes(ORB_FACE_CLASS))
                orbFace = actor;
            if (classes.includes(ORB_GLYPH_CLASS))
                orbGlyph = actor;
            if (classes.includes(APP_BUTTON_CLASS))
                buttons.add(actor);

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };

        walk(this._desktopLayer);

        if (orbFace !== this._orbFace) {
            this._orbFace = orbFace;
            this._lastOrbRectKey = '';
            this._glyphSampleDirty = true;
            this._glyphGeometryChangedUs =
                GLib.get_monotonic_time();
        }

        if (orbGlyph !== this._orbGlyph) {
            if (this._orbGlyph) {
                try {
                    this._orbGlyph.remove_style_class_name?.(
                        TEXT_LIGHT_CLASS
                    );
                    this._orbGlyph.remove_style_class_name?.(
                        TEXT_DARK_CLASS
                    );
                } catch {}
            }

            this._orbGlyph = orbGlyph;
            this._glyphDark = null;
            this._glyphSampleDirty = true;
            this._glyphGeometryChangedUs =
                GLib.get_monotonic_time();
        }

        this._buttons = buttons;
        this._lastRegionPassUs = 0;
        this._expandedRegionsActive = false;
        this._regionMotionActive = false;
        this._lastRegionKey = '';
        for (const batch of this._batches) {
            batch.lastRegionKey = '';
            batch.lastRegionGeometry = null;
        }
    }

    setDragActive(active) {
        const dragging = Boolean(active);
        if (this._dragActive === dragging)
            return;
        this._dragActive = dragging;
        this._glyphSampleGeneration++;

        // The native Orb moves in stage space; its glass renders separately.
        // Invalidate only capture culling on drag state changes. Every drag
        // frame is then tracked by the existing stage before-update hook.
        this._lastRegionPassUs = 0;
        for (const batch of this._batches)
            batch.lastCullRect = null;

        // Screenshotting during the pan can finish at an old location and
        // flip the glyph colour independently of the background material.
        if (!dragging) {
            this._glyphSampleDirty = true;
            this._glyphGeometryChangedUs = GLib.get_monotonic_time();
        }
        this._root?.queue_redraw?.();
    }

    _captureCullRect(minX, minY, maxX, maxY, width, height, index) {
        if (!this._dragActive || index !== 0)
            return [minX, minY, maxX - minX, maxY - minY];

        // Keep the wallpaper/window capture clip stable for small motions:
        // moving it by one pixel per pan event made its offscreen texture
        // lag the native icon and appear to jump vertically.
        const block = 256;
        const margin = 160;
        const x0 = Math.max(0, Math.floor((minX - margin) / block) * block);
        const y0 = Math.max(0, Math.floor((minY - margin) / block) * block);
        const x1 = Math.min(width, Math.ceil((maxX + margin) / block) * block);
        const y1 = Math.min(height, Math.ceil((maxY + margin) / block) * block);
        return [
            x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0),
        ];
    }

    _tick() {
        if (!this._enabled)
            return;

        this._syncRegions();
        this._maybeSampleGlyph();
    }

    _syncRegions() {
        if (
            !this._root ||
            !this._batches.length
        ) {
            return;
        }

        const width = global.stage.width;
        const height = global.stage.height;
        const adapter =
            VLIQ_GLASS_ADAPTERS.orb;
        const nowUs =
            GLib.get_monotonic_time();

        // Expanded pages may have 60+ app actors. GNOME's before-update
        // signal can run much faster than their 24 FPS Liquid Glass scene.
        // Skip the full geometry/hover scan only on an already-visible
        // expanded page, never on the small Orb or initial page reveal.
        if (this._expandedRegionsActive &&
            !this._regionMotionActive &&
            !frameDue(
                nowUs, this._lastRegionPassUs, EXPANDED_REGION_FPS
            ))
            return;
        this._lastRegionPassUs = nowUs;

        this._vendor.setSizeIfChanged(
            this._root,
            width,
            height
        );

        const targets = [];
        if (this._orbFace)
            targets.push(this._orbFace);
        for (const button of this._buttons)
            targets.push(button);

        const regions = [];
        let motionActive = false;

        for (const actor of targets) {
            if (
                !actor?.visible ||
                !actor?.mapped ||
                (
                    actor.get_paint_opacity?.() ??
                    actor.opacity ??
                    255
                ) <= 0
            ) {
                continue;
            }

            // Animated icons must be tracked on every compositor frame.
            // Skipping frames while the icon moves (translation/scale/opacity)
            // makes the background glass visibly jump between 30 Hz samples.
            // Only stationary, expanded pages use the 30 FPS scan cap.
            if (actor !== this._orbFace && (
                actor.get_transition?.('translation-x') ||
                actor.get_transition?.('translation-y') ||
                actor.get_transition?.('scale-x') ||
                actor.get_transition?.('scale-y') ||
                actor.get_transition?.('opacity')
            )) {
                motionActive = true;
            }

            const rect =
                this._vendor.getTransformedRect(
                    actor
                );
            if (!finiteRect(rect))
                continue;

            const [x, y, w, h] = rect;

            if (actor === this._orbFace) {
                const orbRectKey = [
                    Math.round(x),
                    Math.round(y),
                    Math.round(w),
                    Math.round(h),
                ].join(':');

                if (
                    orbRectKey !==
                    this._lastOrbRectKey
                ) {
                    this._lastOrbRectKey =
                        orbRectKey;
                    this._glyphSampleDirty = true;
                    this._glyphGeometryChangedUs =
                        nowUs;
                }
            }

            regions.push({
                x: x - PAD,
                y: y - PAD,
                w: w + PAD * 2,
                h: h + PAD * 2,
                tintR: 1.0,
                tintG: 1.0,
                tintB: 1.0,
                baseStrength: 0.0,
                response:
                    actor.get_hover?.()
                        ? (
                            adapter.hoverResponse ??
                            0.38
                        )
                        : 0.0,
            });
        }

        this._expandedRegionsActive = regions.length > REGIONS_PER_BATCH;
        this._regionMotionActive = motionActive;

        if (!regions.length) {
            for (const batch of this._batches)
                this._clearBatch(batch);

            this._lastRegionKey = '';
            this._lastSceneSyncUs = 0;
            if (this._root.visible)
                this._root.hide?.();
            return;
        }

        this._ensureBatchCount(
            Math.ceil(regions.length / REGIONS_PER_BATCH)
        );

        const configuredSceneFps =
            this._appearance?.sceneFps ?? 30;
        const sceneFps = Math.max(
            15,
            Math.min(
                adapter.sceneFpsCap ?? 24,
                configuredSceneFps
            )
        );
        const intervalUs =
            1000000 / sceneFps;

        for (
            let index = 0;
            index < this._batches.length;
            index++
        ) {
            const batch =
                this._batches[index];
            const start =
                index * REGIONS_PER_BATCH;
            const batchRegions =
                regions.slice(
                    start,
                    start +
                        REGIONS_PER_BATCH
                );

            if (!batchRegions.length) {
                this._clearBatch(batch);
                continue;
            }

            this._vendor.setSizeIfChanged(
                batch.liquidBox,
                width,
                height
            );
            this._vendor.setSizeIfChanged(
                batch.sceneRoot,
                width,
                height
            );

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (const region of batchRegions) {
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

            // Previously each compositor frame created a mapped array and
            // JSON-serialized every region, even on a stationary 63-app page.
            // Compare against the last numeric snapshot without allocating
            // that intermediate key; preserve the *same* rounded geometry
            // and exact hover-response semantics as the original key.
            const previousGeometry =
                batch.lastRegionGeometry;
            let geometryChanged =
                !previousGeometry ||
                previousGeometry.length !==
                    2 + batchRegions.length * 5 ||
                previousGeometry[0] !== width ||
                previousGeometry[1] !== height;

            if (!geometryChanged) {
                for (
                    let regionIndex = 0;
                    regionIndex < batchRegions.length;
                    regionIndex++
                ) {
                    const r = batchRegions[regionIndex];
                    const offset = 2 + regionIndex * 5;
                    if (
                        previousGeometry[offset] !==
                            Math.round(r.x) ||
                        previousGeometry[offset + 1] !==
                            Math.round(r.y) ||
                        previousGeometry[offset + 2] !==
                            Math.round(r.w) ||
                        previousGeometry[offset + 3] !==
                            Math.round(r.h) ||
                        previousGeometry[offset + 4] !==
                            r.response
                    ) {
                        geometryChanged = true;
                        break;
                    }
                }
            }

            if (geometryChanged) {
                const nextGeometry = [
                    width,
                    height,
                ];
                for (const r of batchRegions) {
                    nextGeometry.push(
                        Math.round(r.x),
                        Math.round(r.y),
                        Math.round(r.w),
                        Math.round(r.h),
                        r.response
                    );
                }
                batch.lastRegionGeometry =
                    nextGeometry;
                // Preserve the existing diagnostics key; serialization only
                // happens when a real region state transition requires it.
                batch.lastRegionKey =
                    JSON.stringify(nextGeometry);
                batch.effect
                    ?.setResolution?.(
                        width,
                        height
                    );
                batch.effect
                    ?.setCornerRadius?.(
                        SHARED_RADIUS
                    );
                batch.effect
                    ?.setGlassRegions?.(
                        batchRegions
                    );
            }

            const sceneDue =
                geometryChanged ||
                batch.lastSceneSyncUs === 0 ||
                nowUs -
                    batch.lastSceneSyncUs >=
                    intervalUs;

            if (sceneDue) {
                try {
                    const cullRect = this._captureCullRect(
                        minX, minY, maxX, maxY,
                        width, height, index
                    );
                    // Keep live window clones syncing, but avoid re-setting
                    // stationary capture bounds on every scene frame.
                    const previous =
                        batch.lastCullRect;
                    if (
                        !previous ||
                        cullRect.some(
                            (value, i) =>
                                value !== previous[i]
                        )
                    ) {
                        batch.sceneManager
                            ?.setCullRect?.(
                                cullRect
                            );
                        batch.sceneManager
                            ?.applyBgCloneClip?.(
                                cullRect
                            );
                        batch.lastCullRect =
                            cullRect;
                    }
                    batch.sceneManager
                        ?.sync?.();
                    batch.lastSceneSyncUs =
                        nowUs;
                } catch {}
            }

            if (!batch.liquidBox.visible)
                batch.liquidBox.show?.();
        }

        // Keep legacy debug mirrors useful for the first batch.
        this._lastRegionKey =
            this._batches[0]
                ?.lastRegionKey ?? '';
        this._lastSceneSyncUs =
            this._batches[0]
                ?.lastSceneSyncUs ?? 0;

        if (!this._root.visible)
            this._root.show?.();
    }

    _maybeSampleGlyph() {
        const adapter = VLIQ_GLASS_ADAPTERS.orb;

        if (
            !adapter.adaptiveText ||
            this._dragActive ||
            !this._orbFace ||
            !this._orbGlyph ||
            this._samplePending
        ) {
            return;
        }

        const nowUs = GLib.get_monotonic_time();
        const debounceUs =
            (adapter.adaptiveDebounceMs ?? 180) * 1000;
        const resampleUs =
            (adapter.adaptiveResampleMs ?? 4000) * 1000;
        const fallbackDue =
            this._lastSampleUs === 0 ||
            nowUs - this._lastSampleUs >= resampleUs;

        if (!this._glyphSampleDirty && !fallbackDue)
            return;

        if (
            this._glyphSampleDirty &&
            this._glyphGeometryChangedUs > 0 &&
            nowUs - this._glyphGeometryChangedUs < debounceUs
        ) {
            return;
        }

        const rect = this._vendor.getTransformedRect(this._orbFace);
        if (!finiteRect(rect))
            return;

        this._lastSampleUs = nowUs;
        this._samplePending = true;
        this._glyphSampleDirty = false;
        const generation = this._glyphSampleGeneration;

        const [x, y, w, h] = rect;
        const left = Math.max(0, Math.floor(x + w * 0.15));
        const top = Math.max(0, Math.floor(y + h * 0.15));
        const right = Math.min(
            global.stage.width,
            Math.ceil(x + w * 0.85)
        );
        const bottom = Math.min(
            global.stage.height,
            Math.ceil(y + h * 0.85)
        );

        if (right <= left || bottom <= top) {
            this._samplePending = false;
            return;
        }

        this._screenshot ??= new Shell.Screenshot();
        const stream = Gio.MemoryOutputStream.new_resizable();

        try {
            this._screenshot.screenshot_area(
                left,
                top,
                right - left,
                bottom - top,
                stream,
                (object, result) => {
                    try {
                        const [ok] =
                            object.screenshot_area_finish(result);
                        stream.close(null);
                        if (!ok)
                            return;

                        const bytes = stream.steal_as_bytes();
                        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(
                            Gio.MemoryInputStream.new_from_bytes(bytes),
                            null
                        );
                        if (!pixbuf)
                            return;

                        const data = pixbuf.get_pixels();
                        const stride = pixbuf.get_rowstride();
                        const channels = pixbuf.get_n_channels();
                        const pw = pixbuf.get_width();
                        const ph = pixbuf.get_height();

                        let sum = 0;
                        let count = 0;
                        const step = Math.max(
                            1,
                            Math.floor(Math.min(pw, ph) / 12)
                        );

                        for (let py = 0; py < ph; py += step) {
                            const row = py * stride;
                            for (let px = 0; px < pw; px += step) {
                                const off = row + px * channels;
                                sum += luminance(
                                    data[off] ?? 0,
                                    data[off + 1] ?? 0,
                                    data[off + 2] ?? 0
                                );
                                count++;
                            }
                        }

                        if (!count)
                            return;

                        if (this._dragActive ||
                            generation !== this._glyphSampleGeneration ||
                            !this._enabled)
                            return;
                        const useDark = sum / count > 0.48;
                        if (useDark === this._glyphDark)
                            return;

                        this._glyphDark = useDark;

                        this._orbGlyph.remove_style_class_name?.(
                            TEXT_LIGHT_CLASS
                        );
                        this._orbGlyph.remove_style_class_name?.(
                            TEXT_DARK_CLASS
                        );
                        this._orbGlyph.add_style_class_name?.(
                            useDark
                                ? TEXT_DARK_CLASS
                                : TEXT_LIGHT_CLASS
                        );
                    } catch {}
                    finally {
                        this._samplePending = false;
                    }
                }
            );
        } catch {
            try {
                stream.close(null);
            } catch {}
            this._samplePending = false;
        }
    }

    cleanup() {
        if (!this._enabled)
            return;

        this._enabled = false;

        if (this._stageId) {
            try {
                global.stage.disconnect(this._stageId);
            } catch {}
            this._stageId = 0;
        }

        if (this._scanIdleId) {
            try {
                GLib.source_remove(this._scanIdleId);
            } catch {}
            this._scanIdleId = 0;
        }

        for (const signal of this._layerSignals) {
            try {
                signal.obj.disconnect(signal.id);
            } catch {}
        }
        this._layerSignals = [];

        if (this._orbGlyph) {
            try {
                this._orbGlyph.remove_style_class_name?.(
                    TEXT_LIGHT_CLASS
                );
                this._orbGlyph.remove_style_class_name?.(
                    TEXT_DARK_CLASS
                );
            } catch {}
        }

        for (const batch of this._batches) {
            try {
                batch.sceneManager?.destroy?.();
            } catch {}
        }

        try {
            this._root?.destroy?.();
        } catch {}

        this._desktopLayer = null;
        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._effect = null;
        this._batches = [];
        this._orbFace = null;
        this._orbGlyph = null;
        this._buttons.clear();
        this._screenshot = null;
        this._samplePending = false;
        this._lastRegionKey = '';
        this._lastSceneSyncUs = 0;
        this._lastOrbRectKey = '';
        this._glyphSampleDirty = true;
        this._glyphGeometryChangedUs = 0;

        console.log('[VLIQ][OrbGlass] stopped');
    }
}
