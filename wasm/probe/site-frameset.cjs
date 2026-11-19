// The frameset backend of TYPO3 3.3 to 4.0, for site.cjs: what a spec's
// `backend` holds. alt_main.php is a frameset, with the module menu in the
// frame named menu, whose links call top.goToModule().
'use strict';

const assert = require('assert');

module.exports = {
  // The page the login lands on, which site.cjs also loads into the shell's
  // iframe to see it turned away.
  page: 'alt_main.php',
  landsOn: /\/alt_main\.php$/,
  // The File module, as file_upload.php's returnUrl names it.
  fileList: 'file_list.php',
  // In the shell's iframe, until the shell turns it away, the frameset's
  // frames find the shell as top. 3.8.1's and 4.0.13's call a function of
  // the backend's own top window as they load, which the shell does not
  // have: the reason the backend gets a tab of its own. In both it is
  // alt_menu.php's onload="top.restoreHighlightedModuleMenuItem()", which
  // only alt_main.php defines.
  turnedAwayErrors: /: top\.\w+ is not a function$/,

  async assertLoaded(backend) {
    await backend.waitForFunction(() => document.readyState === 'complete' && document.querySelectorAll('frame').length > 0);
    const frames = await backend.evaluate(() => [...document.querySelectorAll('frame')].map(f => f.getAttribute('name')));
    console.log(`     alt_main.php frames: ${frames.join(', ')}`);
    assert.ok(frames.length >= 2, 'no frameset');
    assert.strictEqual(await backend.evaluate(() => typeof window.goToModule), 'function');
  },

  // The modules the menu links to, by their names, such as web_layout.
  async menuModules(backend) {
    const menu = backend.frame({ name: 'menu' });
    await menu.locator('a[onclick*="goToModule("]').first().waitFor();
    return menu.evaluate(() => [...new Set([...document.querySelectorAll('a[onclick*="goToModule("]')]
      .map(link => link.getAttribute('onclick').match(/goToModule\('([^']+)'/)[1]))]);
  },

  // Clicks the module's link in the menu frame, which calls top.goToModule().
  async openModule(backend, name) {
    await backend.frame({ name: 'menu' }).locator(`a[onclick*="goToModule('${name}')"]`).first().click();
  },
};
