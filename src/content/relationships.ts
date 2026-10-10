import * as Schema from 'effect/Schema';
import { FollowSnapshotSchema, readFollowViewer } from './follow-observation';

const followers = new Map<string, boolean>();

let currentEpoch = -1;

let acceptedSequence = -1;

let observedViewer: string | null = null;

/** Clear previous-account observations as soon as X's profile link changes. */
function refreshObservedViewer(): string | null {
  const viewer = readFollowViewer();

  if (viewer !== observedViewer) {
    observedViewer = viewer;
    followers.clear();
  }

  return viewer;
}

/** Accept validated page observations in publication order for the current viewer. */
export function receiveFollowState(event: MessageEvent<unknown>): boolean {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    !Schema.is(FollowSnapshotSchema)(event.data)
  )
    return false;
  const data = event.data;
  const viewer = refreshObservedViewer();

  if (
    data.viewer !== viewer ||
    (!viewer && data.users.length > 0) ||
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

/** Unknown authors and previous-account observations never grant exemptions. */
export function isFollowed(handle: string): boolean {
  if (!refreshObservedViewer()) return false;

  return followers.get(handle.toLowerCase()) === true;
}

export function clearFollowStates(): void {
  observedViewer = null;
  followers.clear();
  currentEpoch = -1;
  acceptedSequence = -1;
}
