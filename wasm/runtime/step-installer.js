// Drives TYPO3 6.2's own step installer on a site's first boot. It is the
// twin of 6.2/install.php, which does the same for the Docker stack, and
// says why 6.2 is installed this way rather than from a configuration file.
// This one does what that one does, in the same order, with the same values,
// failure checks and log lines. A change to one belongs in the other.
//
// The difference is the transport. install.php talks to the container's
// Apache over loopback. A tab has no loopback, so this sends each request
// through runtime/typo3-site.js's handle(), to the same PHP and the same
// php.ini the site then serves with.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StepInstaller = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const START = '/typo3/sysext/install/Start/';

  class InstallerError extends Error {}

  // install.php's cookie jar: every cookie by name, sent on every request,
  // with no path. Its own, not the site's, so the installer's session ends
  // with the installer, as in Docker.
  class InstallerCookies {
    constructor() {
      this.cookies = new Map();
    }

    store(header) {
      const match = /^\s*([^=;\s]+)=([^;]*)/.exec(header);
      if (match) {
        this.cookies.set(match[1], match[2]);
      }
    }

    header() {
      return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
  }

  function utf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  // html_entity_decode($value, ENT_QUOTES, 'UTF-8'), for what a form's
  // attributes hold.
  const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return String.fromCodePoint(code);
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : entity;
    });
  }

  // install.php's hiddenFields(): the hidden fields of the first form that
  // names a step, by name. Its docblock says why the first such form and not
  // the first form.
  function hiddenFields(body) {
    for (const form of body.match(/<form\b[\s\S]*?<\/form>/g) || []) {
      const fields = new Map();
      for (const input of form.match(/<input\b[^>]*>/g) || []) {
        const attributes = {};
        for (const [, name, value] of input.matchAll(/(\w+)="([^"]*)"/g)) {
          attributes[name] = decodeEntities(value);
        }
        if (attributes.type === 'hidden' && attributes.name !== undefined) {
          fields.set(attributes.name, attributes.value === undefined ? '' : attributes.value);
        }
      }
      if (fields.has('install[action]')) {
        return fields;
      }
    }
    return new Map();
  }

  function excerpt(body) {
    const text = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 1500);
  }

  // install.php's $values, with its env() defaults. env holds what
  // 6.2/entrypoint.sh exports.
  function stepValues(env) {
    const value = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : env[name]);
    return {
      databaseConnect: {
        username: value('TYPO3_DB_USER', 'typo3'),
        password: value('TYPO3_DB_PASSWORD', 'typo3'),
        host: value('TYPO3_DB_HOST', 'db'),
        port: '3306',
      },
      databaseSelect: {
        type: 'existing',
        existing: value('TYPO3_DB_NAME', 'typo3'),
      },
      databaseData: {
        username: value('TYPO3_ADMIN_USER', 'admin'),
        password: value('TYPO3_ADMIN_PASSWORD', 'password'),
        sitename: value('TYPO3_SITENAME', 'TYPO3 6.2.31'),
      },
      defaultConfiguration: {},
      environmentAndFolders: {},
    };
  }

  // site: a runtime/typo3-site.js Typo3Site. env: the environment
  // install.php would see. onStep: called with each step's number and name
  // as the step starts, where install.php logs it. Returns the log, one "[install] " line each; each
  // step's time, from the GETs that showed its form to the POST that sent
  // it; and what PHP logged, which in Docker goes to Apache's error log.
  // Throws an InstallerError whose message is the log, ending with
  // install.php's ERROR line, when the installer does not finish.
  function install(site, env, onStep = () => {}) {
    const lines = [];
    const steps = [];
    const phpLog = [];
    const cookies = new InstallerCookies();
    const base = site.urlPrefix + START;
    const out = message => lines.push(`[install] ${message}`);
    const fail = message => {
      lines.push(`[install] ERROR: ${message}`);
      throw new InstallerError(`${lines.join('\n')}\n`);
    };

    // One request, no redirects followed, as install.php's request().
    const request = (method, url, fields = null) => {
      const target = new URL(url, 'http://127.0.0.1');
      const body = fields === null ? null : new TextEncoder().encode(new URLSearchParams([...fields]).toString());
      const response = site.handle({
        method,
        path: target.pathname,
        query: target.search.slice(1),
        // What PHP's http:// stream sends for install.php's base URL. The
        // installer builds its redirects from it.
        headers: {
          Host: '127.0.0.1',
          'User-Agent': 'typo3-throwback 6.2 installer driver',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
      }, cookies);
      for (const line of response.log || []) {
        phpLog.push(`${method} ${target.pathname}: ${line}`);
      }
      const location = (response.headers.find(([name]) => name.toLowerCase() === 'location') || [])[1];
      return { status: response.status, location: location === undefined ? null : location.trim(), body: utf8(response.body) };
    };

    const resolve = location => (/^https?:\/\//.test(location) ? location : base + location);

    // install.php's getFollowing().
    const getFollowing = url => {
      for (let hops = 0; hops < 12; hops++) {
        const { status, location, body } = request('GET', url);
        if (status === 200) {
          return { url, body };
        }
        if (status < 300 || status >= 400 || location === null) {
          fail(`GET ${url} answered ${status}: ${excerpt(body)}`);
        }
        url = resolve(location);
      }
      return fail(`too many redirects from ${url}`);
    };

    const values = stepValues(env);
    let url = `${base}Install.php`;
    let previous = '';
    const done = [];
    let round;
    for (round = 0; round < 12; round++) {
      const started = Date.now();
      const page = getFollowing(url);
      url = page.url;
      const fields = hiddenFields(page.body);
      const action = fields.get('install[action]') || '';

      if (!Object.prototype.hasOwnProperty.call(values, action)) {
        fail(`expected a step form, got action "${action}": ${excerpt(page.body)}`);
      }
      if (action === previous) {
        fail(`the installer showed "${action}" again after it was posted: ${excerpt(page.body)}`);
      }

      const post = new Map(fields);
      post.set('install[set]', 'execute');
      for (const [name, value] of Object.entries(values[action])) {
        post.set(`install[values][${name}]`, value);
      }

      out(`step ${done.length + 1}: ${action}`);
      onStep(done.length + 1, action);

      if (action === 'environmentAndFolders') {
        if (page.body.includes('I know what I')) {
          out(`the environment check reported errors or warnings: ${excerpt(page.body)}`);
        } else {
          out('the environment check reported nothing: "System looks good"');
        }
      }
      const answer = request('POST', url, post);
      if (answer.status < 300 || answer.status >= 400 || answer.location === null) {
        fail(`posting "${action}" answered ${answer.status}: ${excerpt(answer.body)}`);
      }

      done.push(action);
      previous = action;
      steps.push({ action, ms: Date.now() - started });

      if (action === 'defaultConfiguration') {
        if (!answer.location.includes('index.php') || answer.location.includes('Install.php')) {
          fail(`defaultConfiguration redirected to ${answer.location}, not to the site`);
        }
        out(`installer finished after ${done.join(', ')}; it sent the browser to ${answer.location}`);
        return { log: `${lines.join('\n')}\n`, steps, phpLog };
      }

      url = resolve(answer.location);
    }
    return fail(`the installer did not finish within ${round} steps: ${done.join(', ')}`);
  }

  return { install, InstallerError, hiddenFields };
});
