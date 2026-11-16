// Fixed Milky material, intentionally independent of legacy GSettings:
// native Bottom/Full/3-Part header = black 60%, Date/Quick Settings = white.
// No grain, image URLs, shader or per-frame work.
const HEADER_FILL='rgba(0,0,0,0.600)';
const POPUP_FILL='rgba(245,249,255,0.920)';
const POPUP_RIM='inset 0 0 0 1px rgba(255,255,255,0.200)';

export function milkyPaintTokens(role = 'header') {
    return role === 'popup'
        ? {fill: POPUP_FILL, rim: POPUP_RIM}
        : {fill: HEADER_FILL, rim: 'none'};
}

function fixedSurfaceCss(selectors, material) {
    return selectors.join(',\n') + ' {\n' +
        '  background-color: ' + material.fill + ' !important;\n' +
        '  background-image: none !important;\n' +
        '  border: 0 !important;\n' +
        '  box-shadow: ' + material.rim + ' !important;\n' +
        '}\n';
}

export function buildMilkyAppearanceCss(state = {}) {
    if (!state.milky)
        return '';
    const headers=[
        ...['panelLeft','panelCenter','panelRight'].map(id =>
            '.vliq-global-milky #panel.vliq-three-islands #' + id +
            '.vliq-panel-island'),
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-full-header',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-full-header.vliq-top-header-ready',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-bottom-taskbar',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-bottom-taskbar.vliq-top-header-ready',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-bottom-taskbar.vliq-bottom-taskbar-glass-attached',
        // Milky is ALWAYS black 60%, even with GNOME Dark Style selected.
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-bottom-taskbar.vliq-system-dark-taskbar',
    ];
    const popups=[
        '.vliq-global-milky .vliq-liquid-popup-content.quick-settings',
        '.vliq-global-milky .vliq-liquid-popup-content.datemenu-popover',
        '.vliq-global-milky .popup-menu-content.quick-settings',
        '.vliq-global-milky .popup-menu-content.datemenu-popover',
        // GNOME puts arrow-expanded Wired/Wi-Fi/Bluetooth/Power menus in
        // QuickSettingsMenu._overlay, a sibling of menu.box. Give the
        // actual quick-toggle-menu backplate the same fixed 92% white
        // without painting a second overlay container.
        '.vliq-global-milky .quick-toggle-menu',
        '.vliq-global-milky .vliq-liquid-quick-menu-root .quick-toggle-menu',
    ];
    const otherLiquidSurfaces=[
        // Reuse the real Liquid Glass actor classes, not generic windows.
        // All non-header VLIQ glass surfaces share the fixed white 92%.
        '.vliq-global-milky .vliq-liquid-popup-content',
        '.vliq-global-milky .vliq-liquid-popup-content.popup-menu-content',
        '.vliq-global-milky .vliq-liquid-shell-card',
        '.vliq-global-milky .vliq-app-preview-card.vliq-liquid-shell-card',
        '.vliq-global-milky .vliq-native-notification-glass',
        '.vliq-global-milky .vliq-milky-osd',
        '.vliq-global-milky .vliq-orb-face-v2',
        '.vliq-global-milky .vliq-app-button',
        '.vliq-global-milky .vliq-spotlight-glass-entry',
        '.vliq-global-milky .vliq-spotlight-glass-results',
        '.vliq-global-milky .dash-background.vliq-ubuntu-dock-glass-background',
        '.vliq-global-milky .dash-background.vliq-ubuntu-dock-panel-background',
        '.vliq-global-milky #overviewGroup .window-close.vliq-window-close-shared-glass',
        '.vliq-global-milky #overviewGroup .window-icon.vliq-window-icon-shared-glass',
    ];
    const inactive=['panelLeft','panelCenter','panelRight'].map(id =>
        '.vliq-global-milky #panel.vliq-three-islands #' + id +
        '.vliq-panel-island.vliq-panel-island-inactive');
    return fixedSurfaceCss(headers,milkyPaintTokens('header')) +
        fixedSurfaceCss([...popups,...otherLiquidSurfaces],
            milkyPaintTokens('popup')) +
        fixedSurfaceCss(inactive,{
            fill:'transparent',rim:'none',
        });
}

// St.Widget inline paint bypasses stylesheet load order. These role-specific
// rules only affect native paint owners, never their interactive children.
export function milkyInlineStyle(_state = {},role = 'header') {
    const {fill,rim}=milkyPaintTokens(role);
    return 'background-color: ' + fill + ' !important; ' +
        'background-image: none !important; ' +
        'box-shadow: ' + rim + ' !important;';
}

export function milkyCardActors(panel,islands,_state={}) {
    const result=[];
    if(!panel)
        return result;
    const add=(actor,role)=>{
        if(actor && !result.some(item=>item.actor===actor))
            result.push({actor,role});
    };
    add(panel.statusArea?.quickSettings?.menu?.box,'popup');
    add(panel.statusArea?.dateMenu?.menu?.box,'popup');
    const mode=islands?._layoutMode ??
        (panel.has_style_class_name?.('vliq-bottom-taskbar')
            ?'bottom':panel.has_style_class_name?.('vliq-three-islands')
                ?'split':'full');
    if(mode==='full'||mode==='bottom')
        add(panel,'header');
    else if(mode==='split'){
        for(const actor of [panel._leftBox,panel._centerBox,panel._rightBox]){
            if(actor?.has_style_class_name?.('vliq-panel-island') &&
                !actor?.has_style_class_name?.('vliq-panel-island-inactive'))
                add(actor,'header');
        }
    }
    return result;
}


export class MilkyActorPainter {
    constructor() {
        // Strong references exist only while Milky mode is active. sync([])
        // and clear() release every actor; no per-frame signal or timer.
        this._entries = new Map();
    }

    _restore(actor, entry) {
        // Respect external extensions: never overwrite a newer inline style.
        if (actor?.get_style?.() === entry.applied) {
            try { actor.set_style(entry.original); } catch {}
        }
    }

    sync(actors = [], state = {}) {
        const enabled = state.milky === true;
        const allowed = new Map(
            enabled
                ? actors.map(item => item?.actor
                    ? [item.actor, item.role]
                    : [item, 'header'])
                : []
        );
        for (const [actor, entry] of this._entries) {
            if (allowed.has(actor))
                continue;
            this._restore(actor, entry);
            this._entries.delete(actor);
        }
        if (!enabled)
            return;
        for (const [actor, role] of allowed) {
            const paint = milkyInlineStyle(state, role);
            if (typeof actor?.set_style !== 'function' ||
                typeof actor?.get_style !== 'function')
                continue;
            try {
                const current = actor.get_style() ?? '';
                let entry = this._entries.get(actor);
                if (!entry) {
                    entry = {original: current, applied: null};
                    this._entries.set(actor, entry);
                } else if (current !== entry.applied) {
                    // Another owner modified the widget while Milky was
                    // enabled. Rebase on their style rather than erasing it.
                    entry.original = current;
                }
                const base = entry.original?.trim() ?? '';
                const next = (base ? base + ' ' : '') + paint;
                if (current !== next)
                    actor.set_style(next);
                entry.applied = next;
            } catch (error) {
                // A destroyed/unrealized actor should not break all other
                // cards or leave a strong reference in the registry.
                this._entries.delete(actor);
            }
        }
    }

    clear() {
        this.sync([], {milky: false});
    }
}
