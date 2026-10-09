import * as Schema from 'effect/Schema';

export const FollowStateSchema = Schema.Struct({
  handle: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,15}$/)),
  following: Schema.Boolean,
});

const followers = new Map<string, boolean>();

let currentEpoch = -1;

let acceptedSequence = -1;

let channelKey: CryptoKey | null = null;

let channelGeneration = 0;

let observedViewer: string | null = null;

let viewerGeneration = 0;

/** Deny old-viewer exemptions synchronously, before any signed reset finishes. */
function refreshObservedViewer(): string | null {
  const href = document.querySelector('[data-testid=AppTabBar_Profile_Link]')?.getAttribute('href');
  const viewer = href?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase() ?? null;

  if (viewer !== observedViewer) {
    observedViewer = viewer;
    viewerGeneration++;
    followers.clear();
  }

  return viewer;
}

export const FollowBootstrapReplySchema = Schema.Struct({
  ok: Schema.Literal(true),
  secret: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
    Schema.isBetweenLength(32, 32),
  ),
});

const SignedFollowSchema = Schema.Struct({
  type: Schema.Literal('jev-follow-state'),
  payload: Schema.String.check(Schema.isMaxLength(500000)),
  signature: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
    Schema.isBetweenLength(32, 32),
  ),
});

const VerifiedFollowSchema = Schema.Struct({
  epoch: Schema.Int,
  viewer: Schema.NullOr(Schema.String),
  sequence: Schema.Int,
  users: Schema.Array(FollowStateSchema),
});

/** Install a per-document key delivered only through extension messaging. */
export async function configureFollowChannel(secret: ReadonlyArray<number>): Promise<void> {
  const generation = ++channelGeneration;

  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  if (generation === channelGeneration) channelKey = key;
}

/** Verify observer signatures and replay order before accepting any follow or epoch state. */
export async function receiveFollowState(event: MessageEvent): Promise<boolean> {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    !channelKey ||
    !Schema.is(SignedFollowSchema)(event.data)
  )
    return false;
  refreshObservedViewer();
  const generation = viewerGeneration;
  const key = channelKey;

  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    new Uint8Array(event.data.signature),
    new TextEncoder().encode(event.data.payload),
  );

  const viewer = refreshObservedViewer();

  if (!verified || key !== channelKey || generation !== viewerGeneration) return false;
  let data: unknown;

  try {
    data = JSON.parse(event.data.payload);
  } catch {
    return false;
  }

  if (
    !Schema.is(VerifiedFollowSchema)(data) ||
    data.viewer !== viewer ||
    (!viewer && data.users.length > 0) ||
    data.epoch < 0 ||
    data.epoch < currentEpoch ||
    data.sequence <= acceptedSequence
  )
    return false;
  acceptedSequence = data.sequence;
  const next = new Map(data.users.map((user) => [user.handle.toLowerCase(), user.following]));

  const changed =
    next.size !== followers.size ||
    [...next].some(([handle, following]) => followers.get(handle) !== following);

  currentEpoch = data.epoch;
  followers.clear();

  for (const [handle, following] of next) followers.set(handle, following);

  return changed;
}

/** Unknown authors and previous-viewer relationships never grant exemptions. */
export function isFollowed(handle: string): boolean {
  if (!refreshObservedViewer()) return false;

  return followers.get(handle.toLowerCase()) === true;
}

/** Page relationships are never persisted across accounts or browsing sessions. */
export function clearFollowStates(): void {
  channelGeneration++;
  viewerGeneration++;
  observedViewer = null;
  followers.clear();
  currentEpoch = -1;
  acceptedSequence = -1;
  channelKey = null;
}
