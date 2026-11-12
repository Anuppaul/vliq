import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const KEYBINDING_NAME = 'spotlight-keybinding';
const INPUT_SOURCE_KEYBINDING = 'switch-input-source';
const INPUT_SOURCE_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const MAX_RESULTS = 6;
const CARD_MAX_WIDTH = 860;
const CARD_MARGIN = 40;
const SEARCH_BAR_HEIGHT = 68;
const DEFAULT_VERTICAL_POSITION = 18;

function isSuperSpace(accelerator) {
    return String(accelerator ?? '')
        .replace(/\s+/g, '')
        .toLowerCase() === '<super>space';
}

function safeDescription(app) {
    try {
        return (
            app?.get_app_info?.()?.get_description?.() ??
            ''
        ).trim();
    } catch {
        return '';
    }
}

export class SpotlightSearchController {
    constructor(params) {
        this._settings = params.settings;
        this._appSystem =
            params.appSystem ??
            Shell.AppSystem.get_default();
        this._beforeOpen =
            params.beforeOpen ?? null;
        this._attachSpotlightGlass =
            params.attachSpotlightGlass ??
            null;
        this._refreshAdaptiveText =
            params.refreshAdaptiveText ??
            null;
        this._adaptiveRefreshSourceId = 0;

        this._enabled = false;
        this._visible = false;

        this._layer = null;
        this._card = null;
        this._entry = null;
        this._entryBin = null;
        this._resultsBox = null;
        this._emptyLabel = null;

        this._resultApps = [];
        this._resultButtons = [];
        this._resultSlots = [];
        this._selectedIndex = -1;
        this._searchUpdateSourceId = 0;
        this._lastQuery = null;
        this._usage = Shell.AppUsage.get_default();
        this._descriptionCache = new Map();
        this._lastGeometryKey = '';
        this._prewarmSourceId = 0;

        this._modalGrab = null;
        this._overviewHiddenId = 0;
        this._pendingOpen = false;

        this._settingsChangedId = 0;
        this._monitorsChangedId = 0;
        this._installedChangedId = 0;

        this._wmKeySettings = null;
        this._wmKeyChangedId = 0;
        this._inputSourceManager = null;
        this._spotlightKeybindingInstalled = false;
        this._inputSourceHandlerOverridden = false;
    }

    setup() {
        if (this._enabled)
            return;

        this._enabled = true;
        this._wmKeySettings =
            new Gio.Settings({
                schema_id: INPUT_SOURCE_SCHEMA,
            });

        try {
            this._inputSourceManager =
                Keyboard.getInputSourceManager?.() ??
                null;
        } catch {
            this._inputSourceManager = null;
        }

        this._settingsChangedId =
            this._settings.connect(
                'changed',
                (_settings, key) => {
                    if (
                        key === 'spotlight-enabled' ||
                        key === KEYBINDING_NAME
                    ) {
                        this._syncShortcut();
                        return;
                    }

                    if (
                        key === 'spotlight-vertical-position' &&
                        this._visible
                    ) {
                        this._lastGeometryKey = '';
                        this._syncGeometry();
                    }
                }
            );

        this._monitorsChangedId =
            Main.layoutManager.connect(
                'monitors-changed',
                () => {
                    if (this._visible)
                        this._syncGeometry();
                }
            );

        this._installedChangedId =
            this._appSystem.connect(
                'installed-changed',
                () => {
                    this._lastQuery = null;
                    this._descriptionCache.clear();
                    if (this._visible)
                        this._scheduleResultsUpdate();
                }
            );

        this._wmKeyChangedId =
            this._wmKeySettings.connect(
                'changed::' +
                    INPUT_SOURCE_KEYBINDING,
                () => this._syncShortcut()
            );

        this._syncShortcut();
        this._schedulePrewarm();
    }

    _schedulePrewarm() {
        if (
            !this._enabled ||
            this._layer ||
            this._prewarmSourceId
        ) {
            return;
        }

        this._prewarmSourceId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT_IDLE,
                700,
                () => {
                    this._prewarmSourceId = 0;

                    if (
                        this._enabled &&
                        !this._layer
                    ) {
                        this._ensureUi();
                        this._syncGeometry();
                    }

                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _cancelPrewarm() {
        if (!this._prewarmSourceId)
            return;

        try {
            GLib.source_remove(
                this._prewarmSourceId
            );
        } catch {}
        this._prewarmSourceId = 0;
    }

    _syncShortcut() {
        this._uninstallShortcut();

        if (
            !this._enabled ||
            !this._settings.get_boolean(
                'spotlight-enabled'
            )
        ) {
            this.close(true);
            return;
        }

        let inputSourceUsesSuperSpace = false;
        try {
            inputSourceUsesSuperSpace =
                this._wmKeySettings
                    .get_strv(INPUT_SOURCE_KEYBINDING)
                    .some(isSuperSpace);
        } catch {}

        if (
            inputSourceUsesSuperSpace &&
            this._inputSourceManager &&
            typeof this._inputSourceManager
                ._switchInputSource === 'function'
        ) {
            const inputSourceManager =
                this._inputSourceManager;

            Main.wm.setCustomKeybindingHandler(
                INPUT_SOURCE_KEYBINDING,
                Shell.ActionMode.ALL,
                (display, window, event, binding) => {
                    let isSpotlightShortcut = false;

                    try {
                        const symbol =
                            event?.get_key_symbol?.();
                        const state =
                            event?.get_state?.() ?? 0;
                        const superMask =
                            Clutter.ModifierType.MOD4_MASK ??
                            Clutter.ModifierType.SUPER_MASK ??
                            0;

                        isSpotlightShortcut =
                            symbol === Clutter.KEY_space &&
                            (
                                superMask === 0 ||
                                (state & superMask) !== 0
                            );
                    } catch {}

                    if (isSpotlightShortcut) {
                        this.toggle();
                        return;
                    }

                    // Preserve XF86Keyboard and any other accelerator assigned
                    // to GNOME's input-source action.
                    inputSourceManager
                        ._switchInputSource(
                            display,
                            window,
                            event,
                            binding
                        );
                }
            );

            this._inputSourceHandlerOverridden =
                true;
            return;
        }

        // If the user's input-source action does not own Super+Space, register
        // VLIQ's dedicated binding without touching their keyboard settings.
        let action = Meta.KeyBindingAction.NONE;
        try {
            action = Main.wm.addKeybinding(
                KEYBINDING_NAME,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL |
                    Shell.ActionMode.OVERVIEW,
                () => this.toggle()
            );
        } catch {
            action = Meta.KeyBindingAction.NONE;
        }

        this._spotlightKeybindingInstalled =
            action !== Meta.KeyBindingAction.NONE;

        if (!this._spotlightKeybindingInstalled) {
            console.error(
                '[VLIQ][Spotlight] unable to register Super+Space'
            );
        }
    }

    _uninstallShortcut() {
        if (this._spotlightKeybindingInstalled) {
            try {
                Main.wm.removeKeybinding(
                    KEYBINDING_NAME
                );
            } catch {}
        }
        this._spotlightKeybindingInstalled = false;

        if (this._inputSourceHandlerOverridden) {
            try {
                const inputSourceManager =
                    this._inputSourceManager ??
                    Keyboard.getInputSourceManager?.() ??
                    null;

                if (
                    inputSourceManager &&
                    typeof inputSourceManager
                        ._switchInputSource === 'function'
                ) {
                    Main.wm.setCustomKeybindingHandler(
                        INPUT_SOURCE_KEYBINDING,
                        Shell.ActionMode.ALL,
                        inputSourceManager
                            ._switchInputSource
                            .bind(inputSourceManager)
                    );
                }
            } catch (error) {
                console.error(
                    '[VLIQ][Spotlight] failed to restore input-source handler: ' +
                    error
                );
            }
        }

        this._inputSourceHandlerOverridden =
            false;
    }

    toggle() {
        if (!this._enabled)
            return;

        if (this._visible || this._pendingOpen) {
            this.close();
            return;
        }

        if (Main.overview?.visible) {
            this._pendingOpen = true;

            if (!this._overviewHiddenId) {
                this._overviewHiddenId =
                    Main.overview.connect(
                        'hidden',
                        () => {
                            if (this._overviewHiddenId) {
                                Main.overview.disconnect(
                                    this._overviewHiddenId
                                );
                                this._overviewHiddenId = 0;
                            }

                            if (
                                !this._enabled ||
                                !this._pendingOpen
                            ) {
                                return;
                            }

                            this._pendingOpen = false;
                            this._open();
                        }
                    );
            }

            Main.overview.hide();
            return;
        }

        this._open();
    }

    _scheduleAdaptiveTextRefresh() {
        if (this._adaptiveRefreshSourceId)
            return;

        this._adaptiveRefreshSourceId =
            GLib.idle_add(
                GLib.PRIORITY_HIGH_IDLE,
                () => {
                    this._adaptiveRefreshSourceId = 0;

                    if (
                        this._enabled &&
                        this._visible
                    ) {
                        try {
                            this._refreshAdaptiveText?.();
                        } catch {}
                    }

                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _cancelAdaptiveTextRefresh() {
        if (!this._adaptiveRefreshSourceId)
            return;

        try {
            GLib.source_remove(
                this._adaptiveRefreshSourceId
            );
        } catch {}
        this._adaptiveRefreshSourceId = 0;
    }

    _open() {
        if (
            !this._enabled ||
            this._visible ||
            !this._settings.get_boolean(
                'spotlight-enabled'
            )
        ) {
            return;
        }

        this._pendingOpen = false;

        try {
            this._beforeOpen?.();
        } catch {}

        this._ensureUi();
        this._syncGeometry();
        this._clearSearch();

        this._visible = true;
        this._layer.opacity = 0;
        this._card.scale_x = 0.985;
        this._card.scale_y = 0.985;
        this._layer.show();

        try {
            this._modalGrab =
                Main.pushModal(
                    this._layer,
                    {
                        actionMode:
                            Shell.ActionMode.NORMAL |
                            Shell.ActionMode.OVERVIEW,
                    }
                );
        } catch {
            this._modalGrab = null;
        }

        this._entry.grab_key_focus();
        this._entry.clutter_text
            ?.set_cursor_visible?.(true);

        this._scheduleAdaptiveTextRefresh();

        this._layer.ease({
            opacity: 255,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._card.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 130,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close(immediate = false) {
        this._pendingOpen = false;
        this._cancelSearchUpdate();
        this._cancelAdaptiveTextRefresh();

        if (this._overviewHiddenId) {
            try {
                Main.overview.disconnect(
                    this._overviewHiddenId
                );
            } catch {}
            this._overviewHiddenId = 0;
        }

        if (!this._visible) {
            if (this._layer)
                this._layer.hide();
            return;
        }

        this._visible = false;

        if (this._modalGrab) {
            try {
                Main.popModal(
                    this._modalGrab
                );
            } catch {}
            this._modalGrab = null;
        }

        if (!this._layer)
            return;

        if (immediate) {
            this._layer.remove_all_transitions?.();
            this._card?.remove_all_transitions?.();
            this._layer.hide();
            this._clearSearch();
            return;
        }

        this._layer.ease({
            opacity: 0,
            duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._visible) {
                    this._layer?.hide?.();
                    this._clearSearch();
                }
            },
        });
    }

    _ensureUi() {
        if (this._layer)
            return;

        this._layer = new St.Widget({
            name: 'vliq-spotlight-layer',
            style_class: 'vliq-spotlight-layer',
            reactive: true,
            can_focus: false,
            layout_manager:
                new Clutter.FixedLayout(),
        });
        this._layer.set_size(
            global.stage.width,
            global.stage.height
        );
        this._layer.hide();

        this._card = new St.BoxLayout({
            name: 'vliq-spotlight-card',
            style_class: 'vliq-spotlight-card',
            reactive: true,
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._card.set_pivot_point?.(0.5, 0.5);

        this._entry = new St.Entry({
            // Paint the dark rounded search field independently of whether
            // optional SpotlightGlassManager attaches successfully.
            style_class: 'search-entry vliq-spotlight-glass-entry',
            hint_text: 'Type to search',
            track_hover: true,
            can_focus: true,
        });
        this._entry.set_offscreen_redirect(
            Clutter.OffscreenRedirect.ALWAYS
        );
        this._entry.set_primary_icon(
            new St.Icon({
                style_class: 'search-entry-icon',
                icon_name: 'edit-find-symbolic',
            })
        );

        this._clearIcon = new St.Icon({
            style_class: 'search-entry-icon',
            icon_name: 'edit-clear-symbolic',
        });

        this._entryBin = new St.Bin({
            child: this._entry,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._resultsBox = new St.BoxLayout({
            style_class:
                'search-section-content vliq-spotlight-results',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });

        for (let i = 0; i < MAX_RESULTS; i++) {
            const slot =
                this._createResultSlot(i);
            this._resultSlots.push(slot);
            this._resultsBox.add_child(
                slot.button
            );
        }

        this._emptyLabel = new St.Label({
            style_class:
                'search-statustext vliq-spotlight-empty',
            text: 'No applications found',
            visible: false,
        });
        this._resultsBox.add_child(
            this._emptyLabel
        );

        this._card.add_child(this._entryBin);
        this._card.add_child(this._resultsBox);
        this._layer.add_child(this._card);

        Main.uiGroup.add_child(this._layer);

        try {
            this._attachSpotlightGlass?.(
                this._entry,
                this._resultsBox,
                this._layer
            );
        } catch (error) {
            console.error(
                '[VLIQ][Spotlight] core glass attach failed: ' +
                error
            );
        }

        this._entry.clutter_text.connect(
            'text-changed',
            () => this._scheduleResultsUpdate()
        );

        this._entry.clutter_text.connect(
            'key-press-event',
            (_actor, event) =>
                this._onEntryKeyPress(event)
        );

        this._entry.connect(
            'secondary-icon-clicked',
            () => {
                this._entry.set_text('');
                this._entry.grab_key_focus();
            }
        );

        this._layer.connect(
            'button-press-event',
            (_actor, event) => {
                let target = null;
                try {
                    target =
                        global.stage
                            .get_event_actor(event);
                } catch {}

                if (
                    target &&
                    this._card?.contains?.(target)
                ) {
                    return Clutter.EVENT_PROPAGATE;
                }

                this.close();
                return Clutter.EVENT_STOP;
            }
        );
    }

    _createResultSlot(index) {
        const button = new St.Button({
            style_class: 'list-search-result',
            can_focus: false,
            reactive: true,
            track_hover: true,
            visible: false,
        });

        const row = new St.BoxLayout({
            style_class: 'list-search-result-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        const iconBin = new St.Bin({
            style_class:
                'vliq-spotlight-result-icon-bin',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(iconBin);

        const labels = new St.BoxLayout({
            style_class:
                'vliq-spotlight-result-labels',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const title = new St.Label({
            style_class: 'list-search-result-title',
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        title.clutter_text.ellipsize =
            Pango.EllipsizeMode.END;
        labels.add_child(title);

        const subtitle = new St.Label({
            style_class: 'list-search-result-description',
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            visible: false,
        });
        subtitle.clutter_text.ellipsize =
            Pango.EllipsizeMode.END;
        labels.add_child(subtitle);

        row.add_child(labels);

        button.set_child(row);

        const slot = {
            index,
            button,
            iconBin,
            title,
            subtitle,
            app: null,
            appId: null,
        };

        button.connect(
            'clicked',
            () => {
                if (slot.app)
                    this._activateApp(slot.app);
            }
        );

        button.connect(
            'notify::hover',
            () => {
                if (
                    button.hover &&
                    button.visible
                ) {
                    this._setSelectedIndex(
                        index
                    );
                }
            }
        );

        return slot;
    }

    _bindResultSlot(slot, app) {
        if (!slot || !app)
            return;

        const appId =
            app.get_id?.() ??
            app.get_name?.() ??
            '';

        if (slot.appId !== appId) {
            slot.app = app;
            slot.appId = appId;
            slot.title.text =
                app.get_name?.() ?? '';

            let description =
                this._descriptionCache.get(appId);
            if (description === undefined) {
                description =
                    safeDescription(app);
                this._descriptionCache.set(
                    appId,
                    description
                );
            }

            slot.subtitle.text =
                description;
            slot.subtitle.visible =
                Boolean(description);

            let icon = null;
            try {
                icon =
                    app.create_icon_texture(32);
            } catch {}

            slot.iconBin.child = icon;
        } else {
            slot.app = app;
        }

        if (!slot.button.visible)
            slot.button.show();
    }

    _cancelSearchUpdate() {
        if (!this._searchUpdateSourceId)
            return;

        try {
            GLib.source_remove(
                this._searchUpdateSourceId
            );
        } catch {}
        this._searchUpdateSourceId = 0;
    }

    _scheduleResultsUpdate() {
        if (
            !this._visible ||
            this._searchUpdateSourceId
        ) {
            return;
        }

        this._searchUpdateSourceId =
            GLib.idle_add(
                GLib.PRIORITY_HIGH_IDLE,
                () => {
                    this._searchUpdateSourceId = 0;

                    if (
                        this._enabled &&
                        this._visible
                    ) {
                        this._updateResults();
                    }

                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _clearSearch() {
        this._cancelSearchUpdate();
        this._lastQuery = null;

        if (this._entry) {
            this._entry.set_text('');
            this._cancelSearchUpdate();
            this._entry.set_secondary_icon(null);
        }

        this._clearResults();
    }

    _clearResults() {
        for (const slot of this._resultSlots)
            slot.button.hide();

        this._resultApps = [];
        this._resultButtons = [];
        this._selectedIndex = -1;

        this._emptyLabel?.hide?.();
        this._resultsBox?.hide?.();
    }

    _updateResults() {
        if (
            !this._entry ||
            !this._resultsBox
        ) {
            return;
        }

        const query =
            this._entry.get_text().trim();

        if (query === this._lastQuery)
            return;
        this._lastQuery = query;

        if (query) {
            this._entry.set_secondary_icon(
                this._clearIcon
            );
        } else {
            this._entry.set_secondary_icon(null);
            this._clearResults();
            return;
        }

        let groups = [];
        try {
            groups =
                Shell.AppSystem.search(query) ??
                [];
        } catch {
            groups = [];
        }

        const seen = new Set();
        const apps = [];

        for (const rawGroup of groups) {
            const group = [...rawGroup];

            try {
                group.sort(
                    (a, b) =>
                        this._usage.compare(a, b)
                );
            } catch {}

            for (const id of group) {
                if (
                    seen.has(id) ||
                    apps.length >= MAX_RESULTS
                ) {
                    continue;
                }

                seen.add(id);

                const app =
                    this._appSystem.lookup_app(id);
                if (!app)
                    continue;

                try {
                    const appInfo =
                        app.get_app_info?.();
                    if (
                        appInfo?.should_show &&
                        !appInfo.should_show()
                    ) {
                        continue;
                    }
                } catch {}

                apps.push(app);
            }

            if (apps.length >= MAX_RESULTS)
                break;
        }

        this._resultApps = apps;
        this._resultButtons = [];

        for (let i = 0; i < MAX_RESULTS; i++) {
            const slot =
                this._resultSlots[i];

            if (i < apps.length) {
                this._bindResultSlot(
                    slot,
                    apps[i]
                );
                this._resultButtons.push(
                    slot.button
                );
            } else {
                slot.button.hide();
            }
        }

        this._emptyLabel.visible =
            apps.length === 0;
        this._resultsBox.show();

        if (apps.length)
            this._setSelectedIndex(0);
        else
            this._selectedIndex = -1;

        this._scheduleAdaptiveTextRefresh();
    }

    _setSelectedIndex(index) {
        if (!this._resultButtons.length) {
            this._selectedIndex = -1;
            return;
        }

        const normalized =
            (
                index %
                this._resultButtons.length +
                this._resultButtons.length
            ) %
            this._resultButtons.length;

        this._selectedIndex = normalized;

        this._resultButtons.forEach(
            (button, buttonIndex) => {
                if (
                    buttonIndex ===
                    normalized
                ) {
                    button.add_style_pseudo_class(
                        'focus'
                    );
                } else {
                    button.remove_style_pseudo_class(
                        'focus'
                    );
                }
            }
        );
    }

    _moveSelection(delta) {
        if (!this._resultButtons.length)
            return;

        const base =
            this._selectedIndex >= 0
                ? this._selectedIndex
                : 0;
        this._setSelectedIndex(
            base + delta
        );
    }

    _onEntryKeyPress(event) {
        const symbol =
            event.get_key_symbol();

        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._moveSelection(1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._activateSelected();
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _activateSelected() {
        if (
            this._selectedIndex < 0 ||
            this._selectedIndex >=
                this._resultApps.length
        ) {
            return;
        }

        this._activateApp(
            this._resultApps[
                this._selectedIndex
            ]
        );
    }

    _activateApp(app) {
        if (!app)
            return;

        this.close(true);

        try {
            app.activate();
        } catch (error) {
            console.error(
                '[VLIQ][Spotlight] app activation failed: ' +
                error
            );
        }
    }

    _syncGeometry() {
        if (!this._layer || !this._card)
            return;

        const monitor =
            Main.layoutManager.currentMonitor ??
            Main.layoutManager.primaryMonitor ??
            {
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
            };

        const width = Math.min(
            CARD_MAX_WIDTH,
            Math.max(
                360,
                monitor.width -
                    CARD_MARGIN * 2
            )
        );

        let verticalPosition =
            DEFAULT_VERTICAL_POSITION;
        try {
            verticalPosition =
                this._settings.get_int(
                    'spotlight-vertical-position'
                );
        } catch {}

        verticalPosition =
            Math.max(
                8,
                Math.min(
                    55,
                    verticalPosition
                )
            );

        const x =
            monitor.x +
            Math.round(
                (monitor.width - width) / 2
            );

        const rawY =
            monitor.y +
            Math.round(
                monitor.height *
                verticalPosition /
                100
            );
        const minY =
            monitor.y + CARD_MARGIN;
        const maxY =
            monitor.y +
            monitor.height -
            SEARCH_BAR_HEIGHT -
            CARD_MARGIN;
        const y =
            Math.max(
                minY,
                Math.min(maxY, rawY)
            );

        const geometryKey = [
            global.stage.width,
            global.stage.height,
            monitor.x,
            monitor.y,
            monitor.width,
            monitor.height,
            width,
            y,
        ].join(':');

        if (
            geometryKey ===
            this._lastGeometryKey
        ) {
            return;
        }
        this._lastGeometryKey =
            geometryKey;

        if (
            this._layer.width !==
                global.stage.width ||
            this._layer.height !==
                global.stage.height
        ) {
            this._layer.set_size(
                global.stage.width,
                global.stage.height
            );
        }

        if (this._card.width !== width)
            this._card.set_width(width);

        if (this._entry) {
            if (this._entry.width !== width)
                this._entry.set_width(width);
            if (
                this._entry.height !==
                SEARCH_BAR_HEIGHT
            ) {
                this._entry.set_height(
                    SEARCH_BAR_HEIGHT
                );
            }
        }

        if (
            this._card.x !== x ||
            this._card.y !== y
        ) {
            this._card.set_position(x, y);
        }
    }

    destroy() {
        if (!this._enabled)
            return;

        this._enabled = false;
        this._cancelPrewarm();
        this._cancelSearchUpdate();
        this._cancelAdaptiveTextRefresh();
        this.close(true);
        this._uninstallShortcut();

        if (
            this._settings &&
            this._settingsChangedId
        ) {
            try {
                this._settings.disconnect(
                    this._settingsChangedId
                );
            } catch {}
        }
        this._settingsChangedId = 0;

        if (this._monitorsChangedId) {
            try {
                Main.layoutManager.disconnect(
                    this._monitorsChangedId
                );
            } catch {}
        }
        this._monitorsChangedId = 0;

        if (
            this._appSystem &&
            this._installedChangedId
        ) {
            try {
                this._appSystem.disconnect(
                    this._installedChangedId
                );
            } catch {}
        }
        this._installedChangedId = 0;

        if (
            this._wmKeySettings &&
            this._wmKeyChangedId
        ) {
            try {
                this._wmKeySettings.disconnect(
                    this._wmKeyChangedId
                );
            } catch {}
        }
        this._wmKeyChangedId = 0;

        try {
            this._layer?.destroy?.();
        } catch {}

        this._layer = null;
        this._card = null;
        this._entry = null;
        this._resultsBox = null;
        this._emptyLabel = null;
        this._resultApps = [];
        this._resultButtons = [];
        this._resultSlots = [];
        this._descriptionCache.clear();
        this._descriptionCache = null;
        this._clearIcon = null;
        this._lastGeometryKey = '';
        this._settings = null;
        this._appSystem = null;
        this._wmKeySettings = null;
        this._inputSourceManager = null;
        this._attachSpotlightGlass = null;
        this._refreshAdaptiveText = null;
    }
}
