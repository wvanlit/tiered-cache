# Tiered Cache - Development Instructions

## Project Overview
This is a TypeScript cache library implementing a multi-tiered caching system with in-memory and distributed layers. The cache supports sophisticated features like batch operations, soft/strict timeouts, background updates, and stampede protection.

## Architecture Understanding

### Core Components
- **MultiTieredCache**: Main cache class implementing the `Cache` interface
- **Memory Layer**: Fast in-memory cache (first tier) using Keyv
- **Distributed Layer**: Persistent distributed cache (second tier) using Keyv with Redis
- **Cache Entries**: Structured as `{ value: T, freshUntil: UnixTimestamp }` with TTL and lifetime management

### Key Features
- **Batch Operations**: Optimized bulk get/set operations with complex flow logic
- **Tiered Retrieval**: Memory → Distributed → Factory fallback chain
- **Timeout Management**: Soft timeouts (return stale) vs strict timeouts (throw error)
- **Stampede Protection**: Coalesces concurrent requests for same keys
- **Background Updates**: Non-blocking cache warming and cross-tier syncing

## Development Workflow

### Setup & Environment
```bash
# Install dependencies
npm install

# Start Redis for integration tests
npm run docker:up

# Run all tests
npm run test

# Run unit tests
npm run test:unit

# Development with watch mode
npm run test:watch

# Linting
npm run lint
npm run lint:fix
```

### Code Architecture Rules

#### Type Safety
- Use `Cacheable` type for all cache values (JSON-serializable only)
- Leverage `Key` type alias for cache keys (string)
- Use `Batch<T>` type for batch operations (Map<Key, T>)
- All public methods should be properly typed with generics

#### Error Handling
- Soft timeouts should return stale data when available
- Strict timeouts should throw errors
- Factory failures should gracefully fall back to stale data
- Always prefer returning something over nothing

#### Performance Considerations
- Background operations should never block user requests
- Use `void` promises for fire-and-forget operations
- Implement proper stampede protection for concurrent requests
- Minimize serialization overhead

### Testing Strategy

#### Unit Tests (`test/unit/`)
- Mock all external dependencies (Keyv instances)
- Test timeout behaviors with `vitest.useFakeTimers()`
- Test complex batch flow scenarios
- Test stampede protection logic
- Test cache state transitions (fresh → stale → miss)

#### Integration Tests (`test/integration/`)
- Use real Redis instance via Docker
- Test full end-to-end workflows
- Test serialization/deserialization
- Test cross-tier synchronization
- Test actual timeout behaviors

### Code Style Guidelines

#### Naming Conventions
- Private methods: `__methodName` (double underscore for internal cache operations)
- Private fields: `private readonly field` (prefer readonly when possible)
- Types: PascalCase (`CacheEntry`, `CacheConfiguration`)
- Constants: UPPER_SNAKE_CASE (`MS_IN_A_SEC`)

#### Method Organization
- Public interface methods first
- Private implementation methods grouped by functionality
- Helper/utility methods at the bottom
- Keep complex logic in separate private methods

#### Documentation
- Avoid comments unless explaining complex algorithms or business logic
- Use JSDoc for complex types and interfaces
- TODO comments for known technical debt
- Type annotations should be self-documenting

## Key Implementation Details

### Batch Get Flow
The most complex operation - understand the three-phase retrieval:
1. **Memory Phase**: Get fresh/stale/miss from memory cache
2. **Distributed Phase**: Get remaining keys from distributed cache + background sync to memory
3. **Factory Phase**: Get remaining keys from factory + update both caches

### Timeout Handling
- **Soft Timeout**: Return stale data if available, used for non-critical paths
- **Strict Timeout**: Throw error, used as absolute maximum wait time
- **Skip Soft**: Skip soft timeout when missing keys exist (prefer completeness over speed)

### Stampede Protection
- Coalesce concurrent requests for same keys using `inflightForFactory` Map
- Return union of newly retrieved + in-flight results
- Clean up inflight entries on completion/error

### Cache Entry Lifecycle
- **Fresh**: `freshUntil > now()` - serve immediately
- **Stale**: `freshUntil <= now()` but still in cache - can serve but should refresh
- **Expired**: not in cache - purged by Keyv automatically

## Common Development Patterns

### Adding New Cache Methods
1. Add to `Cache` interface first
2. Implement in `MultiTieredCache` class
3. Consider if it needs batch equivalent
4. Add comprehensive unit tests
5. Add integration tests if external dependencies involved

### Testing Complex Scenarios
```typescript
// Use fake timers for timeout testing
vitest.useFakeTimers();

// Test cache state transitions
const now = Date.now();
vitest.setSystemTime(now);
// ... set up cache entries
vitest.setSystemTime(now + ttl * 1000 + 1); // Make entries stale
```

### Debugging Cache Behavior
- Use `getBatch` return values to inspect cache hit/miss patterns
- Check `inflightForFactory` Map for concurrent request debugging
- Monitor background `void` promises for cache warming issues

## Performance Optimization

### Critical Paths
- Memory cache hits should be fastest (no await chains)
- Distributed cache with background memory sync
- Factory calls should be last resort

### Memory Management
- Cache entries have automatic lifetime management via Keyv TTL
- Background operations clean up inflight tracking
- Prefer streaming/lazy evaluation for large batch operations

### Concurrency
- All cache operations are async and should be non-blocking
- Use `Promise.race` for timeout implementations
- Background operations should use `void` promises

## Testing Scenarios to Always Cover

### Unit Test Scenarios
- Fresh hits from memory
- Stale hits requiring distributed lookup
- Complete misses requiring factory
- Timeout scenarios (soft vs strict)
- Stampede protection with concurrent requests
- Background sync operations

### Integration Test Scenarios
- Real Redis connectivity
- Serialization round-trips
- Cross-tier consistency
- Network timeout handling
- Redis connection failures

## Debugging Tips

### Common Issues
- **Infinite Loops**: Check timeout configurations and factory implementations
- **Stale Data**: Verify TTL vs lifetime configurations
- **Memory Leaks**: Ensure `inflightForFactory` cleanup on errors
- **Serialization**: Verify all cached data is JSON-serializable

### Performance Debugging
- Monitor cache hit ratios across tiers
- Check background operation completion
- Measure factory call frequency
- Profile timeout trigger rates

## Future Development Areas

### Potential Features
- Cache warming strategies
- Metrics and observability
- Custom serialization strategies
- Distributed locking improvements
- Cache invalidation patterns

### Technical Debt
- Complete stampede protection implementation (marked TODO)
- Enhanced error handling and recovery
- Configurable serialization
- Memory cache size limits
