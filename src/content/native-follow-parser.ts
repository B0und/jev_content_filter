export interface FollowState {
  handle: string;
  following: boolean;
}

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

/** Extract JSON-only native relationship values without mutable page-side helpers. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native response parsing uses captured intrinsics to resist page-side tampering.
export function collectFollowStates(data: unknown): FollowState[] {
  const users: Record<string, boolean> = create(null);
  const queue: unknown[] = [data];

  let size = 1,
    visited = 0;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Native response parsing uses captured intrinsics to resist page-side tampering.
  const field = (value: unknown, name: string): unknown =>
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native response parsing uses captured intrinsics to resist page-side tampering.
    value !== null && typeof value === 'object' ? own(value, name)?.value : undefined;

  while (size && visited++ < 50000) {
    const item = queue[--size];

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native response parsing uses captured intrinsics to resist page-side tampering.
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
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native response parsing uses captured intrinsics to resist page-side tampering.
      typeof handle === 'string' &&
      apply(handleExec, validHandle, [handle]) &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native response parsing uses captured intrinsics to resist page-side tampering.
      typeof following === 'boolean';

    if (recognized) users[apply(lower, handle, [])] = following;
    const names = keys(item);

    for (let i = 0; i < names.length && size < 50000; i++) {
      const name = names[i]!;

      // Directional source/target records are not viewer-to-author observations.
      if (name === 'relationship') continue;

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

  const result: FollowState[] = [],
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
