import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    VLIQ_GLASS_ADAPTERS,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';

const DEFAULT_RADIUS = 24;
const SAMPLE_MARGIN_MIN = 48;
const SAMPLE_MARGIN_MAX = 180;
const TEXT_LIGHT_CLASS = 'vliq-notification-text-light';
const TEXT_DARK_CLASS = 'vliq-notification-text-dark';
const LIGHT_TEXT = '#f7f8fc';
const DARK_TEXT = '#17191f';
const TEXT_SWITCH_ADVANTAGE = 1.18;
const MIN_READABLE_CONTRAST = 4.5;

function finiteRect(values) {
    return values.every(Number.isFinite) &&
        values[2] > 1 &&
        values[3] > 1;
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

function contrastRatio(a, b) {
    return (
        (Math.max(a, b) + 0.05) /
        (Math.min(a, b) + 0.05)
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

    let sum = 0;
    for (let i = trim; i < sorted.length - trim; i++)
        sum += sorted[i];

    return sum / Math.max(1, sorted.length - trim * 2);
}

const LIGHT_LUMA = hexLuminance(LIGHT_TEXT);
const DARK_LUMA = hexLuminance(DARK_TEXT);


export class NotificationGlassManager {
    constructor(params) {
        this._vendor = params.vendor;
        this._settings = params.settings;
        this._readAppearance = params.readAppearance;
        this._enabled = false;
        this._bannerBin = null;
        this._signals = [];
        this._settingsSignals = [];
        this._materials = new Map();
        this._appearance = null;
        this._screenshot = null;
    }

    setup() {
        if (this._enabled)
            return;

        const tray = Main.messageTray;
        const bannerBin = tray?._bannerBin;
        if (!bannerBin)
            throw new Error('GNOME MessageTray banner container is unavailable');

        this._enabled = true;
        this._bannerBin = bannerBin;
        this._appearance = this._readAppearance();

        this._signals.push({
            obj: bannerBin,
            id: bannerBin.connect('child-added', (_container, actor) => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (
                        this._enabled &&
                        actor?.get_parent?.() === this._bannerBin
                    ) {
                        this._attach(actor);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }),
        });

        this._signals.push({
            obj: bannerBin,
            id: bannerBin.connect('child-removed', (_container, actor) => {
                this._detach(actor);
            }),
        });

        for (const actor of bannerBin.get_children?.() ?? [])
            this._attach(actor);

        if (tray?._banner)
            this._attach(tray._banner);

        for (const key of [
            'notification-brightness',
            'notification-contrast',
            'notification-saturation',
            'notification-corner-radius',
            'blur-method',
            'glass-blur-downscale',
        ]) {
            try {
                this._settingsSignals.push(
                    this._settings.connect(
                        'changed::' + key,
                        () => this._refreshMaterialSettings()
                    )
                );
            } catch {
                // The pilot must not fail because an optional setting is absent.
            }
        }

        console.log(
            '[VLIQ][NotificationGlass] live refractive material active'
        );
    }

    updateAppearance(state = this._readAppearance()) {
        this._appearance = state;
        for (const material of this._materials.values()) {
            this._applyAppearance(material, state);
            this._queueSync(material);
        }
    }

    _readCornerRadius(actor) {
        try {
            actor?.ensure_style?.();
            const radius = actor
                ?.get_theme_node?.()
                ?.get_border_radius?.(St.Corner.TOPLEFT);
            if (Number.isFinite(radius) && radius > 0)
                return radius;
        } catch {
            // Fall through to the renderer setting.
        }

        try {
            const radius = this._settings.get_double(
                'notification-corner-radius'
            );
            if (Number.isFinite(radius) && radius > 0)
                return radius;
        } catch {
            // Use the conservative fallback below.
        }

        return DEFAULT_RADIUS;
    }

    _attach(actor) {
        if (
            !this._enabled ||
            !actor ||
            actor === this._bannerBin ||
            this._materials.has(actor)
        ) {
            return;
        }

        const radius = this._readCornerRadius(actor);
        const originalInlineStyle =
            actor.get_style?.() ??
            actor.style ??
            '';

        actor.add_style_class_name?.(
            'vliq-native-notification-glass'
        );

        // NotificationMessage itself is the painted GNOME/Yaru card
        // (.message + .notification-banner). Inline paint neutralization is
        // intentional here: it outranks theme specificity without changing
        // geometry, content, input or MessageTray animation.
        const transparentStyle =
            'background-color: transparent !important; ' +
            'background-image: none !important; ' +
            'border-color: transparent !important; ' +
            'box-shadow: none !important;';
        actor.set_style?.(
            originalInlineStyle
                ? originalInlineStyle + ' ' + transparentStyle
                : transparentStyle
        );

        const bannerRoot = this._resolveBannerRoot(actor);

        const root = new this._vendor.UnpickableActor();
        root.set_name('vliq-notification-material-root');
        root.set_size(1, 1);
        root.hide();

        const liquidBox = new this._vendor.UnpickableActor();
        liquidBox.set_name('vliq-notification-liquid-box');
        liquidBox.set_clip_to_allocation(true);
        liquidBox.set_position(0, 0);
        liquidBox.set_size(1, 1);
        root.add_child(liquidBox);

        // Live compositor-native scene source: wallpaper + Meta.WindowActor
        // clones. This stays on the GPU; no screenshot or CPU readback.
        const sceneManager =
            new this._vendor.WindowCloneManager(
                liquidBox,
                null,
                'vliq-notification-scene'
            );

        // Matches the proven LiquidEffect container pattern used by the
        // vendored managers. It paints nothing; it only avoids a Clutter
        // offscreen-cache optimization edge case that can produce black frames.
        const breaker = new this._vendor.UnpickableActor();
        breaker.set_name('vliq-notification-optimization-breaker');
        breaker.set_size(1, 1);
        breaker.set_opacity(0);
        liquidBox.add_child(breaker);

        const effect = new this._vendor.LiquidEffect({
            extensionPath: this._vendor.root,
            settings: this._settings,
            owner: 'vliq-notification-lite',
        });

        const notificationAdapter =
            VLIQ_GLASS_ADAPTERS.notificationBanner;
        effect.setPadding?.(
            notificationAdapter.shaderPadding ?? 20
        );
        effect.setIsDock?.(false);
        liquidBox.add_effect(effect);

        const filterLayer = new St.Widget({
            name: 'vliq-notification-white-filter',
            style_class: 'vliq-glass-white-filter',
            reactive: false,
        });
        root.add_child(filterLayer);

        try {
            if (
                bannerRoot?.get_parent?.() ===
                Main.layoutManager.uiGroup
            ) {
                Main.layoutManager.uiGroup.insert_child_below(
                    root,
                    bannerRoot
                );
            } else {
                Main.layoutManager.uiGroup.add_child(root);
            }
        } catch (error) {
            try {
                root.destroy?.();
            } catch {
                // Best-effort partial construction cleanup.
            }
            actor.remove_style_class_name?.(
                'vliq-native-notification-glass'
            );
            console.error(
                '[VLIQ][NotificationGlass] attach failed: ' + error
            );
            return;
        }

        const material = {
            actor,
            bannerRoot,
            root,
            liquidBox,
            sceneManager,
            filterLayer,
            effect,
            radius,
            originalInlineStyle,
            signals: [],
            laterId: 0,
            lastShaderX: null,
            lastShaderY: null,
            lastShaderW: null,
            lastShaderH: null,
            lastResolutionW: 0,
            lastResolutionH: 0,
            lastShadowMaxRadius: NaN,
            lastSceneSyncUs: 0,
            textSampleSourceId: 0,
            textGeneration: 0,
            useDarkText: null,
        };

        this._materials.set(actor, material);
        this._connectGeometrySignals(material);
        this._applyAppearance(
            material,
            this._appearance ?? this._readAppearance()
        );

        effect.setLiveGeometryHook?.(() => {
            if (
                this._enabled &&
                this._materials.get(actor) === material
            ) {
                this._sync(material, true);
            }
        });

        this._queueSync(material);
        this._scheduleTextSample(
            material,
            VLIQ_GLASS_ADAPTERS.notificationBanner
                .adaptiveSampleDelayMs ?? 220
        );
    }

    _resolveBannerRoot(actor) {
        let root = this._bannerBin ?? actor;
        while (
            root?.get_parent?.() &&
            root.get_parent() !== Main.layoutManager.uiGroup
        ) {
            const parent = root.get_parent();
            if (!parent)
                break;
            root = parent;
        }
        return root;
    }

    _connectGeometrySignals(material) {
        const watched = new Set();
        let cursor = material.actor;

        while (
            cursor &&
            cursor !== Main.layoutManager.uiGroup
        ) {
            watched.add(cursor);
            cursor = cursor.get_parent?.() ?? null;
        }

        if (this._bannerBin)
            watched.add(this._bannerBin);

        const queue = () => {
            this._queueSync(material);

            if (
                material.actor?.mapped &&
                material.actor?.visible &&
                material.useDarkText === null &&
                !material.textSampleSourceId
            ) {
                this._scheduleTextSample(
                    material,
                    80
                );
            }
        };

        for (const target of watched) {
            for (const signal of [
                'notify::allocation',
                'notify::x',
                'notify::y',
                'notify::translation-x',
                'notify::translation-y',
                'notify::scale-x',
                'notify::scale-y',
                'notify::opacity',
                'notify::visible',
                'notify::mapped',
            ]) {
                try {
                    material.signals.push({
                        obj: target,
                        id: target.connect(signal, queue),
                    });
                } catch {
                    // Not every Shell actor exposes every property notification.
                }
            }
        }

        try {
            material.signals.push({
                obj: material.actor,
                id: material.actor.connect(
                    'destroy',
                    () => this._detach(material.actor)
                ),
            });
        } catch {
            // child-removed remains the fallback cleanup path.
        }
    }

    _cancelTextSample(material) {
        if (!material)
            return;

        material.textGeneration =
            (material.textGeneration ?? 0) + 1;

        if (material.textSampleSourceId) {
            try {
                GLib.source_remove(material.textSampleSourceId);
            } catch {}
            material.textSampleSourceId = 0;
        }
    }

    _scheduleTextSample(material, delayMs = 220) {
        if (
            !this._enabled ||
            !material ||
            !VLIQ_GLASS_ADAPTERS.notificationBanner.adaptiveText
        ) {
            return;
        }

        this._cancelTextSample(material);
        const generation = material.textGeneration;

        material.textSampleSourceId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT_IDLE,
                Math.max(0, delayMs),
                () => {
                    material.textSampleSourceId = 0;
                    this._sampleTextPolarity(
                        material,
                        generation
                    );
                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _captureBannerFrame(rect) {
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

        if (!this._screenshot)
            this._screenshot = new Shell.Screenshot();

        return new Promise(resolve => {
            let stream = null;

            try {
                stream =
                    Gio.MemoryOutputStream.new_resizable();

                this._screenshot.screenshot_area(
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

                            const bytes =
                                stream.steal_as_bytes();
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

    _bannerLuminance(frame) {
        if (!frame)
            return null;

        const insetX =
            Math.min(14, frame.width * 0.06);
        const insetY =
            Math.min(10, frame.height * 0.10);
        const left = Math.floor(insetX);
        const top = Math.floor(insetY);
        const right = Math.max(
            left + 1,
            Math.ceil(frame.width - insetX)
        );
        const bottom = Math.max(
            top + 1,
            Math.ceil(frame.height - insetY)
        );

        const step = Math.max(
            1,
            Math.floor(
                Math.min(
                    right - left,
                    bottom - top
                ) / 28
            )
        );

        const values = [];
        const {data, stride, channels} = frame;

        for (let py = top; py < bottom; py += step) {
            const row = py * stride;

            for (let px = left; px < right; px += step) {
                const index = row + px * channels;
                let r = data[index];
                let g = data[index + 1];
                let b = data[index + 2];

                if (channels > 3) {
                    const alpha = data[index + 3];
                    if (alpha < 32)
                        continue;

                    if (alpha < 255) {
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

    _chooseDarkText(material, luminance) {
        if (!Number.isFinite(luminance))
            return null;

        const lightContrast = contrastRatio(
            luminance,
            LIGHT_LUMA
        );
        const darkContrast = contrastRatio(
            luminance,
            DARK_LUMA
        );

        const previous = material.useDarkText;
        if (previous === null)
            return darkContrast > lightContrast;

        const current =
            previous ? darkContrast : lightContrast;
        const alternative =
            previous ? lightContrast : darkContrast;

        if (
            current < MIN_READABLE_CONTRAST &&
            alternative >= MIN_READABLE_CONTRAST
        ) {
            return !previous;
        }

        if (
            alternative >
            current * TEXT_SWITCH_ADVANTAGE
        ) {
            return !previous;
        }

        return previous;
    }

    _applyTextPolarity(material, useDarkText) {
        if (
            !material?.actor ||
            useDarkText === null ||
            material.useDarkText === useDarkText
        ) {
            return;
        }

        material.actor.remove_style_class_name?.(
            TEXT_LIGHT_CLASS
        );
        material.actor.remove_style_class_name?.(
            TEXT_DARK_CLASS
        );
        material.actor.add_style_class_name?.(
            useDarkText
                ? TEXT_DARK_CLASS
                : TEXT_LIGHT_CLASS
        );
        material.useDarkText = useDarkText;
    }

    async _sampleTextPolarity(
        material,
        generation
    ) {
        if (
            !this._enabled ||
            !material ||
            this._materials.get(material.actor) !==
                material ||
            generation !== material.textGeneration ||
            !material.actor?.mapped ||
            !material.actor?.visible
        ) {
            return;
        }

        const rect =
            this._vendor.getTransformedRect(
                material.actor
            );
        if (!finiteRect(rect))
            return;

        let frame = null;
        try {
            frame =
                await this._captureBannerFrame(rect);
        } catch {
            frame = null;
        }

        if (
            !frame ||
            !this._enabled ||
            generation !== material.textGeneration ||
            this._materials.get(material.actor) !==
                material
        ) {
            return;
        }

        const luminance =
            this._bannerLuminance(frame);
        const useDarkText =
            this._chooseDarkText(
                material,
                luminance
            );

        this._applyTextPolarity(
            material,
            useDarkText
        );
    }

    _applyAppearance(material, state) {
        if (!material?.effect || !state)
            return;

        const role =
            VLIQ_GLASS_ROLES.notificationCard;
        const adapter =
            VLIQ_GLASS_ADAPTERS.notificationBanner;
        const scopedAppearance =
            adapter.appearanceProfile
                ? state?.[adapter.appearanceProfile]
                : null;
        const profile =
            scopedAppearance
                ? {
                    ...state,
                    ...scopedAppearance,
                }
                : state;

        let brightness = null;
        let contrast = null;
        let saturation = null;

        try {
            brightness = this._settings.get_double(
                'notification-brightness'
            );
            contrast = this._settings.get_double(
                'notification-contrast'
            );
            saturation = this._settings.get_double(
                'notification-saturation'
            );
        } catch {
            // Shared material defaults remain valid.
        }

        applyVLIQGlassRole(
            material.effect,
            role,
            {
                tintColor: [
                    (profile.r ?? 255) / 255,
                    (profile.g ?? 255) / 255,
                    (profile.b ?? 255) / 255,
                ],
                tintStrength:
                    profile.opacity ?? role.tintStrength,
                baseBlur: profile.blur ?? 7,
                cornerRadius: material.radius,
                brightness,
                contrast,
                saturation,
                multiRegion: adapter.multiRegion,
            }
        );

        // No second body/filter plate. The LiquidEffect owns the complete
        // visible material, rim, refraction and depth.
        const filterOpacity = Math.max(
            0,
            Math.min(
                0.20,
                adapter.filterOpacityOverride ??
                    0.0
            )
        );

        material.filterLayer?.set_style?.(
            'background-color: rgba(255,255,255,' +
            filterOpacity.toFixed(3) +
            '); border-radius: ' +
            Math.round(material.radius) +
            'px; border: none; box-shadow: none;'
        );
    }

    _refreshMaterialSettings() {
        for (const material of this._materials.values()) {
            this._applyAppearance(
                material,
                this._appearance ?? this._readAppearance()
            );
            this._queueSync(material);
        }
    }

    _queueSync(material) {
        if (
            !this._enabled ||
            !material ||
            material.laterId
        ) {
            return;
        }

        material.laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW,
            () => {
                material.laterId = 0;

                if (
                    this._enabled &&
                    this._materials.get(material.actor) === material
                ) {
                    this._sync(material, false);
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _ensureSceneManager(material) {
        if (!material)
            return null;

        if (material.sceneManager)
            return material.sceneManager;

        material.sceneManager =
            new this._vendor.WindowCloneManager(
                material.liquidBox,
                null,
                'vliq-notification-scene'
            );
        material.lastSceneSyncUs = 0;
        return material.sceneManager;
    }

    _releaseSceneManager(material) {
        if (!material?.sceneManager)
            return;

        try {
            material.sceneManager.destroy?.();
        } catch {
            // Scene may already be tearing down.
        }
        material.sceneManager = null;
        material.lastSceneSyncUs = 0;
    }

    _sync(material, shaderOnly) {
        const actor = material?.actor;
        if (
            !actor ||
            this._materials.get(actor) !== material
        ) {
            return;
        }

        const rect =
            this._vendor.getTransformedRect(actor);
        if (!finiteRect(rect)) {
            if (!shaderOnly)
                material.root.hide?.();
            return;
        }

        const [absX, absY, width, height] = rect;

        const opacity =
            actor.get_paint_opacity?.() ??
            actor.opacity ??
            255;

        if (
            !actor.mapped ||
            !actor.visible ||
            opacity <= 0
        ) {
            if (!shaderOnly) {
                material.root.hide?.();
                this._releaseSceneManager(material);
            }
            return;
        }

        const monitor =
            this._vendor.resolveMonitorGeometry([
                actor,
                this._bannerBin,
            ]) ??
            Main.layoutManager.primaryMonitor ??
            {
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
            };

        const monitorX = monitor.x ?? 0;
        const monitorY = monitor.y ?? 0;
        const screenW = Math.max(
            1,
            monitor.width ?? global.stage.width
        );
        const screenH = Math.max(
            1,
            monitor.height ?? global.stage.height
        );

        const adapter =
            VLIQ_GLASS_ADAPTERS.notificationBanner;
        const shaderPad = Math.max(
            0,
            adapter.shaderPadding ?? 20
        );

        // LiquidEffect single-rect mode subtracts padding*2 from dock_w/h.
        // Expand the supplied geometry by the same padding so the resulting
        // visible rounded rect is exactly the native NotificationMessage
        // allocation. This is the same geometry contract used by PopupGlass.
        const glassAbsX = absX - shaderPad;
        const glassAbsY = absY - shaderPad;
        const glassW = width + shaderPad * 2;
        const glassH = height + shaderPad * 2;
        const glassX = glassAbsX - monitorX;
        const glassY = glassAbsY - monitorY;
        const contentX = absX - monitorX;
        const contentY = absY - monitorY;

        const geometryChanged =
            material.lastShaderX !== glassX ||
            material.lastShaderY !== glassY ||
            material.lastShaderW !== glassW ||
            material.lastShaderH !== glassH;

        if (geometryChanged) {
            material.lastShaderX = glassX;
            material.lastShaderY = glassY;
            material.lastShaderW = glassW;
            material.lastShaderH = glassH;

            material.effect.setGlassGeometry?.(
                glassX,
                glassY,
                glassW,
                glassH
            );
        }

        if (shaderOnly)
            return;

        this._vendor.setPositionIfChanged(
            material.root,
            monitorX,
            monitorY
        );
        this._vendor.setSizeIfChanged(
            material.root,
            screenW,
            screenH
        );
        this._vendor.setPositionIfChanged(
            material.liquidBox,
            0,
            0
        );
        this._vendor.setSizeIfChanged(
            material.liquidBox,
            screenW,
            screenH
        );
        this._vendor.setPositionIfChanged(
            material.filterLayer,
            contentX,
            contentY
        );
        this._vendor.setSizeIfChanged(
            material.filterLayer,
            width,
            height
        );

        const sceneManager = this._ensureSceneManager(material);
        sceneManager?.setOffset?.(
            -monitorX,
            -monitorY
        );

        const scopedAppearance =
            adapter.appearanceProfile
                ? this._appearance?.[adapter.appearanceProfile]
                : null;
        const surfaceAppearance =
            scopedAppearance
                ? {
                    ...this._appearance,
                    ...scopedAppearance,
                }
                : this._appearance;

        const blur = Math.max(
            0,
            surfaceAppearance?.blur ?? 0
        );
        const margin = Math.max(
            SAMPLE_MARGIN_MIN,
            Math.min(
                SAMPLE_MARGIN_MAX,
                Math.round(blur * 3 + 36)
            )
        );

        this._vendor.setClipIfChanged(
            material.root,
            glassX - margin,
            glassY - margin,
            glassW + margin * 2,
            glassH + margin * 2
        );

        const captureRect = [
            glassAbsX - margin,
            glassAbsY - margin,
            glassW + margin * 2,
            glassH + margin * 2,
        ];
        const configuredSceneFps =
            this._appearance?.sceneFps ?? 30;
        const sceneFps = Math.max(
            15,
            Math.min(
                adapter.sceneFpsCap ?? 60,
                configuredSceneFps
            )
        );
        const nowUs = GLib.get_monotonic_time();
        const intervalUs = 1000000 / sceneFps;
        const sceneDue =
            geometryChanged ||
            material.lastSceneSyncUs === 0 ||
            nowUs - material.lastSceneSyncUs >= intervalUs;

        if (sceneDue) {
            sceneManager?.setCullRect?.(captureRect);
            sceneManager?.applyBgCloneClip?.(captureRect);
            sceneManager?.sync?.();
            material.lastSceneSyncUs = nowUs;
        }

        if (
            material.lastResolutionW !== screenW ||
            material.lastResolutionH !== screenH
        ) {
            material.lastResolutionW = screenW;
            material.lastResolutionH = screenH;
            material.effect.setResolution?.(
                screenW,
                screenH
            );
        }

        const shadowMaxRadius =
            Math.max(0, margin - 12);
        if (
            material.lastShadowMaxRadius !==
            shadowMaxRadius
        ) {
            material.lastShadowMaxRadius =
                shadowMaxRadius;
            material.effect.setShadowMaxRadius?.(
                shadowMaxRadius
            );
        }

        if (material.root.opacity !== opacity)
            material.root.opacity = opacity;

        if (!material.root.visible)
            material.root.show?.();
    }

    _detach(actor) {
        const material = this._materials.get(actor);
        if (!material)
            return;

        this._materials.delete(actor);
        this._cancelTextSample(material);

        if (material.laterId) {
            try {
                global.compositor.get_laters().remove(
                    material.laterId
                );
            } catch {
                // Later may already have fired.
            }
            material.laterId = 0;
        }

        for (const signal of material.signals ?? []) {
            try {
                signal.obj.disconnect(signal.id);
            } catch {
                // Actor may already be tearing down.
            }
        }
        material.signals = [];

        try {
            material.effect?.setLiveGeometryHook?.(null);
        } catch {
            // Effect may already be detached.
        }

        this._releaseSceneManager(material);

        try {
            material.root?.destroy?.();
        } catch {
            // Root may already have been destroyed with Shell teardown.
        }

        try {
            if (actor?.set_style)
                actor.set_style(material.originalInlineStyle ?? '');

            actor?.remove_style_class_name?.(
                'vliq-native-notification-glass'
            );
            actor?.remove_style_class_name?.(
                TEXT_LIGHT_CLASS
            );
            actor?.remove_style_class_name?.(
                TEXT_DARK_CLASS
            );
        } catch {
            // Notification may already be destroyed.
        }
    }

    cleanup() {
        this._enabled = false;

        for (const signal of this._signals) {
            try {
                signal.obj.disconnect(signal.id);
            } catch {
                // MessageTray may already be tearing down.
            }
        }
        this._signals = [];

        for (const id of this._settingsSignals) {
            try {
                this._settings.disconnect(id);
            } catch {
                // Settings may already be tearing down.
            }
        }
        this._settingsSignals = [];

        for (const actor of [...this._materials.keys()])
            this._detach(actor);

        this._materials.clear();
        this._bannerBin = null;
        this._screenshot = null;
    }
}
