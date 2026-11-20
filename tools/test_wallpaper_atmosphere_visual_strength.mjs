import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const dir='../gnome-shell/vliq@wonderer.tech/';
const [configSource,shader,css]=await Promise.all([
    'wallpaperAtmosphereConfig.js','wallpaperAtmosphereEffect.js',
    'runtime.css',
].map(name=>readFile(new URL(dir+name,import.meta.url),'utf8')));
const {WALLPAPER_MILKY_TINT: tint,WALLPAPER_STYLES: styles}=
    new Function(configSource.replace(/^export\s+/gm,'')+
        '\nreturn {WALLPAPER_MILKY_TINT,WALLPAPER_STYLES};')();
assert.deepEqual(styles.map(x=>x.id),['milky','original']);
assert.deepEqual(tint,{red:245,green:249,blue:255,opacity:0.24});

// Source-of-truth parity with the accepted VLIQ native panel hover shade.
const hover=css.match(/#panel\.vliq-liquid-top-panel \.panel-button:hover,[\s\S]*?background-color:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
assert.ok(hover,'expected native panel hover material');
assert.deepEqual(hover.slice(1).map(Number),
    [tint.red,tint.green,tint.blue,tint.opacity]);
assert.match(shader,/vec3 milky = vec3\(245\.0 \/ 255\.0, 249\.0 \/ 255\.0, 255\.0 \/ 255\.0\)/);
assert.match(shader,/vec3 tinted = mix\(sourceColor, milky, 0\.24\)/);
assert.equal((shader.match(/texture2D\(cogl_sampler0, uv\)/g)??[]).length,1);
assert.doesNotMatch(shader,/va_static_noise|va_luminance|filmicStrength|vignette|ambientStrength|contrastColor|grain|uniform\s+(?:float|vec)/i);
assert.match(shader,/vec4\(tinted \* original\.a, original\.a\) \* cogl_color_in/);

// Pixel-space proof for the specified alpha blend. No edge-dependent
// vignetting, temporal noise, clipping, hue rotation or dynamic settings.
const color=[tint.red,tint.green,tint.blue].map(x=>x/255);
const mix=(source)=>source.map((channel,i)=>
    channel*(1-tint.opacity)+color[i]*tint.opacity);
for(const original of [
    [0,0,0],[1,1,1],[0.1,0.2,0.8],[0.9,0.3,0.1],
]) {
    const out=mix(original);
    assert.ok(out.every((v,i)=>v>=Math.min(original[i],color[i]) &&
        v<=Math.max(original[i],color[i])));
    for(const alpha of [0,0.2,0.6,1]) {
        const premultiplied=out.map(v=>v*alpha);
        assert.ok(premultiplied.every(v=>v>=0 && v<=alpha));
        if(alpha===0)assert.deepEqual(premultiplied,[0,0,0]);
    }
}
const black=mix([0,0,0]);
assert.ok(black.every(x=>x<0.25),'dark wallpaper remains visible');
const white=mix([1,1,1]);
assert.ok(white.every(x=>x>0.99),'white wallpaper remains white');
assert.deepEqual(mix([0.4,0.4,0.4]),mix([0.4,0.4,0.4]),
    'static shade does not depend on time, coordinates or frames');
console.log('Wallpaper tint: exact Milky hover color/opacity, static one-sample shader and alpha safety PASS.');
