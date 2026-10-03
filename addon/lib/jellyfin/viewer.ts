import { AsyncLocalStorage } from 'node:async_hooks';

interface ViewerScope {
  ownWatchlist: boolean;
  readsExtensions: boolean;
  accountOwner: string;
}

const scope = new AsyncLocalStorage<ViewerScope>();

export function runInViewerScope<T>(ownWatchlist: boolean, fn: () => T, readsExtensions = false): T {
  return scope.run({ ownWatchlist, readsExtensions, accountOwner: '' }, fn);
}

/** For work done as a user outside a Jellyfin request: the handoff and the playstate sync. */
export function runAsAccountOwner<T>(accountOwner: string, fn: () => T): T {
  const held = scope.getStore();
  return scope.run({ ownWatchlist: held?.ownWatchlist ?? false, readsExtensions: held?.readsExtensions ?? false, accountOwner }, fn);
}

/** Set once a request's config is scoped to the signed-in user. */
export function noteAccountOwner(accountOwner: string): void {
  const held = scope.getStore();
  if (held) held.accountOwner = accountOwner;
}

export function viewerAccountOwner(): string {
  return scope.getStore()?.accountOwner ?? '';
}

export function viewerOwnsWatchlist(): boolean {
  return scope.getStore()?.ownWatchlist === true;
}

export function viewerReadsExtensions(): boolean {
  return scope.getStore()?.readsExtensions === true;
}
