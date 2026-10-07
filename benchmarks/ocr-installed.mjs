import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
/** Evaluate in the installed extension popup through the persistent browser session. */
async function evaluate(expression) {
  const { stdout } = await run(
    'node',
    ['scripts/extension-agent.mjs', 'eval', 'popup', expression],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
const corpus = JSON.parse(await readFile('benchmarks/ocr-results.json', 'utf8')).cases;
await evaluate(
  'chrome.runtime.sendMessage({type:"extract-image-text",url:"https://pbs.twimg.com/media/landscape.png"})',
);
const samples = [];
for (const item of corpus.filter((item) => !item.singleLine && item.expected)) {
  const bytes = await readFile(item.imageFile);
  const dataUrl = `data:image/${item.jpeg ? 'jpeg' : 'png'};base64,${bytes.toString('base64')}`;
  const expression = `(async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const reply = await chrome.runtime.sendMessage({target:"local-inference",operation:"ocr",dataUrl:${JSON.stringify(dataUrl)}});
      if (reply._tag !== "Success") throw new Error(JSON.stringify(reply));
      runs.push({text:reply.success,ms:performance.now()-start});
    }
    return runs;
  })()`;
  samples.push({ id: item.id, runs: await evaluate(expression) });
}
const status = JSON.parse((await run('node', ['scripts/extension-agent.mjs', 'status'])).stdout);
const result = {
  executedAt: new Date().toISOString(),
  generation: status.generation,
  lastCheck: {
    ok: status.lastCheck.ok,
    generation: status.lastCheck.generation,
    errors: status.lastCheck.errors,
  },
  samples,
};
await writeFile('benchmarks/ocr-installed-results.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
