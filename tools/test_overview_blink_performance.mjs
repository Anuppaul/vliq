import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const overviewSource = await readFile(new URL('appGridBackdrop.js',base),'utf8');
const wallpaperSource = await readFile(new URL('wallpaperAtmosphere.js',base),'utf8');

const begin = overviewSource.indexOf('    _syncVisibility(phase = null) {');
const end = overviewSource.indexOf('    updateAppearance() {',begin);
assert.ok(begin >= 0 && end > begin);
const sync = new Function('Main','OVERVIEW_WALLPAPER_CLASS',
    'return ({\n'+overviewSource.slice(begin,end)+'\n})._syncVisibility;');
const styleClass='vliq-overview-wallpaper';
const applied=new Set();
let adds=0, removes=0, shows=0, hides=0;
const layer={visible:false,show(){shows++;this.visible=true;},
    hide(){hides++;this.visible=false;}};
const overview={
    visible:false,mapped:false,
    add_style_class_name(name){adds++;applied.add(name);},
    remove_style_class_name(name){removes++;applied.delete(name);},
    has_style_class_name(name){return applied.has(name);},
};
const main={overview:{visible:false},layoutManager:{overviewGroup:overview}};
const owner={_enabled:true,_layer:layer,_overviewTransition:null};
const apply=sync(main,styleClass);

apply.call(owner);
assert.equal(layer.visible,false);
assert.equal(adds,0);

// During opening, the native actor can be visible but not mapped yet.
apply.call(owner,'showing');
assert.equal(layer.visible,true);
assert.equal(shows,1);
assert.equal(adds,1);
for(let i=0;i<100;i++){
    overview.visible=(i%2===0);
    overview.mapped=(i%3===0);
    main.overview.visible=(i%5===0);
    apply.call(owner);
}
assert.equal(shows,1,'one allocation, no 100-frame hide/show churn');
assert.equal(hides,0);
assert.equal(adds,1,'no repeated stylesheet invalidation');
assert.equal(removes,0);

// Hiding must retain the existing blurred wallpaper until GNOME has
// finished the native closing animation, rather than exposing a black base.
apply.call(owner,'hiding');
for(let i=0;i<60;i++){
    overview.visible=i%2===0;
    overview.mapped=i%3===0;
    main.overview.visible=i%4===0;
    apply.call(owner);
}
assert.equal(hides,0);
assert.equal(adds,1);
apply.call(owner,'hidden');
assert.equal(layer.visible,false);
assert.equal(hides,1);
assert.equal(removes,1);
assert.equal(owner._overviewTransition,null);

// Re-entering Overview must revive the cached layer exactly once.
apply.call(owner,'showing');
assert.equal(shows,2);
assert.equal(adds,2);
apply.call(owner,'shown');
assert.equal(shows,2);
apply.call(owner,'hidden');
assert.equal(hides,2);
assert.equal(removes,2);

// The immutable wallpaper tint should never reconfigure all loaded actors
// when GNOME emits duplicate effective style changes.
assert.match(wallpaperSource,
    /if \(next\.active === this\._profile\.active\)\s*return;/);
assert.doesNotMatch(wallpaperSource, /GLib\.timeout_add/);
console.log('Overview transition: no blink from transient mapping, no redundant CSS churn and fixed wallpaper profile fast path PASS.');
