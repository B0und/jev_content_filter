import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionSession } from './extension-session.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.wxt/extension-agent');
const socket = path.join(directory, 'session.sock');
const stateFile = path.join(directory, 'session.json');
const [command = 'help', ...args] = process.argv.slice(2);

function request(operation, params = {}) {
  return new Promise((resolve, reject) => {
    const connection = http.request(
      {
        socketPath: socket,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        timeout: 120_000,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (response.statusCode !== 200) reject(new Error(result.error));
            else resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    connection.on('error', reject);
    connection.on('timeout', () =>
      connection.destroy(new Error('Extension agent command timed out')),
    );
    connection.end(JSON.stringify({ operation, ...params }));
  });
}

async function serve() {
  const session = new ExtensionSession({
    root,
    artifacts: path.join(directory, 'artifacts'),
    profile: path.join(directory, args.includes('--live') ? 'live-profile' : 'fixture-profile'),
    headless: args.includes('--headless'),
    live: args.includes('--live'),
  });
  try {
    await session.start({ build: !args.includes('--no-build') });
    await session.verify();
  } catch (error) {
    await session.close();
    throw error;
  }
  if (!args.includes('--no-watch')) session.watch();
  const server = http.createServer((incoming, outgoing) => {
    let body = '';
    incoming.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) incoming.destroy();
    });
    incoming.on('end', () => {
      void (async () => {
        const params = JSON.parse(body);
        let result;
        if (params.operation === 'status') result = session.status();
        else if (params.operation === 'logs') {
          result = {
            entries: session.logs.filter(
              (entry) =>
                entry.sequence > (params.since ?? 0) &&
                (!params.context || entry.context === params.context),
            ),
            lastSequence: session.sequence,
          };
        } else if (params.operation === 'stop') {
          result = { stopped: true };
          setImmediate(() => {
            void shutdown();
          });
        } else
          result = await session.serialize(async () => {
            if (params.operation === 'inspect') return session.inspect(params.surface ?? 'popup');
            if (params.operation === 'reload')
              return session.reload({ build: params.build !== false });
            if (params.operation === 'verify') return session.verify();
            if (params.operation === 'doctor') return session.doctor();
            if (params.operation === 'click') {
              const page = await session.page(params.surface ?? 'popup');
              await page.locator(params.selector).click();
              return { clicked: params.selector };
            }
            if (params.operation === 'fill') {
              const page = await session.page(params.surface ?? 'popup');
              await page.locator(params.selector).fill(params.value);
              return { filled: params.selector };
            }
            if (params.operation === 'eval') {
              if (params.surface === 'background')
                return (await session.worker()).evaluate(params.expression);
              return (await session.page(params.surface ?? 'popup')).evaluate(params.expression);
            }
            throw new Error(`Unknown command: ${params.operation}`);
          });
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify(result ?? null));
      })().catch((error) => {
        outgoing.writeHead(500, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: error.message }));
      });
    });
  });
  await rm(socket, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  await writeFile(stateFile, JSON.stringify({ pid: process.pid, socket }));
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    server.close();
    await session.close();
    await rm(socket, { force: true });
    await rm(stateFile, { force: true });
  }
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
  session.browser.on('disconnected', () => {
    void shutdown();
  });
}

async function main() {
  if (command === 'serve') return serve();
  if (command === 'help') {
    console.log(`Extension verification browser (JSON output)

npm run agent:browser -- start [--headless] [--live] [--no-watch] [--no-build]
npm run agent:browser -- status
npm run agent:browser -- inspect [popup|feed|logs]
npm run agent:browser -- logs [background|popup|content|page|harness] [--since=N]
npm run agent:browser -- reload [--no-build]
npm run agent:browser -- verify
npm run agent:browser -- doctor
npm run agent:browser -- click <surface> <selector>
npm run agent:browser -- fill <surface> <selector> <value>
npm run agent:browser -- eval <surface|background> <expression>
npm run agent:browser -- stop

Default: visible browser, offline X fixture, automatic build/reload/verification.
--live: real X page in a separate persistent profile; sign in in that browser.
Snapshots, screenshots, build failures, and verification results: .wxt/extension-agent/
`);
    return;
  }
  if (command === 'start') {
    try {
      console.log(JSON.stringify(await request('status'), null, 2));
      return;
    } catch {
      /* A session has not started, or its socket is stale. */
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const previous = JSON.parse(await readFile(stateFile, 'utf8'));
      process.kill(previous.pid, 0);
      throw new Error(
        `Session process ${previous.pid} is still running but is not responding. Check ${directory}/server.log.`,
      );
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
    const log = openSync(path.join(directory, 'server.log'), 'w', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', ...args], {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    child.unref();
    await writeFile(stateFile, JSON.stringify({ pid: child.pid, socket }));
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        console.log(JSON.stringify(await request('status'), null, 2));
        return;
      } catch {
        await delay(500);
      }
      try {
        process.kill(child.pid, 0);
      } catch {
        throw new Error(`Browser startup failed. See ${directory}/server.log.`);
      }
    }
    throw new Error(`Startup timed out. See ${directory}/server.log.`);
  }
  const params = {};
  if (['inspect', 'eval', 'click', 'fill'].includes(command)) params.surface = args[0] ?? 'popup';
  if (['click', 'fill'].includes(command)) params.selector = args[1];
  if (command === 'fill') params.value = args[2];
  if (command === 'eval') params.expression = args.slice(1).join(' ');
  if (command === 'reload') params.build = !args.includes('--no-build');
  if (command === 'logs') {
    params.context = args.find((arg) => !arg.startsWith('--'));
    params.since = Number(args.find((arg) => arg.startsWith('--since='))?.split('=')[1] ?? 0);
  }
  const result = await request(command, params);
  console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false) process.exitCode = 1;
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
