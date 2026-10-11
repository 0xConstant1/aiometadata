import { AsyncLocalStorage } from 'node:async_hooks';

interface ViewerScope {
  ownWatchlist: boolean;
  readsExtensions: boolean;
  accountOwner: string;
  marksUnaired: boolean;
}

const scope = new AsyncLocalStorage<ViewerScope>();

export function runInViewerScope<T>(ownWatchlist: boolean, fn: () => T, readsExtensions = false): T {
  return scope.run({ ownWatchlist, readsExtensions, accountOwner: '', marksUnaired: true }, fn);
}

/** For work done as a user outside a Jellyfin request: the handoff and the playstate sync. */
export function runAsAccountOwner<T>(accountOwner: string, fn: () => T): T {
  const held = scope.getStore();
  return scope.run({ ownWatchlist: held?.ownWatchlist ?? false, readsExtensions: held?.readsExtensions ?? false, accountOwner, marksUnaired: held?.marksUnaired ?? true }, fn);
}

/** Set once a request's config is scoped to the signed-in user. */
export function noteAccountOwner(accountOwner: string): void {
  const held = scope.getStore();
  if (held) held.accountOwner = accountOwner;
}

export function noteMarksUnaired(marks: boolean): void {
  const held = scope.getStore();
  if (held) held.marksUnaired = marks;
}

export function viewerMarksUnaired(): boolean {
  return scope.getStore()?.marksUnaired !== false;
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
