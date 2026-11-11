import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    GLASS_TEXT_PALETTE,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';

const CLOSE_TARGET_CLASS = 'window-close';
const ICON_TARGET_CLASS = 'window-icon';
const CAPTION_TARGET_CLASS = 'window-caption';
const CLOSE_ACTIVE_CLASS = 'vliq-window-close-shared-glass';
const ICON_ACTIVE_CLASS = 'vliq-window-icon-shared-glass';
const CAPTION_TEXT_LIGHT_CLASS = 'vliq-window-caption-text-light';
const CAPTION_TEXT_DARK_CLASS = 'vliq-window-caption-text-dark';
const PAD = 20;
const MAX_REGIONS = 16;
const SHARED_RADIUS = 24;
const ICON_BADGE_SIZE = 48;
const ICON_VISUAL_SIZE = 40;
const SCAN_INTERVAL_US = 180000;
const SCAN_FALLBACK_INTERVAL_US = 1200000;
const CAPTION_SAMPLE_INTERVAL_US = 650000;
const CAPTION_SAMPLE_GRID = 18;
const CAPTION_SWITCH_ADVANTAGE = 1.18;
const CAPTION_MIN_READABLE_CONTRAST = 4.5;
const CAPTION_LIGHT_TEXT = GLASS_TEXT_PALETTE.light;
const CAPTION_DARK_TEXT = GLASS_TEXT_PALETTE.dark;

function classesOf(actor) {
    return String(
        actor?.get_style_class_name?.() ??
        actor?.style_class ??
        ''
    ).split(/\s+/).filter(Boolean);
}

function finiteRect(rect) {
    return (
        Array.isArray(rect) &&
        rect.length >= 4 &&
        rect.every(Number.isFinite) &&
        rect[2] > 1 &&
        rect[3] > 1
    );
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function srgbToLinear(channel) {
    const n = channel / 255;
    return n <= 0.04045
        ? n / 12.92
        : Math.pow((n + 0.055) / 1.055, 2.4);
}

function rgbLuminance(r, g, b) {
    return (
        0.2126 * srgbToLinear(r) +
        0.7152 * srgbToLinear(g) +
        0.0722 * srgbToLinear(b)
    );
}

function hexLuminance(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return rgbLuminance(
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    );
}

function trimmedMean(values, trimRatio = 0.30) {
    if (!values.length)
        return null;

    const sorted = values.slice().sort((a, b) => a - b);
    const trim = Math.min(
        Math.floor(sorted.length * trimRatio),
        Math.floor((sorted.length - 1) / 2)
    );
    const start = trim;
    const end = sorted.length - trim;

    let sum = 0;
    for (let i = start; i < end; i++)
        sum += sorted[i];

    return sum / Math.max(1, end - start);
}

function contrastRatio(a, b) {
    return (
        (Math.max(a, b) + 0.05) /
        (Math.min(a, b) + 0.05)
    );
}

const CAPTION_LIGHT_LUMA =
    hexLuminance(CAPTION_LIGHT_TEXT);
const CAPTION_DARK_LUMA =
    hexLuminance(CAPTION_DARK_TEXT);

export class OverviewCloseGlassManager {
    constructor(params) {
        this._vendor = params.vendor;
        this._settings = params.settings;
        this._readAppearance = params.readAppearance;

        this._overview = null;
        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._iconLayer = null;
        this._wallpaper = null;
        this._effect = null;

        this._appearance = null;
        this._targets = new Map();
        this._captions = new Map();
        this._captionScreenshot = null;
        this._captionSamplePending = false;
        this._lastCaptionSampleUs = 0;
        this._captionGeneration = 0;
        this._stageId = 0;
        this._overviewSignals = [];
        this._lastScanUs = 0;
        this._scanDirty = true;
        this._watchedActors = new Map();
        this._treeWatchReady = false;
        this._lastRegionKey = '';
        this._lastRegionGeometry = [];
        this._enabled = false;
    }

    setup() {
        if (this._enabled)
            return;

        const overview =
            Main.layoutManager.overviewGroup;
        if (!overview)
            throw new Error('GNOME overviewGroup unavailable');

        this._enabled = true;
        this._overview = overview;
        this._appearance = this._readAppearance();

        this._createLayer();

        // Native Overview actors are only watched/scanned while the window
        // picker is active. No full-tree walk at extension startup.
        this._setupOverviewFrameLoop();

        console.log(
            '[VLIQ][OverviewCloseGlass] shared window chrome glass active'
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
            this._stopTreeWatch();
        };

        const sync = () => {
            const appGridActive =
                Boolean(
                    Main.overview
                        ?.dash
                        ?.showAppsButton
                        ?.checked
                );
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
                !appGridActive &&
                !searchActive
            ) {
                if (!this._stageId) {
                    this._startTreeWatch();
                    this._scan(true);
                }
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
            const showAppsButton =
                Main.overview
                    ?.dash
                    ?.showAppsButton;
            if (showAppsButton) {
                this._overviewSignals.push({
                    object: showAppsButton,
                    id: showAppsButton.connect(
                        'notify::checked',
                        sync
                    ),
                });
            }
        } catch {}

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

    _createLayer() {
        const root = new this._vendor.UnpickableActor({
            name: 'vliq-window-close-glass-root',
            reactive: false,
        });
        root.set_no_layout?.(true);
        root.set_position(0, 0);
        root.set_size(1, 1);
        root.hide();

        const liquidBox = new this._vendor.UnpickableActor({
            name: 'vliq-window-close-liquid-box',
            reactive: false,
        });
        liquidBox.set_no_layout?.(true);
        liquidBox.set_position(0, 0);
        liquidBox.set_size(1, 1);
        liquidBox.set_clip_to_allocation(true);
        root.add_child(liquidBox);

        const sceneRoot = new this._vendor.UnpickableActor({
            name: 'vliq-window-close-scene',
            reactive: false,
        });
        sceneRoot.set_no_layout?.(true);
        sceneRoot.set_position(0, 0);
        sceneRoot.set_size(1, 1);
        liquidBox.add_child(sceneRoot);

        const wallpaper =
            this._vendor.createBackgroundMirror?.(
                'vliq-window-close-wallpaper'
            ) ?? null;
        if (wallpaper) {
            wallpaper.set_no_layout?.(true);
            wallpaper.set_position?.(0, 0);
            sceneRoot.add_child(wallpaper);
        }

        const breaker = new this._vendor.UnpickableActor({
            name: 'vliq-window-close-breaker',
            reactive: false,
        });
        breaker.set_no_layout?.(true);
        breaker.set_size(1, 1);
        breaker.set_opacity(0);
        liquidBox.add_child(breaker);

        const effect = new this._vendor.LiquidEffect({
            extensionPath: this._vendor.root,
            settings: this._settings,
            owner: 'vliq-overview-window-close',
        });
        effect.setPadding?.(PAD);
        effect.setIsDock?.(false);
        effect.setMultiRegionMode?.(true);
        effect.setShadowMaxRadius?.(0);
        liquidBox.add_effect(effect);

        const iconLayer = new this._vendor.UnpickableActor({
            name: 'vliq-window-close-icon-layer',
            reactive: false,
        });
        iconLayer.set_no_layout?.(true);
        iconLayer.set_position(0, 0);
        iconLayer.set_size(1, 1);
        root.add_child(iconLayer);

        // The layer must sit ABOVE WindowPreview's own offscreen-composited
        // subtree; otherwise the glass gets flattened into the preview and is
        // visually lost. UnpickableActor keeps all native click/hover input on
        // the original .window-close buttons below.
        this._overview.add_child(root);

        this._root = root;
        this._liquidBox = liquidBox;
        this._sceneRoot = sceneRoot;
        this._iconLayer = iconLayer;
        this._wallpaper = wallpaper;
        this._effect = effect;

        this._applyAppearance();
    }

    _applyAppearance(
        state = this._appearance ?? this._readAppearance()
    ) {
        if (!this._effect || !state)
            return;

        this._appearance = state;
        const role = VLIQ_GLASS_ROLES.shellCard;

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
            // Shared material defaults are valid.
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
                    state.opacity ?? role.tintStrength,
                baseBlur: state.blur ?? 7,
                cornerRadius: 24,
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
        // The shared renderer normally hides native app icons and draws
        // sharp clones over Liquid badges. Milky has no shader: restore
        // the ORIGINAL native icons before hiding the clone layer.
        for (const [actor, entry] of this._targets) {
            if (entry.kind === 'icon') {
                try {
                    actor.opacity = state?.milky
                        ? (entry.nativeOpacity ?? 255)
                        : 0;
                } catch {}
            }
        }
        if (state?.milky)
            this._root?.hide?.();
        else
            this._applyAppearance(state);
        this._lastRegionKey = '';
    }

    _ignoreTreeNode(actor) {
        if (!actor || actor === this._root)
            return true;

        // Renderer/clone subtrees are not native Overview controls. Do not
        // count their internal mutations as reasons to rebuild the registry.
        const name = actor.get_name?.() ?? '';
        return name.startsWith('vliq-') ||
            name.startsWith('lg-');
    }

    _startTreeWatch() {
        if (!this._enabled || !this._overview ||
            this._watchedActors.size > 0)
            return;

        this._watchTreeNode(this._overview);
        const rootEntry = this._watchedActors.get(this._overview);
        this._treeWatchReady = Boolean(
            rootEntry?.added && rootEntry?.removed
        );
        this._scanDirty = true;
    }

    _watchTreeNode(actor) {
        if (
            !this._enabled ||
            this._ignoreTreeNode(actor) ||
            this._watchedActors.has(actor)
        ) {
            return;
        }

        const entry = {added: 0, removed: 0, destroyed: 0};
        this._watchedActors.set(actor, entry);

        try {
            entry.added = actor.connect('child-added',
                (_parent, child) => {
                    if (this._ignoreTreeNode(child))
                        return;
                    this._scanDirty = true;
                    this._watchTreeNode(child);
                });
        } catch {}

        try {
            entry.removed = actor.connect('child-removed',
                (_parent, child) => {
                    if (this._ignoreTreeNode(child))
                        return;
                    this._scanDirty = true;
                    this._unwatchTreeNode(child);
                });
        } catch {}

        try {
            entry.destroyed = actor.connect('destroy', () => {
                this._scanDirty = true;
                this._unwatchTreeNode(actor);
            });
        } catch {}

        for (const child of actor.get_children?.() ?? [])
            this._watchTreeNode(child);
    }

    _unwatchTreeNode(actor) {
        if (!actor || !this._watchedActors.has(actor))
            return;

        for (const child of actor.get_children?.() ?? [])
            this._unwatchTreeNode(child);

        const entry = this._watchedActors.get(actor);
        this._watchedActors.delete(actor);
        for (const id of [
            entry.added, entry.removed, entry.destroyed,
        ]) {
            if (!id)
                continue;
            try {
                actor.disconnect(id);
            } catch {}
        }
    }

    _stopTreeWatch() {
        // Release all native actor subscriptions when Overview is hidden.
        // This avoids retaining its subtree for the rest of the session.
        for (const [actor, entry] of this._watchedActors) {
            for (const id of [
                entry.added, entry.removed, entry.destroyed,
            ]) {
                if (!id)
                    continue;
                try {
                    actor.disconnect(id);
                } catch {}
            }
        }
        this._watchedActors.clear();
        this._treeWatchReady = false;
        this._scanDirty = true;
        this._lastScanUs = 0;
    }

    _scan(force = false) {
        if (!this._overview)
            return;

        const nowUs = GLib.get_monotonic_time();
        const scanInterval = this._treeWatchReady
            ? SCAN_FALLBACK_INTERVAL_US
            : SCAN_INTERVAL_US;
        if (
            !force &&
            !this._scanDirty &&
            nowUs - this._lastScanUs < scanInterval
        ) {
            return;
        }
        this._lastScanUs = nowUs;
        this._scanDirty = false;

        const found = new Set();
        const foundCaptions = new Set();
        const walk = actor => {
            if (!actor || actor === this._root)
                return;

            const actorClasses = classesOf(actor);

            if (actorClasses.includes(CAPTION_TARGET_CLASS)) {
                foundCaptions.add(actor);
                return;
            }

            if (
                actorClasses.includes(CLOSE_TARGET_CLASS) ||
                actorClasses.includes(ICON_TARGET_CLASS)
            ) {
                found.add(actor);
                return;
            }

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };
        walk(this._overview);

        for (const [actor, entry] of this._targets) {
            if (found.has(actor))
                continue;

            try {
                actor.remove_style_class_name?.(
                    entry.kind === 'icon'
                        ? ICON_ACTIVE_CLASS
                        : CLOSE_ACTIVE_CLASS
                );
            } catch {}
            if (entry.kind === 'icon') {
                try {
                    actor.opacity =
                        entry.nativeOpacity ?? 255;
                } catch {}
            }
            try {
                entry.clone?.destroy?.();
            } catch {}
            this._targets.delete(actor);
        }

        for (const actor of found) {
            if (this._targets.has(actor))
                continue;

            const kind =
                classesOf(actor).includes(ICON_TARGET_CLASS)
                    ? 'icon'
                    : 'close';

            let clone = null;
            try {
                clone = new Clutter.Clone({
                    source: actor,
                    reactive: false,
                });
                clone.set_name?.(
                    kind === 'icon'
                        ? 'vliq-window-app-icon-clone'
                        : 'vliq-window-close-icon-clone'
                );
                clone.set_no_layout?.(true);
                clone.remove_transition?.('position');
                clone.remove_transition?.('size');
                clone.remove_transition?.('scale-x');
                clone.remove_transition?.('scale-y');
                clone.set_pivot_point?.(0, 0);
                clone.set_scale?.(1, 1);
                this._iconLayer.add_child(clone);
            } catch {
                clone = null;
            }

            try {
                actor.add_style_class_name?.(
                    kind === 'icon'
                        ? ICON_ACTIVE_CLASS
                        : CLOSE_ACTIVE_CLASS
                );
            } catch {}

            const nativeOpacity =
                actor.opacity ?? 255;

            if (kind === 'icon' && !this._appearance?.milky) {
                try {
                    actor.opacity = 0;
                } catch {}
            }

            this._targets.set(actor, {
                clone,
                kind,
                nativeOpacity,
            });
        }

        for (const [actor, state] of this._captions) {
            if (foundCaptions.has(actor))
                continue;

            try {
                actor.remove_style_class_name?.(
                    CAPTION_TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    CAPTION_TEXT_DARK_CLASS
                );
            } catch {}
            try {
                actor.set_style?.(
                    state.originalStyle ?? null
                );
            } catch {}
            this._captions.delete(actor);
        }

        for (const actor of foundCaptions) {
            if (this._captions.has(actor))
                continue;

            this._captions.set(actor, {
                useDarkText: null,
                originalStyle:
                    actor.get_style?.() ??
                    actor.style ??
                    null,
            });
        }
    }

    _visibleCaptions() {
        const result = [];

        for (const actor of this._captions.keys()) {
            if (
                !actor?.visible ||
                !actor?.mapped ||
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

            result.push({actor, rect});
        }

        return result;
    }

    _captureCaptionFrame(rect) {
        if (!finiteRect(rect))
            return Promise.resolve(null);

        const [x, y, width, height] = rect;
        const left = Math.max(0, Math.floor(x));
        const top = Math.max(0, Math.floor(y));
        const right = Math.min(
            global.stage.width,
            Math.ceil(x + width)
        );
        const bottom = Math.min(
            global.stage.height,
            Math.ceil(y + height)
        );

        if (right <= left || bottom <= top)
            return Promise.resolve(null);

        if (!this._captionScreenshot)
            this._captionScreenshot = new Shell.Screenshot();

        return new Promise(resolve => {
            let stream = null;

            try {
                stream = Gio.MemoryOutputStream.new_resizable();
                this._captionScreenshot.screenshot_area(
                    left,
                    top,
                    right - left,
                    bottom - top,
                    stream,
                    (object, result) => {
                        try {
                            if (!object)
                                throw new Error(
                                    'null screenshot object'
                                );

                            const [ok] =
                                object.screenshot_area_finish(
                                    result
                                );
                            stream.close(null);

                            if (!ok) {
                                resolve(null);
                                return;
                            }

                            const bytes = stream.steal_as_bytes();
                            const pixbuf =
                                GdkPixbuf.Pixbuf.new_from_stream(
                                    Gio.MemoryInputStream
                                        .new_from_bytes(bytes),
                                    null
                                );

                            if (!pixbuf) {
                                resolve(null);
                                return;
                            }

                            resolve({
                                x: left,
                                y: top,
                                width: pixbuf.get_width(),
                                height: pixbuf.get_height(),
                                stride: pixbuf.get_rowstride(),
                                channels: pixbuf.get_n_channels(),
                                data: pixbuf.get_pixels(),
                            });
                        } catch {
                            try {
                                stream?.close?.(null);
                            } catch {}
                            resolve(null);
                        }
                    }
                );
            } catch {
                try {
                    stream?.close?.(null);
                } catch {}
                resolve(null);
            }
        });
    }

    _captionLuminance(frame, rect) {
        if (!frame || !finiteRect(rect))
            return null;

        let [x, y, width, height] = rect;

        const insetX = Math.min(8, width * 0.06);
        const insetY = Math.min(5, height * 0.14);
        x += insetX;
        y += insetY;
        width -= insetX * 2;
        height -= insetY * 2;

        const left = clampNumber(
            Math.floor(x - frame.x),
            0,
            frame.width - 1
        );
        const top = clampNumber(
            Math.floor(y - frame.y),
            0,
            frame.height - 1
        );
        const right = clampNumber(
            Math.ceil(x + width - frame.x),
            left + 1,
            frame.width
        );
        const bottom = clampNumber(
            Math.ceil(y + height - frame.y),
            top + 1,
            frame.height
        );

        if (right <= left || bottom <= top)
            return null;

        const sampleWidth = right - left;
        const sampleHeight = bottom - top;
        const step = Math.max(
            1,
            Math.floor(
                Math.min(sampleWidth, sampleHeight) /
                CAPTION_SAMPLE_GRID
            )
        );

        const values = [];
        const {data, stride, channels} = frame;

        for (let py = top; py < bottom; py += step) {
            const row = py * stride;

            for (let px = left; px < right; px += step) {
                const offset = row + px * channels;
                let r = data[offset] ?? 0;
                let g = data[offset + 1] ?? 0;
                let b = data[offset + 2] ?? 0;

                if (channels >= 4) {
                    const alpha = data[offset + 3] ?? 255;
                    if (alpha > 0 && alpha < 255) {
                        const inv = 255 / alpha;
                        r = clampNumber(
                            Math.round(r * inv),
                            0,
                            255
                        );
                        g = clampNumber(
                            Math.round(g * inv),
                            0,
                            255
                        );
                        b = clampNumber(
                            Math.round(b * inv),
                            0,
                            255
                        );
                    }
                }

                values.push(
                    rgbLuminance(r, g, b)
                );
            }
        }

        return trimmedMean(values, 0.30);
    }

    _chooseCaptionDarkText(actor, luminance) {
        if (!Number.isFinite(luminance))
            return null;

        const lightContrast = contrastRatio(
            luminance,
            CAPTION_LIGHT_LUMA
        );
        const darkContrast = contrastRatio(
            luminance,
            CAPTION_DARK_LUMA
        );

        const state = this._captions.get(actor);
        const previous = state?.useDarkText ?? null;

        if (previous === null)
            return darkContrast > lightContrast;

        const current =
            previous ? darkContrast : lightContrast;
        const alternative =
            previous ? lightContrast : darkContrast;

        if (
            current < CAPTION_MIN_READABLE_CONTRAST &&
            alternative >= CAPTION_MIN_READABLE_CONTRAST
        ) {
            return !previous;
        }

        if (
            alternative >
            current * CAPTION_SWITCH_ADVANTAGE
        ) {
            return !previous;
        }

        return previous;
    }

    _applyCaptionPolarity(actor, useDarkText) {
        if (!actor || useDarkText === null)
            return;

        const state = this._captions.get(actor);
        if (!state)
            return;

        const color = useDarkText
            ? CAPTION_DARK_TEXT
            : CAPTION_LIGHT_TEXT;

        if (state.useDarkText !== useDarkText) {
            try {
                actor.remove_style_class_name?.(
                    CAPTION_TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    CAPTION_TEXT_DARK_CLASS
                );
                actor.add_style_class_name?.(
                    useDarkText
                        ? CAPTION_TEXT_DARK_CLASS
                        : CAPTION_TEXT_LIGHT_CLASS
                );
            } catch {}

            state.useDarkText = useDarkText;
        }

        // Inline color wins over Yaru/tooltip/accent foreground rules. This is
        // intentional: adaptive polarity must only ever be near-black/near-white.
        try {
            const desiredStyle =
                'color: ' + color + ';';
            const currentStyle =
                actor.get_style?.() ??
                actor.style ??
                null;

            // Keep foreground adaptive without re-invalidating the GNOME
            // theme when a caption sample confirms the same color.
            if (currentStyle !== desiredStyle)
                actor.set_style?.(desiredStyle);
        } catch {}
    }

    async _sampleCaptionPolarity(generation, visible) {
        if (
            !this._enabled ||
            generation !== this._captionGeneration ||
            !Main.overview?.visible
        ) {
            return;
        }

        // Reuse the rectangles collected by the due-time sampler. Calling
        // _visibleCaptions() here again doubles transformed-geometry work.
        if (!visible.length)
            return;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const {rect} of visible) {
            minX = Math.min(minX, rect[0]);
            minY = Math.min(minY, rect[1]);
            maxX = Math.max(maxX, rect[0] + rect[2]);
            maxY = Math.max(maxY, rect[1] + rect[3]);
        }

        const frame = await this._captureCaptionFrame([
            minX,
            minY,
            maxX - minX,
            maxY - minY,
        ]);

        if (
            !frame ||
            !this._enabled ||
            generation !== this._captionGeneration
        ) {
            return;
        }

        for (const {actor, rect} of visible) {
            const luminance =
                this._captionLuminance(frame, rect);
            const useDarkText =
                this._chooseCaptionDarkText(
                    actor,
                    luminance
                );
            this._applyCaptionPolarity(
                actor,
                useDarkText
            );
        }
    }

    _maybeSampleCaptions() {
        const nowUs = GLib.get_monotonic_time();
        if (
            this._captionSamplePending ||
            (
                this._lastCaptionSampleUs > 0 &&
                nowUs - this._lastCaptionSampleUs <
                    CAPTION_SAMPLE_INTERVAL_US
            )
        ) {
            return;
        }

        // Geometry traversal is only needed when an actual sample is due.
        const visible = this._visibleCaptions();
        if (!visible.length) {
            this._lastCaptionSampleUs = nowUs;
            return;
        }

        this._captionSamplePending = true;
        this._lastCaptionSampleUs = nowUs;
        const generation = ++this._captionGeneration;

        this._sampleCaptionPolarity(generation, visible)
            .catch(() => {})
            .finally(() => {
                if (generation === this._captionGeneration)
                    this._captionSamplePending = false;
            });
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
        if (this._appearance?.milky) {
            // Keep native Overview controls and window icons clickable;
            // do not capture their backdrop or composite a glass layer.
            this._root.hide?.();
            this._scan(false);
            return;
        }

        const appGridActive =
            Boolean(
                Main.overview
                    ?.dash
                    ?.showAppsButton
                    ?.checked
            );
        const searchActive =
            Boolean(
                Main.overview
                    ?.searchController
                    ?.searchActive
            );

        if (
            !this._overview.visible ||
            !this._overview.mapped ||
            !Main.overview?.visible ||
            appGridActive ||
            searchActive
        ) {
            if (this._root.visible)
                this._root.hide?.();
            return;
        }

        this._scan(false);
        this._maybeSampleCaptions();

        const groupRect =
            this._vendor.getTransformedRect(
                this._overview
            );
        if (!finiteRect(groupRect))
            return;

        const [groupX, groupY, groupTW, groupTH] =
            groupRect;
        const rootW = Math.max(
            1,
            this._overview.width ?? groupTW
        );
        const rootH = Math.max(
            1,
            this._overview.height ?? groupTH
        );
        const scaleX = Math.max(groupTW / rootW, 0.001);
        const scaleY = Math.max(groupTH / rootH, 0.001);

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
        this._vendor.setSizeIfChanged(
            this._iconLayer,
            rootW,
            rootH
        );

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

        if (this._wallpaper) {
            this._vendor.setPositionIfChanged?.(
                this._wallpaper,
                0,
                0
            );
            this._vendor.setSizeIfChanged?.(
                this._wallpaper,
                global.stage.width,
                global.stage.height
            );
        }

        const regions = [];

        for (const [actor, entry] of this._targets) {
            const visible = Boolean(
                actor?.visible &&
                actor?.mapped &&
                (
                    entry.kind === 'icon' ||
                    (actor.get_paint_opacity?.() ??
                        actor.opacity ??
                        255) > 0
                )
            );

            if (!visible) {
                entry.clone?.hide?.();
                continue;
            }

            const rect =
                this._vendor.getTransformedRect(actor);
            if (!finiteRect(rect)) {
                entry.clone?.hide?.();
                continue;
            }

            const [absX, absY, width, height] = rect;
            const localX = (absX - groupX) / scaleX;
            const localY = (absY - groupY) / scaleY;
            const localW = width / scaleX;
            const localH = height / scaleY;

            let glassX = localX;
            let glassY = localY;
            let glassW = localW;
            let glassH = localH;

            if (entry.kind === 'icon') {
                const badgeSize = Math.min(
                    ICON_BADGE_SIZE,
                    Math.max(2, Math.min(localW, localH))
                );
                glassW = badgeSize;
                glassH = badgeSize;
                glassX =
                    localX + (localW - badgeSize) / 2;
                glassY =
                    localY + (localH - badgeSize) / 2;
            }

            regions.push({
                x: glassX - PAD,
                y: glassY - PAD,
                w: glassW + PAD * 2,
                h: glassH + PAD * 2,
                tintR: 1.0,
                tintG: 1.0,
                tintB: 1.0,
                baseStrength:
                    entry.kind === 'icon'
                        ? 0.026
                        : 0.0,
                response: 0.0,
            });

            if (entry.clone) {
                if (entry.kind === 'icon') {
                    const visualSize = Math.min(
                        ICON_VISUAL_SIZE,
                        Math.max(2, Math.min(localW, localH))
                    );
                    this._vendor.setPositionIfChanged(
                        entry.clone,
                        localX + (localW - visualSize) / 2,
                        localY + (localH - visualSize) / 2
                    );
                    this._vendor.setSizeIfChanged(
                        entry.clone,
                        visualSize,
                        visualSize
                    );
                    const cloneOpacity =
                        entry.nativeOpacity ?? 255;
                    if (entry.clone.opacity !== cloneOpacity)
                        entry.clone.opacity = cloneOpacity;
                } else {
                    this._vendor.setPositionIfChanged(
                        entry.clone,
                        localX,
                        localY
                    );
                    this._vendor.setSizeIfChanged(
                        entry.clone,
                        localW,
                        localH
                    );
                    const cloneOpacity =
                        actor.get_paint_opacity?.() ??
                        actor.opacity ??
                        255;
                    if (entry.clone.opacity !== cloneOpacity)
                        entry.clone.opacity = cloneOpacity;
                }

                if (!entry.clone.visible)
                    entry.clone.show?.();
            }

            if (regions.length >= MAX_REGIONS)
                break;
        }

        if (!regions.length) {
            // Empty shader uniforms need to be sent only once per transition.
            // Clear the geometry cache too so a newly revealed button uploads
            // its regions even if its rectangle is unchanged.
            if (this._lastRegionGeometry.length) {
                this._effect.setGlassRegions?.([]);
                this._lastRegionGeometry = [];
            }
            if (this._root.visible)
                this._root.hide?.();
            return;
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
            this._effect.setCornerRadius?.(SHARED_RADIUS);
            this._effect.setResolution?.(
                rootW,
                rootH
            );
            this._effect.setGlassRegions?.(
                regions
            );
        }

        if (!this._root.visible)
            this._root.show?.();
    }

    cleanup() {
        if (!this._enabled)
            return;
        this._enabled = false;

        this._stopStageSync();
        this._stopTreeWatch();

        for (const {object, id} of this._overviewSignals) {
            try {
                object?.disconnect?.(id);
            } catch {}
        }
        this._overviewSignals = [];

        for (const [actor, entry] of this._targets) {
            try {
                actor.remove_style_class_name?.(
                    entry.kind === 'icon'
                        ? ICON_ACTIVE_CLASS
                        : CLOSE_ACTIVE_CLASS
                );
            } catch {}
            if (entry.kind === 'icon') {
                try {
                    actor.opacity =
                        entry.nativeOpacity ?? 255;
                } catch {}
            }
            try {
                entry.clone?.destroy?.();
            } catch {}
        }
        this._targets.clear();

        this._captionGeneration++;
        this._captionSamplePending = false;

        for (const [actor, state] of this._captions) {
            try {
                actor.remove_style_class_name?.(
                    CAPTION_TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    CAPTION_TEXT_DARK_CLASS
                );
            } catch {}
            try {
                actor.set_style?.(
                    state.originalStyle ?? null
                );
            } catch {}
        }
        this._captions.clear();
        this._captionScreenshot = null;
        this._lastCaptionSampleUs = 0;

        try {
            this._root?.destroy?.();
        } catch {}

        this._overview = null;
        this._root = null;
        this._liquidBox = null;
        this._sceneRoot = null;
        this._iconLayer = null;
        this._wallpaper = null;
        this._effect = null;
        this._appearance = null;
        this._lastRegionKey = '';
        this._lastRegionGeometry = [];

        console.log(
            '[VLIQ][OverviewCloseGlass] stopped'
        );
    }
}
