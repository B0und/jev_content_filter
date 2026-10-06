import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { chromium } from '@playwright/test';

export class ExtensionSession {
  constructor({ root, output, artifacts, profile, headless = false, live = false }) {
    this.root = root;
    this.output = output ?? path.join(root, '.output/chrome-mv3');
    this.artifacts = artifacts;
    this.profile = profile;
    this.headless = headless;
    this.live = live;
    this.logs = [];
    this.sequence = 0;
    this.generation = 0;
    this.targets = new Map();
    this.retiredWorkers = new WeakSet();
    this.watchers = [];
    this.queue = Promise.resolve();
    this.lastCheck = null;
    this.lastBuild = null;
    this.stopping = false;
  }

  record(context, type, text, url = '') {
    const entry = {
      sequence: ++this.sequence,
      time: new Date().toISOString(),
      generation: this.generation,
      context,
      type,
      text,
      url,
    };
    this.logs.push(entry);
    this.logStream?.write(`${JSON.stringify(entry)}\n`);
    if (this.logs.length > 1000) this.logs.shift();
    return entry;
  }

  serialize(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  async build() {
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'build'], {
        cwd: this.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const collect = (chunk) => {
        output = (output + chunk.toString()).slice(-30_000);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
    this.lastBuild = {
      ...result,
      durationMs: Date.now() - started,
      time: new Date().toISOString(),
    };
    if (result.code !== 0) {
      this.record('harness', 'error', result.output);
      throw new Error(`Extension build failed (exit ${result.code}). See status.lastBuild.output.`);
    }
  }

  async start({ build = true } = {}) {
    await mkdir(this.artifacts, { recursive: true });
    this.logStream = createWriteStream(path.join(this.artifacts, 'console.jsonl'), {
      flags: 'a',
      mode: 0o600,
    });
    if (build) await this.build();
    this.manifest = JSON.parse(await readFile(path.join(this.output, 'manifest.json'), 'utf8'));
    this.browser = await puppeteer.launch({
      executablePath: process.env.EXTENSION_BROWSER_PATH || chromium.executablePath(),
      userDataDir: this.profile,
      headless: this.headless,
      pipe: true,
      enableExtensions: true,
      protocolTimeout: 15_000,
      defaultViewport: null,
    });
    this.browser.on('targetcreated', (target) => {
      void this.attach(target).catch((error) => {
        if (!this.stopping && !/closed|destroyed/i.test(error.message))
          this.record('harness', 'error', error.message);
      });
    });
    this.browser.on('targetdestroyed', (target) => this.targets.delete(target));
    await Promise.all(this.browser.targets().map((target) => this.attach(target)));
    this.generation = 1;
    this.extensionId = await this.browser.installExtension(this.output);
    const worker = await this.worker();
    if (!this.live) {
      // Wait for the application's async initialization before seeding settings.
      // Otherwise its normalization write can overwrite the fixture credentials.
      const setup = await this.browser.newPage();
      try {
        await setup.goto(`chrome-extension://${this.extensionId}/logs.html`);
        await setup.evaluate(async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              await chrome.runtime.sendMessage({ type: 'get-status' });
              return;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          throw new Error('Background message listener did not initialize');
        });
        // This profile is only for the offline fixture. No real credentials or provider calls.
        await worker.evaluate(async () => {
          const existing = await chrome.storage.local.get('agentFixtureInitialized');
          if (existing.agentFixtureInitialized) return;
          await chrome.storage.local.set({
            agentFixtureInitialized: true,
            settings: {
              masterEnabled: true,
              textProvider: 'vercel',
              textConfigRevision: 0,
              providerKeys: { vercel: 'agent-fixture-key', typesafe: '', openrouter: '' },
              enabled: {
                porn: false,
                hentai: false,
                sexy: false,
                drawings: false,
                sexualText: true,
                aiGenerated: true,
              },
              thresholds: {
                porn: 0.6,
                hentai: 0.6,
                sexy: 0.65,
                drawings: 0.7,
                sexualText: 0.65,
                aiGenerated: 0.65,
              },
            },
          });
        });
      } finally {
        await setup.close();
      }
    }
    this.feed = await this.browser.newPage();
    await this.attach(this.feed.target());
    if (!this.live) await this.mockRequests(this.feed);
    await this.feed.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    return this.status();
  }

  attach(target) {
    if (this.retiredWorkers.has(target)) return Promise.resolve();
    if (!['page', 'service_worker'].includes(target.type())) return Promise.resolve();
    if (this.targets.has(target)) return this.targets.get(target).ready;
    const state = { contexts: new Map(), ready: null };
    this.targets.set(target, state);
    state.ready = (async () => {
      const client = await target.createCDPSession();
      state.client = client;
      client.on('Runtime.executionContextCreated', ({ context }) =>
        state.contexts.set(context.id, context),
      );
      client.on('Runtime.executionContextsCleared', () => state.contexts.clear());
      client.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
        state.contexts.delete(executionContextId),
      );
      const source = (id, url) => {
        if (target.type() === 'service_worker') return 'background';
        const document = target.url();
        if (document.startsWith('chrome-extension://'))
          return document.endsWith('/popup.html') ? 'popup' : 'extension-page';
        const context = state.contexts.get(id);
        return context?.origin?.startsWith('chrome-extension://') ||
          url?.startsWith('chrome-extension://')
          ? 'content'
          : 'page';
      };
      client.on('Runtime.consoleAPICalled', (event) => {
        const url = event.stackTrace?.callFrames?.[0]?.url ?? target.url();
        const text = event.args
          .map((arg) => {
            if (arg.value === undefined) return arg.description ?? arg.type;
            if (typeof arg.value === 'string') return arg.value;
            return JSON.stringify(arg.value);
          })
          .join(' ');
        this.record(source(event.executionContextId, url), event.type, text, url);
      });
      client.on('Runtime.exceptionThrown', ({ exceptionDetails: details }) => {
        this.record(
          source(details.executionContextId, details.url),
          'exception',
          details.exception?.description ?? details.text,
          details.url ?? target.url(),
        );
      });
      await client.send('Runtime.enable');
    })();
    return state.ready;
  }

  async mockRequests(page) {
    const feed = await readFile(path.join(this.root, 'tests/e2e/feed.html'), 'utf8');
    const image = await readFile(path.join(this.root, 'mock/pbs.twimg.com/media/landscape.png'));
    // Intercept the worker too: page interception alone cannot stop background fetches.
    const workerTarget = await this.browser.waitForTarget(
      (target) =>
        target.type() === 'service_worker' &&
        target.url().startsWith(`chrome-extension://${this.extensionId}/`),
    );
    const state = this.targets.get(workerTarget);
    await this.attach(workerTarget);
    const mockWorker = async (target) => {
      if (
        target.type() !== 'service_worker' ||
        this.retiredWorkers.has(target) ||
        !target.url().startsWith(`chrome-extension://${this.extensionId}/`)
      )
        return;
      await this.attach(target);
      const state = this.targets.get(target);
      if (!state.mockReady)
        state.mockReady = (async () => {
          const client = state.client;
          client.on('Fetch.requestPaused', (event) => {
            void respond(client, event).catch((error) => {
              if (!this.stopping && !/closed|destroyed/i.test(error.message))
                this.record('harness', 'error', error.message);
            });
          });
          await client.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }] });
        })();
      await state.mockReady;
    };
    const respond = async (client, { requestId, request }) => {
      const url = new URL(request.url);
      let body;
      let contentType = 'application/json';
      if (url.hostname === 'ai-gateway.vercel.sh') {
        const text = JSON.parse(request.postData ?? '{}').state?.tweet_text ?? '';
        body = Buffer.from(
          JSON.stringify({
            answers: {
              sexual: { type: 'boolean', probability: text.includes('BLOCK_TEXT') ? 0.99 : 0.01 },
              ai: { type: 'boolean', probability: 0.02 },
            },
          }),
        );
      } else if (url.hostname === 'pbs.twimg.com') {
        body = image;
        contentType = 'image/png';
      } else {
        await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        return;
      }
      await client.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: contentType }],
        body: body.toString('base64'),
      });
    };
    // Register before reloads can create a replacement worker.
    this.browser.on('targetcreated', (target) => {
      void mockWorker(target).catch((error) => this.record('harness', 'error', error.message));
    });
    this.mockWorker = mockWorker;
    assert(state, 'Background collector was not attached');
    await mockWorker(workerTarget);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      let action;
      if (url.protocol === 'chrome-extension:') action = request.continue();
      else if (['x.com', 'twitter.com'].includes(url.hostname))
        action = request.respond({ contentType: 'text/html', body: feed });
      else if (url.hostname === 'pbs.twimg.com')
        action = request.respond({ contentType: 'image/png', body: image });
      else action = request.abort();
      void action.catch((error) => {
        if (!this.stopping) this.record('harness', 'error', error.message);
      });
    });
  }

  async worker() {
    const target = await this.browser.waitForTarget(
      (candidate) =>
        candidate.type() === 'service_worker' &&
        !this.retiredWorkers.has(candidate) &&
        candidate.url().startsWith(`chrome-extension://${this.extensionId}/`),
      { timeout: 15_000 },
    );
    await this.attach(target);
    if (this.mockWorker) await this.mockWorker(target);
    const client = this.targets.get(target).client;
    // A new worker target can be discoverable before Chrome installs extension APIs.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const probe = await client.send('Runtime.evaluate', {
        expression:
          "typeof chrome !== 'undefined' && typeof chrome.runtime?.getManifest === 'function'",
        returnByValue: true,
      });
      if (probe.result.value === true) {
        ready = true;
        break;
      }
      await delay(50);
    }
    assert(ready, 'Extension worker did not initialize its Chrome APIs');
    // Resolve the current default execution context on each call. Puppeteer's cached
    // WebWorker execution context can remain stale after extension reload/suspension.
    return {
      evaluate: async (expression, ...args) => {
        const source =
          typeof expression === 'string'
            ? expression
            : `(${expression.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
        const response = await client.send('Runtime.evaluate', {
          expression: source,
          awaitPromise: true,
          returnByValue: true,
        });
        if (response.exceptionDetails)
          throw new Error(
            response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
          );
        return response.result.value;
      },
    };
  }

  async popup() {
    if (this.popupPage && !this.popupPage.isClosed()) return this.popupPage;
    await this.feed.bringToFront();
    const extension = (await this.browser.extensions()).get(this.extensionId);
    assert(extension, 'The extension is not installed');
    const popupTarget = this.browser.waitForTarget(
      (target) =>
        target.type() === 'page' &&
        target.url() ===
          `chrome-extension://${this.extensionId}/${this.manifest.action.default_popup}`,
      { timeout: 15_000 },
    );
    await extension.triggerAction(this.feed);
    const target = await popupTarget;
    await this.attach(target);
    this.popupPage = await target.asPage();
    await this.popupPage.waitForSelector('h1', { timeout: 15_000 });
    return this.popupPage;
  }

  async page(surface) {
    if (surface === 'feed') {
      await this.feed.bringToFront();
      return this.feed;
    }
    if (surface === 'popup') return this.popup();
    if (surface === 'logs') {
      if (!this.logPage || this.logPage.isClosed()) {
        this.logPage = await this.browser.newPage();
        await this.attach(this.logPage.target());
        await this.logPage.goto(`chrome-extension://${this.extensionId}/logs.html`);
      }
      await this.logPage.bringToFront();
      return this.logPage;
    }
    throw new Error('Surface must be popup, feed, or logs');
  }

  async inspect(surface = 'popup') {
    const page = await this.page(surface);
    await page.waitForSelector('body');
    const snapshot = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: document.body.innerText,
      controls: Array.from(document.querySelectorAll('button, input, select, [role="switch"]')).map(
        (element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id,
          role: element.getAttribute('role'),
          label: element.getAttribute('aria-label') || element.textContent?.trim(),
          value:
            element instanceof HTMLInputElement &&
            (element.type === 'password' || /key/i.test(element.id))
              ? '<REDACTED>'
              : element.value,
          checked: element.getAttribute('aria-checked'),
        }),
      ),
    }));
    const directory = path.join(this.artifacts, `generation-${this.generation}`);
    await mkdir(directory, { recursive: true });
    const screenshot = path.join(directory, `${surface}.png`);
    const snapshotPath = path.join(directory, `${surface}.json`);
    // Mask credentials even if the popup's Show key button has been used.
    const mask = await page.addStyleTag({
      content: '#gateway-key { visibility: hidden !important; }',
    });
    try {
      await page.screenshot({ path: screenshot });
    } finally {
      await mask.evaluate((element) => element.remove());
    }
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    return { ...snapshot, screenshot, snapshotPath, generation: this.generation };
  }

  async reload({ build = true } = {}) {
    if (build) await this.build();
    this.manifest = JSON.parse(await readFile(path.join(this.output, 'manifest.json'), 'utf8'));
    if (this.popupPage && !this.popupPage.isClosed()) await this.popupPage.close();
    this.popupPage = null;
    // Debugger attachments can keep the previous worker target alive during reload.
    // Retire those targets and release their sessions before choosing the new worker.
    for (const [target, state] of this.targets) {
      if (target.type() !== 'service_worker') continue;
      this.retiredWorkers.add(target);
      await state.ready;
      await state.client.detach();
      this.targets.delete(target);
    }
    this.generation++;
    this.extensionId = await this.browser.installExtension(this.output);
    const runningManifest = await (
      await this.worker()
    ).evaluate(() => chrome.runtime.getManifest());
    assert.equal(
      runningManifest.name,
      this.manifest.name,
      'Background worker did not load the current extension',
    );
    if (this.logPage && !this.logPage.isClosed()) await this.logPage.reload();
    await this.feed.reload({ waitUntil: 'domcontentloaded' });
    this.record('harness', 'info', 'Extension reloaded and target tab refreshed');
    return this.verify();
  }

  async check() {
    const popup = await this.popup();
    await popup.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Enable filtering"]')
          ?.hasAttribute('aria-checked'),
      { timeout: 10_000, polling: 50 },
    );
    const snapshot = await this.inspect('popup');
    assert.equal(
      await popup.$eval('h1', (element) => element.textContent.trim().toLowerCase()),
      this.manifest.name.toLowerCase(),
      'Popup heading is incorrect',
    );
    assert(
      snapshot.controls.some((control) => control.label === 'Enable filtering'),
      'Popup filtering switch is missing',
    );
    assert(
      snapshot.controls.some((control) => control.label === 'Open logs'),
      'Popup log button is missing',
    );
    if (!this.live) {
      await this.feed.waitForFunction(
        () =>
          document
            .querySelector('[data-post="101"] [data-jev-host]')
            ?.shadowRoot?.querySelector('button'),
        { timeout: 15_000, polling: 50 },
      );
    }
    await this.worker();
    const errors = this.logs.filter(
      (entry) =>
        entry.generation === this.generation && ['error', 'exception'].includes(entry.type),
    );
    this.lastCheck = {
      ok: errors.length === 0,
      generation: this.generation,
      time: new Date().toISOString(),
      mode: this.live ? 'live-smoke' : 'offline-fixture',
      popup: snapshot,
      errors,
    };
    await writeFile(
      path.join(this.artifacts, 'verification.json'),
      JSON.stringify(this.lastCheck, null, 2),
    );
    return this.lastCheck;
  }

  async verify() {
    try {
      return await this.check();
    } catch (error) {
      this.lastCheck = {
        ok: false,
        generation: this.generation,
        time: new Date().toISOString(),
        error: error.message,
      };
      await writeFile(
        path.join(this.artifacts, 'verification.json'),
        JSON.stringify(this.lastCheck, null, 2),
      );
      return this.lastCheck;
    }
  }

  async doctor() {
    const since = this.sequence;
    const marker = `agent-log-probe-${Date.now()}`;
    const worker = await this.worker();
    const popup = await this.popup();
    await worker.evaluate((text) => console.info(text), `${marker}:background`);
    await popup.evaluate((text) => console.info(text), `${marker}:popup`);
    const realms = this.feed.extensionRealms();
    let content;
    for (const realm of realms) {
      if ((await realm.extension())?.id === this.extensionId) {
        content = realm;
        break;
      }
    }
    assert(content, 'Content-script execution context is missing');
    await content.evaluate((text) => console.info(text), `${marker}:content`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const entries = this.logs.filter(
        (entry) => entry.sequence > since && entry.text.startsWith(marker),
      );
      if (
        ['background', 'popup', 'content'].every((context) =>
          entries.some((entry) => entry.context === context),
        )
      )
        return { ok: true, entries };
      await delay(50);
    }
    throw new Error(
      'Log probe failed: background, popup, and content messages must all be captured',
    );
  }

  watch() {
    const changed = () => {
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        void this.serialize(async () => {
          try {
            await this.reload();
          } catch (error) {
            this.lastCheck = {
              ok: false,
              generation: this.generation,
              time: new Date().toISOString(),
              error: error.message,
            };
            this.record('harness', 'error', error.message);
            await writeFile(
              path.join(this.artifacts, 'verification.json'),
              JSON.stringify(this.lastCheck, null, 2),
            );
          }
        });
      }, 400);
    };
    for (const directory of ['src', 'public'])
      this.watchers.push(watch(path.join(this.root, directory), { recursive: true }, changed));
    this.watchers.push(
      watch(this.root, (_, filename) => {
        if (['wxt.config.ts', 'package.json', 'package-lock.json'].includes(filename)) changed();
      }),
    );
  }

  status() {
    const check = this.lastCheck;
    return {
      running: !this.stopping,
      pid: process.pid,
      extensionId: this.extensionId,
      generation: this.generation,
      mode: this.live ? 'live' : 'offline-fixture',
      headed: !this.headless,
      watching: this.watchers.length > 0,
      output: this.output,
      artifacts: this.artifacts,
      lastBuild: this.lastBuild,
      lastCheck: check && {
        ok: check.ok,
        time: check.time,
        generation: check.generation,
        error: check.error,
        errors: check.errors,
        screenshot: check.popup?.screenshot,
      },
      lastLogSequence: this.sequence,
    };
  }

  async close() {
    this.stopping = true;
    clearTimeout(this.watchTimer);
    this.watchers.forEach((watcher) => watcher.close());
    await this.queue;
    if (this.browser) await this.browser.close();
    if (this.logStream) await new Promise((resolve) => this.logStream.end(resolve));
  }
}
