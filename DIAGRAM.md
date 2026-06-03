# noviq — Application Flow

Visual reference for how noviq is wired together. Two entry points (CLI and
HTTP API) feed the same scraping core; the core hides each store behind a single
`StoreAdapter` interface and drives a humanized cloakbrowser session.

## 1. System architecture

```mermaid
flowchart TD
  subgraph Entrypoints
    CLI["CLI<br/>src/cli.ts"]
    API["HTTP API (Elysia)<br/>src/api/index.ts"]
  end

  subgraph Core["Scraping core"]
    Dispatch["streamReviews / getReviews<br/>src/scrape.ts"]
    Engine["runScraper engine<br/>src/engine.ts"]
    Browser["cloakbrowser session<br/>src/browser.ts"]
    subgraph Adapters["StoreAdapter implementations"]
      Apple["appleAdapter<br/>amp-api proxy · offset paging"]
      Google["googleAdapter<br/>batchexecute · token paging"]
    end
  end

  subgraph Output
    Stream["AsyncGenerator&lt;Review&gt;"]
    CSV["CSV / JSON sinks<br/>src/output.ts"]
  end

  Stores[("App Store /<br/>Google Play")]

  CLI --> Dispatch
  API --> Dispatch
  Dispatch -->|"infer store"| Engine
  Engine --> Apple
  Engine --> Google
  Apple --> Browser
  Google --> Browser
  Browser -->|"in-page fetch"| Stores
  Engine --> Stream
  Stream --> CSV
  Stream --> API
```

## 2. API request lifecycle

Cross-cutting concerns are global Elysia plugins; the controller stays thin and
delegates to the service.

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant SH as securityHeaders<br/>(onRequest)
  participant BL as bodyLimit<br/>(onRequest)
  participant V as Query validation<br/>(reviews.query model)
  participant C as reviews controller
  participant S as ReviewService
  participant Core as scraping core
  participant EH as errorHandler<br/>(onError)

  Client->>SH: GET /reviews?appId=...
  SH->>SH: set CSP + hardening headers
  SH->>BL: continue
  BL->>BL: Content-Length ≤ 10MB?
  alt too large
    BL-->>Client: 413 Payload Too Large
  else ok
    BL->>V: continue
    V->>V: validate query
    alt invalid
      V-->>Client: 422 (+ security headers)
    else valid
      V->>C: handler({ query })
      C->>S: ReviewService.scrape(query)
      S->>Core: getReviews(opts)
      Core-->>S: Review[]
      S-->>C: { store, appId, country, count, reviews }
      C-->>Client: 200 JSON (+ Server-Timing)
    end
  end
  Note over EH: any thrown error → 404 / 500 JSON envelope
```

## 3. Scraping engine loop

`runScraper` is store-agnostic: it manages the session, de-duplication,
`limit`/`since` cutoffs, jittered delays and 429 backoff. Each adapter only
implements `landingUrl`, `initialCursor` and `fetchBatch`.

```mermaid
flowchart TD
  Start(["streamReviews(opts)"]) --> Open["openSession()<br/>launch cloakbrowser · navigate landing page"]
  Open --> Fetch["adapter.fetchBatch(page, opts, cursor)"]
  Fetch --> Status{HTTP status}
  Status -->|429| Backoff["sleep(base × attempt)"] --> Fetch
  Status -->|404 / empty| Close
  Status -->|200| Norm["normalize → Review[]"]
  Norm --> Loop{"for each review"}
  Loop -->|"seen id?"| Loop
  Loop -->|"date < since?"| Close
  Loop -->|new| Yield["yield review · onReview()"]
  Yield --> Limit{"collected ≥ limit?"}
  Limit -->|yes| Close
  Limit -->|no| Loop
  Loop -->|"page done"| Dry{"all duplicates<br/>2 pages running?"}
  Dry -->|yes| Close
  Dry -->|"next cursor null"| Close
  Dry -->|"has next"| Jitter["jitter(pageDelay)"] --> Fetch
  Close(["session.close()"]) --> End(["done"])
```

## 4. StoreAdapter abstraction

Adding a store is one new adapter — no engine changes.

```mermaid
classDiagram
  class StoreAdapter~C~ {
    +store: Store
    +initialCursor: C
    +landingUrl(opts) string
    +fetchBatch(page, opts, cursor) FetchResult~C~
  }
  class appleAdapter {
    cursor = number (offset)
  }
  class googleAdapter {
    cursor = { token }
  }
  class runScraper {
    +manages session, dedup, limit, since, backoff
  }
  StoreAdapter <|.. appleAdapter
  StoreAdapter <|.. googleAdapter
  runScraper ..> StoreAdapter : drives
```
