// Only JSON-compatible values are cacheable
export type CacheablePrimitive = string | number | boolean | null | undefined;
export type Cacheable = CacheablePrimitive | Cacheable[] | { [key: string]: Cacheable };

export interface CacheItem<T extends Cacheable> {
  key: string;
  value: T;
  expired?: boolean;
}

export interface CacheLayer {
  get<T extends Cacheable>(key: string, allowExpired: boolean): Promise<T | null>;
  set<T extends Cacheable>(item: CacheItem<T>): Promise<void>;

  getMany<T extends Cacheable>(keys: string[], allowExpired: boolean): Promise<(T | null)[]>;
  setMany<T extends Cacheable>(items: CacheItem<T>[]): Promise<void>;

  getOrSet<T extends Cacheable>(key: string, factory: () => Promise<T>): Promise<T>;
  getOrSetMany<T extends Cacheable>(keys: string[], factory: (missing: string[]) => Promise<T[]>): Promise<T[]>;
}

export type CacheSettings = {
  ttl: {
    memory: {
      /**
       * Seconds until data is considered stale
       */
      soft: number;

      /**
       * Seconds until data expires
       */
      strict: number;
    };
    distributed: {
      /**
       * Seconds until data is considered stale
       */
      soft: number;

      /**
       * Seconds until data expires
       */
      strict: number;
    };
  };

  timeouts: {
    /**
     * Returns stale data if available - in millis
     */
    soft: number;

    /**
     * Throws an exception when passed - in millis
     */
    strict: number;
  };

  allowBackgroundUpdates?: boolean;
};

export type InternalCacheItem<T> = {
  value: T;
  // For soft ttl - Unix Timestamp
  expiredAfter: number;
};
