import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recognizeOcrImage } from '../../src/inference/ocr-image';

const close = vi.fn();
const image = new Blob(['test image']);
const reading = (text: string, confidence: number) => ({ data: { text, confidence } });

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1, height: 1, close }));
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      width = 1;
      height = 1;
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          putImageData: vi.fn(),
        };
      }
      async convertToBlob() {
        return new Blob(['contrast image']);
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it('retains dim first-pass wording when the clearer reading omits it', async () => {
  const recognize = vi
    .fn()
    .mockResolvedValueOnce(reading('nude photos\nWelcome home', 60))
    .mockResolvedValueOnce(reading('Welcome home', 95));
  const text = await recognizeOcrImage({ recognize }, image);
  expect(text).toContain('nude photos\nWelcome home');
  expect(text).toContain('Welcome home');
  expect(close).toHaveBeenCalledOnce();
});

it('keeps successful text and releases the worker if the retry rejects', async () => {
  const recognize = vi
    .fn()
    .mockResolvedValueOnce(reading('nude photos', 60))
    .mockRejectedValueOnce(new Error('OCR child worker crashed'));
  const release = vi.fn().mockResolvedValue(undefined);
  await expect(recognizeOcrImage({ recognize }, image, release)).resolves.toBe('nude photos');
  expect(release).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('keeps successful text if preparing the retry or releasing its worker fails', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Decode failed')));
  const recognize = vi.fn().mockResolvedValue(reading('nude photos', 60));
  const release = vi.fn().mockRejectedValue(new Error('Already terminated'));
  await expect(recognizeOcrImage({ recognize }, image, release)).resolves.toBe('nude photos');
  expect(recognize).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it('propagates a primary recognition failure', async () => {
  const recognize = vi.fn().mockRejectedValue(new Error('Primary OCR failed'));
  await expect(recognizeOcrImage({ recognize }, image)).rejects.toThrow('Primary OCR failed');
});

it('does not duplicate an unchanged reading', async () => {
  const recognize = vi
    .fn()
    .mockResolvedValueOnce(reading('nude photos', 60))
    .mockResolvedValueOnce(reading('nude photos', 95));
  await expect(recognizeOcrImage({ recognize }, image)).resolves.toBe('nude photos');
});

it('does not add a less confident alternate reading', async () => {
  const recognize = vi
    .fn()
    .mockResolvedValueOnce(reading('nude photos', 60))
    .mockResolvedValueOnce(reading('Welcome home', 30));
  await expect(recognizeOcrImage({ recognize }, image)).resolves.toBe('nude photos');
});
