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
        this.effects=new Map();this.adds=0;this.removes=0;this.parent=null;
    }
    get_parent(){return this.parent;}
    bind_property(property,overlay,targetProperty){
        overlay[targetProperty]=this[property] ?? (property==='opacity'?255:true);
        return {unbind(){}};
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
    constructor(opts){this.opts=opts;this.constraints=[];this.parent=null;overlayCreates++;}
    add_constraint(constraint){this.constraints.push(constraint);}
    destroy(){overlayDestroys++;this.parent?.remove_child(this);}
}
const St={Widget:NativeOverlay};
const GObject={BindingFlags:{SYNC_CREATE:1}};
const Clutter={BindConstraint:class {constructor(o){Object.assign(this,o);}},
    BindCoordinate:{ALL:0}};
const Type=new Function('GLib','Meta','Main','Clutter','St','GObject',
    'readWallpaperProfile',
    managerSource.replace(/^import[\s\S]*?;\s*$/gm,'')
        .replace(/^export\s+/gm,'') +
        '\nreturn WallpaperAtmosphereManager;'
)(GLib,Meta,Main,Clutter,St,GObject,config.readWallpaperProfile);
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
const settings=new Settings();
const manager=new Type(settings);
manager.setup();
assert.equal(manager._actors.size,2);
assert.equal(overlayCount(native),1,'Milky is default on loaded wallpaper');
assert.equal(overlayCount(unloaded),0,'never shade unloaded Mutter background');
assert.equal(overlayCreates,1);
drainIdles();
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Native Milky White tint on 1\/1 loaded wallpaper sources/);

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
    /Native Milky White tint on 3\/3 loaded wallpaper sources/);

// Retired settings must not reconfigure, repaint, or add effects.
const oldCount=overlayCreates;
const oldNativeAdds=overlayCreates;
settings.change('wallpaper-grain',100);
settings.change('wallpaper-filmic',0);
drainIdles();
assert.equal(overlayCreates,oldNativeAdds);
assert.equal(overlayCreates,oldCount);

// Switching to Original detaches the pass and preserves saved legacy data.
settings.change('wallpaper-style','original');
drainIdles();
for(const actor of [native,unloaded,mirror,grid])
    assert.equal(actor.parent?.children.filter(x=>x.opts?.name==='vliq-wallpaper-milky-tint').length ?? 0,0);
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Original: no VLIQ wallpaper tint attached/);
assert.equal(settings.data.get('wallpaper-grain'),100);

// Old saved presets map to Milky without modifying the GSettings value.
settings.change('wallpaper-style','cinematic');
drainIdles();
assert.equal(settings.get_string('wallpaper-style'),'cinematic');
assert.equal(overlayCount(native),1);
assert.equal(overlayCount(mirror),1);
assert.equal(overlayCount(grid),1);

// Background load changes detach/attach safely, including null background.
native.content.setLoaded(false);
assert.equal(overlayCount(native),0);
native.content.setLoaded(true);
assert.equal(overlayCount(native),1);
unloaded.content.setLoaded(true);
assert.equal(overlayCount(unloaded),1);

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

manager.cleanup();
assert.equal(manager._actors.size,0);
assert.equal(manager._containers.size,0);
assert.equal(overlayCount(replacement),0);
assert.equal(desktop.get_children().length,3);
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Inactive: VLIQ wallpaper tint stopped/);

// Real integration, packaging and compositor class contracts.
assert.match(integration,/new WallpaperAtmosphereManager\(this\._vliqSettings\)/);
assert.match(integration,/new AppGridBackdropManager\(\{\s*atmosphereManager:/);
assert.match(integration,/cleanup\(\s*'wallpaperAtmosphereManager'/);
assert.match(appGrid,/this\._atmosphereManager\?\.watchContainer\(widget\)/);
assert.match(appGrid,/this\._atmosphereManager\?\.unwatchContainer\(widget\)/);
for(const name of ['wallpaperAtmosphere.js','wallpaperAtmosphereEffect.js',
    'wallpaperAtmosphereConfig.js','wallpaperAtmospherePreferences.js'])
    assert.ok(install.includes('"' + name + '"'));
assert.match(managerSource,/insert_child_above\(overlay, actor\)/);
assert.match(managerSource,/Clutter\.BindConstraint/);
assert.doesNotMatch(managerSource,/getWallpaperTintEffectClass|add_effect_with_name/);
assert.doesNotMatch(effectSource,/GLib\.timeout_add|Shell\.Screenshot|new Gio\.File/);
console.log('Native Milky wallpaper tint: first-paint overlay, source scoping, legacy migration, Original opt-out, lifecycle and packaging PASS.');
