// VLIQ Quick Settings Brightness (GNOME Shell 50).
//
// GNOME already ships a native BrightnessItem, but hides it when
// Main.brightnessManager.globalScale is null (common on desktop PCs with
// external monitors and no supported hardware backlight).
//
// 1. Hardware backlight: keep GNOME's existing BrightnessItem, move it
//    directly below the sound output slider, never replace its signal path.
// 2. No supported backlight: add ONE native QuickSlider in the same position,
//    backed by one Clutter.BrightnessContrastEffect on GNOME's uiGroup.
//    This dims wallpaper, windows, Shell panel and Quick Settings together.
//    It is *software dimming*, not DDC/CI, hardware backlight or gamma.
// 3. Fullscreen video can use Mutter direct scanout and BYPASS uiGroup's
//    shader. While software dimming is active, hold one ref-counted
//    compositor.disable_unredirect() lease (as GNOME's OSD does).
//    Release the EXACT same lease on 100%, disable, failure or hot-swap.
// 4. The GPU effect exists only below 100%; never modify actor opacity,
//    attach to global.stage, create a fullscreen overlay or poll.
// 5. Full restore on disable / live runtime hot-swap.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const SOFTWARE_EFFECT_NAME = 'vliq-quick-brightness-software-dim';
const SOFTWARE_SLIDER_CLASS = 'vliq-software-brightness';
const MIN_SOFT_PERCENT = 30;
const MAX_SOFT_DIM = 0.50;

export function clampSoftBrightness(value) {
    return Math.max(MIN_SOFT_PERCENT, Math.min(100,
        Number.isFinite(value) ? Math.round(value) : 100));
}

export function softwareDimFactor(percent) {
    // Negative brightness reduces colour components. The lower bound keeps
    // the compositor useable; 100% maps to exact +0 and no GPU effect.
    const clamped = clampSoftBrightness(percent);
    if (clamped >= 100)
        return 0;
    return -MAX_SOFT_DIM * (100 - clamped) /
        (100 - MIN_SOFT_PERCENT);
}

export function getQuickBrightnessActors(panel) {
    const quick = panel?.statusArea?.quickSettings;
    const menu = quick?.menu;
    const grid = menu?._grid;
    const output = quick?._volumeOutput?._output ??
        quick?._volumeOutput?.quickSettingsItems?.[0] ?? null;
    const input = quick?._volumeInput?._input ??
        quick?._volumeInput?.quickSettingsItems?.[0] ?? null;
    const brightness = quick?._brightness?.quickSettingsItems?.[0] ?? null;
    return {quick, menu, grid, output, input, brightness};
}

/**
 * GNOME Shell 50 scene topology: uiGroup is the compositor-painted parent
 * containing window_group, top_window_group, panel and Quick Settings.
 * A brightness effect on window_group alone does not touch panel/overlays,
 * producing the reported "not fullscreen" brightness regression.
 *
 * Never fall back to window_group (partial dimming) or global.stage
 * (dangerous root-stage postprocessing). If GNOME reorganizes its scene,
 * fail closed instead of dimming an unexpected actor.
 */
export function getFullDesktopBrightnessHost() {
    const host = Main.layoutManager?.uiGroup ?? Main.uiGroup ?? null;
    if (
        !host || host === global.stage || host === global.window_group ||
        typeof host.add_effect_with_name !== 'function' ||
        typeof host.remove_effect !== 'function' ||
        !global.window_group || !global.top_window_group ||
        typeof host.contains !== 'function' ||
        !host.contains(global.window_group) ||
        !host.contains(global.top_window_group)
    )
        return null;
    return host;
}

function isChildOf(actor, parent) {
    return Boolean(actor && parent && actor.get_parent?.() === parent);
}

export class QuickBrightnessManager {
    constructor(settings) {
        this._settings = settings;
        this._running = false;
        this._grid = null;
        this._gridChildId = 0;
        this._brightnessManager = null;
        this._brightnessChangedId = 0;
        this._enabledChangedId = 0;
        this._percentChangedId = 0;
        this._idleId = 0;
        this._syncing = false;
        this._syncingSlider = false;
        this._softwareSlider = null;
        this._softwareSliderChangedId = 0;
        this._effect = null;
        this._effectHost = null;
        this._unredirectCompositor = null;
        this._unredirectHeld = false;
        this._movedNative = null;
        this._status = '';
    }

    setup() {
        if (this._running)
            return;

        this._running = true;
        this._enabledChangedId = this._settings.connect(
            'changed::quick-brightness-enabled', () => this._queueSync()
        );
        this._percentChangedId = this._settings.connect(
            'changed::quick-soft-brightness', () => this._queueSync()
        );

        this._brightnessManager = Main.brightnessManager ?? null;
        if (this._brightnessManager) {
            try {
                this._brightnessChangedId = this._brightnessManager.connect(
                    'changed', () => this._queueSync()
                );
            } catch (error) {
                console.warn(
                    '[VLIQ][Brightness] hardware manager signal unavailable: ' +
                    error
                );
            }
        }

        const {grid} = getQuickBrightnessActors(Main.panel);
        if (!grid) {
            this._publishStatus('Unavailable: GNOME Quick Settings grid missing');
            return;
        }

        this._grid = grid;
        try {
            // GNOME Shell 50 populates indicators asynchronously. This event
            // covers deferred sound/brightness slider insertion without a
            // timer loop or monkey-patching QuickSettings prototypes.
            this._gridChildId = grid.connect(
                'child-added', () => this._queueSync()
            );
        } catch (error) {
            console.warn(
                '[VLIQ][Brightness] grid lifecycle signal unavailable: ' +
                error
            );
        }
        this._sync();
    }

    _enabled() {
        try {
            return this._settings.get_boolean('quick-brightness-enabled');
        } catch {
            return false;
        }
    }

    _percent() {
        try {
            return clampSoftBrightness(
                this._settings.get_int('quick-soft-brightness')
            );
        } catch {
            return 100;
        }
    }

    _publishStatus(status) {
        if (this._status === status)
            return;
        this._status = status;
        try {
            if (this._settings.get_string('quick-brightness-status') !== status)
                this._settings.set_string('quick-brightness-status', status);
        } catch {
            // Status is informational, not a reason to break Quick Settings.
        }
    }

    _queueSync() {
        if (!this._running || this._idleId)
            return;

        this._idleId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._idleId = 0;
                if (this._running)
                    this._sync();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _hardwareSupported() {
        // This is exactly the GNOME Shell 50 BrightnessItem visibility
        // condition. No DDC calls, permission elevation or fake hardware.
        return Boolean(this._brightnessManager?.globalScale);
    }

    _moveDirectlyAfterOutput(item, output, grid) {
        if (!isChildOf(item, grid) || !isChildOf(output, grid))
            return false;

        const siblings = grid.get_children?.() ?? [];
        const outputIndex = siblings.indexOf(output);
        if (outputIndex < 0 || siblings[outputIndex + 1] === item)
            return false;

        // GNOME native grid layout determines rows by child stacking order.
        // Both items already have column-span=2 in QuickSettingsMenu.
        grid.set_child_above_sibling(item, output);
        return true;
    }

    _reorderNative(native, output, grid) {
        if (!isChildOf(native, grid) || !isChildOf(output, grid))
            return;

        // Preserve GNOME's original ordering for extension disable.
        if (!this._movedNative) {
            const children = grid.get_children();
            const index = children.indexOf(native);
            this._movedNative = {
                item: native,
                grid,
                predecessor: index > 0 ? children[index - 1] : null,
            };
        }

        this._moveDirectlyAfterOutput(native, output, grid);
    }

    _restoreNative() {
        const original = this._movedNative;
        this._movedNative = null;
        if (!original)
            return;

        const {item, grid, predecessor} = original;
        if (!isChildOf(item, grid))
            return;

        try {
            if (isChildOf(predecessor, grid))
                grid.set_child_above_sibling(item, predecessor);
            else if (predecessor === null)
                grid.set_child_below_sibling(item, null);
        } catch (error) {
            console.warn(
                '[VLIQ][Brightness] native slider position restore failed: ' +
                error
            );
        }
    }

    _createSoftwareSlider(menu, grid, output) {
        if (this._softwareSlider)
            return;

        if (!menu || !grid || typeof QuickSlider !== 'function')
            return;

        const host = getFullDesktopBrightnessHost();
        if (!host ||
            typeof Clutter.BrightnessContrastEffect !== 'function'
        ) {
            this._publishStatus(
                'Unavailable: safe full-desktop dimming host missing'
            );
            return;
        }

        const item = new QuickSlider({
            iconName: 'display-brightness-symbolic',
            iconLabel: 'Brightness (software dimming)',
            menuEnabled: false,
        });
        item.add_style_class_name(SOFTWARE_SLIDER_CLASS);
        item.slider.accessible_name = 'Brightness (software dimming)';
        this._syncingSlider = true;
        item.slider.value = this._percent() / 100;
        this._syncingSlider = false;

        try {
            this._softwareSliderChangedId = item.slider.connect(
                'notify::value', () => {
                    if (!this._running || this._syncingSlider ||
                        !this._enabled() || this._hardwareSupported())
                        return;

                    const percent = clampSoftBrightness(
                        item.slider.value * 100
                    );
                    if (percent !== this._percent())
                        this._settings.set_int('quick-soft-brightness', percent);
                    // Apply live without waiting for the deferred status UI.
                    this._applySoftDim(percent);
                }
            );

            menu.addItem(item, 2);
            this._softwareSlider = item;
            this._moveDirectlyAfterOutput(item, output, grid);
        } catch (error) {
            if (this._softwareSliderChangedId) {
                try {
                    item.slider.disconnect(this._softwareSliderChangedId);
                } catch {}
                this._softwareSliderChangedId = 0;
            }
            try { item.menu?.actor?.destroy(); } catch {}
            try { item.destroy(); } catch {}
            this._publishStatus('Unavailable: cannot add native brightness slider');
            console.warn(
                '[VLIQ][Brightness] QuickSlider insertion failed: ' + error
            );
        }
    }

    _removeSoftwareSlider() {
        const item = this._softwareSlider;
        this._softwareSlider = null;
        if (!item)
            return;

        if (this._softwareSliderChangedId) {
            try { item.slider.disconnect(this._softwareSliderChangedId); } catch {}
        }
        this._softwareSliderChangedId = 0;

        // QuickSlider creates a QuickToggleMenu in a separate overlay.
        // Both must be destroyed; removing only the grid widget leaks it.
        try { item.menu?.actor?.destroy(); } catch {}
        try { item.destroy(); } catch {}
    }

    /**
     * GNOME Shell 50 / Mutter can scan a fullscreen video's buffer directly
     * to the monitor, bypassing the UI scene completely. uiGroup's
     * Clutter.BrightnessContrastEffect will then NOT affect fullscreen
     * video. GNOME's own OSD calls disable_unredirect()/enable_unredirect()
     * in balanced pairs. This is a reference-counted compositor inhibition:
     * own exactly one lease per active software brightness GPU pass.
     *
     * Do not acquire in native hardware mode or at 100%. If unsupported,
     * fail closed rather than letting fullscreen suddenly become bright.
     */
    _acquireCompositing() {
        if (this._unredirectHeld)
            return true;

        const compositor = global.compositor;
        if (
            !compositor ||
            typeof compositor.disable_unredirect !== 'function' ||
            typeof compositor.enable_unredirect !== 'function'
        ) {
            this._publishStatus(
                'Unavailable: fullscreen compositing API missing'
            );
            return false;
        }

        try {
            compositor.disable_unredirect();
            this._unredirectCompositor = compositor;
            this._unredirectHeld = true;
            return true;
        } catch (error) {
            this._publishStatus(
                'Unavailable: cannot keep fullscreen video dimmed'
            );
            console.warn(
                '[VLIQ][Brightness] disable_unredirect failed: ' + error
            );
            return false;
        }
    }

    _releaseCompositing() {
        if (!this._unredirectHeld)
            return;

        const compositor = this._unredirectCompositor;
        // Mark released before invoking a foreign GNOME Shell callback so
        // reentrant teardown cannot accidentally decrement twice.
        this._unredirectHeld = false;
        this._unredirectCompositor = null;
        try {
            compositor?.enable_unredirect?.();
        } catch (error) {
            console.warn(
                '[VLIQ][Brightness] enable_unredirect failed: ' + error
            );
        }
    }

    _applySoftDim(percent) {
        const value = clampSoftBrightness(percent);
        const dim = softwareDimFactor(value);

        // Never spend a GPU pass at maximum; remove our owned effect.
        if (value >= 100) {
            this._removeEffect();
            return true;
        }

        const host = getFullDesktopBrightnessHost();
        if (!host ||
            typeof Clutter.BrightnessContrastEffect !== 'function'
        ) {
            this._removeEffect();
            this._publishStatus(
                'Unavailable: safe full-desktop dimming host missing'
            );
            return false;
        }

        // If Shell rebuilt its uiGroup, remove the old effect first:
        // the old compositor inhibition must also be released before a
        // replacement effect takes ownership.
        if (this._effect && this._effectHost !== host)
            this._removeEffect();

        // Reject collisions BEFORE disabling direct scanout. Another
        // extension may own a shader with our name; a rejected attachment
        // must never keep a compositor inhibition lease alive.
        if (!this._effect) {
            let occupied = false;
            try {
                occupied = Boolean(host.get_effect?.(SOFTWARE_EFFECT_NAME));
            } catch {
                // A destroyed/replaced GNOME host must never leave behind
                // a compositor-wide direct-scanout inhibition lease.
                this._removeEffect();
                this._publishStatus('Unavailable: brightness effect lookup failed');
                return false;
            }
            if (occupied) {
                this._removeEffect();
                this._publishStatus('Unavailable: existing brightness effect');
                return false;
            }
        }

        // Acquire BEFORE adding the scene brightness shader: a fullscreen
        // video may already be scanned out directly when the slider moves.
        // Holding the lease across subsequent slider updates prevents
        // repeated compositor-wide toggle/repaint churn.
        if (!this._acquireCompositing()) {
            this._removeEffect();
            return false;
        }

        if (!this._effect) {
            try {
                // Recheck after acquisition in case another extension raced
                // us between the initial lookup and shader attachment.
                if (host.get_effect?.(SOFTWARE_EFFECT_NAME)) {
                    this._removeEffect();
                    this._publishStatus('Unavailable: existing brightness effect');
                    return false;
                }
                const effect = new Clutter.BrightnessContrastEffect();
                effect.set_brightness(dim);
                host.add_effect_with_name(SOFTWARE_EFFECT_NAME, effect);
                this._effect = effect;
                this._effectHost = host;
            } catch (error) {
                this._removeEffect();
                this._publishStatus('Unavailable: software dimming failed');
                console.warn(
                    '[VLIQ][Brightness] software GPU effect unavailable: ' +
                    error
                );
                return false;
            }
        } else {
            try {
                this._effect.set_brightness(dim);
            } catch (error) {
                this._removeEffect();
                this._publishStatus('Unavailable: software dimming update failed');
                console.warn(
                    '[VLIQ][Brightness] dimming update failed: ' + error
                );
                return false;
            }
        }
        return this._effectHost === host && Boolean(this._effect);
    }

    _removeEffect() {
        const effect = this._effect;
        const host = this._effectHost;
        this._effect = null;
        this._effectHost = null;
        if (host && effect) {
            try {
                host.remove_effect(effect);
            } catch (error) {
                console.warn(
                    '[VLIQ][Brightness] remove owned GPU effect failed: ' +
                    error
                );
            }
        }
        // MUST run even when effect creation failed after disabling
        // direct scanout. Never hold the compositor's global counter after
        // the shader disappears or on extension hot-swap.
        this._releaseCompositing();
    }

    _sync() {
        if (!this._running || this._syncing)
            return;
        this._syncing = true;

        try {
            const {menu, grid, output, brightness} =
                getQuickBrightnessActors(Main.panel);
            if (!grid || !menu) {
                this._removeEffect();
                this._removeSoftwareSlider();
                this._publishStatus('Unavailable: Quick Settings not ready');
                return;
            }

            if (!this._enabled()) {
                this._removeEffect();
                this._removeSoftwareSlider();
                this._restoreNative();
                this._publishStatus('Off');
                return;
            }

            if (this._hardwareSupported()) {
                this._removeEffect();
                this._removeSoftwareSlider();
                if (brightness) {
                    this._reorderNative(brightness, output, grid);
                    this._publishStatus(
                        'Hardware: GNOME native brightness control'
                    );
                } else {
                    this._publishStatus('Hardware: waiting for native slider');
                }
                return;
            }

            // No recognized hardware backlight. GNOME's BrightnessItem
            // stays hidden; leave it alone and expose one VLIQ-native
            // fallback QuickSlider directly below the Sound slider.
            this._restoreNative();
            this._createSoftwareSlider(menu, grid, output);
            if (this._softwareSlider) {
                this._moveDirectlyAfterOutput(
                    this._softwareSlider, output, grid
                );
                const percent = this._percent();
                const value = percent / 100;
                if (Math.abs(this._softwareSlider.slider.value - value) > 0.001) {
                    this._syncingSlider = true;
                    this._softwareSlider.slider.value = value;
                    this._syncingSlider = false;
                }
                if (this._applySoftDim(percent)) {
                    this._publishStatus(
                        'Software dimming: desktop + fullscreen video (GPU)'
                    );
                }
            }
        } catch (error) {
            this._removeEffect();
            this._publishStatus('Unavailable: brightness setup failed');
            console.warn('[VLIQ][Brightness] setup error: ' + error);
        } finally {
            this._syncing = false;
        }
    }

    cleanup() {
        if (!this._running)
            return;
        this._running = false;

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._removeEffect();
        this._removeSoftwareSlider();
        this._restoreNative();

        if (this._grid && this._gridChildId) {
            try { this._grid.disconnect(this._gridChildId); } catch {}
        }
        this._grid = null;
        this._gridChildId = 0;

        if (this._brightnessManager && this._brightnessChangedId) {
            try {
                this._brightnessManager.disconnect(this._brightnessChangedId);
            } catch {}
        }
        this._brightnessManager = null;
        this._brightnessChangedId = 0;

        if (this._enabledChangedId) {
            try { this._settings.disconnect(this._enabledChangedId); } catch {}
        }
        if (this._percentChangedId) {
            try { this._settings.disconnect(this._percentChangedId); } catch {}
        }
        this._enabledChangedId = 0;
        this._percentChangedId = 0;
        this._publishStatus('Off');
        this._settings = null;
    }
}
