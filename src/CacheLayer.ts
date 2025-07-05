import Keyv from "keyv";
import { CacheLayer, CacheSettings, Cacheable, CacheItem, InternalCacheItem } from "./Types";

const MS_IN_A_SEC = 1000;

export class TieredCacheLayer implements CacheLayer {
  private readonly settings: CacheSettings;
  private readonly memory: Keyv;
  private readonly distributed: Keyv;

  private readonly cacheInFlight: Map<string, Promise<any>> = new Map();

  constructor(settings: CacheSettings, memory: Keyv, distributed: Keyv) {
    this.settings = settings;
    this.memory = memory;
    this.distributed = distributed;
  }

  /**
   * Retrieve a single value by key.
   * @param key cache key
   * @param allowExpired return stale value if fresh miss and expired
   * @description Delegates data fetching to batch getMany for consistent expiry and fallback behavior.
   */
  async get<T extends Cacheable>(key: string, allowExpired: boolean): Promise<T | null> {
    const [memoryItem, memoryExpired] = await this.getFromCache<T>(this.memory, key);
    if (memoryItem && !memoryExpired) {
      return memoryItem;
    }

    // If we have an expired item in the memory cache and we are already fetching from the distributed cache,
    // we return the expired value for performance reasons (if allowed)
    if (this.cacheInFlight.has(key) && allowExpired && memoryItem) {
      return memoryItem;
    }

    return await this.handleInFlight(this.cacheInFlight, key, () =>
      this.getMany([key], allowExpired).then((items) => items[0]),
    );
  }

  async set<T extends Cacheable>(item: CacheItem<T>): Promise<void> {
    await Promise.allSettled([this.setInCache(this.memory, item), this.setInCache(this.distributed, item)]);
  }

  async getMany<T extends Cacheable>(keys: string[], allowExpired: boolean): Promise<(T | null)[]> {
    const fromMemory = await this.getManyFromCache<T>(this.memory, keys);
    const missingItemsInMemory = fromMemory.some((i) => i[0] === null || i[1] /* expired */);

    // If all items are fresh in memory, just return them
    if (!missingItemsInMemory) {
      return fromMemory.map((i) => i[0]);
    }

    // We use reduce to prevent having to map > filter > map
    const missingKeys = fromMemory.reduce((list, value, index) => {
      if (value[0] === null || value[1]) {
        list.push(keys[index]);
      }
      return list;
    }, Array<string>());

    // TODO: consider batching or de-duplicating in-flight batch requests to avoid N fetches per key
    // We don't protect getMany from in flight requests, as it will create a lot of promises (1 per key)
    const distributedResults = await this.getManyFromCache<T>(this.distributed, missingKeys);

    const { result, toSetInMemory } = this.mergeBatchResults(
      keys,
      fromMemory,
      missingKeys,
      distributedResults,
      allowExpired,
    );

    if (toSetInMemory.length) {
      await this.setManyInCache(this.memory, toSetInMemory);
    }

    return result;
  }

  async setMany<T extends Cacheable>(items: CacheItem<T>[]): Promise<void> {
    await Promise.allSettled([this.setManyInCache(this.memory, items), this.setManyInCache(this.distributed, items)]);
  }

  /**
   * Get value from cache or execute factory function if not found/expired.
   * Supports soft/hard timeouts and background updates.
   */
  async getOrSet<T extends Cacheable>(key: string, factory: () => Promise<T>): Promise<T> {
    const [memoryItem, memoryExpired] = await this.getFromCache<T>(this.memory, key);

    if (memoryItem && !memoryExpired) {
      return memoryItem;
    }

    // If we have an expired item in memory and we are already fetching, return the expired value
    if (this.cacheInFlight.has(key) && memoryItem) {
      return memoryItem;
    }

    return await this.handleInFlight(this.cacheInFlight, key, async () => {
      const [distributedItem, distributedExpired] = await this.getFromCache<T>(this.distributed, key);

      if (distributedItem && !distributedExpired) {
        await this.setInCache(this.memory, { key, value: distributedItem });
        return distributedItem;
      }

      // Execute factory with timeout protection
      const result = await this.executeFactoryWithTimeout(factory, memoryItem || distributedItem);

      // Cache the result
      await this.set({ key, value: result });

      // Background update if we have stale data and background updates are enabled
      if (this.settings.allowBackgroundUpdates && (memoryItem || distributedItem)) {
        this.scheduleBackgroundUpdate(key, factory);
      }

      return result;
    });
  }

  /**
   * Get multiple values from cache or execute factory function for missing/expired keys.
   * Supports soft/hard timeouts and background updates.
   */
  async getOrSetMany<T extends Cacheable>(keys: string[], factory: (missing: string[]) => Promise<T[]>): Promise<T[]> {
    const fromMemory = await this.getManyFromCache<T>(this.memory, keys);
    const allFreshInMemory = fromMemory.every(([item, expired]) => item !== null && !expired);

    if (allFreshInMemory) {
      return fromMemory.map(([item]) => item!);
    }

    const batchKey = `batch:${keys.sort().join(",")}`;

    return await this.handleInFlight(this.cacheInFlight, batchKey, async () => {
      const fromDistributed = await this.getManyFromCache<T>(this.distributed, keys);

      const missingKeys: string[] = [];
      const staleValues: (T | null)[] = [];
      const result: T[] = [];

      for (let i = 0; i < keys.length; i++) {
        const [memoryItem, memoryExpired] = fromMemory[i];
        const [distributedItem, distributedExpired] = fromDistributed[i];

        if (memoryItem && !memoryExpired) {
          result[i] = memoryItem;
          staleValues[i] = null;
        } else if (distributedItem && !distributedExpired) {
          result[i] = distributedItem;
          staleValues[i] = null;
          await this.setInCache(this.memory, { key: keys[i], value: distributedItem });
        } else {
          missingKeys.push(keys[i]);
          staleValues[i] = memoryItem || distributedItem;
        }
      }

      if (missingKeys.length === 0) {
        return result;
      }

      const factoryResults = await this.executeBatchFactoryWithTimeout(
        () => factory(missingKeys),
        missingKeys,
        staleValues,
        keys,
      );

      const itemsToCache: CacheItem<T>[] = [];
      let factoryIndex = 0;

      for (let i = 0; i < keys.length; i++) {
        if (result[i] === undefined) {
          const factoryResult = factoryResults[factoryIndex++];
          result[i] = factoryResult;
          itemsToCache.push({ key: keys[i], value: factoryResult });
        }
      }

      if (itemsToCache.length > 0) {
        await this.setMany(itemsToCache);

        if (this.settings.allowBackgroundUpdates && staleValues.some((v) => v !== null)) {
          this.scheduleBatchBackgroundUpdate(missingKeys, factory);
        }
      }

      return result;
    });
  }

  /**
   * Write an item with soft (stale-while-revalidate) and strict (absolute eviction) TTL.
   */
  private setInCache<T extends Cacheable>(cache: Keyv, item: CacheItem<T>) {
    const isMemory = cache === this.memory;
    const setting = isMemory ? this.settings.ttl.memory : this.settings.ttl.distributed;
    const now = this.now();
    const expiredAfter = item.expired ? now : now + setting.soft * MS_IN_A_SEC;

    return cache.set<InternalCacheItem<T>>(item.key, { value: item.value, expiredAfter }, setting.strict * MS_IN_A_SEC);
  }

  /**
   * Batch write items with soft/strict TTL.
   */
  private setManyInCache<T extends Cacheable>(cache: Keyv, items: CacheItem<T>[]) {
    const isMemory = cache === this.memory;
    const setting = isMemory ? this.settings.ttl.memory : this.settings.ttl.distributed;
    const now = this.now();
    const expiredAfter = now + setting.soft * MS_IN_A_SEC;
    const ttl = setting.strict * MS_IN_A_SEC;

    return cache.setMany<InternalCacheItem<T>>(
      items.map((item, i) => ({
        key: item.key,
        value: { value: item.value, expiredAfter: item.expired ? now : expiredAfter },
        ttl,
      })),
    );
  }

  private async getFromCache<T extends Cacheable>(cache: Keyv, key: string): Promise<[T | null, boolean]> {
    const item = await cache.get<InternalCacheItem<T>>(key);

    let expired = true;
    if (item) {
      expired = item.expiredAfter <= this.now();
    }

    return [item?.value ?? null, expired] as const;
  }

  private async getManyFromCache<T extends Cacheable>(cache: Keyv, keys: string[]): Promise<[T | null, boolean][]> {
    const items = await cache.getMany<InternalCacheItem<T>>(keys);
    const now = this.now();

    return items.map((item) => {
      let expired = true;
      if (item) {
        expired = item.expiredAfter <= now;
      }

      return [item?.value ?? null, expired] as const;
    });
  }

  /**
   * De-duplicate concurrent fetches for the same key to prevent stampedes.
   */
  private handleInFlight<T>(inflight: Map<string, Promise<any>>, key: string, fn: () => Promise<T>) {
    if (inflight.has(key)) {
      return inflight.get(key);
    }

    const promise = fn().finally(() => inflight.delete(key));

    inflight.set(key, promise);

    return promise;
  }

  private now() {
    return Date.now();
  }

  /**
   * Combine memory and distributed batch results, enforce soft vs strict expiry, and collect items to back-fill into memory cache.
   */
  private mergeBatchResults<T extends Cacheable>(
    keys: string[],
    fromMemory: Array<[T | null, boolean]>,
    missingKeys: string[],
    distributedResults: Array<[T | null, boolean]>,
    allowExpired: boolean,
  ): { result: (T | null)[]; toSetInMemory: CacheItem<T>[] } {
    const distributedResultsMap = new Map<string, [T | null, boolean]>();

    missingKeys.forEach((key, idx) => {
      distributedResultsMap.set(key, distributedResults[idx]);
    });

    const result: (T | null)[] = [];
    const toSetInMemory: CacheItem<T>[] = [];

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const [memoryItem, memoryExpired] = fromMemory[i];

      if (!memoryExpired) {
        result.push(memoryItem);
        continue;
      }

      const dist = distributedResultsMap.get(key);

      if (dist) {
        const [distributedItem, distributedExpired] = dist;

        if (distributedItem != null) {
          // Fill the memory cache so we don't have to go to the distributed cache every time
          // If the distributed item is expired, we ensure the memory item is also expired
          toSetInMemory.push({ key, value: distributedItem, expired: distributedExpired });

          if (!distributedExpired || allowExpired) {
            result.push(distributedItem);
            continue;
          }
        }
      }

      if (allowExpired && memoryItem != null) {
        result.push(memoryItem);
        continue;
      }

      result.push(null);
    }

    return { result, toSetInMemory };
  }

  /**
   * Execute factory function with timeout protection.
   */
  private async executeFactoryWithTimeout<T extends Cacheable>(
    factory: () => Promise<T>,
    staleValue: T | null,
  ): Promise<T> {
    const softTimeout = this.settings.timeouts.soft;
    const hardTimeout = this.settings.timeouts.strict;

    const factoryPromise = factory();

    // If we have a stale value and soft timeout is configured, race the factory against the soft timeout
    if (staleValue && softTimeout > 0) {
      const softTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Soft timeout exceeded")), softTimeout);
      });

      try {
        return await Promise.race([factoryPromise, softTimeoutPromise]);
      } catch (error) {
        if (error instanceof Error && error.message === "Soft timeout exceeded") {
          return staleValue;
        }
        throw error;
      }
    }

    // Apply hard timeout if configured
    if (hardTimeout > 0) {
      const hardTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Hard timeout exceeded")), hardTimeout);
      });

      return await Promise.race([factoryPromise, hardTimeoutPromise]);
    }

    return await factoryPromise;
  }

  /**
   * Schedule a background update for a key.
   */
  private scheduleBackgroundUpdate<T extends Cacheable>(key: string, factory: () => Promise<T>): void {
    setImmediate(async () => {
      try {
        const result = await factory();
        await this.set({ key, value: result });
      } catch (error) {
        // Silently ignore background update errors
      }
    });
  }

  /**
   * Execute batch factory function with timeout protection.
   */
  private async executeBatchFactoryWithTimeout<T extends Cacheable>(
    factory: () => Promise<T[]>,
    missingKeys: string[],
    staleValues: (T | null)[],
    originalKeys: string[],
  ): Promise<T[]> {
    const softTimeout = this.settings.timeouts.soft;
    const hardTimeout = this.settings.timeouts.strict;

    const factoryPromise = factory();

    // If we have any stale values and soft timeout is configured, race the factory against the soft timeout
    const hasStaleValues = staleValues.some((v) => v !== null);
    if (hasStaleValues && softTimeout > 0) {
      const softTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Soft timeout exceeded")), softTimeout);
      });

      try {
        return await Promise.race([factoryPromise, softTimeoutPromise]);
      } catch (error) {
        if (error instanceof Error && error.message === "Soft timeout exceeded") {
          // Return stale values for the missing keys
          const result: T[] = [];
          let missingIndex = 0;

          for (let i = 0; i < originalKeys.length; i++) {
            if (missingKeys.includes(originalKeys[i])) {
              const staleValue = staleValues[i];
              if (staleValue !== null) {
                result.push(staleValue);
              } else {
                throw error; // No stale value available, re-throw the timeout error
              }
              missingIndex++;
            }
          }

          return result;
        }
        throw error;
      }
    }

    // Apply hard timeout if configured
    if (hardTimeout > 0) {
      const hardTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Hard timeout exceeded")), hardTimeout);
      });

      return await Promise.race([factoryPromise, hardTimeoutPromise]);
    }

    return await factoryPromise;
  }

  /**
   * Schedule a background update for multiple keys.
   */
  private scheduleBatchBackgroundUpdate<T extends Cacheable>(
    keys: string[],
    factory: (missing: string[]) => Promise<T[]>,
  ): void {
    setImmediate(async () => {
      try {
        const results = await factory(keys);
        const itemsToCache: CacheItem<T>[] = results.map((value, index) => ({
          key: keys[index],
          value,
        }));
        await this.setMany(itemsToCache);
      } catch (error) {
        // Silently ignore background update errors
      }
    });
  }
}
