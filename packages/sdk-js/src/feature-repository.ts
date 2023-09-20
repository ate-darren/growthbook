import {
  CacheSettings,
  FeatureApiResponse,
  Polyfills,
  RepositoryKey,
} from "./types/growthbook";
import type { GrowthBook } from ".";

type CacheEntry = {
  data: FeatureApiResponse;
  sse?: boolean;
  version: string;
  staleAt: Date;
};
type ScopedChannel = {
  src: EventSource | null;
  cb: (event: MessageEvent<string>) => void;
  errors: number;
};

// Config settings
const cacheSettings: CacheSettings = {
  // Consider a fetch stale after 1 minute
  staleTTL: 1000 * 60,
  cacheKey: "gbFeaturesCache",
  backgroundSync: true,
};
const polyfills: Polyfills = {
  fetch: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
  SubtleCrypto: globalThis.crypto ? globalThis.crypto.subtle : undefined,
  EventSource: globalThis.EventSource,
};
try {
  if (globalThis.localStorage) {
    polyfills.localStorage = globalThis.localStorage;
  }
} catch (e) {
  // Ignore localStorage errors
}

// Global state
const subscribedInstances: Map<RepositoryKey, Set<GrowthBook>> = new Map();
let cacheInitialized = false;
const cache: Map<RepositoryKey, CacheEntry> = new Map();
const activeFetches: Map<
  RepositoryKey,
  Promise<FeatureApiResponse>
> = new Map();
const streams: Map<RepositoryKey, ScopedChannel> = new Map();
const supportsSSE: Set<RepositoryKey> = new Set();

// Public functions
export function setPolyfills(overrides: Partial<Polyfills>): void {
  Object.assign(polyfills, overrides);
}
export function configureCache(overrides: Partial<CacheSettings>): void {
  Object.assign(cacheSettings, overrides);
  if (!cacheSettings.backgroundSync) {
    clearAutoRefresh();
  }
}

export async function clearCache(): Promise<void> {
  cache.clear();
  activeFetches.clear();
  clearAutoRefresh();
  cacheInitialized = false;
  await updatePersistentCache();
}

export async function refreshFeatures(
  instance: GrowthBook,
  timeout?: number,
  skipCache?: boolean,
  allowStale?: boolean,
  updateInstance?: boolean,
  backgroundSync?: boolean
): Promise<void> {
  if (!backgroundSync) {
    cacheSettings.backgroundSync = false;
  }

  const data = await fetchFeaturesWithCache(
    instance,
    allowStale,
    timeout,
    skipCache
  );
  updateInstance && data && (await refreshInstance(instance, data));
}

// Subscribe a GrowthBook instance to feature changes
export function subscribe(instance: GrowthBook): void {
  const key = getKey(instance);
  const subs = subscribedInstances.get(key) || new Set();
  subs.add(instance);
  subscribedInstances.set(key, subs);
}
export function unsubscribe(instance: GrowthBook): void {
  subscribedInstances.forEach((s) => s.delete(instance));
}

// Private functions
async function updatePersistentCache() {
  try {
    if (!polyfills.localStorage) return;
    await polyfills.localStorage.setItem(
      cacheSettings.cacheKey,
      JSON.stringify(Array.from(cache.entries()))
    );
  } catch (e) {
    // Ignore localStorage errors
  }
}

async function fetchFeaturesWithCache(
  instance: GrowthBook,
  allowStale?: boolean,
  timeout?: number,
  skipCache?: boolean
): Promise<FeatureApiResponse | null> {
  const key = getKey(instance);
  const now = new Date();
  await initializeCache();
  const existing = cache.get(key);
  if (existing && !skipCache && (allowStale || existing.staleAt > now)) {
    // Restore from cache whether or not SSE is supported
    if (existing.sse) supportsSSE.add(key);

    // Reload features in the background if stale
    if (existing.staleAt < now) {
      fetchFeatures(instance);
    }
    // Otherwise, if we don't need to refresh now, start a background sync
    else {
      startAutoRefresh(instance);
    }
    return existing.data;
  } else {
    return await promiseTimeout(fetchFeatures(instance), timeout);
  }
}

function getKey(instance: GrowthBook): RepositoryKey {
  const [apiHost, clientKey] = instance.getApiInfo();
  return instance.isRemoteEval()
    ? `${apiHost}||${clientKey}||${instance.getUserId()}`
    : `${apiHost}||${clientKey}`;
}

// Guarantee the promise always resolves within {timeout} ms
// Resolved value will be `null` when there's an error or it takes too long
// Note: The promise will continue running in the background, even if the timeout is hit
function promiseTimeout<T>(
  promise: Promise<T>,
  timeout?: number
): Promise<T | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let timer: unknown;
    const finish = (data?: T) => {
      if (resolved) return;
      resolved = true;
      timer && clearTimeout(timer as NodeJS.Timer);
      resolve(data || null);
    };

    if (timeout) {
      timer = setTimeout(() => finish(), timeout);
    }

    promise.then((data) => finish(data)).catch(() => finish());
  });
}

// Populate cache from localStorage (if available)
async function initializeCache(): Promise<void> {
  if (cacheInitialized) return;
  cacheInitialized = true;
  try {
    if (polyfills.localStorage) {
      const value = await polyfills.localStorage.getItem(
        cacheSettings.cacheKey
      );
      if (value) {
        const parsed: [RepositoryKey, CacheEntry][] = JSON.parse(value);
        if (parsed && Array.isArray(parsed)) {
          parsed.forEach(([key, data]) => {
            cache.set(key, {
              ...data,
              staleAt: new Date(data.staleAt),
            });
          });
        }
      }
    }
  } catch (e) {
    // Ignore localStorage errors
  }
}

// Called whenever new features are fetched from the API
function onNewFeatureData(key: RepositoryKey, data: FeatureApiResponse): void {
  // If contents haven't changed, ignore the update, extend the stale TTL
  const version = data.dateUpdated || "";
  const staleAt = new Date(Date.now() + cacheSettings.staleTTL);
  const existing = cache.get(key);
  if (existing && version && existing.version === version) {
    existing.staleAt = staleAt;
    updatePersistentCache();
    return;
  }

  // Update in-memory cache
  cache.set(key, {
    data,
    version,
    staleAt,
    sse: supportsSSE.has(key),
  });
  // Update local storage (don't await this, just update asynchronously)
  updatePersistentCache();

  // Update features for all subscribed GrowthBook instances
  const instances = subscribedInstances.get(key);
  instances && instances.forEach((instance) => refreshInstance(instance, data));
}

async function refreshInstance(
  instance: GrowthBook,
  data: FeatureApiResponse
): Promise<void> {
  await (data.encryptedExperiments
    ? instance.setEncryptedExperiments(
        data.encryptedExperiments,
        undefined,
        polyfills.SubtleCrypto
      )
    : instance.setExperiments(data.experiments || instance.getExperiments()));

  await (data.encryptedFeatures
    ? instance.setEncryptedFeatures(
        data.encryptedFeatures,
        undefined,
        polyfills.SubtleCrypto
      )
    : instance.setFeatures(data.features || instance.getFeatures()));
}

async function fetchFeatures(
  instance: GrowthBook
): Promise<FeatureApiResponse> {
  const key = getKey(instance);
  const {
    apiHost,
    featuresPath,
    remoteEvalHost,
    remoteEvalPath,
    apiRequestHeaders,
  } = instance.getApiHosts();
  const clientKey = instance.getClientKey();
  const remoteEval = instance.isRemoteEval();

  const endpoint = remoteEval
    ? `${remoteEvalHost}${remoteEvalPath}/${clientKey}`
    : `${apiHost}${featuresPath}/${clientKey}`;
  const options: RequestInit = remoteEval
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiRequestHeaders },
        body: JSON.stringify({
          attributes: instance.getAttributes(),
        }),
      }
    : {
        headers: apiRequestHeaders,
      };

  let promise = activeFetches.get(key);
  if (!promise) {
    promise = (polyfills.fetch as typeof globalThis.fetch)(endpoint, options)
      // TODO: auto-retry if status code indicates a temporary error
      .then((res) => {
        if (res.headers.get("x-sse-support") === "enabled") {
          supportsSSE.add(key);
        }
        return res.json();
      })
      .then((data: FeatureApiResponse) => {
        onNewFeatureData(key, data);
        startAutoRefresh(instance);
        activeFetches.delete(key);
        return data;
      })
      .catch((e) => {
        process.env.NODE_ENV !== "production" &&
          instance.log("Error fetching features", {
            apiHost,
            clientKey,
            error: e ? e.message : null,
          });
        activeFetches.delete(key);
        return Promise.resolve({});
      });
    activeFetches.set(key, promise);
  }
  return await promise;
}

// Watch a feature endpoint for changes
// Will prefer SSE if enabled, otherwise fall back to cron
function startAutoRefresh(instance: GrowthBook): void {
  const key = getKey(instance);
  const {
    streamingHost,
    streamingPath,
    apiRequestHeaders,
  } = instance.getApiHosts();
  const clientKey = instance.getClientKey();
  if (
    cacheSettings.backgroundSync &&
    supportsSSE.has(key) &&
    polyfills.EventSource
  ) {
    if (streams.has(key)) return;
    const channel: ScopedChannel = {
      src: null,
      cb: (event: MessageEvent<string>) => {
        try {
          if (event.type === "features-updated") {
            fetchFeatures(instance);
          } else if (event.type === "features") {
            const json: FeatureApiResponse = JSON.parse(event.data);
            onNewFeatureData(key, json);
          }
          // Reset error count on success
          channel.errors = 0;
        } catch (e) {
          process.env.NODE_ENV !== "production" &&
            instance.log("SSE Error", {
              streamingHost,
              clientKey,
              error: e ? (e as Error).message : null,
            });
          onSSEError(
            channel,
            streamingHost,
            streamingPath,
            apiRequestHeaders,
            clientKey
          );
        }
      },
      errors: 0,
    };
    streams.set(key, channel);
    enableChannel(
      channel,
      streamingHost,
      streamingPath,
      apiRequestHeaders,
      clientKey
    );
  }
}

function onSSEError(
  channel: ScopedChannel,
  host: string,
  path: string,
  headers: Record<string, string>,
  clientKey: string
) {
  channel.errors++;
  if (channel.errors > 3 || (channel.src && channel.src.readyState === 2)) {
    // exponential backoff after 4 errors, with jitter
    const delay =
      Math.pow(3, channel.errors - 3) * (1000 + Math.random() * 1000);
    disableChannel(channel);
    setTimeout(() => {
      enableChannel(channel, host, path, headers, clientKey);
    }, Math.min(delay, 300000)); // 5 minutes max
  }
}

function disableChannel(channel: ScopedChannel) {
  if (!channel.src) return;
  channel.src.onopen = null;
  channel.src.onerror = null;
  channel.src.close();
  channel.src = null;
}

function enableChannel(
  channel: ScopedChannel,
  host: string,
  path: string,
  headers: Record<string, string>,
  clientKey: string
) {
  try {
    channel.src = new polyfills.EventSource(`${host}${path}/${clientKey}`, {
      headers,
    }) as EventSource;
  } catch (e) {
    channel.src = new polyfills.EventSource(
      `${host}${path}/${clientKey}`
    ) as EventSource;
  }
  channel.src.addEventListener("features", channel.cb);
  channel.src.addEventListener("features-updated", channel.cb);
  channel.src.onerror = () => {
    onSSEError(channel, host, path, headers, clientKey);
  };
  channel.src.onopen = () => {
    channel.errors = 0;
  };
}

function destroyChannel(channel: ScopedChannel, key: RepositoryKey) {
  disableChannel(channel);
  streams.delete(key);
}

function clearAutoRefresh() {
  // Clear list of which keys are auto-updated
  supportsSSE.clear();

  // Stop listening for any SSE events
  streams.forEach(destroyChannel);

  // Remove all references to GrowthBook instances
  subscribedInstances.clear();
}
