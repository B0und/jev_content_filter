import { collectFollowStates } from '../../src/content/follow-observation';
import { expect, it, afterEach, beforeEach } from 'vitest';
import { receiveFollowState, isFollowed, clearFollowStates } from '../../src/content/relationships';
import { settings, newPost, hits, previewHits } from '../../src/content/state';
import { defaultSettings } from '../../src/filtering/types';

let sequence = 0;

beforeEach(() => {
  sequence = 0;
  const profile = document.createElement('a');
  profile.dataset.testid = 'AppTabBar_Profile_Link';
  profile.setAttribute('href', '/viewer');
  document.body.append(profile);
});

function packet(
  epoch: number,
  users: Array<{ handle: string; following: boolean }>,
  seq = ++sequence,
  viewer: string | null = 'viewer',
) {
  return new MessageEvent('message', {
    source: window,
    origin: location.origin,
    data: { type: 'jev-follow-state', epoch, sequence: seq, viewer, users },
  });
}

afterEach(() => {
  clearFollowStates();
  document.querySelector('[data-testid=AppTabBar_Profile_Link]')?.remove();
  settings.current = defaultSettings();
});

it('uses explicit following, never followed_by, and accepts supported user formats', () => {
  expect(
    collectFollowStates({
      users: [
        { legacy: { screen_name: 'Reader', following: true, followed_by: false } },
        { core: { screen_name: 'Other' }, relationship_perspectives: { following: false } },
        { screen_name: 'Direct', following: true },
        { legacy: { screen_name: 'Follower', followed_by: true } },
      ],
    }),
  ).toEqual(
    expect.arrayContaining([
      { handle: 'reader', following: true },
      { handle: 'other', following: false },
      { handle: 'direct', following: true },
    ]),
  );
  expect(collectFollowStates({ legacy: { screen_name: 'Follower', followed_by: true } })).toEqual(
    [],
  );
});

it('ignores malformed relationships and unrelated new fields', () => {
  expect(
    collectFollowStates({
      users: [
        { legacy: { screen_name: 'Wrong', following: 'true' } },
        { legacy: { screen_name: '../invalid', following: true } },
        {
          core: { screen_name: 'Reader', newly_added: 17 },
          relationship_perspectives: { following: false, other_flag: true },
        },
      ],
    }),
  ).toEqual([{ handle: 'reader', following: false }]);
  expect(collectFollowStates(null)).toEqual([]);
  expect(collectFollowStates('not an object')).toEqual([]);
});

it('unknown accounts stay filtered, then follow/unfollow updates both body and preview policy', () => {
  settings.current.skipFollowed = true;
  const post = newPost('123', 'Reader', 'body', [], '', '');
  post.scores = { hentai: 0.97, porn: 0.9 };
  post.previewScores = { hentai: 0.98 };
  expect(hits(post).map((hit) => hit.key)).toEqual(['porn', 'hentai']);
  expect(receiveFollowState(packet(1, [{ handle: 'reader', following: true }]))).toBe(true);
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
  receiveFollowState(packet(1, [{ handle: 'reader', following: false }]));
  expect(previewHits(post).map((hit) => hit.key)).toEqual(
    expect.arrayContaining(['hentai', 'custom:later']),
  );
});

it('rejects malformed snapshots, wrong origins and foreign windows', () => {
  const data = {
    type: 'jev-follow-state',
    epoch: 1,
    sequence: 1,
    viewer: 'viewer',
    users: [{ handle: 'reader', following: true }],
  };

  expect(receiveFollowState(new MessageEvent('message', { origin: location.origin, data }))).toBe(
    false,
  );
  expect(
    receiveFollowState(
      new MessageEvent('message', { source: window, origin: 'https://other.example', data }),
    ),
  ).toBe(false);
  expect(
    receiveFollowState(
      new MessageEvent('message', {
        source: window,
        origin: location.origin,
        data: { ...data, users: [{ handle: 'reader', following: 'yes' }] },
      }),
    ),
  ).toBe(false);
  expect(receiveFollowState(packet(-1, [{ handle: 'reader', following: true }]))).toBe(false);
  expect(receiveFollowState(packet(1, [{ handle: 'reader', following: true }], 1))).toBe(true);
  expect(isFollowed('other')).toBe(false);
});

it('modern relationship state takes precedence over conflicting legacy fields', () => {
  expect(
    collectFollowStates({
      core: { screen_name: 'Reader' },
      legacy: { screen_name: 'Reader', following: true },
      relationship_perspectives: { following: false },
    }),
  ).toEqual([{ handle: 'reader', following: false }]);
});

it('clears previous-viewer follows and rejects obsolete epochs', () => {
  receiveFollowState(packet(1, [{ handle: 'reader', following: true }]));
  expect(isFollowed('reader')).toBe(true);
  expect(receiveFollowState(packet(2, []))).toBe(true);
  expect(isFollowed('reader')).toBe(false);
  expect(receiveFollowState(packet(1, [{ handle: 'reader', following: true }]))).toBe(false);
  receiveFollowState(packet(2, [{ handle: 'reader', following: true }]));
  expect(isFollowed('reader')).toBe(true);
});

it('a newer snapshot replaces stale exemptions and ignores duplicate or late messages', () => {
  receiveFollowState(packet(1, [{ handle: 'reader', following: true }], 1));
  const older = packet(1, [{ handle: 'reader', following: false }], 2);
  const newest = packet(1, [{ handle: 'other', following: true }], 3);
  expect(receiveFollowState(newest)).toBe(true);
  expect(receiveFollowState(newest)).toBe(false);
  expect(receiveFollowState(older)).toBe(false);
  expect(isFollowed('reader')).toBe(false);
  expect(isFollowed('other')).toBe(true);
});

it('directional source/target relationships are not viewer-relative observations', () => {
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

it('account changes clear exemptions immediately and reject old-account observations', () => {
  receiveFollowState(packet(1, [{ handle: 'reader', following: true }]));
  const profile = document.querySelector('[data-testid=AppTabBar_Profile_Link]')!;
  profile.setAttribute('href', '/otherViewer');
  expect(isFollowed('reader')).toBe(false);
  expect(receiveFollowState(packet(1, [{ handle: 'reader', following: true }]))).toBe(false);
  receiveFollowState(packet(2, [{ handle: 'reader', following: true }], ++sequence, 'otherviewer'));
  expect(isFollowed('reader')).toBe(true);
  profile.remove();
  expect(isFollowed('reader')).toBe(false);
});

it('teardown clears page-local state for the next content session', () => {
  receiveFollowState(packet(1, [{ handle: 'reader', following: true }]));
  clearFollowStates();
  expect(isFollowed('reader')).toBe(false);
  expect(receiveFollowState(packet(0, [{ handle: 'reader', following: true }], 1))).toBe(true);
});
