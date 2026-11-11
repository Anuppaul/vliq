// A true VLIQ Liquid Glass material limited to the native Ubuntu Dock panel.
// Follows the established ShellCardSurface architecture, NOT the fullscreen
// DashManager FBO that caused PR #35's whole-screen black regression.
import GLib from 'gi://GLib';
import {frameDue} from './frameBudget.js';

import {
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';

const SCENE_FPS = 24;
const MARGIN_LIMIT = 0; // full-width native panel, square corners, no shadow

export class PanelGlassSurface {
    constructor(vendor, settings, readAppearance, options = {}) {
        this._cornerRadius = Math.max(0, options.cornerRadius ?? 0);
        this._borderless = options.borderless === true;
        // True 3-Part milky cards: CSS alone paints the native GNOME
        // island boxes. No LiquidEffect/Clutter actor is allocated.
        this._cssOnly = options.cssOnly === true;
        this._milky = false;
        this._requestedOpacity = 255;
        this._vendor = vendor;
        this._settings = settings;
        this._readAppearance = readAppearance;
        this._material = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._effect = null;
        this._lastSceneUs = 0;
        this._lastCapture = null;
        this._lastPaint = null;
        this._boundsDirty = true;
        this._destroyed = false;
    }

    attach(group, dockRoot) {
        if (!group || !dockRoot)
            return false;
        if (this._cssOnly)
            return true;
        if (this._material)
            return false;
        let material = null;
        let manager = null;
        try {
            material = new this._vendor.UnpickableActor({
                name: 'vliq-native-panel-liquid-glass',
                reactive: false,
            });
            material.set_no_layout?.(true);
            material.set_clip_to_allocation(true);
            material.set_size(1, 1);
            material.set_opacity(0);

            const scene = new this._vendor.UnpickableActor({
                name: 'vliq-native-panel-liquid-scene',
                reactive: false,
            });
            scene.set_no_layout?.(true);
            material.add_child(scene);

            // Nonempty capture during the first GL paint/allocation.
            const breaker = new this._vendor.UnpickableActor({
                name: 'vliq-panel-capture-breaker',
                reactive: false,
            });
            breaker.set_no_layout?.(true);
            breaker.set_size(1, 1);
            breaker.set_opacity(0);
            material.add_child(breaker);

            const effect = new this._vendor.LiquidEffect({
                extensionPath: this._vendor.root,
                settings: this._settings,
                owner: 'vliq-panel-local',
            });
            effect.setPadding?.(0);
            effect.setShadowMaxRadius?.(0);
            effect.setIsDock?.(false);
            effect.setMultiRegionMode?.(false);
            effect.setCornerRadius?.(this._cornerRadius);
            material.add_effect(effect);

            // The material is at most as large as the native panel, and
            // Clutter clips the *capture* and its composite to the actor.
            // Never insert an OffscreenEffect on Main.uiGroup or DockDash.
            group.insert_child_below(material, dockRoot);

            manager = new this._vendor.WindowCloneManager(
                scene, null, 'vliq-native-panel-local'
            );

            this._material = material;
            this._sceneRoot = scene;
            this._sceneManager = manager;
            this._effect = effect;
            effect.setLiveGeometryHook?.(() => this._syncPaint());
            this.updateAppearance();
            return true;
        } catch (error) {
            try { manager?.destroy?.(); } catch {}
            try { material?.destroy?.(); } catch {}
            console.warn('[VLIQ][PanelGlass] bounded material attach failed: ' + error);
            return false;
        }
    }

    updateAppearance() {
        if (this._destroyed)
            return;
        const state = this._readAppearance?.() ?? {};
        const milky = state.milky === true;
        if (this._milky !== milky) {
            this._milky = milky;
            this._boundsDirty = true;
            if (this._material)
                this._material.opacity = milky ? 0 : this._requestedOpacity;
        }
        if (!this._effect)
            return;
        let brightness = null;
        let contrast = null;
        let saturation = null;
        try {
            brightness = this._settings.get_double('dock-brightness');
            contrast = this._settings.get_double('dock-contrast');
            saturation = this._settings.get_double('dock-saturation');
        } catch {}
        applyVLIQGlassRole(
            this._effect,
            VLIQ_GLASS_ROLES.dock,
            {
                tintColor: [
                    (state.r ?? 255) / 255,
                    (state.g ?? 255) / 255,
                    (state.b ?? 255) / 255,
                ],
                tintStrength: state.opacity ?? 0.02,
                baseBlur: state.blur ?? 7,
                cornerRadius: this._cornerRadius,
                brightness,
                contrast,
                saturation,
                multiRegion: false,
            }
        );
        this._effect.setIsDock?.(false);
        this._effect.setPadding?.(0);
        this._effect.setShadowMaxRadius?.(0);
        this._effect.setCornerRadius?.(this._cornerRadius);
        if (this._borderless) {
            // Bottom mode only: disable shader rim, contour, specular light,
            // inner AO and shadow; leave tint, blur and refraction intact.
            this._effect.setSurfaceLightEnabled?.(false);
            this._effect._uniforms?.set?.('ao_intensity', 0.0);
            this._effect._uniforms?.set?.('shadow_intensity', 0.0);
        }
        this._material?.queue_redraw?.();
    }

    setBounds(x, y, width, height, opacity = 255) {
        if (this._destroyed || !this._material)
            return;
        const actor = this._material;
        if (![x, y, width, height, opacity].every(Number.isFinite) ||
            width <= 1 || height <= 1 ||
            // Defense-in-depth. The caller verifies native panel thickness
            // against its monitor before reaching this layer.
            Math.min(width, height) > 240) {
            if (actor.opacity !== 0) {
                actor.opacity = 0;
                this._boundsDirty = true;
            }
            return;
        }
        if (Math.abs(actor.x - x) > 0.1 || Math.abs(actor.y - y) > 0.1) {
            actor.set_position(x, y);
            this._boundsDirty = true;
        }
        if (Math.abs(actor.width - width) > 0.1 ||
            Math.abs(actor.height - height) > 0.1) {
            actor.set_size(width, height);
            this._lastPaint = null;
            this._boundsDirty = true;
        }
        if (!actor.visible)
            actor.show?.();
        this._requestedOpacity = Math.max(0, Math.min(255, opacity));
        const nextOpacity = this._milky ? 0 : this._requestedOpacity;
        if (actor.opacity !== nextOpacity)
            actor.opacity = nextOpacity;
        this.syncFrame();
    }

    hide() {
        if (this._material && this._material.opacity !== 0) {
            this._material.opacity = 0;
            this._boundsDirty = true;
        }
    }

    get ready() {
        if (this._cssOnly || this._milky)
            return !this._destroyed;
        return Boolean(
            !this._destroyed &&
            this._effect?._shadersLoaded &&
            (this._effect?._diagCompositedPaintCount ?? 0) > 0 &&
            this._material?.mapped
        );
    }

    _syncPaint() {
        if (this._destroyed || !this._material || !this._effect)
            return;
        const [width, height] = this._material.get_size?.() ?? [0, 0];
        if (width <= 1 || height <= 1 ||
            (this._lastPaint && this._lastPaint[0] === width &&
                this._lastPaint[1] === height))
            return;
        this._lastPaint = [width, height];
        this._effect.setResolution?.(width, height);
        this._effect.setGlassGeometry?.(
            MARGIN_LIMIT, MARGIN_LIMIT, width, height
        );
    }

    syncFrame() {
        if (this._milky)
            return;
        if (this._destroyed || !this._material || !this._sceneRoot ||
            !this._sceneManager || !this._material.mapped ||
            this._material.opacity === 0)
            return;

        const [width, height] = this._material.get_size?.() ?? [0, 0];
        if (width <= 1 || height <= 1)
            return;

        // The common stationary-panel path runs on every stage frame.
        // Avoid a GObject transformed-position query until the next actual
        // clone-sync deadline. A moving panel bypasses the budget immediately.
        const nowUs = GLib.get_monotonic_time();
        if (!this._boundsDirty &&
            !frameDue(nowUs, this._lastSceneUs, SCENE_FPS))
            return;

        const [absX, absY] =
            this._material.get_transformed_position?.() ?? [NaN, NaN];
        if (!Number.isFinite(absX) || !Number.isFinite(absY))
            return;

        const rectangle = [absX, absY, width, height];
        const changed = !this._lastCapture ||
            rectangle.some((v, i) => this._lastCapture[i] !== v);
        // A hide/reveal at identical bounds still needs a fresh capture.
        if (!changed && !this._boundsDirty &&
            !frameDue(nowUs, this._lastSceneUs, SCENE_FPS))
            return;

        // Same scene mapping as ShellCardSurface: screen-coordinate window
        // clones become local capture coordinates by translating the scene.
        const scene = this._sceneRoot;
        this._vendor.setSizeIfChanged(
            scene, global.stage.width, global.stage.height
        );
        if (scene.x !== 0 || scene.y !== 0)
            scene.set_position(0, 0);
        this._vendor.setTranslationIfChanged(scene, -absX, -absY);
        if (changed) {
            this._sceneManager.setCullRect?.(rectangle);
            this._sceneManager.applyBgCloneClip?.(rectangle);
        }
        this._sceneManager.sync?.();
        this._lastCapture = rectangle;
        this._lastSceneUs = nowUs;
        this._boundsDirty = false;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        try { this._effect?.setLiveGeometryHook?.(null); } catch {}
        try { this._sceneManager?.destroy?.(); } catch {}
        try { this._material?.destroy?.(); } catch {}
        this._material = null;
        this._sceneRoot = null;
        this._sceneManager = null;
        this._effect = null;
    }
}
