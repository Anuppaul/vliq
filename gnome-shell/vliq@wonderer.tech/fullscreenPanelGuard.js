// VLIQ fullscreen chrome visibility guard — GNOME Shell 50.
//
// Mutter's fullscreen direct-scanout inhibitor keeps fullscreen video inside
// the uiGroup compositor so software brightness applies. GNOME's native
// panelBox is already tracked with trackFullscreen:true; however, VLIQ's
// independent top-panel Liquid Glass actor lives directly under uiGroup and
// can remain drawn after the native panel disappears.
//
// This guard reconciles ONLY the native panelBox on the primary monitor and
// VLIQ's owned top-panel glass actor. It does not change Ubuntu Dock native
// hide settings, rewrite stage/window opacity or affect fullscreen video.

export function primaryPanelIsFullscreen(layout, display) {
    if (!layout || !display)
        return false;
    const index = layout.primaryMonitor?.index ?? layout.primaryIndex;
    if (!Number.isInteger(index) || index < 0)
        return false;
    try {
        if (display.get_monitor_in_fullscreen?.(index))
            return true;
    } catch {}
    try {
        const focused = display.focus_window;
        if (
            focused?.is_fullscreen?.() &&
            focused.get_monitor?.() === index
        )
            return true;
    } catch {}
    try {
        return Boolean(layout.primaryMonitor?.inFullscreen);
    } catch {
        return false;
    }
}

export class FullscreenPanelChromeGuard {
    constructor({layout, display, panel, panelManager}) {
        this._layout = layout;
        this._display = display;
        this._panel = panel;
        this._manager = panelManager;
        this._signals = [];
        this._running = false;
        this._syncing = false;
        this._forcedNativeHide = false;
        this._glassSuppressed = false;
        this._lastFullscreen = null;
    }

    setup() {
        if (this._running)
            return;
        this._running = true;

        // GNOME Shell uses this exact display signal for fullscreen state
        // changes. Mapped/visible listeners also repair late native
        // allocations without polling or monkeypatching its layout manager.
        for (const [actor, signal] of [
            [this._display, 'in-fullscreen-changed'],
            [this._layout?.panelBox, 'notify::visible'],
            [this._panel, 'notify::mapped'],
        ]) {
            try {
                if (!actor?.connect)
                    continue;
                const id = actor.connect(signal, () => this.sync());
                if (id)
                    this._signals.push({actor, id});
            } catch (error) {
                console.warn(
                    '[VLIQ][FullscreenPanel] optional ' +
                    signal + ' signal unavailable: ' + error
                );
            }
        }

        // The vendor DashManager uses a stage-level glass layer separate
        // from the native panelBox. Make its per-frame visibility gate
        // respect GNOME's monitor-fullscreen state as well as mapped state.
        try {
            this._manager?.setVisibilityGate?.(
                () => this._shouldShowGlass()
            );
        } catch {}
        this.sync();
    }

    _shouldShowGlass() {
        return Boolean(
            this._running &&
            !primaryPanelIsFullscreen(this._layout, this._display) &&
            this._layout?.panelBox?.visible !== false &&
            this._panel?.visible !== false &&
            this._panel?.mapped !== false
        );
    }

    sync() {
        if (!this._running || this._syncing)
            return;
        this._syncing = true;
        try {
            const fullscreen =
                primaryPanelIsFullscreen(this._layout, this._display);
            if (this._lastFullscreen !== fullscreen) {
                this._lastFullscreen = fullscreen;
                // A full-desktop BrightnessContrastEffect is an offscreen
                // postprocessing pass. Invalidate its scene once per state
                // transition so a cached top-panel glass frame cannot linger.
                this._layout?.uiGroup?.queue_redraw?.();
            }
            const box = this._layout?.panelBox;

            // GNOME itself normally hides panelBox (trackFullscreen:true).
            // Only repair a still-visible native panel when its PRIMARY
            // monitor is actually fullscreen. Do not hide the panel for a
            // fullscreen video on an unrelated secondary monitor.
            if (fullscreen && box?.visible === true) {
                this._forcedNativeHide = true;
                box.visible = false;
            } else if (!fullscreen && this._forcedNativeHide) {
                this._forcedNativeHide = false;
                // Hand visibility back to GNOME, honoring session mode
                // and Overview. Do not force a panel visible when GNOME
                // would otherwise keep it hidden.
                if (typeof this._layout?._updateVisibility === 'function')
                    this._layout._updateVisibility();
                else if (box)
                    box.visible = true;
            }

            const background = this._manager?.bgActor;
            if (!background) {
                // New GNOME 50 top-bar islands have three bounded materials,
                // not DashManager's single bgActor. Reconcile their visibility
                // immediately on fullscreen/overview signals, instead of
                // leaving one frame of glass over a fullscreen video.
                this._manager?.sync?.();
                return;
            }

            if (!this._shouldShowGlass()) {
                if (background.opacity !== 0)
                    background.opacity = 0;
                this._glassSuppressed = true;
                return;
            }

            // Only restore opacity if *this guard* suppressed it. If
            // another system hid the glass, leave its state untouched.
            if (this._glassSuppressed) {
                this._glassSuppressed = false;
                const opacity = this._panel?.get_paint_opacity?.() ??
                    this._panel?.opacity ?? 255;
                background.opacity = opacity;
                background.queue_redraw?.();
            }
        } catch (error) {
            console.warn(
                '[VLIQ][FullscreenPanel] visibility sync failed: ' +
                error
            );
        } finally {
            this._syncing = false;
        }
    }

    cleanup() {
        if (!this._running)
            return;
        this._running = false;

        for (const {actor, id} of this._signals) {
            try { actor.disconnect(id); } catch {}
        }
        this._signals = [];

        // Remove the callback so a disposed runtime cannot be referenced by
        // vendor frame updates after VLIQ hot-swaps.
        try { this._manager?.setVisibilityGate?.(null); } catch {}

        if (this._forcedNativeHide) {
            this._forcedNativeHide = false;
            try {
                if (typeof this._layout?._updateVisibility === 'function')
                    this._layout._updateVisibility();
                // If still fullscreen, leave GNOME's panel hidden; if
                // fullscreen has ended and layout updater is absent,
                // restore only the visibility that VLIQ changed.
                else if (!primaryPanelIsFullscreen(this._layout, this._display))
                    this._layout.panelBox.visible = true;
            } catch {}
        }

        // The vendor manager owns the actor and cleans it up separately.
        // Never forcibly show a glass actor during a fullscreen hot-swap.
        this._glassSuppressed = false;
        this._manager = null;
        this._panel = null;
        this._layout = null;
        this._display = null;
    }
}
