import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ExtensionSession } from '../../scripts/extension-session.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function waitUntil(check, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Expected browser state was not reached');
}

void test(
  'agent verifies the toolbar popup, collects every context, and rebuilds changed code',
  { timeout: 90_000 },
  async (t) => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'jev-agent-'));
    const output = path.join(project, 'dist');
    await cp(path.join(root, '.output/chrome-mv3'), output, { recursive: true });
    for (const directory of ['src', 'public', 'tests/e2e', 'mock/pbs.twimg.com/media'])
      await mkdir(path.join(project, directory), { recursive: true });
    await cp(path.join(root, 'tests/e2e/feed.html'), path.join(project, 'tests/e2e/feed.html'));
    await cp(
      path.join(root, 'mock/pbs.twimg.com/media/landscape.png'),
      path.join(project, 'mock/pbs.twimg.com/media/landscape.png'),
    );
    await cp(path.join(output, 'popup.html'), path.join(project, 'popup.template.html'));
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ scripts: { build: 'node build.mjs' } }),
    );
    await writeFile(
      path.join(project, 'build.mjs'),
      `
    import { readFile, writeFile } from 'node:fs/promises';
    const revision = await readFile('src/revision.txt', 'utf8');
    if (revision === 'broken') { console.error('intentional build failure'); process.exit(1); }
    const popup = await readFile('popup.template.html', 'utf8');
    await writeFile('dist/popup.html', popup.replace('</body>', '<div id="revision">' + revision + '</div></body>'));
  `,
    );
    const session = new ExtensionSession({
      root: project,
      output,
      artifacts: path.join(project, 'artifacts'),
      profile: path.join(project, 'profile'),
      headless: true,
    });
    t.after(async () => {
      await session.close();
      await rm(project, { recursive: true, force: true });
    });
    await session.start({ build: false });

    await t.test(
      'inspects the real action popup and captures logs from separate execution contexts',
      async () => {
        assert.equal((await session.verify()).ok, true);
        assert.equal((await session.doctor()).ok, true);
        const snapshot = await session.inspect();
        assert(snapshot.url.startsWith(`chrome-extension://${session.extensionId}/`));
        assert.equal(
          snapshot.controls.find((control) => control.id === 'gateway-key').value,
          '<REDACTED>',
        );
        assert((await readFile(snapshot.screenshot)).length > 1000);
      },
    );

    await t.test('popup changes reach the active content-script tab', async () => {
      const popup = await session.popup();
      await session.feed.waitForFunction(
        () => getComputedStyle(document.querySelector('[data-post="102"]')).display === 'none',
        { polling: 50, timeout: 10_000 },
      );
      await popup.click('[aria-label="Enable filtering"]');
      await session.feed.waitForFunction(
        () => getComputedStyle(document.querySelector('[data-post="102"]')).display !== 'none',
        { polling: 50, timeout: 10_000 },
      );
      await popup.click('[aria-label="Enable filtering"]');
      await session.feed.waitForFunction(
        () => getComputedStyle(document.querySelector('[data-post="102"]')).display === 'none',
        { polling: 50, timeout: 10_000 },
      );
    });

    await t.test('watcher rebuilds and the actual popup runs the changed build', async () => {
      session.watch();
      const previous = session.generation;
      await writeFile(path.join(project, 'src/revision.txt'), 'fresh-build-42');
      await waitUntil(
        () => session.generation > previous && session.lastCheck?.generation === session.generation,
      );
      assert.equal(session.lastCheck.ok, true, JSON.stringify(session.lastCheck));
      const popup = await session.popup();
      assert.equal(
        await popup.$eval('#revision', (element) => element.textContent),
        'fresh-build-42',
      );
      assert.equal(
        await popup.$eval('[aria-label="Enable filtering"]', (element) =>
          element.getAttribute('aria-checked'),
        ),
        'true',
      );
      assert.equal((await session.doctor()).ok, true, 'Collectors must reconnect after reload');
    });

    await t.test('uncaught background exceptions fail verification', async () => {
      await (
        await session.worker()
      ).evaluate(() => {
        setTimeout(() => {
          throw new Error('agent-uncaught-probe');
        }, 0);
      });
      await waitUntil(() =>
        session.logs.some(
          (entry) =>
            entry.context === 'background' &&
            entry.type === 'exception' &&
            entry.text.includes('agent-uncaught-probe'),
        ),
      );
      const report = await session.verify();
      assert.equal(report.ok, false);
      assert(
        report.errors.some(
          (entry) => entry.context === 'background' && entry.text.includes('agent-uncaught-probe'),
        ),
      );
      assert.equal(
        JSON.parse(await readFile(path.join(project, 'artifacts/verification.json'), 'utf8')).ok,
        false,
      );
    });

    await t.test(
      'build failures preserve the loaded extension and recovery clears the failed generation',
      async () => {
        const previous = session.generation;
        await writeFile(path.join(project, 'src/revision.txt'), 'broken');
        await waitUntil(() => session.lastCheck?.error?.includes('Extension build failed'));
        assert.equal(session.generation, previous, 'A failed build must not reload partial output');
        assert.equal(session.lastBuild.code, 1);
        await writeFile(path.join(project, 'src/revision.txt'), 'recovered-build');
        await waitUntil(
          () =>
            session.generation > previous && session.lastCheck?.generation === session.generation,
        );
        assert.equal(session.lastCheck.ok, true, JSON.stringify(session.lastCheck));
        assert.equal(
          await (await session.popup()).$eval('#revision', (element) => element.textContent),
          'recovered-build',
        );
      },
    );

    await t.test('broken popup content produces a failing report', async () => {
      await (
        await session.popup()
      ).$eval('h1', (element) => {
        element.textContent = 'Broken heading';
      });
      const report = await session.verify();
      assert.equal(report.ok, false);
      assert.match(report.error, /Popup heading is incorrect/);
    });
  },
);
