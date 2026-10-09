import { expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  collectFollowStates,
  receiveFollowState,
  isFollowed,
  clearFollowStates,
  configureFollowChannel,
} from '../../src/content/relationships';
import { settings, newPost, hits, previewHits } from '../../src/content/state';
import { defaultSettings } from '../../src/filtering/types';

const secret = Array.from({ length: 32 }, (_, i) => i);
let sequence = 0;
beforeEach(async () => {
  sequence = 0;
  const profile = document.createElement('a');
  profile.dataset.testid = 'AppTabBar_Profile_Link';
  profile.setAttribute('href', '/viewer');
  document.body.append(profile);
  await configureFollowChannel(secret);
});
/** Sign synthetic observer packets with the fixture-only key. */
async function packet(
  epoch: number,
  users: Array<{ handle: string; following: boolean }>,
  seq = ++sequence,
  viewer: string | null = 'viewer',
) {
  const payload = JSON.stringify({ epoch, sequence: seq, viewer, users });
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = [
    ...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))),
  ];
  return new MessageEvent('message', {
    source: window,
    origin: location.origin,
    data: { type: 'jev-follow-state', payload, signature },
  });
}

afterEach(() => {
  clearFollowStates();
  document.querySelector('[data-testid=AppTabBar_Profile_Link]')?.remove();
  settings.current = defaultSettings();
});

it('uses explicit following, never followed_by, and accepts both native user formats', () => {
  expect(
    collectFollowStates({
      users: [
        { legacy: { screen_name: 'Reader', following: true, followed_by: false } },
        { core: { screen_name: 'Other' }, relationship_perspectives: { following: false } },
        { legacy: { screen_name: 'Follower', followed_by: true } },
      ],
    }),
  ).toEqual(
    expect.arrayContaining([
      { handle: 'reader', following: true },
      { handle: 'other', following: false },
    ]),
  );
  expect(collectFollowStates({ legacy: { screen_name: 'Follower', followed_by: true } })).toEqual(
    [],
  );
});

it('unknown accounts stay filtered, then follow/unfollow updates both body and preview policy', async () => {
  settings.current = defaultSettings();
  settings.current.skipFollowed = true;
  const post = newPost('123', 'Reader', 'body', [], '', '');
  post.scores = { hentai: 0.97, porn: 0.9 };
  post.previewScores = { hentai: 0.98 };
  expect(hits(post).map((hit) => hit.key)).toEqual(['porn', 'hentai']);
  expect(await receiveFollowState(await packet(1, [{ handle: 'reader', following: true }]))).toBe(
    true,
  );
  expect(isFollowed('READER')).toBe(true);
  expect(hits(post)).toEqual([]);
  settings.current.textFilters.push({
    id: 'later',
    name: 'Later',
    instructions: 'test',
    threshold: 0.5,
    enabled: true,
  });
  post.scores['custom:later'] = 0.99;
  post.previewScores['custom:later'] = 0.99;
  expect(hits(post)).toEqual([]);
  expect(previewHits(post)).toEqual([]);
  await receiveFollowState(await packet(1, [{ handle: 'reader', following: false }]));
  expect(previewHits(post).map((hit) => hit.key)).toEqual(
    expect.arrayContaining(['hentai', 'custom:later']),
  );
});

it('rejects invalid or foreign-window messages and never grants an exception to another author', async () => {
  expect(
    await receiveFollowState(
      new MessageEvent('message', {
        data: {
          type: 'jev-follow-state',
          epoch: 1,
          users: [{ handle: 'reader', following: true }],
        },
      }),
    ),
  ).toBe(false);
  expect(isFollowed('reader')).toBe(false);
  settings.current.authorExceptions = [{ handle: 'reader', categories: ['hentai'] }];
  const post = newPost('123', 'other', 'body', [], '', '');
  post.scores.hentai = 0.97;
  expect(hits(post).map((hit) => hit.key)).toEqual(['hentai']);
});

it('modern relationship perspective owns state over conflicting nested legacy fields', () => {
  expect(
    collectFollowStates({
      core: { screen_name: 'Reader' },
      legacy: { screen_name: 'Reader', following: true },
      relationship_perspectives: { following: false },
    }),
  ).toEqual([{ handle: 'reader', following: false }]);
});

it('clears previous-viewer follows and rejects obsolete epochs', async () => {
  await receiveFollowState(await packet(1, [{ handle: 'reader', following: true }]));
  expect(isFollowed('reader')).toBe(true);
  expect(await receiveFollowState(await packet(2, []))).toBe(true);
  expect(isFollowed('reader')).toBe(false);
  expect(await receiveFollowState(await packet(1, [{ handle: 'reader', following: true }]))).toBe(
    false,
  );
  expect(isFollowed('reader')).toBe(false);
  await receiveFollowState(await packet(2, [{ handle: 'reader', following: true }]));
  expect(isFollowed('reader')).toBe(true);
});

it('forged epochs, payloads and replayed signatures cannot grant exemptions or poison genuine updates', async () => {
  const good = await packet(1, [{ handle: 'reader', following: false }]);
  const forged = new MessageEvent('message', {
    source: window,
    origin: location.origin,
    data: {
      ...good.data,
      payload: JSON.stringify({
        epoch: 999999,
        sequence: 999999,
        users: [{ handle: 'reader', following: true }],
      }),
    },
  });
  expect(await receiveFollowState(forged)).toBe(false);
  expect(isFollowed('reader')).toBe(false);
  expect(await receiveFollowState(good)).toBe(true);
  expect(await receiveFollowState(good)).toBe(false);
  expect(await receiveFollowState(await packet(1, [{ handle: 'reader', following: true }]))).toBe(
    true,
  );
  expect(isFollowed('reader')).toBe(true);
});

it('a newer complete snapshot removes stale exemptions even when earlier packets arrive late', async () => {
  await receiveFollowState(await packet(1, [{ handle: 'reader', following: true }], 1));
  expect(isFollowed('reader')).toBe(true);
  const older = await packet(1, [{ handle: 'reader', following: false }], 2);
  const newest = await packet(1, [{ handle: 'other', following: true }], 3);
  await receiveFollowState(newest);
  expect(isFollowed('reader')).toBe(false);
  expect(isFollowed('other')).toBe(true);
  expect(await receiveFollowState(older)).toBe(false);
  expect(isFollowed('reader')).toBe(false);
  expect(isFollowed('other')).toBe(true);
});

it('teardown prevents a pending key import from reopening the old channel', async () => {
  const pending = configureFollowChannel(secret);
  clearFollowStates();
  await pending;
  expect(await receiveFollowState(await packet(1, [{ handle: 'reader', following: true }]))).toBe(
    false,
  );
});

it('page array setters and regexp patches cannot invent positive native relationships', () => {
  // oxlint-disable-next-line typescript/unbound-method -- saved only to restore the original RegExp prototype method.
  const originalExec = RegExp.prototype.exec;
  let result: ReturnType<typeof collectFollowStates>;
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set(value) {
        if (value && typeof value === 'object' && 'following' in value) value.following = true;
        Object.defineProperty(this, '0', {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      },
    });
    RegExp.prototype.exec = () => null;
    result = collectFollowStates({ legacy: { screen_name: 'Reader', following: false } });
  } finally {
    Reflect.deleteProperty(Array.prototype, '0');
    RegExp.prototype.exec = originalExec;
  }
  expect(result!).toEqual([{ handle: 'reader', following: false }]);
});

it('directional source/target relationships never grant viewer-relative exemptions', () => {
  expect(
    collectFollowStates({
      relationship: {
        source: { screen_name: 'Viewer', following: false },
        target: { screen_name: 'Follower', following: true },
      },
    }),
  ).toEqual([]);
  expect(
    collectFollowStates({ user: { legacy: { screen_name: 'Reader', following: true } } }),
  ).toEqual([{ handle: 'reader', following: true }]);
});

it('a viewer transition immediately denies exemptions and rejects in-flight old-viewer verification', async () => {
  await receiveFollowState(await packet(1, [{ handle: 'reader', following: true }]));
  expect(isFollowed('reader')).toBe(true);
  const event = await packet(1, [
    { handle: 'reader', following: true },
    { handle: 'other', following: true },
  ]);
  const nativeVerify = crypto.subtle.verify.bind(crypto.subtle);
  const completion = Promise.withResolvers<void>();
  const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const verified = await nativeVerify(...args);
    await completion.promise;
    return verified;
  });
  const pending = receiveFollowState(event);
  try {
    document
      .querySelector('[data-testid=AppTabBar_Profile_Link]')!
      .setAttribute('href', '/otherViewer');
    expect.soft(isFollowed('reader')).toBe(false);
    completion.resolve();
    expect(await pending).toBe(false);
    expect(isFollowed('other')).toBe(false);
  } finally {
    completion.resolve();
    spy.mockRestore();
  }
  await receiveFollowState(
    await packet(2, [{ handle: 'reader', following: true }], ++sequence, 'otherviewer'),
  );
  expect(isFollowed('reader')).toBe(true);
  document.querySelector('[data-testid=AppTabBar_Profile_Link]')!.remove();
  expect(isFollowed('reader')).toBe(false);
});
