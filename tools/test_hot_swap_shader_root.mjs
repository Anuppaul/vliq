import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Regression: a GNOME Wayland live runtime swap MUST reuse the registered
// LiquidEffect GType but source GLSL from the newly installed vendor tree.
// Previously cached vendor.root pointed to a stale revision, so changed
// white/gray borders existed on disk yet old TL/BR white glass remained.
const root=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');
const modules=[
    'panelGlass.js','orbGlass.js','shellCards.js','spotlightGlass.js',
    'popupGlass.js','overviewSearchGlass.js','notificationGlass.js',
    'overviewCloseGlass.js',
];
const [integration,installer,...sources]=await Promise.all([
    read('liquidGlassDock.js'),
    readFile(new URL('../gnome-shell/install.sh',import.meta.url),'utf8'),
    ...modules.map(read),
]);
assert.match(integration,/const vendorModules = await loadLiquidGlassVendorModules\(/);
assert.match(integration,/shaderRoot: canonicalVendorRoot\(\)/);
assert.match(integration,/\.\.\.vendorModules,/);
assert.match(integration,/\[VLIQ\]\[GlassShader\] moduleRoot=/);
assert.match(integration,/this\._vendor\.shaderRoot/);
assert.doesNotMatch(integration,/vendorModules\.root\s*=/);
assert.match(integration,/new this\._vendor\.OsdManager\(\s*this\._vendor\.shaderRoot,/);
assert.match(integration,/new this\._vendor\.DashManager\(\s*this\._vendor\.shaderRoot,/);
for(let i=0;i<modules.length;i++){
    assert.match(sources[i],/extensionPath:\s*this\._vendor\.shaderRoot \?\? this\._vendor\.root,/,
        modules[i]+' must load the current shader, not stale cached vendor.root');
}
assert.match(installer,/cp -a "\$\{SOURCE_DIR\}\/\$\{runtime_source\}" "\$\{destination\}"/);
assert.match(installer,/destination="\$\{TARGET_DIR\}\/\$\{runtime_source\}"/);
assert.match(installer,/stage_runtime_revision\s*\(\)/);
console.log('GNOME hot-swap: canonical current shader data, reused registered vendor classes, and all optical surfaces PASS.');
