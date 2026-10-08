import * as Schema from 'effect/Schema';

export const FollowStateSchema = Schema.Struct({
  handle: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,15}$/)),
  following: Schema.Boolean,
});
export const FollowMessageSchema = Schema.Struct({
  type: Schema.Literal('jev-follow-state'),
  users: Schema.Array(FollowStateSchema),
});
const record = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const followers = new Map<string, boolean>();

/** Extract explicit viewer-to-author relationships from native X user objects only. */
export function collectFollowStates(data: unknown): Array<typeof FollowStateSchema.Type> {
  const users = new Map<string, boolean>();
  const queue: unknown[] = [data];
  let visited = 0;
  while (queue.length && visited++ < 50000) {
    const item = queue.pop();
    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }
    if (!record(item)) continue;
    const legacy = record(item.legacy) ? item.legacy : item;
    const core = record(item.core) ? item.core : legacy;
    const perspective = record(item.relationship_perspectives)
      ? item.relationship_perspectives
      : legacy;
    const candidate = {
      handle: core.screen_name ?? legacy.screen_name,
      following: perspective.following ?? legacy.following,
    };
    const recognized = Schema.is(FollowStateSchema)(candidate);
    if (recognized) users.set(candidate.handle.toLowerCase(), candidate.following);
    // These are metadata for the enclosing user, not independent legacy users.
    queue.push(
      ...Object.entries(item)
        .filter(
          ([key]) => !recognized || !['legacy', 'core', 'relationship_perspectives'].includes(key),
        )
        .map(([, value]) => value),
    );
  }
  return [...users].map(([handle, following]) => ({ handle, following }));
}

/** Accept only validated same-window messages; unknown authors remain filtered. */
export function receiveFollowState(event: MessageEvent): boolean {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    !Schema.is(FollowMessageSchema)(event.data)
  )
    return false;
  let changed = false;
  for (const user of event.data.users) {
    const handle = user.handle.toLowerCase();
    if (followers.get(handle) !== user.following) changed = true;
    followers.set(handle, user.following);
  }
  while (followers.size > 5000) followers.delete(followers.keys().next().value!);
  return changed;
}

export function isFollowed(handle: string): boolean {
  return followers.get(handle.toLowerCase()) === true;
}

/** Page relationships are never persisted across accounts or browsing sessions. */
export function clearFollowStates(): void {
  followers.clear();
}
