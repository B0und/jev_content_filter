import { flow, Option, Predicate } from 'effect';
import * as Schema from 'effect/Schema';

const HandleSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,15}$/));

export const FollowStateSchema = Schema.Struct({
  handle: HandleSchema,
  following: Schema.Boolean,
});

export type FollowState = typeof FollowStateSchema.Type;

export const FollowSnapshotSchema = Schema.Struct({
  type: Schema.Literal('jev-follow-state'),
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  viewer: Schema.NullOr(HandleSchema),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  users: Schema.Array(FollowStateSchema).check(Schema.isMaxLength(5000)),
});

/** Both observer and receiver use X's current profile link to identify account changes. */
export function readFollowViewer(): string | null {
  return (
    document
      .querySelector('[data-testid=AppTabBar_Profile_Link]')
      ?.getAttribute('href')
      ?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]
      ?.toLowerCase() ?? null
  );
}

const UserFieldsSchema = Schema.Struct({ screen_name: HandleSchema, following: Schema.Boolean });

const UserSchema = Schema.Union([
  Schema.Struct({
    core: Schema.Struct({ screen_name: HandleSchema }),
    relationship_perspectives: Schema.Struct({ following: Schema.Boolean }),
  }),
  Schema.Struct({ legacy: UserFieldsSchema }),
  UserFieldsSchema,
]);

/** Normalize supported wire formats once; callers only see handle and following. */
function normalizeUser(user: typeof UserSchema.Type): FollowState {
  if ('core' in user)
    return {
      handle: user.core.screen_name.toLowerCase(),
      following: user.relationship_perspectives.following,
    };
  const fields = 'legacy' in user ? user.legacy : user;

  return { handle: fields.screen_name.toLowerCase(), following: fields.following };
}

const readUser = flow(
  Schema.decodeUnknownOption(UserSchema),
  Option.map(normalizeUser),
  Option.getOrUndefined,
);

/** Extract explicit viewer-relative relationships from supported X response formats. */
function relationships(data: Schema.MutableJson): FollowState[] {
  const users = new Map<string, boolean>();
  const queue: Schema.MutableJson[] = [data];
  let visited = 0;

  while (queue.length && visited++ < 50000) {
    const item = queue.pop();

    if (Array.isArray(item)) {
      for (const value of item) {
        if (queue.length >= 50000) break;
        queue.push(value);
      }

      continue;
    }

    if (
      item == null ||
      Predicate.isString(item) ||
      Predicate.isNumber(item) ||
      Predicate.isBoolean(item)
    )
      continue;
    const user = readUser(item);

    if (user) users.set(user.handle, user.following);

    for (const [name, value] of Object.entries(item)) {
      // Source/target flags need not describe the active viewer's relationship to an author.
      if (name === 'relationship') continue;

      if (user && ['legacy', 'core', 'relationship_perspectives'].includes(name)) continue;

      if (queue.length >= 50000) break;
      queue.push(value);
    }
  }

  return Array.from(users, ([handle, following]) => ({ handle, following }));
}

export const collectFollowStates = flow(
  Schema.decodeUnknownOption(Schema.MutableJson),
  Option.match({ onNone: (): FollowState[] => [], onSome: relationships }),
);
