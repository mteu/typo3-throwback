// TYPO3 4.5.40 for site.cjs: what its frontend shows, its ExtJS backend, and
// the checks only 4.5.40 has.
'use strict';

const assert = require('assert');

// The job's CHARSET_PROBE, which 4.5/provision.php seeds as the root page's
// title, as UTF-8.
const CHARSET_PROBE = 'Skaarhøj · Gödöllő · 日本語';
// Typed into the editor of a UTF-8 page: the ő and the kanji are outside
// latin1, which 4.0.13's ISO-8859-1 backend could only store as references.
const RENAMED = 'Renamed in a 2015 backend, Gödöllő 日本語';

// backend.php is one document: an ExtJS viewport, with the module menu in it
// and each module in an iframe named content, which most modules still
// reach as top.content.
const viewport = {
  page: 'backend.php',
  landsOn: /\/backend\.php$/,
  // The File module moved into the filelist extension in 4.5.
  fileList: 'sysext/filelist/mod1/file_list.php',
  // In the shell's iframe, until the shell turns it away, backend.php finds
  // the shell as top, which has neither top.TYPO3 nor top.TS. Two of its
  // scripts read them as they load: viewportConfiguration.js reads
  // top.TYPO3.LLL, and opendocs.js top.TS.PATH_typo3. Without that
  // configuration the viewport does not build (viewport.js reads
  // items[0]), and modulemenu.js finds no TYPO3.Backend.ContentContainer or
  // ModuleMenuContainer. These five are all it throws.
  turnedAwayErrors: /: Cannot read properties of undefined \(reading '(LLL|PATH_typo3|0|ContentContainer|ModuleMenuContainer)'\)$/,

  async assertLoaded(backend) {
    await backend.waitForSelector('#typo3-menu li.submodule', { timeout: 30000 });
    const state = await backend.evaluate(() => ({
      viewport: typeof TYPO3 === 'object' && typeof TYPO3.Backend === 'object',
      content: Boolean(document.querySelector('iframe[name="content"]')),
      token: typeof TYPO3 === 'object' && /^[0-9a-f]{40}$/.test(TYPO3.ExtDirectToken || ''),
      frames: document.querySelectorAll('frame').length,
    }));
    console.log(`     backend.php: ExtJS viewport ${state.viewport}, content iframe ${state.content}, Ext.Direct token ${state.token}`);
    assert.deepStrictEqual(state, { viewport: true, content: true, token: true, frames: 0 });
  },

  // The modules the menu lists, by the ids of their items, such as web_layout.
  async menuModules(backend) {
    await backend.waitForSelector('#typo3-menu li.submodule', { timeout: 30000 });
    return backend.$$eval('#typo3-menu li.submodule', items => items.map(item => item.id));
  },

  // Clicks the module's item, which TYPO3.ModuleMenu.App.showModule() opens
  // in the content iframe.
  async openModule(backend, name) {
    await backend.click(`#typo3-menu li#${name}`);
  },
};

// Page 1's node in the page tree, which ExtJS draws in backend.php itself
// from what TYPO3.Components.PageTree.DataProvider answers over Ext.Direct:
// the title the node edits in place, and the text it shows.
const pageTreeNode = backend => backend.evaluate(() => {
  const tree = Ext.ComponentMgr.all.items.find(component => typeof component.getNodeById === 'function' && component.getNodeById('p1'));
  const node = tree && tree.getNodeById('p1');
  return node ? { editableText: node.attributes.editableText, shown: node.ui.getTextEl().innerText } : null;
});

module.exports = {
  title: CHARSET_PROBE,
  day: '2015-02-19',
  renamed: RENAMED,
  // 4.5/provision.php's template renders the release in an <h1>, and the
  // page title in <p id="charset-probe">, as TypoScript reads it back from
  // the database.
  assertFrontend(html, title) {
    assert.ok(html.includes('<h1>TYPO3 4.5.40</h1>'), 'the seeded heading is missing');
    const probe = (html.match(/<p id="charset-probe">(.*?)<\/p>/s) || [])[1];
    assert.strictEqual(probe, title, `the charset probe is not "${title}"`);
  },
  // The seeded page is text only.
  frontendImages: [],
  backend: viewport,
  remoteModules: [],
  // 4.5.40's menu with the extensions in releases/4.5.40.js's extList.
  minModules: 13,
  phpUploadRefused: /Extension of file name "uploaded\.php" is not allowed/,
  // tce_file.php answers 303 to the form's returnUrl, the file list, and
  // keeps what it refused as a flash message in the backend session, which
  // the list shows above the files. The message names the refused file, so
  // the listing leaves it out.
  async submitUpload({ backend, content, uploadName, fileListShowing }) {
    await content.locator('input[type="submit"]').first().click();
    await fileListShowing(uploadName);
    return backend.frame({ name: 'content' }).evaluate(() => {
      const messages = [...document.querySelectorAll('.typo3-message')];
      const said = messages.map(message => message.innerText).join('\n');
      messages.forEach(message => message.remove());
      return { said, listing: document.body.innerText };
    });
  },
  archiveLicences: /typo3\/contrib\/extjs\/LICENSE\.txt/,
  backendChecks: [
    ['the page tree, drawn from Ext.Direct answers, shows the renamed page', async ({ backend }) => {
      // The tree shows a title cut to the backend user's titleLen, 30 by
      // default (t3lib_tree_pagetree_Commands::getNewNode()).
      const expected = { editableText: RENAMED, shown: `${RENAMED.slice(0, 30)}...` };
      let node = null;
      for (let tries = 0; tries < 100; tries++) {
        node = await pageTreeNode(backend);
        if (node && node.editableText === RENAMED) {
          break;
        }
        await backend.waitForTimeout(300);
      }
      assert.deepStrictEqual(node, expected);
    }],

    // The page tree's own calls go out as raw JSON POSTs, which sw.js relays
    // to the PHP worker one by one. Six at once, each its own fetch and tid,
    // and one batched pair as ExtJS sends them: every answer must be the one
    // for its own body.
    ['six Ext.Direct calls at once, and a batch, each get the answer to their own body', async ({ backend }) => {
      const answers = await backend.evaluate(async renamed => {
        const url = 'ajax.php?ajaxID=ExtDirect::route&namespace=TYPO3.Components.PageTree';
        const token = TYPO3.ExtDirectToken;
        const call = (tid, method, data) => ({ action: 'DataProvider', method, data: [...data, token], type: 'rpc', tid });
        // Search terms that find the page, by a word outside latin1, and
        // ones that find nothing.
        const searches = ['日本語', 'nothing-1', 'Gödöllő', 'nothing-2', '2015 backend', 'nothing-3'];
        const send = async body => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify(body),
          });
          return { status: response.status, type: response.headers.get('Content-Type'), text: await response.text() };
        };
        const single = searches.map((term, i) => send(call(100 + i, 'getFilteredTree', ['root', { id: 'root' }, term])));
        const batch = send([call(200, 'getNodeTypes', []), call(201, 'getNextTreeLevel', ['root', { id: 'root' }])]);
        const replies = await Promise.all([...single, batch]);
        return replies.map((reply, i) => {
          let parsed = null;
          try {
            parsed = JSON.parse(reply.text);
          } catch (error) {
            return { i, status: reply.status, notJson: reply.text.slice(0, 300) };
          }
          const list = Array.isArray(parsed) ? parsed : [parsed];
          return {
            i,
            status: reply.status,
            type: reply.type,
            replies: list.map(item => ({
              tid: item.tid,
              method: item.method,
              type: item.type,
              message: item.message,
              found: JSON.stringify(item.result || null).includes(renamed),
            })),
            search: searches[i],
          };
        });
      }, RENAMED);
      for (const answer of answers) {
        assert.ok(!answer.notJson, `call ${answer.i} was answered with: ${answer.notJson}`);
        assert.strictEqual(answer.status, 200);
        assert.match(answer.type, /^application\/json; *charset=utf-8$/i);
      }
      const singles = answers.slice(0, 6).map(answer => answer.replies.map(reply => [reply.tid, reply.method, reply.type, reply.found]));
      assert.deepStrictEqual(singles, [
        [[100, 'getFilteredTree', 'rpc', true]],
        [[101, 'getFilteredTree', 'rpc', false]],
        [[102, 'getFilteredTree', 'rpc', true]],
        [[103, 'getFilteredTree', 'rpc', false]],
        [[104, 'getFilteredTree', 'rpc', true]],
        [[105, 'getFilteredTree', 'rpc', false]],
      ]);
      assert.deepStrictEqual(answers[6].replies.map(reply => [reply.tid, reply.method, reply.type]),
        [[200, 'getNodeTypes', 'rpc'], [201, 'getNextTreeLevel', 'rpc']]);
      assert.strictEqual(answers[6].replies[1].found, true, 'the batched getNextTreeLevel does not name the renamed page');
    }],
  ],
};
