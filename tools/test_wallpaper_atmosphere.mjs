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
        this.effects=new Map();this.adds=0;this.removes=0;
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
    add_child(child){this.children.push(child);this.emit('child-added',child);}
    remove_child(child){
        this.children=this.children.filter(x=>x!==child);
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
let registrations=0;
let cachedEffectClass=null;
class FakeEffect {}
const Type=new Function('GLib','Meta','Main',
    'readWallpaperProfile','getWallpaperTintEffectClass',
    managerSource.replace(/^import[\s\S]*?;\s*$/gm,'')
        .replace(/^export\s+/gm,'') +
        '\nreturn WallpaperAtmosphereManager;'
)(GLib,Meta,Main,config.readWallpaperProfile,()=>{
    if (!cachedEffectClass) {
        cachedEffectClass=FakeEffect;
        registrations++;
    }
    return cachedEffectClass;
});
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
const settings=new Settings();
const manager=new Type(settings);
manager.setup();
assert.equal(manager._actors.size,2);
assert.equal(native.effects.size,1,'Milky is default on loaded wallpaper');
assert.equal(unloaded.effects.size,0,'never shade unloaded Mutter background');
assert.equal(registrations,1);
drainIdles();
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Milky White tint attached to 1\/1 loaded wallpaper sources/);

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
assert.equal(mirror.effects.size,1);
assert.equal(grid.effects.size,1);
assert.equal(panelIcon.effects,undefined);
drainIdles();
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Milky White tint attached to 3\/3 loaded wallpaper sources/);

// Retired settings must not reconfigure, repaint, or add effects.
const oldCount=registrations;
const oldNativeAdds=native.adds;
settings.change('wallpaper-grain',100);
settings.change('wallpaper-filmic',0);
drainIdles();
assert.equal(native.adds,oldNativeAdds);
assert.equal(registrations,oldCount);

// Switching to Original detaches the pass and preserves saved legacy data.
settings.change('wallpaper-style','original');
drainIdles();
for(const actor of [native,unloaded,mirror,grid])
    assert.equal(actor.effects.size,0);
assert.match(settings.get_string('wallpaper-runtime-status'),
    /Original: no VLIQ wallpaper tint attached/);
assert.equal(settings.data.get('wallpaper-grain'),100);

// Old saved presets map to Milky without modifying the GSettings value.
settings.change('wallpaper-style','cinematic');
drainIdles();
assert.equal(settings.get_string('wallpaper-style'),'cinematic');
assert.equal(native.effects.size,1);
assert.equal(mirror.effects.size,1);
assert.equal(grid.effects.size,1);

// Background load changes detach/attach safely, including null background.
native.content.setLoaded(false);
assert.equal(native.effects.size,0);
native.content.setLoaded(true);
assert.equal(native.effects.size,1);
unloaded.content.setLoaded(true);
assert.equal(unloaded.effects.size,1);

// Real wallpaper replacement and mirror removal must release effects.
desktop.remove_child(native);
assert.equal(native.effects.size,0);
const replacement=new BackgroundActor();
desktop.add_child(replacement);
assert.equal(replacement.effects.size,1);
uiGroup.remove_child(mirrorGroup);
assert.equal(mirror.effects.size,0);
manager.unwatchContainer(overview);
assert.equal(grid.effects.size,0);

manager.cleanup();
assert.equal(manager._actors.size,0);
assert.equal(manager._containers.size,0);
assert.equal(replacement.effects.size,0);
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
assert.match(effectSource,/vfunc_build_pipeline/);
assert.match(effectSource,/vfunc_get_static_snippet/);
assert.match(effectSource,/Shell\.GLSLEffect \?\? Clutter\.ShaderEffect/);
assert.doesNotMatch(effectSource,/GLib\.timeout_add|Shell\.Screenshot|new Gio\.File/);
console.log('Fixed Milky wallpaper tint: source scoping, legacy migration, Original opt-out, lifecycle and packaging PASS.');
