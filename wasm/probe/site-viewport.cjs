// The ExtJS backend of TYPO3 4.5 and 6.2, for site.cjs: what a spec's
// `backend` holds, and the checks both releases run on it.
'use strict';

const assert = require('assert');

// backend.php is one document: an ExtJS viewport, with the module menu in it
// and each module in an iframe named content, which most modules still
// reach as top.content.
const viewport = {
  page: 'backend.php',
  landsOn: /\/backend\.php$/,
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

// What site.cjs runs in the backend once the page is renamed. renamed: the
// title the editor saved. found: three search terms that find it, such as
// a word outside latin1. titleLen: the backend user's default, after which
// the page tree cuts a title.
function viewportChecks(renamed, found, titleLen) {
  return [
    ['the page tree, drawn from Ext.Direct answers, shows the renamed page', async ({ backend }) => {
      // The tree shows a title cut to the backend user's titleLen
      // (getNewNode() of the page tree's Commands).
      const shown = renamed.length > titleLen ? `${renamed.slice(0, titleLen)}...` : renamed;
      const expected = { editableText: renamed, shown };
      let node = null;
      for (let tries = 0; tries < 100; tries++) {
        node = await pageTreeNode(backend);
        if (node && node.editableText === renamed) {
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
      const answers = await backend.evaluate(async ({ renamed, found }) => {
        const url = 'ajax.php?ajaxID=ExtDirect::route&namespace=TYPO3.Components.PageTree';
        const token = TYPO3.ExtDirectToken;
        const call = (tid, method, data) => ({ action: 'DataProvider', method, data: [...data, token], type: 'rpc', tid });
        // Search terms that find the page, by a word outside latin1, and
        // ones that find nothing.
        const searches = [found[0], 'nothing-1', found[1], 'nothing-2', found[2], 'nothing-3'];
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
      }, { renamed, found });
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
  ];
}

module.exports = { viewport, viewportChecks };
