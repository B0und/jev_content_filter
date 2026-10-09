import { expect, it, afterEach } from 'vitest';
import {
  collectFollowStates,
  receiveFollowState,
  isFollowed,
  clearFollowStates,
} from '../../src/content/relationships';
import { settings, newPost, hits, previewHits } from '../../src/content/state';
import { defaultSettings } from '../../src/filtering/types';

afterEach(() => {
  clearFollowStates();
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

it('unknown accounts stay filtered, then follow/unfollow updates both body and preview policy', () => {
  settings.current = defaultSettings();
  settings.current.followedExemptions = ['hentai'];
  const post = newPost('123', 'Reader', 'body', [], '', '');
  post.scores = { hentai: 0.97, porn: 0.9 };
  post.previewScores = { hentai: 0.98 };
  expect(hits(post).map((hit) => hit.key)).toEqual(['porn', 'hentai']);
  const message = (following: boolean) =>
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { type: 'jev-follow-state', epoch: 1, users: [{ handle: 'reader', following }] },
    });
  expect(receiveFollowState(message(true))).toBe(true);
  expect(isFollowed('READER')).toBe(true);
  expect(hits(post).map((hit) => hit.key)).toEqual(['porn']);
  expect(previewHits(post)).toEqual([]);
  receiveFollowState(message(false));
  expect(previewHits(post).map((hit) => hit.key)).toEqual(['hentai']);
});

it('rejects invalid or foreign-window messages and never grants an exception to another author', () => {
  expect(
    receiveFollowState(
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

it('clears previous-viewer follows and rejects obsolete epochs', () => {
  const send = (epoch: number, users: Array<{ handle: string; following: boolean }>) =>
    receiveFollowState(
      new MessageEvent('message', {
        source: window,
        origin: location.origin,
        data: { type: 'jev-follow-state', epoch, users },
      }),
    );
  send(1, [{ handle: 'reader', following: true }]);
  expect(isFollowed('reader')).toBe(true);
  expect(send(2, [])).toBe(true);
  expect(isFollowed('reader')).toBe(false);
  expect(send(1, [{ handle: 'reader', following: true }])).toBe(false);
  expect(isFollowed('reader')).toBe(false);
  send(2, [{ handle: 'reader', following: true }]);
  expect(isFollowed('reader')).toBe(true);
});
