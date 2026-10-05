# Rate limiter: reading list and plan

## Reading list, in order

### 1. The algorithms

- [Stripe: Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters) — token bucket, the four kinds of limiters Stripe runs, and load shedding. The [companion gist](https://gist.github.com/ptarjan/e38f45f2dfe601419ca3af937fff574d) has their Redis code.
- [Figma: An alternative approach to rate limiting](https://www.figma.com/blog/an-alternative-approach-to-rate-limiting/) — why fixed windows and sliding logs fall short, and a cheaper middle ground.
- [Cloudflare: Counting things, a lot of different things](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) — the sliding window counter at scale; 0.003% error across 400 million requests.
- [Brandur: Rate Limiting, Cells, and GCRA](https://brandur.org/rate-limiting) — GCRA, as used by Stripe and Shopify: one timestamp per key. Pair with [GCRA: leaky buckets without the buckets](https://dotat.at/@/2024-08-30-gcra.html).

### 2. The overview

- [ByteByteGo: Design a Rate Limiter](https://bytebytego.com/courses/system-design-interview/design-a-rate-limiter) — the five common algorithms compared side by side.

### 3. Talking to clients over HTTP

- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) — `429 Too Many Requests` and `Retry-After`.
- [IETF draft: RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-09) — the emerging standard for telling clients their remaining quota.

### 4. Well-built examples

- [@upstash/ratelimit algorithm docs](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms) — a clean TypeScript interface with pluggable algorithms.
- [redis-cell](https://github.com/brandur/redis-cell) — GCRA as a single Redis command.

## Making it a tool, not a one-off

1. **A small, honest interface.** "May this key spend 1 unit right now?" returns allowed or denied, remaining quota, and reset time.
2. **Pluggable algorithms** behind that interface (token bucket, sliding window, GCRA), benchmarked against each other with the results in the README.
3. **Pluggable storage.** In-memory first, then Redis, where updates must be atomic so two servers sharing a limit don't race.
4. **Middleware** for a popular framework (Express or Hono), so adding it to an API is one line.
5. **Standard responses.** `429`, `Retry-After`, and the IETF `RateLimit` headers.
6. **Tests with a fake clock**, so timing tests run instantly and never flake.
7. **A live demo:** a small deployed API plus a load-test script that shows throttling.
8. **Published to npm.**

Steps 1, 2, and 6 with the in-memory store make a solid project; Redis and middleware make it something people would use.

## Where to start

Read Stripe and Figma, then write a token bucket in TypeScript with an in-memory store and fake-clock tests. The core design question to work out first: how does a token bucket refill without a background timer?
