# Tiered Cache

> A Typescript cache library supporting an in-memory and distributed layer at the same time

## Features

- In-memory and distributed tier caching
- Batch operations
- Soft expiry and strict timeouts
- Background updates on timeout


## Batch Get flow

The batch get flow is probably the most complex part of the cache.

Here's a detailed diagram of how it works:

```mermaid
flowchart LR
    %% ─────────── Nodes ───────────
    Input(["Keys[]"])

    subgraph Memory Cache
        PartMem["Get from Memory<br/>fresh · stale · miss"]
    end

    subgraph Distributed Cache
        PartDist["Get from Distributed<br/>fresh · stale · miss"]
        WriteMem["Background write<br/>to memory cache"]
    end

    subgraph factorySub["Factory"]
        SLock["Coalesce fetches"]
        Factory["Get from factory"]
        WriteBoth["Write to memory<br/>+ distributed cache"]
    end

    Merge["Merge into Batch"]
    Output([Batch])
    Error(["Timeout Error"])

    %% ─────────── Flow ───────────
    Input --> PartMem

    %% Memory-tier paths
    PartMem -- fresh --> Merge
    PartMem -- stale & miss --> PartDist

    %% Distributed-tier paths
    PartDist -- fresh --> Merge
    PartDist -. fresh .-> WriteMem
    PartDist -- MC stale (on soft timeout) --> Merge
    PartDist -- stale & miss --> SLock
    PartDist -- strict timeout --> Error


    %% Stampede protection and factory
    SLock --> Factory --> WriteBoth --> Merge
    Factory -- DC stale (on soft timeout) --> Merge
    Factory -- strict timeout --> Error


    %% Final output
    Merge --> Output
```

Dotted lines indicate background operations that do not block the main flow.
