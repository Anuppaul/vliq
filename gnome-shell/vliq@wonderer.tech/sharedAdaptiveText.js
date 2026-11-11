import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    GLASS_TEXT_PALETTE,
} from './glassMaterialSystem.js';

const TEXT_LIGHT_CLASS = 'vliq-shared-text-light';
const TEXT_DARK_CLASS = 'vliq-shared-text-dark';

const SHELL_CARD_CLASS = 'vliq-liquid-shell-card';
const POPUP_CLASS = 'vliq-liquid-popup-content';
const SEARCH_PROVIDER_CLASS = 'search-section-content';
const SPOTLIGHT_SEARCH_CLASS =
    'vliq-spotlight-glass-entry';

const SCAN_INTERVAL_US = 1000000;
const FRAME_TICK_GATE_US = 250000;
const SURFACE_SAMPLE_INTERVAL_US = 1800000;
const PANEL_SAMPLE_INTERVAL_US = 3200000;
const SAMPLE_GRID = 24;
const SWITCH_ADVANTAGE = 1.18;
const MIN_READABLE_CONTRAST = 4.5;

const LIGHT_TEXT = GLASS_TEXT_PALETTE.light;
const DARK_TEXT = GLASS_TEXT_PALETTE.dark;

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

    let sum = 0;
    for (let i = trim; i < sorted.length - trim; i++)
        sum += sorted[i];

    return sum / Math.max(
        1,
        sorted.length - trim * 2
    );
}

function contrastRatio(a, b) {
    return (
        (Math.max(a, b) + 0.05) /
        (Math.min(a, b) + 0.05)
    );
}

function hasPseudo(actor, name) {
    try {
        return Boolean(
            actor?.has_style_pseudo_class?.(name)
        );
    } catch {
        return false;
    }
}

const LIGHT_LUMA = hexLuminance(LIGHT_TEXT);
const DARK_LUMA = hexLuminance(DARK_TEXT);

const SEMANTIC_CLASS_FRAGMENTS = Object.freeze([
    'error',
    'warning',
    'critical',
    'success',
    'destructive',
    'suggested',
    'accent',
    'calendar-today',
    'semantic-tint',
]);

export class SharedAdaptiveTextManager {
    constructor(params) {
        this._vendor = params.vendor;

        this._enabled = false;
        this._screenshot = null;

        this._targets = new Map();
        this._styledActors = new Map();

        this._stageId = 0;
        this._lastTickUs = 0;
        this._lastScanUs = 0;

        this._surfaceSamplePending = false;
        this._panelSamplePending = false;
        this._lastSurfaceSampleUs = 0;
        this._lastPanelSampleUs = 0;

        this._surfaceGeneration = 0;
        this._panelGeneration = 0;
    }

    setup() {
        if (this._enabled)
            return;

        this._enabled = true;
        this._scan(true);

        // Keep sampling aligned with the compositor's frame boundary. The
        // cadence checks inside _tick() make this callback effectively a cheap
        // timestamp test on ordinary frames, while screenshots never start
        // from an arbitrary GLib timeout in the middle of pointer/input work.
        this._stageId = global.stage.connect(
            'before-update',
            () => this._tick()
        );

        console.log(
            '[VLIQ][AdaptiveText] shared Shell text polarity active'
        );
    }

    _isManagedPopup(actor) {
        const classes = classesOf(actor);
        if (!classes.includes(POPUP_CLASS))
            return false;

        // Date Menu + Quick Settings already have finer per-card adaptive
        // foreground sampling. Do not stack a second polarity owner on them.
        return !(
            classes.includes('datemenu-popover') ||
            classes.includes('quick-settings')
        );
    }

    _bottomTaskbarClock() {
        const panel = Main.panel;
        if (!panel || !classesOf(panel).includes('vliq-bottom-taskbar'))
            return null;

        // GNOME Shell 50's DateMenuButton owns a native St.Label named
        // _clockDisplay (also exposed as label_actor). Keep that actor:
        // no duplicate text, no altered menu input or container ownership.
        const dateMenu = panel.statusArea?.dateMenu;
        const label = dateMenu?._clockDisplay ??
            dateMenu?.label_actor ?? null;
        return label instanceof St.Label && label.get_parent?.()
            ? label : null;
    }

    _isTarget(actor) {
        if (!actor)
            return false;

        if (actor === Main.panel)
            return true;

        const classes = classesOf(actor);

        return (
            classes.includes(SHELL_CARD_CLASS) ||
            classes.includes(SEARCH_PROVIDER_CLASS) ||
            classes.includes(SPOTLIGHT_SEARCH_CLASS) ||
            this._isManagedPopup(actor)
        );
    }

    _scan(force = false) {
        if (!this._enabled)
            return;

        const nowUs = GLib.get_monotonic_time();
        if (
            !force &&
            nowUs - this._lastScanUs < SCAN_INTERVAL_US
        ) {
            return;
        }
        this._lastScanUs = nowUs;

        const found = new Set();

        if (Main.panel)
            found.add(Main.panel);

        // Unlike the three top islands, the bottom taskbar places the
        // native clock on the far right. Its background may have opposite
        // luminance to the rest of the panel, so it needs its OWN sample.
        // Reuse the existing surface screenshot batch; no new stage hook.
        const dateClock = this._bottomTaskbarClock();
        if (dateClock)
            found.add(dateClock);

        const walk = actor => {
            if (!actor)
                return;

            const name = actor.get_name?.() ?? '';
            const spotlightTree =
                name.startsWith(
                    'vliq-spotlight'
                );

            if (
                (
                    name.startsWith('vliq-') &&
                    !spotlightTree
                ) ||
                name.startsWith('lg-')
            ) {
                return;
            }

            if (this._isTarget(actor))
                found.add(actor);

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };

        walk(Main.uiGroup);

        for (const [actor] of this._targets) {
            if (found.has(actor))
                continue;
            this._restoreRoot(actor);
            this._targets.delete(actor);
        }

        let addedSurface = false;
        let addedPanel = false;

        for (const actor of found) {
            if (this._targets.has(actor))
                continue;

            const kind =
                actor === Main.panel
                    ? 'panel'
                    : 'surface';

            this._targets.set(actor, {
                useDarkText: null,
                kind,
            });

            if (kind === 'panel')
                addedPanel = true;
            else
                addedSurface = true;
        }

        // A newly discovered surface should not wait for the slower steady
        // state cadence. Force the next tick to sample it immediately.
        if (addedSurface)
            this._lastSurfaceSampleUs = 0;
        if (addedPanel)
            this._lastPanelSampleUs = 0;
    }

    _rootVisible(actor) {
        if (!actor)
            return false;

        return Boolean(
            actor.visible &&
            actor.mapped &&
            (actor.get_paint_opacity?.() ??
                actor.opacity ??
                255) > 0
        );
    }

    _isSemanticText(actor, root) {
        let node = actor;
        let guard = 32;

        while (node && guard-- > 0) {
            if (
                hasPseudo(node, 'default') ||
                hasPseudo(node, 'checked') ||
                hasPseudo(node, 'selected')
            ) {
                return true;
            }

            const classes = classesOf(node);
            if (
                classes.some(name =>
                    SEMANTIC_CLASS_FRAGMENTS.some(fragment =>
                        name.includes(fragment)
                    )
                )
            ) {
                return true;
            }

            if (node === root)
                break;

            node = node.get_parent?.() ?? null;
        }

        return false;
    }

    _textActors(root) {
        const found = [];
        // Only in Bottom mode: the clock must be styled from its separate
        // local backdrop, never overwritten by the whole-panel sample.
        const separatelySampledClock =
            root === Main.panel ? this._bottomTaskbarClock() : null;

        const walk = actor => {
            if (!actor || actor === separatelySampledClock)
                return;

            if (
                actor !== root &&
                (
                    actor instanceof St.Label ||
                    actor instanceof St.Entry
                )
            ) {
                if (
                    actor.visible &&
                    !this._isSemanticText(actor, root)
                ) {
                    found.push(actor);
                }
            }

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };

        if (root instanceof St.Entry ||
            (root instanceof St.Label && root.visible))
            found.push(root);
        else
            walk(root);

        return found;
    }

    _styleTextActor(actor, root, useDarkText) {
        if (!actor)
            return;

        let state = this._styledActors.get(actor);

        if (!state) {
            state = {
                root,
                originalStyle:
                    actor.get_style?.() ??
                    actor.style ??
                    null,
                useDarkText: null,
            };
            this._styledActors.set(actor, state);

            try {
                actor.connect('destroy', () => {
                    this._styledActors.delete(actor);
                });
            } catch {}
        } else {
            state.root = root;
        }

        const color =
            useDarkText
                ? DARK_TEXT
                : LIGHT_TEXT;

        if (state.useDarkText !== useDarkText) {
            try {
                actor.remove_style_class_name?.(
                    TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    TEXT_DARK_CLASS
                );
                actor.add_style_class_name?.(
                    useDarkText
                        ? TEXT_DARK_CLASS
                        : TEXT_LIGHT_CLASS
                );
            } catch {}

            state.useDarkText = useDarkText;
        }

        // Match the approved Overview caption behavior exactly: apply the
        // black/white decision directly to the text actor. This outranks
        // Yaru/GNOME descendant foreground rules that can otherwise keep
        // theme/accent colours such as green even after our polarity class
        // is correct.
        try {
            const original =
                state.originalStyle ?? '';
            const prefix = original
                ? original.replace(/;\s*$/, '') + '; '
                : '';

            const desiredStyle =
                prefix + 'color: ' + color + ';';

            // Sampling unchanged polarity must not trigger another Shell
            // style invalidation. Still correct a later external override.
            const currentStyle =
                actor.get_style?.() ??
                actor.style ??
                null;
            if (currentStyle !== desiredStyle)
                actor.set_style?.(desiredStyle);
        } catch {}
    }

    _applyRootPolarity(root, useDarkText) {
        if (!root || useDarkText === null)
            return;

        for (const actor of this._textActors(root))
            this._styleTextActor(
                actor,
                root,
                useDarkText
            );
    }

    _restoreRoot(root) {
        for (const [actor, state] of [...this._styledActors]) {
            if (state.root !== root)
                continue;

            try {
                actor.remove_style_class_name?.(
                    TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    TEXT_DARK_CLASS
                );
            } catch {}

            try {
                actor.set_style?.(
                    state.originalStyle ?? null
                );
            } catch {}

            this._styledActors.delete(actor);
        }
    }

    _captureFrame(rect) {
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
                stream = Gio.MemoryOutputStream.new_resizable();

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

    _luminance(frame, rect) {
        if (!frame || !finiteRect(rect))
            return null;

        let [x, y, width, height] = rect;

        const insetX = Math.min(10, width * 0.04);
        const insetY = Math.min(8, height * 0.10);

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
                SAMPLE_GRID
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

    _chooseDarkText(target, luminance) {
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

        const state = this._targets.get(target);
        const previous = state?.useDarkText ?? null;

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
            current * SWITCH_ADVANTAGE
        ) {
            return !previous;
        }

        return previous;
    }

    _visibleEntries(kind) {
        const entries = [];

        for (const [actor, state] of this._targets) {
            if (
                state.kind !== kind ||
                !this._rootVisible(actor)
            ) {
                continue;
            }

            // Sample the button's full padded glass backdrop, not only
            // the tight glyph rectangle (which would bias the histogram
            // toward the PREVIOUS clock text colour). Style the actual
            // native clock label using the resulting local polarity.
            const sampleActor = actor === this._bottomTaskbarClock()
                ? (Main.panel?.statusArea?.dateMenu?.container ?? actor)
                : actor;
            const rect = this._vendor.getTransformedRect(sampleActor);

            if (!finiteRect(rect))
                continue;

            entries.push({actor, rect});
        }

        return entries;
    }

    async _sampleEntries(entries, generation, kind) {
        if (
            !this._enabled ||
            !entries.length
        ) {
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const {rect} of entries) {
            minX = Math.min(minX, rect[0]);
            minY = Math.min(minY, rect[1]);
            maxX = Math.max(maxX, rect[0] + rect[2]);
            maxY = Math.max(maxY, rect[1] + rect[3]);
        }

        const frame = await this._captureFrame([
            minX,
            minY,
            maxX - minX,
            maxY - minY,
        ]);

        const liveGeneration =
            kind === 'panel'
                ? this._panelGeneration
                : this._surfaceGeneration;

        if (
            !frame ||
            !this._enabled ||
            generation !== liveGeneration
        ) {
            return;
        }

        for (const {actor, rect} of entries) {
            const luminance =
                this._luminance(frame, rect);
            const useDarkText =
                this._chooseDarkText(
                    actor,
                    luminance
                );

            if (useDarkText === null)
                continue;

            const state = this._targets.get(actor);
            if (state)
                state.useDarkText = useDarkText;

            this._applyRootPolarity(
                actor,
                useDarkText
            );
        }
    }

    _maybeSample(kind) {
        const panel = kind === 'panel';
        const nowUs = GLib.get_monotonic_time();
        const pending = panel
            ? this._panelSamplePending
            : this._surfaceSamplePending;
        const last = panel
            ? this._lastPanelSampleUs
            : this._lastSurfaceSampleUs;
        const interval = panel
            ? PANEL_SAMPLE_INTERVAL_US
            : SURFACE_SAMPLE_INTERVAL_US;

        // Cadence/pending checks must happen before _visibleEntries().
        // That method reads transformed geometry for every registered target;
        // doing it on every compositor frame defeated the sampling interval.
        if (
            pending ||
            (
                last > 0 &&
                nowUs - last < interval
            )
        ) {
            return;
        }

        const entries = this._visibleEntries(kind);
        if (!entries.length) {
            // Avoid re-walking an empty/invisible target set every frame.
            // _scan() resets this timestamp to zero as soon as it discovers a
            // new target, so newly-visible surfaces still get sampled quickly.
            if (panel)
                this._lastPanelSampleUs = nowUs;
            else
                this._lastSurfaceSampleUs = nowUs;
            return;
        }

        let generation;

        if (panel) {
            this._panelSamplePending = true;
            this._lastPanelSampleUs = nowUs;
            generation = ++this._panelGeneration;
        } else {
            this._surfaceSamplePending = true;
            this._lastSurfaceSampleUs = nowUs;
            generation = ++this._surfaceGeneration;
        }

        this._sampleEntries(
            entries,
            generation,
            kind
        )
            .catch(() => {})
            .finally(() => {
                if (panel) {
                    if (generation === this._panelGeneration)
                        this._panelSamplePending = false;
                } else if (
                    generation === this._surfaceGeneration
                ) {
                    this._surfaceSamplePending = false;
                }
            });
    }

    _tick() {
        if (!this._enabled)
            return;

        const nowUs = GLib.get_monotonic_time();
        if (
            this._lastTickUs > 0 &&
            nowUs - this._lastTickUs <
                FRAME_TICK_GATE_US
        ) {
            return;
        }
        this._lastTickUs = nowUs;

        this._scan(false);
        this._maybeSample('surface');
        this._maybeSample('panel');
    }

    refresh() {
        this._surfaceGeneration++;
        this._panelGeneration++;
        this._surfaceSamplePending = false;
        this._panelSamplePending = false;
        this._lastTickUs = 0;
        this._lastSurfaceSampleUs = 0;
        this._lastPanelSampleUs = 0;
        this._scan(true);

        // Preserve the old "next compositor frame" responsiveness for explicit
        // appearance/monitor refreshes without keeping a permanent frame hook.
        this._maybeSample('surface');
        this._maybeSample('panel');
    }

    cleanup() {
        if (!this._enabled)
            return;

        this._enabled = false;

        if (this._stageId) {
            try {
                global.stage.disconnect(
                    this._stageId
                );
            } catch {}
            this._stageId = 0;
        }

        this._surfaceGeneration++;
        this._panelGeneration++;

        for (const root of this._targets.keys())
            this._restoreRoot(root);

        this._targets.clear();

        for (const [actor, state] of this._styledActors) {
            try {
                actor.remove_style_class_name?.(
                    TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    TEXT_DARK_CLASS
                );
            } catch {}

            try {
                actor.set_style?.(
                    state.originalStyle ?? null
                );
            } catch {}
        }
        this._styledActors.clear();

        this._screenshot = null;
        this._surfaceSamplePending = false;
        this._panelSamplePending = false;
        this._lastTickUs = 0;
        this._lastSurfaceSampleUs = 0;
        this._lastPanelSampleUs = 0;

        console.log(
            '[VLIQ][AdaptiveText] stopped'
        );
    }
}
