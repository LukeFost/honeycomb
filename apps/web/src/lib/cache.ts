// Short-TTL, promise-memoizing cache for the serving layer. Two jobs:
//  1. Concurrent callers share one in-flight load — a page that reads several loaders in
//     the same render triggers a single BigQuery round-trip, not one per loader.
//  2. Results expire after a short TTL so the refresh loop's updates surface, while the
//     cache still sits in front of the small derived view (never a raw-logs scan).
const DEFAULT_TTL_MS = Number(process.env.BQ_CACHE_TTL_MS ?? 30_000);

type Entry<T> = { value: Promise<T>; at: number };
const store = new Map<string, Entry<unknown>>();

export function cached<T>(key: string, loader: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const value = loader().catch((err) => {
    // Don't cache a rejection: evict so the next caller retries a fresh load.
    if (store.get(key)?.value === value) store.delete(key);
    throw err;
  });
  store.set(key, { value, at: Date.now() });
  return value;
}

/** Evict one key (or everything) — called after a refresh so reads pick up new data now. */
export function clearCache(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}
