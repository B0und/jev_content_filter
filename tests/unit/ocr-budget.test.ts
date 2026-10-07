import { Effect } from 'effect';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { extractImageText } from '../../src/inference/ocr';

afterEach(() => vi.unstubAllGlobals());

it('rejects oversized encoded images before allocating a decoded bitmap', async () => {
  const image = await readFile('mock/pbs.twimg.com/media/landscape.png');
  // PNG dimensions live in IHDR. No bitmap decode is needed to read them.
  image.writeUInt32BE(5000, 16);
  image.writeUInt32BE(4000, 20);
  const decode = vi.fn();
  vi.stubGlobal('createImageBitmap', decode);
  await expect(
    Effect.runPromise(extractImageText(`data:image/png;base64,${image.toString('base64')}`)),
  ).rejects.toThrow('Image exceeds the local OCR pixel budget.');
  expect(decode).not.toHaveBeenCalled();
});

it('rejects unknown dimensions without asking the image decoder to guess', async () => {
  const decode = vi.fn();
  vi.stubGlobal('createImageBitmap', decode);
  await expect(Effect.runPromise(extractImageText('data:image/png;base64,AA=='))).rejects.toThrow(
    'Image dimensions could not be read',
  );
  expect(decode).not.toHaveBeenCalled();
});
