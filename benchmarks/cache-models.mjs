import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SELECTED_MODELS } from '../src/shared/model-catalog.ts';

const root = resolve('.cache/models');
for (const model of Object.values(SELECTED_MODELS)) {
  for (const file of model.files) {
    const destination = resolve(root, model.id, model.revision, file);
    try {
      if ((await stat(destination)).size > 0) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const url = `${model.baseUrl}/${file}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body)
      throw new Error(`Model fixture download failed (${response.status}): ${model.id}/${file}`);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.download`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  console.log(`Cached pinned test assets: ${model.id}@${model.revision}`);
}
