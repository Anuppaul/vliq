import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = n => readFile(new URL(n, base), 'utf8');
const [paintSource, css, gpu, native, notifications, cards, popups] =
    await Promise.all([
        'milkyPaint.js', 'runtime.css', 'liquidGlassDock.js',
        'nativeCssIntegration.js', 'notificationGlass.js',
        'shellCards.js', 'popupGlass.js',
    ].map(read));
const {milkyPaintTokens, buildMilkyAppearanceCss} =
    new Function(paintSource.replace(/^export /gm, '') +
    '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss};')();
const white = milkyPaintTokens('popup').fill;
const black = milkyPaintTokens('header').fill;
assert.equal(white, 'rgba(245,249,255,0.920)');
assert.equal(black, 'rgba(0,0,0,0.600)');
const actual = buildMilkyAppearanceCss({milky:true});
const surfaces = [
    '.vliq-liquid-popup-content',               // generic app/panel menus
    '.vliq-liquid-shell-card',                 // modal, Alt+Tab, dialogs
    '.vliq-app-preview-card.vliq-liquid-shell-card',
    '.vliq-native-notification-glass',         // top notification banners
    '.vliq-orb-face-v2',                       // launcher orb
    '.vliq-app-button',                        // Orb app buttons
    '.vliq-spotlight-glass-entry',
    '.vliq-spotlight-glass-results',
    '.vliq-milky-osd',                         // volume/brightness OSD
    '.dash-background.vliq-ubuntu-dock-glass-background',
    '.dash-background.vliq-ubuntu-dock-panel-background',
    '#overviewGroup .window-close.vliq-window-close-shared-glass',
    '#overviewGroup .window-icon.vliq-window-icon-shared-glass',
];
for (const target of surfaces) {
    assert.ok(actual.includes(target),
        'all Liquid surfaces must have a Milky counterpart: '+target);
    assert.ok(css.includes('.vliq-global-milky '+target),
        'static CSS fallback also covers '+target);
}
const firstMenu = actual.indexOf('.vliq-global-milky .vliq-liquid-popup-content');
assert.ok(firstMenu>=0);
const menuBody = actual.slice(actual.indexOf('{', firstMenu),
    actual.indexOf('}', firstMenu));
assert.ok(menuBody.includes('background-color: '+white),
    'generic app menu color must be Milky White 92%');
assert.ok(actual.includes('background-color: '+black),
    'header/taskbar must remain black 60%');
assert.match(gpu, /this\._syncMilkyOsdMaterial\(enabled\)/,
    'OSD native material should be enabled in Milky mode');
assert.match(gpu, /milkyPaintTokens\('popup'\)/,
    'Ubuntu Dock inline material should use the same white paint');
assert.match(notifications, /_syncMilkyBannerPaint\(material, state\)/,
    'notification manager must update real GNOME actor inline style');
assert.match(notifications, /this\._syncMilkyBannerPaint\(material, state\)/,
    'notification style must be applied during material updates');
assert.match(notifications, /_applyTextPolarity\(material, true\)/,
    'white notification card must always use readable dark foreground');
assert.match(notifications, /this\._syncMilkyBannerPaint\(material,\s*this\._appearance/,
    'new banner in already-selected Milky must be white immediately');
assert.match(cards,/const CARD_CLASS = 'vliq-liquid-shell-card'/);
assert.match(popups,/const GLASS_CLASS = 'vliq-liquid-popup-content'/);
assert.match(native,/buildMilkyAppearanceCss\(state\)/);
assert.doesNotMatch(actual,/url\(|background-repeat:\s*repeat/,
    'no Grain or new texture render');
assert.equal(buildMilkyAppearanceCss({milky:false}), '');
console.log('Milky parity: notifications, popup/app menus, dialogs, previews, Orb, Spotlight, Dock, OSD and overview; headers black, all other Liquid surfaces white PASS.');
