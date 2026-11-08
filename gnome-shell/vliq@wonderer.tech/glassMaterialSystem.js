// VLIQ shared Liquid Glass material system.
//
// This module is the design-system layer above the generic vendored renderer.
// Surface adapters decide WHAT is glass (Date Menu cards, Quick Settings pods,
// notification cards, etc.); this file decides HOW VLIQ glass behaves.
//
// Keep visual constants here rather than scattering them across managers.
// Changing a role here intentionally updates every surface consuming that role.

export const GLASS_TEXT_PALETTE = Object.freeze({
    light: '#f7f8fc',
    dark: '#17191f',
});

export const GLASS_INTERACTION = Object.freeze({
    pressed: 1.0,
    engaged: 0.70,
    selected: 0.22,
    damping: 0.22,
    epsilon: 0.008,
});

// v10 liquid lens: stronger edge refraction, Fresnel glints and viscous
// engagement without changing tint, blur or renderer topology.
// MaterialSettings reads these through the GSettings migration in
// liquidGlassDock.js; role.optics remains the canonical target profile.
const INNER_CARD_OPTICS = Object.freeze({
    max_z: 144.0,
    displacement_scale: 58.0,
    edge_smoothing: 0.82,
    profile_shape_n: 3.9,
    ior: 1.78,
    chroma_strength: 1.85,
    specular_intensity: 0.78,
    shininess: 74.0,
    rim_width: 2.0,
    rim_intensity: 1.15,
    rim_directional_power: 1.55,
    rim_power: 2.05,
    rim_light_color_intensity: 1.28,
    sheen_intensity: 0.21,
    light_angle_deg: 108.0,
    ao_intensity: 0.34,
    ao_radius: 1.3,
    shadow_radius: 0.0,
    shadow_intensity: 0.0,
});

const PREMIUM_CARD_ROLE = Object.freeze({
    optics: INNER_CARD_OPTICS,
    tintStrength: 0.026,
    blurScale: 0.85,
    blurMin: 4,
    blurMax: 7,
    contrastFloor: 1.04,
    multiRegion: true,
    surfaceLight: true,
    blurMethod: 1,
    // MaterialSettings owns optical uniforms so advanced preference controls
    // remain live and survive ordinary appearance updates.
    settingsOwnOptics: true,
    interaction: GLASS_INTERACTION,
    text: GLASS_TEXT_PALETTE,
});

const CLEAN_POPUP_CHROME = Object.freeze({
    shadow: false,
    filterBorder: false,
    nativeBorder: false,
});

export const VLIQ_GLASS_ROLES = Object.freeze({
    // Aliases intentionally point to the SAME frozen role object.
    // One material tune therefore updates every adopted VLIQ card surface.
    innerCard: PREMIUM_CARD_ROLE,
    quickMenuCard: PREMIUM_CARD_ROLE,
    notificationCard: PREMIUM_CARD_ROLE,
    shellCard: PREMIUM_CARD_ROLE,
    osdCard: PREMIUM_CARD_ROLE,
    topPanel: PREMIUM_CARD_ROLE,
    dock: PREMIUM_CARD_ROLE,
    orbCard: PREMIUM_CARD_ROLE,
});

export const VLIQ_GLASS_ADAPTERS = Object.freeze({
    popupMenu: Object.freeze({
        popupChrome: CLEAN_POPUP_CHROME,
        filterUsesContentBounds: true,
        // LiquidEffect single-rect mode subtracts shader padding from BOTH
        // sides of the supplied geometry. Generic PopupMenu glass uses the
        // exact native menu bounds, so both geometry and shader padding are 0.
        edgePadding: 0,
        shaderPadding: 0,
        sceneFpsCap: 24,
    }),
    dateMenu: Object.freeze({
        popupChrome: CLEAN_POPUP_CHROME,
        filterUsesContentBounds: true,
        // Geometry expands by the same amount that LiquidEffect subtracts,
        // leaving the visible glass shape exactly on menu.box.
        edgePadding: 20,
        shaderPadding: 20,
        adaptiveText: true,
        adaptiveSampleDelayMs: 520,
        adaptiveResampleMs: 3200,
    }),
    quickMenu: Object.freeze({
        edgePadding: 20,
        shaderPadding: 20,
        // Quick Settings is a system surface: it follows the global System
        // Liquid Glass appearance. Date Menu calibration stays independent.
        useSystemAppearance: true,
        filterUsesContentBounds: true,
        multiRegion: false,

        // Preserve the accepted pod density at the current 2% system tint:
        // 0.02 * 2.3 = 0.046. Unlike the old constant, this now tracks the
        // global Tint slider all the way down to a real zero.
        nestedTintScale: 2.3,
        nestedTintMax: 0.11,

        // One popup capture serves every visible pod. Sampling starts after
        // the open animation settles and stays deliberately low-frequency.
        adaptiveText: true,
        adaptiveSampleDelayMs: 520,
        // Quick Menu is normally short-lived. One sample on open (and one on
        // expanded-menu change) avoids periodic GPU->CPU screenshot stalls.
        adaptiveResampleMs: 0,
        expandedSampleDelayMs: 140,

        // Theme flips must feel immediate. Apply the Shell theme foreground
        // synchronously, then let one backdrop sample correct it next frame.
        themeResampleDelayMs: 16,

        // Expanded QuickToggleMenu closes directly; no opacity fade-out.
        collapseFade: false,

        // Native controls keep compositor-rate input/animation; only the
        // captured live scene behind the glass is capped.
        sceneFpsCap: 24,

        // All pods use the same neutral glass material. Selection never
        // recolors the tile body; active state is expressed only through the
        // live Shell accent on foreground content.
        neutralTint: Object.freeze([1.0, 1.0, 1.0]),
        neutralBaseStrength: 0.046,
        activeForegroundSource: 'shell-theme',

        // One physical rim. Native/filter borders and shadows stay out.
        popupChrome: CLEAN_POPUP_CHROME,
        innerNativeBorder: false,
        innerNativeShadow: false,
    }),
    notificationBanner: Object.freeze({
        multiRegion: false,
        appearanceProfile: 'dateMenu',
        filterOpacityOverride: 0.0,
        sceneFpsCap: 24,
        adaptiveText: true,
        adaptiveSampleDelayMs: 220,
        adaptiveResampleMs: 0,

        // LiquidEffect single-rect mode subtracts padding*2 from geometry.
        // Geometry must therefore be expanded by this exact amount before
        // being supplied to the shader (same contract as PopupGlass).
        shaderPadding: 20,
        borderAlpha: 0.0,
    }),
    shellCard: Object.freeze({
        multiRegion: false,
        inheritGlobalTint: true,
        inheritGlobalBlur: true,
    }),
    topPanel: Object.freeze({
        multiRegion: false,
        inheritGlobalTint: true,
        inheritGlobalBlur: true,
        cornerRadius: 0,
    }),
    dock: Object.freeze({
        multiRegion: false,
        inheritGlobalTint: true,
        inheritGlobalBlur: true,
        preserveNativeGeometry: true,
    }),
    orb: Object.freeze({
        multiRegion: true,
        sceneFpsCap: 24,
        adaptiveText: true,
        adaptiveDebounceMs: 180,
        adaptiveResampleMs: 4000,
        // Interactive refraction brightens gently under the cursor; shader
        // response is bounded [0,1] and does not schedule extra GPU passes.
        hoverResponse: 0.62,
    }),
    spotlight: Object.freeze({
        multiRegion: true,
        sceneFpsCap: 24,
        adaptiveText: true,
        hoverResponse: 0.52,
        focusResponse: 0.28,
    }),
    osd: Object.freeze({
        multiRegion: false,
    }),

});

export function clampGlass(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function resolveGlassInteractionTarget({
    pressed = false,
    engaged = false,
    selected = false,
} = {}, profile = GLASS_INTERACTION) {
    if (pressed)
        return profile.pressed;
    if (engaged)
        return profile.engaged;
    if (selected)
        return profile.selected;
    return 0.0;
}

export function stepGlassInteraction(
    previous,
    target,
    profile = GLASS_INTERACTION
) {
    let next =
        previous + (target - previous) * profile.damping;

    if (Math.abs(target - next) < profile.epsilon)
        next = target;

    return next;
}

export function resolveRoleBlur(baseBlur, role = VLIQ_GLASS_ROLES.innerCard) {
    const blur = Number.isFinite(baseBlur) ? baseBlur : 7;

    // Zero is an explicit off state, not a request for the role floor.
    if (blur <= 0)
        return 0;

    return clampGlass(
        Math.round(blur * role.blurScale),
        role.blurMin,
        role.blurMax
    );
}

export function applyVLIQGlassRole(
    effect,
    role = VLIQ_GLASS_ROLES.innerCard,
    {
        tintColor = [1, 1, 1],
        tintStrength = role.tintStrength,
        baseBlur = 7,
        blurRadius = null,
        cornerRadius = null,
        brightness = null,
        contrast = null,
        saturation = null,
        multiRegion = role.multiRegion,
    } = {}
) {
    if (!effect)
        return;

    const [r, g, b] = tintColor;

    effect.setTintColor?.(r, g, b);
    effect.setTintStrength?.(tintStrength);
    effect.setBlurRadius?.(
        blurRadius ?? resolveRoleBlur(baseBlur, role)
    );

    if (cornerRadius !== null)
        effect.setCornerRadius?.(cornerRadius);

    effect.setSurfaceLightEnabled?.(role.surfaceLight);
    effect.setBlurMethod?.(role.blurMethod);
    effect.setMultiRegionMode?.(multiRegion);

    if (brightness !== null)
        effect.setBrightness?.(brightness);
    if (contrast !== null)
        effect.setContrast?.(
            Math.max(role.contrastFloor ?? 0, contrast)
        );
    if (saturation !== null)
        effect.setSaturation?.(saturation);

    if (!role.settingsOwnOptics) {
        try {
            const uniforms = effect._uniforms;
            for (const [name, value] of Object.entries(role.optics))
                uniforms?.set?.(name, value);
            effect.queue_repaint?.();
        } catch {
            // The public renderer API remains sufficient if internals change.
        }
    }
}
