import Keyv, { KeyvEntry } from "keyv";

/**
 * Only JSON serialization compatible values
 */
export type Cacheable = string | number | boolean | null | undefined | Cacheable[] | { [key: string]: Cacheable };

export type Key = string;
export type Batch<T> = Map<Key, T>;

export interface Cache {
  get<T extends Cacheable>(key: Key): Promise<T>;
  get<T extends Cacheable>(key: Key, factory: () => Promise<T>): Promise<T>;

  getBatch<T extends Cacheable>(keys: Key[]): Promise<Batch<T>>;
  getBatch<T extends Cacheable>(keys: Key[], factory: (keys: Key[]) => Promise<Batch<T>>): Promise<Batch<T>>;

  set<T extends Cacheable>(key: Key, value: T): Promise<void>;
  setBatch<T extends Cacheable>(values: Batch<T>): Promise<void>;

  has(key: Key): Promise<boolean>;
  hasBatch(keys: Key[]): Promise<Batch<boolean>>;

  delete(key: Key): Promise<void>;
  deleteBatch(keys: Key[]): Promise<void>;

  clear(): Promise<void>;
}

export type Seconds = number;
export type UnixTimestamp = number;

/**
 * We use 2 types of timeouts.
 * A soft timeout returns stale data after it has been passed.
 * A strict timeout throws an exception after it has been passed.
 */
export type CacheTimeout = {
  soft: Seconds;
  strict: Seconds;
};

export type CacheLayerConfiguration = {
  /**
   * The actual cache object
   */
  cache: Keyv;

  /**
   * Duration a cache entry is considered fresh — after this it becomes stale
   */
  ttl: Seconds;

  /**
   * Absolute duration a cache entry is allowed to stay in the cache — even when stale
   */
  lifetime: Seconds;
};

export type CacheConfiguration = {
  /**
   * The first tier of caching used
   */
  memory: CacheLayerConfiguration;

  /**
   * The second tier of caching
   */
  distributed: CacheLayerConfiguration;

  /**
   * Timeouts applied to getting data from the distributed cache
   */
  distributedTimeout: CacheTimeout;

  /**
   * Timeouts applied to getting fresh data from a factory method
   */
  factoryTimeout: CacheTimeout;
};

type CacheEntry<T extends Cacheable> = {
  value: T;
  freshUntil: UnixTimestamp;
};

export default class MultiTieredCache implements Cache {
  private readonly config: CacheConfiguration;
  private readonly memoryCache: Keyv;
  private readonly distributedCache: Keyv;

  constructor(config: CacheConfiguration) {
    this.config = config;
    this.memoryCache = config.memory.cache;
    this.distributedCache = config.distributed.cache;
  }

  async getBatch<T extends Cacheable>(keys: Key[], factory?: (keys: Key[]) => Promise<Batch<T>>): Promise<Batch<T>> {
    const { fresh: freshM, stale: staleM, miss: missM } = await this.__getFromCache<T>(this.memoryCache, keys);

    if (freshM.size === keys.length) {
      return freshM;
    }

    const { freshD, staleD, missD } = await this.__getFromDistributedCache<T>(staleM, missM);

    // Ensure distributed values are in the memory cache for performance & graceful fallback
    // Not awaited to ensure it happens in the background
    this.setBatchInCache(freshD, this.config.memory, true);
    this.setBatchInCache(staleD, this.config.memory, false);

    // Misses need to be retrieved from the factory
    let fromFactory: Batch<T> | undefined;
    if (factory && missD.length) {
      fromFactory = await this.__getFromFactory<T>(staleD, missD, factory);

      // Ensure new values are in both caches
      await this.setBatch(fromFactory, true);
    }

    // Merge all fresh values into a batch
    return new Map([...freshM, ...freshD, ...(fromFactory ? fromFactory : [])]);
  }

  async __getFromCache<T extends Cacheable>(cache: Keyv, keys: Key[]) {
    const entries = await cache.getMany<CacheEntry<T>>(keys);
    return this.splitByState<T>(keys, entries);
  }

  async __getFromDistributedCache<T extends Cacheable>(staleM: Batch<T>, missM: Key[]) {
    const keys = [...missM, ...staleM.keys()];

    /*
    TODO: Acquire stampede lock per key
      Full hit
        Wait until done
      Partial hit
        Fetch keys + put in stampede lock
        Wait until done for hit
      Full miss
        Fetch keys + put in stampede lock
    */

    // TODO: Handle soft timeout (return staleM as stale, missM as miss) / strict timeout (throw exception)
    const { fresh: freshD, stale: staleD, miss: missD } = await this.__getFromCache<T>(this.distributedCache, keys);

    return {
      freshD,
      staleD,
      missD,
    };
  }

  async __getFromFactory<T extends Cacheable>(
    staleD: Batch<T>,
    missD: Key[],
    factory: (keys: Key[]) => Promise<Batch<T>>,
  ) {
    const keys = [...missD, ...staleD.keys()];

    /*
    TODO: Acquire stampede lock per key
      Full hit
        Skip if background
        Wait if not
      Partial hit
        Fetch keys + put in stampede lock
        Skip if background / Wait until done for hit
      Full miss
        Fetch keys + put in stampede lock
    */

    // TODO: Handle soft timeout (return staleD as stale, missD as miss) / strict timeout (throw exception)

    return await factory(keys);
  }

  async get<T extends Cacheable>(key: Key, factory?: () => Promise<T>): Promise<T> {
    const batchFactory = factory ? async () => new Map([[key, await factory()]]) : undefined;

    const v = await this.getBatch([key], batchFactory);

    // We assume all input keys are always returned in the batch
    return v.get(key)!;
  }

  set<T extends Cacheable>(key: Key, value: T): Promise<void> {
    return this.setBatch(new Map([[key, value]]));
  }

  async setBatch<T extends Cacheable>(values: Batch<T>, fresh: boolean = true): Promise<void> {
    await this.setBatchInCache(values, this.config.memory, fresh);
    await this.setBatchInCache(values, this.config.distributed, fresh);
  }

  async setBatchInCache<T extends Cacheable>(values: Batch<T>, config: CacheLayerConfiguration, fresh: boolean) {
    const now = this.now();

    const entries = values
      .entries()
      .map((kv) => this.batchEntry(kv[0], kv[1], now, config, fresh))
      .toArray();

    await config.cache.setMany(entries);
  }

  async has(key: Key): Promise<boolean> {
    return (await this.memoryCache.has(key)) || (await this.distributedCache.has(key));
  }

  async hasBatch(keys: Key[]): Promise<Batch<boolean>> {
    const inMemory = await this.memoryCache.hasMany(keys);
    const inDistributed = await this.distributedCache.hasMany(keys);

    const result = new Map();

    for (let i = 0; i < keys.length; i++) {
      result.set(keys[i], inMemory[i] || inDistributed[i]);
    }

    return result;
  }

  async delete(key: Key): Promise<void> {
    await this.memoryCache.delete(key);
    await this.distributedCache.delete(key);
  }

  async deleteBatch(keys: Key[]): Promise<void> {
    await this.memoryCache.deleteMany(keys);
    await this.distributedCache.deleteMany(keys);
  }

  async clear(): Promise<void> {
    await this.memoryCache.clear();
    await this.distributedCache.clear();
  }

  batchEntry<T extends Cacheable>(
    key: Key,
    value: T,
    now: UnixTimestamp,
    config: CacheLayerConfiguration,
    fresh = true,
  ): KeyvEntry {
    const entry: CacheEntry<T> = { value, freshUntil: fresh ? now + config.ttl : now };

    return {
      key,
      value: entry,
      ttl: now + config.lifetime,
    };
  }

  now() {
    return Date.now();
  }

  splitByState<T extends Cacheable>(
    keys: Key[],
    entries: (CacheEntry<T> | undefined)[],
  ): { fresh: Batch<T>; stale: Batch<T>; miss: Key[] } {
    const fresh: Batch<T> = new Map();
    const stale: Batch<T> = new Map();
    const miss: Key[] = [];

    const now = this.now();

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const entry = entries[i];

      if (entry) {
        if (entry.freshUntil > now) {
          fresh.set(key, entry.value);
        } else {
          stale.set(key, entry.value);
        }
      } else {
        miss.push(key);
      }
    }

    return {
      fresh,
      stale,
      miss,
    };
  }
}
