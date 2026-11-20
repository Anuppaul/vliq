import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// One immutable, compositor-native wallpaper tint pass. This matches
// runtime.css's Milky hover background: rgba(245,249,255,0.24).
// No filmic grading, vignette, ambient color, grain, adaptive contrast,
// blur, screenshot, frame clock or uniforms. Never tint the whole stage.
export const WALLPAPER_TINT_FRAGMENT = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec4 original = texture2D(cogl_sampler0, uv);
vec3 sourceColor = original.rgb / max(original.a, 0.0001);
vec3 milky = vec3(245.0 / 255.0, 249.0 / 255.0, 255.0 / 255.0);
vec3 tinted = mix(sourceColor, milky, 0.24);
// Preserve GNOME's premultiplied alpha, crossfades and transparent pixels.
cogl_color_out = vec4(tinted * original.a, original.a) * cogl_color_in;
`;

// A new GType is mandatory: older GLSLEffect implementations cannot have
// their shader snippet replaced during VLIQ's live runtime hot reload.
const CACHE_KEY = Symbol.for('vliq.wallpaper.milky.effect.v1');

export function getWallpaperTintEffectClass() {
    if (globalThis[CACHE_KEY])
        return globalThis[CACHE_KEY];

    const Base = Shell.GLSLEffect ?? Clutter.ShaderEffect;
    if (!Base)
        throw new Error('GNOME GLSL shader effects are unavailable');

    class WallpaperMilkyTintEffect extends Base {
        _init() {
            super._init();
        }
    }

    if (Shell.GLSLEffect) {
        Object.defineProperty(WallpaperMilkyTintEffect.prototype,
            'vfunc_build_pipeline', {
                value() {
                    this.add_glsl_snippet(
                        Cogl.SnippetHook.FRAGMENT,
                        '',
                        WALLPAPER_TINT_FRAGMENT,
                        true
                    );
                },
            });
    } else {
        Object.defineProperty(WallpaperMilkyTintEffect.prototype,
            'vfunc_get_static_snippet', {
                value() {
                    const snippet = Cogl.Snippet.new(
                        Cogl.SnippetHook.FRAGMENT,
                        '',
                        null
                    );
                    snippet.set_replace(WALLPAPER_TINT_FRAGMENT);
                    return snippet;
                },
            });
    }

    const Effect = GObject.registerClass(
        {GTypeName: 'VLIQWallpaperMilkyTintEffectV1'},
        WallpaperMilkyTintEffect
    );
    globalThis[CACHE_KEY] = Effect;
    return Effect;
}
