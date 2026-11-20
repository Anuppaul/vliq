import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = '../gnome-shell/vliq@wonderer.tech/';
const read = name => readFile(new URL(base + name, import.meta.url), 'utf8');
const [configSource, managerSource, effectSource, schema,
    integration, appGrid, install] = await Promise.all([
    read('wallpaperAtmosphereConfig.js'),
    read('wallpaperAtmosphere.js'),
    read('wallpaperAtmosphereEffect.js'),
    read('schemas/org.gnome.shell.extensions.vliq.gschema.xml'),
    read('liquidGlassDock.js'),
    read('appGridBackdrop.js'),
    readFile(new URL('../gnome-shell/install.sh', import.meta.url), 'utf8'),
]);

const config = new Function(
    configSource.replace(/^export\s+/gm, '') +
    '\nreturn {WALLPAPER_STYLES,WALLPAPER_MILKY_TINT,readWallpaperProfile};'
)();
assert.deepEqual(config.WALLPAPER_STYLES.map(x => x.id), ['milky','original']);
assert.deepEqual(config.WALLPAPER_MILKY_TINT,
    {red:245,green:249,blue:255,opacity:0.24});
assert.equal(config.readWallpaperProfile({
    get_string:()=> 'original',get_user_value:()=>null,
}).style,'milky','old unsaved default migrates without session restart');
assert.equal(config.readWallpaperProfile({
    get_string:()=> 'original',get_user_value:()=>({}),
}).style,'original','explicit Original remains an opt-out');
assert.match(schema,
    /<key name="wallpaper-style" type="s">\s*<default>'milky'<\/default>/);
for (const key of ['wallpaper-filmic','wallpaper-vignette',
    'wallpaper-ambient','wallpaper-grain','wallpaper-adaptive-contrast']) {
    assert.match(schema,new RegExp('<key name="' + key + '"'));
    assert.doesNotMatch(managerSource,new RegExp("get_int\\('" + key));
}
assert.doesNotMatch(managerSource,/ATMOSPHERE_KEYS|\.configure\(/);
assert.doesNotMatch(effectSource,
    /va_filmic|va_vignette|va_ambient|va_grain|va_adaptive|va_resolution/);

class Emitter {
    constructor() {this._subs=new Map();this._id=0;}
    connect(event,handler) {
        const id=++this._id;this._subs.set(id,{event,handler});return id;
    }
    disconnect(id) {this._subs.delete(id);}
    emit(event,...args) {
        for(const item of [...this._subs.values()])
            if(item.event===event)item.handler(this,...args);
    }
}
class BackgroundContent extends Emitter {
    constructor(loaded=true){super();this.background=loaded?{}:null;}
    setLoaded(loaded){this.background=loaded?{}:null;this.emit('notify::background');}
}
class BackgroundActor extends Emitter {
    constructor(loaded=true){
        super();this.content=new BackgroundContent(loaded);
        this.visible=true;
        this.opacity=255;
        this.effects=new Map();this.adds=0;this.removes=0;this.parent=null;
    }
    get_parent(){return this.parent;}
    bind_property(property,overlay,targetProperty){
        const sync=()=>{overlay[targetProperty]=this[property];};
        sync();
        const id=this.connect('notify::'+property,sync);
        return {unbind:()=>this.disconnect(id)};
    }
    add_effect_with_name(name,effect){
        assert.equal(name,'vliq-milky-wallpaper');
        assert.equal(this.effects.has(name),false,'one effect per wallpaper');
        this.effects.set(name,effect);this.adds++;
    }
    remove_effect(effect){
        for(const [key,value] of this.effects)
            if(value===effect){this.effects.delete(key);this.removes++;return;}
    }
}
class Actor extends Emitter {
    constructor(name){super();this.name=name;this.children=[];}
    get_name(){return this.name;}
    get_children(){return [...this.children];}
    add_child(child){this.children.push(child);child.parent=this;this.emit('child-added',child);}
    insert_child_above(child,sibling){
        const idx=this.children.indexOf(sibling);
        assert.ok(idx>=0);
        this.children.splice(idx+1,0,child);child.parent=this;
        this.emit('child-added',child);
    }
    remove_child(child){
        this.children=this.children.filter(x=>x!==child);
        child.parent=null;
        this.emit('child-removed',child);
    }
}
const desktop=new Actor('desktop');
const uiGroup=new Actor('uiGroup');
const native=new BackgroundActor();
const unloaded=new BackgroundActor(false);
const panelIcon=new Actor('native-app-icon');
for(const child of [native,unloaded,panelIcon])desktop.add_child(child);
const Meta={BackgroundActor,BackgroundContent};
const Main={layoutManager:{_backgroundGroup:desktop,uiGroup}};
const idles=new Map();
let idleId=0;
const GLib={
    get_monotonic_time:()=>1000000,
    PRIORITY_DEFAULT_IDLE:200,
    SOURCE_REMOVE:false,
    idle_add(_priority,fn){const id=++idleId;idles.set(id,fn);return id;},
    source_remove(id){idles.delete(id);},
};
function drainIdles() {
    let n=0;
    while(idles.size) {
        assert.ok(++n<100,'no unbounded idle scheduling');
        const [id,fn]=idles.entries().next().value;
        idles.delete(id);
        assert.equal(fn(),false);
    }
}
let overlayCreates=0;
let overlayDestroys=0;
class NativeOverlay {
    constructor(opts){
        this.opts=opts;this.constraints=[];this.parent=null;
        this.background_color=opts.background_color;
        this.colorWrites=0;
        this.visible=true;this.opacity=255;
        overlayCreates++;
    }
    add_constraint(constraint){this.constraints.push(constraint);}
    set_background_color(color){
        this.background_color=color;
        this.colorWrites++;
    }
    destroy(){overlayDestroys++;this.parent?.remove_child(this);}
}
const GObject={BindingFlags:{SYNC_CREATE:1}};
const Cogl={Color:class {constructor(o){Object.assign(this,o);}}};
const Clutter={
    Actor:NativeOverlay,
    BindConstraint:class {constructor(o){Object.assign(this,o);}},
    BindCoordinate:{ALL:0},
};
const Type=new Function('GLib','Meta','Main','Clutter','Cogl','GObject',
    'readWallpaperProfile',
    managerSource.replace(/^import[\s\S]*?;\s*$/gm,'')
        .replace(/^export\s+/gm,'') +
        '\nreturn WallpaperAtmosphereManager;'
)(GLib,Meta,Main,Clutter,Cogl,GObject,config.readWallpaperProfile);
class Settings extends Emitter {
    constructor(style='milky'){
        super();this.data=new Map([
            ['wallpaper-style',style],
            ['wallpaper-runtime-status','Not initialized'],
            ['wallpaper-filmic',62],['wallpaper-vignette',52],
            ['wallpaper-ambient',54],['wallpaper-grain',3],
            ['wallpaper-adaptive-contrast',56],
        ]);
    }
    get_string(key){return this.data.get(key);}
    get_int(){throw new Error('Retired effect settings must not be read');}
    set_string(key,value){this.change(key,value);}
    change(key,value){this.data.set(key,value);this.emit('changed',key);}
}
const overlayCount=actor => actor.parent?.children.filter(child =>
    child.opts?.name === 'vliq-wallpaper-milky-tint' &&
    child.constraints.some(c=>c.source===actor)).length ?? 0;
// GNOME Shell 50 supplies a Stage after-paint signal. Verify each
// wallpaper toggle installs only a single one-shot handler and cleanup
// disconnects it without polling or persistent frame callbacks.
const stage=new Emitter();
const oldStage=global.stage;
global.stage=stage;

const settings=new Settings();
const manager=new Type(settings);
manager.setup();
assert.equal(manager._actors.size,2);
assert.equal(overlayCount(native),1,'Milky is default on loaded wallpaper');
assert.equal(overlayCount(unloaded),1,'tint is armed before async background image loading');
assert.equal(overlayCreates,2);
drainIdles();
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Native Milky White tint allocated on 2\/2 wallpaper actors \(1 backgrounds loaded/);

// The shared mirror is created lazily, while App Grid has independent
// per-monitor wallpaper actors. Neither may tint the UI above the wallpaper.
const mirrorGroup=new Actor('lg-bg-mirror-source');
const mirror=new BackgroundActor();
mirrorGroup.add_child(mirror);
uiGroup.add_child(mirrorGroup);
const overview=new Actor('overview-wallpaper-container');
const grid=new BackgroundActor();
overview.add_child(grid);
assert.equal(manager.watchContainer(overview),true);
assert.equal(manager.watchContainer(overview),false);
assert.equal(overlayCount(mirror),1);
assert.equal(overlayCount(grid),1);
assert.equal(panelIcon.effects,undefined);
drainIdles();
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Native Milky White tint allocated on 4\/4 wallpaper actors \(3 backgrounds loaded/);

// Retired settings must not reconfigure, repaint, or add effects.
const oldCount=overlayCreates;
const oldNativeAdds=overlayCreates;
settings.change('wallpaper-grain',100);
settings.change('wallpaper-filmic',0);
drainIdles();
assert.equal(overlayCreates,oldNativeAdds);
assert.equal(overlayCreates,oldCount);

// Style changes happen before the idle queue runs and never recreate paint
// actors. A busy shell must not delay a wallpaper tint by ~500ms.
const actors=[native,unloaded,mirror,grid];
const overlays=actors.map(actor => actor.parent.children.find(
    child=>child.opts?.name==='vliq-wallpaper-milky-tint' &&
        child.constraints.some(constraint=>constraint.source===actor)
));
assert.deepEqual(overlays.map(overlay=>overlay.background_color.alpha),
    [61,61,61,61]);
assert.ok(overlays.every(overlay=>overlay.opts.style === undefined),
    'native Clutter color quads must never use CSS stylesheet paint');
const beforeStyleChange=overlayCreates;
settings.change('wallpaper-style','original');
assert.equal(stage._subs.size,1,'one pending after-paint callback');
stage.emit('after-paint');
assert.equal(stage._subs.size,0,'paint probe must disconnect after one frame');
assert.ok(overlays.every(overlay=>overlay.background_color.alpha===0),
    'Original must remove tint in the synchronous callback');
assert.ok(overlays.every(overlay=>overlay.visible===true),
    'Original must not unmap the reusable native quad');
assert.equal(overlayCreates,beforeStyleChange);
drainIdles();
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Original: no VLIQ wallpaper tint attached/);
assert.equal(settings.data.get('wallpaper-grain'),100);

// Old saved presets map to Milky without modifying the GSettings value.
settings.change('wallpaper-style','cinematic');
assert.equal(stage._subs.size,1);
assert.ok(overlays.every(overlay=>overlay.background_color.alpha===61),
    'Milky must use the fixed 24% native color in the synchronous callback');
assert.ok(overlays.every(overlay=>overlay.visible===true),
    'mode toggle must not unmap and remap a reusable paint quad');
assert.equal(overlayCreates,beforeStyleChange,
    'style toggles reuse original allocated overlay actors');
drainIdles();
assert.equal(settings.get_string('wallpaper-style'),'cinematic');
assert.equal(overlayCount(native),1);
assert.equal(overlayCount(mirror),1);
assert.equal(overlayCount(grid),1);

// GNOME native background fade visibility and Original must combine;
// an actor going invisible must not re-enable a disabled tint layer.
native.visible=false;
native.emit('notify::visible');
assert.equal(overlays[0].visible,false);
native.visible=true;
native.emit('notify::visible');
assert.equal(overlays[0].visible,true);
native.opacity=128;
native.emit('notify::opacity');
assert.equal(overlays[0].opacity,128,
    'GNOME fade opacity must be mirrored through a native binding');
native.opacity=255;
native.emit('notify::opacity');
settings.change('wallpaper-style','original');
native.emit('notify::visible');
assert.equal(overlays[0].background_color.alpha,0,
    'GNOME visibility change cannot override Original shade');
assert.equal(overlays[0].visible,true,
    'Original keeps compositor-native quad allocated and mapped');
settings.change('wallpaper-style','milky');
assert.equal(overlays[0].background_color.alpha,61);

// Background load changes must not detach or recreate a tint layer:
// Mutter can paint an old or new background during async image loading.
const beforeBackgroundChange=overlayCreates;
native.content.setLoaded(false);
assert.equal(overlayCount(native),1);
native.content.setLoaded(true);
assert.equal(overlayCount(native),1);
unloaded.content.setLoaded(true);
assert.equal(overlayCount(unloaded),1);
assert.equal(overlayCreates,beforeBackgroundChange,
    'no late tint recreation during wallpaper load/crossfade');

// Real wallpaper replacement and mirror removal must release effects.
desktop.remove_child(native);
assert.equal(overlayCount(native),0);
const replacement=new BackgroundActor();
desktop.add_child(replacement);
assert.equal(overlayCount(replacement),1);
uiGroup.remove_child(mirrorGroup);
assert.equal(overlayCount(mirror),0);
manager.unwatchContainer(overview);
assert.equal(overlayCount(grid),0);

// The final probe stays pending until cleanup and must not leak.
assert.equal(stage._subs.size,1);
manager.cleanup();
assert.equal(stage._subs.size,0);
if(oldStage===undefined)delete global.stage;
else global.stage=oldStage;
assert.equal(manager._actors.size,0);
assert.equal(manager._containers.size,0);
assert.equal(overlayCount(replacement),0);
assert.equal(desktop.get_children().length,3);
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Inactive: VLIQ wallpaper tint stopped/);

// Real integration, packaging and compositor class contracts.
assert.match(integration,/new WallpaperAtmosphereManager\(this\._vliqSettings\)/);
const earlyStart=integration.indexOf(
    'new WallpaperAtmosphereManager(this._vliqSettings)');
const vendorLoad=integration.indexOf(
    'this._vendor = await loadLiquidGlassVendorModules(');
assert.ok(earlyStart >= 0 && vendorLoad >= 0 && earlyStart < vendorLoad,
    'wallpaper tint must initialize before async vendor load');
assert.equal((integration.match(/new WallpaperAtmosphereManager\(/g)??[]).length,1,
    'only one wallpaper manager can own the same native actors');
assert.match(integration,/new AppGridBackdropManager\(\{\s*atmosphereManager:/);
assert.match(integration,/cleanup\(\s*'wallpaperAtmosphereManager'/);
assert.match(appGrid,/this\._atmosphereManager\?\.watchContainer\(widget\)/);
assert.match(appGrid,/this\._atmosphereManager\?\.unwatchContainer\(widget\)/);
for(const name of ['wallpaperAtmosphere.js','wallpaperAtmosphereEffect.js',
    'wallpaperAtmosphereConfig.js','wallpaperAtmospherePreferences.js'])
    assert.ok(install.includes('"' + name + '"'));
assert.match(managerSource,/insert_child_above\(overlay, actor\)/);
assert.match(managerSource,/Clutter\.BindConstraint/);
assert.match(managerSource,/new Clutter\.Actor\(/);
assert.match(managerSource,/new Cogl\.Color\(/);
assert.doesNotMatch(managerSource,/new St\.Widget|background-color:\s*'|overlay\.visible = visible/);
assert.doesNotMatch(managerSource,/getWallpaperTintEffectClass|add_effect_with_name/);
assert.match(managerSource,/this\._enabled && this\._profile\.active/);
assert.match(managerSource,/this\._applyNow\(\);/);
assert.doesNotMatch(managerSource,/this\._scheduleApply\(\)/);
assert.doesNotMatch(managerSource,/GLib\.idle_add\([\s\S]*?\(\) => \{[\s\S]*?this\._applyNow\(\)/,
    'wallpaper style application may not be queued behind low priority idles');
assert.doesNotMatch(managerSource,/this\._profile\.active &&\s*this\._hasLoadedBackground\(record\)/);
assert.doesNotMatch(effectSource,/GLib\.timeout_add|Shell\.Screenshot|new Gio\.File/);
console.log('Native Milky wallpaper tint: no-CSS Cogl color quad, instant alpha switch, zero remaps, background fades, cleanup and packaging PASS.');
