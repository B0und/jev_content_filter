import * as Schema from 'effect/Schema';

export const FollowStateSchema = Schema.Struct({
  handle: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,15}$/)),
  following: Schema.Boolean,
});
// MAIN uses these references captured at document_start, before page scripts.
const own = Object.getOwnPropertyDescriptor;
const keys = Object.keys;
const isArray = Array.isArray;
const apply = Reflect.apply;
// oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with the original string.
const lower = String.prototype.toLowerCase;
const validHandle = /^[a-zA-Z0-9_]{1,15}$/;
// oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with the original RegExp.
const handleExec = RegExp.prototype.exec;
const define = Object.defineProperty;
const create = Object.create;
const followers = new Map<string, boolean>();
let currentEpoch = -1;
let acceptedSequence = -1;
let channelKey: CryptoKey | null = null;
let channelGeneration = 0;

/** Extract JSON-only native relationship values without mutable page-side helpers. */
export function collectFollowStates(data: unknown): Array<typeof FollowStateSchema.Type> {
  const users: Record<string, boolean> = create(null);
  const queue: unknown[] = [data];
  let size = 1,
    visited = 0;
  const field = (value: unknown, name: string): unknown =>
    value !== null && typeof value === 'object' ? own(value, name)?.value : undefined;
  while (size && visited++ < 50000) {
    const item = queue[--size];
    if (item === null || typeof item !== 'object') continue;
    if (isArray(item)) {
      for (let i = 0; i < item.length && size < 50000; i++)
        define(queue, size++, {
          value: item[i],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      continue;
    }
    const legacy = field(item, 'legacy') ?? item;
    const core = field(item, 'core') ?? legacy;
    const perspective = field(item, 'relationship_perspectives') ?? legacy;
    const handle = field(core, 'screen_name') ?? field(legacy, 'screen_name');
    const following = field(perspective, 'following') ?? field(legacy, 'following');
    const recognized =
      typeof handle === 'string' &&
      apply(handleExec, validHandle, [handle]) &&
      typeof following === 'boolean';
    if (recognized) users[apply(lower, handle, [])] = following;
    const names = keys(item);
    for (let i = 0; i < names.length && size < 50000; i++) {
      const name = names[i]!;
      if (
        recognized &&
        (name === 'legacy' || name === 'core' || name === 'relationship_perspectives')
      )
        continue;
      define(queue, size++, {
        value: field(item, name),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  const result: Array<typeof FollowStateSchema.Type> = [],
    names = keys(users);
  for (let i = 0; i < names.length; i++) {
    const handle = names[i]!;
    define(result, i, {
      value: { handle, following: users[handle]! },
      enumerable: true,
      configurable: true,
    });
  }
  return result;
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
  const key = channelKey;
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    new Uint8Array(event.data.signature),
    new TextEncoder().encode(event.data.payload),
  );
  if (!verified || key !== channelKey) return false;
  let data: unknown;
  try {
    data = JSON.parse(event.data.payload);
  } catch {
    return false;
  }
  if (
    !Schema.is(VerifiedFollowSchema)(data) ||
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
  return followers.get(handle.toLowerCase()) === true;
}

/** Page relationships are never persisted across accounts or browsing sessions. */
export function clearFollowStates(): void {
  channelGeneration++;
  followers.clear();
  currentEpoch = -1;
  acceptedSequence = -1;
  channelKey = null;
}
