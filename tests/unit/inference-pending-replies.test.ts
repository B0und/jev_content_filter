import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { encodeOcrReply, OcrError } from '../../src/inference/contracts';
import { createPendingReplies } from '../../src/entrypoints/inference/pending-replies';

function register(expected: 'result' | 'ocr-result' = 'result') {
  const requests = createPendingReplies();
  const resolve = vi.fn();
  const reject = vi.fn();
  requests.add(7, { expected, resolve, reject });

  return { requests, resolve, reject };
}

describe('inference reply correlation', () => {
  it('delivers a validated result once and releases only its matching slot', () => {
    const { requests, resolve, reject } = register();

    const event = new MessageEvent('message', {
      data: { type: 'result', id: 7, reply: { ok: true, scores: { porn: 0.8 } } },
    });

    expect(requests.settle(event)).toBe(7);
    expect(resolve).toHaveBeenCalledWith(event.data);
    expect(reject).not.toHaveBeenCalled();
    expect(requests.settle(event)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('removes undeclared payload fields before exposing the result', () => {
    const { requests, resolve } = register();

    const data = {
      type: 'result',
      id: 7,
      reply: { ok: true, scores: { porn: 0.8 }, untrusted: 'extra' },
    };

    requests.settle(new MessageEvent('message', { data }));
    expect(resolve).toHaveBeenCalledWith({
      type: 'result',
      id: 7,
      reply: { ok: true, scores: { porn: 0.8 } },
    });
  });

  it('fails malformed payloads rather than leaving the request waiting', () => {
    const { requests, resolve, reject } = register();
    expect(
      requests.settle(
        new MessageEvent('message', {
          data: { type: 'result', id: 7, reply: { ok: true, scores: { porn: 4 } } },
        }),
      ),
    ).toBe(7);
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      new Error('Local inference worker returned an invalid result.'),
    );
  });

  it('rejects a result from the wrong operation even if its payload is valid', () => {
    const { requests, resolve, reject } = register('ocr-result');
    expect(
      requests.settle(
        new MessageEvent('message', {
          data: { type: 'result', id: 7, reply: { ok: true, scores: {} } },
        }),
      ),
    ).toBe(7);
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      new Error('Local inference worker returned the wrong result kind.'),
    );
  });

  it.each(['success', 'failure'])('validates encoded OCR %s results', async (outcome) => {
    const { requests, resolve, reject } = register('ocr-result');

    const work =
      outcome === 'success'
        ? Effect.succeed('image words')
        : Effect.fail(new OcrError({ message: 'OCR failed' }));

    const reply = await Effect.runPromise(encodeOcrReply(work));
    const data = { type: 'ocr-result', id: 7, reply };
    expect(requests.settle(new MessageEvent('message', { data }))).toBe(7);
    expect(resolve).toHaveBeenCalledWith(data);
    expect(reject).not.toHaveBeenCalled();
  });

  it('ignores unrelated or cancelled replies and rejects pending work on failure', () => {
    const { requests, resolve, reject } = register();
    expect(
      requests.settle(new MessageEvent('message', { data: { type: 'status', id: 7 } })),
    ).toBeNull();
    expect(
      requests.settle(new MessageEvent('message', { data: { type: 'result', id: 8 } })),
    ).toBeNull();
    requests.cancel(7);
    expect(
      requests.settle(new MessageEvent('message', { data: { type: 'result', id: 7 } })),
    ).toBeNull();
    requests.add(9, { expected: 'result', resolve, reject });
    const error = new Error('worker crashed');
    requests.failAll(error);
    requests.failAll(error);
    expect(reject).toHaveBeenCalledExactlyOnceWith(error);
    expect(resolve).not.toHaveBeenCalled();
  });
});
