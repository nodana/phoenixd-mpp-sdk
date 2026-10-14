# Development

## Local setup

Use Node.js 22.12 or later. Install dependencies and run the checks:

```sh
npm install
npm test
```

The adapter uses `@nodana/phoenixd-ts` from npm for both development and its public peer dependency. It requires version 0.2.0 or later within the 0.2 series.

The test command checks source and test types, runs the tests, builds all entry points, and checks ESM/CommonJS imports and TypeScript declarations as consumers. The integration test exercises the real Phoenixd HTTP client through an injected fetch implementation, including node authentication, form encoding, a missing payment response, and the MPP client's automatic paid retry. It uses mocked node responses; it does not verify real BOLT11 decoding, Lightning settlement or compatibility with a live daemon. Run a funded regtest integration before a production release.

### Redis integration tests

With `redis-server` and `redis-cli` available on your PATH, run:

```sh
npm run test:redis
```

This suite starts a disposable Redis instance on a Unix socket with TCP disabled. It checks concurrent issuance and consumption across independent clients, key expiry, namespace isolation, persistence across actual Redis restarts, and the paid HTTP flow across server instances. It uses a private temporary directory and never connects to an existing Redis service. The regular `npm test` does not require a Redis installation.

## Package roles

`phoenixd-ts` handles the node HTTP API. `mppx` supplies the MPP schemas, signed challenges, credentials, receipts and HTTP handler. This package implements the Lightning charge method between them. Server and payer exports are separate; each accepts a configured client instance.

The Lightning wire schema is adapted from the MIT-licensed Lightspark implementation. Attribution is in `NOTICE`. Node access, request binding, state storage and payment handling are implemented here.

## HTTP lifecycle

The adapter targets mppx 0.13.4's `preflight`, `validate` and `broadcast` hooks. Preflight captures the HTTP request and hashes its body without consuming the application's copy. The adapter supports the HTTP handler lifecycle; standalone credential validation and alternate transports do not supply the required request context and fail closed.

Invoices are created only when returning a challenge. The transport response hook fills the invoice details, caps expiry to the invoice, signs the completed challenge, and persists it before responding. It updates the framework's challenge and request objects in place so lifecycle events report the same signed challenge that went to the client. A successful credential retry does not create another invoice.

Validation compares the entire echoed challenge to its stored form, checks expiry and current price, binds it to the exact URL, HTTP method and body hash, and verifies the SHA-256 preimage proof. Broadcast validates again, then atomically consumes the challenge before returning a receipt. Replayed or invalid credentials receive a fresh challenge and invoice. Payment responses use `Cache-Control: no-store`.

Request bodies are buffered for hashing. Apply the application's normal request size limits before the payment handler. Application headers are not part of the stored request binding; keep authorisation and any header-dependent resource selection in the application's access checks.

The payer checks decoded invoice amount, hash, network and expiry before paying. Concurrent requests for the same invoice within one method instance share a payment promise. It checks outgoing history before sending; a settled payment reuses its verified proof and a pending payment fails closed. On an uncertain payment result, it checks history once and otherwise reports `payment_unknown`. It does not automatically send another payment. This coalescing is process-local; coordinate multiple payer processes separately.

A consumed credential is not a fulfilment record. If application work fails after acceptance, another request requires another payment. For operations needing recoverable fulfilment, record the purchased operation and expose an authenticated recovery endpoint in the application.

## Implement a charge store

Implement the exported `ChargeStore` interface when using a database or a distributed deployment:

- `issue(record)` persists an immutable record before the challenge response, rejecting duplicate IDs and payment hashes among retained records.
- `get(id)` returns the authoritative record or `undefined` for an unknown ID. Report storage failures by throwing.
- `consume(id)` atomically returns `true` once, only for an existing, unconsumed, unexpired record. Concurrent callers across processes must have exactly one winner. Throw on storage failure.

Store no payment preimages or node passwords. Enforce atomic uniqueness and consumption in the database itself. Retain records until expiry, including consumed records, so payment credentials cannot be replayed during their lifetime. Keep issuance and consumption reads consistent across instances.

`redisStore(client, { keyPrefix })` accepts the connected `node-redis` client through a structural `RedisClient` interface requiring `sendCommand(args)`. It does not add a Redis runtime dependency, open or close connections, or handle reconnects. The application owns the client's lifecycle. Default replies must be strings/numbers/null, as returned by node-redis without custom reply mappings.

Issuance uses a Lua script to check both challenge ID and payment hash uniqueness, then persist the record and hash reservation together. Consumption uses another script to check expiry and the consumed flag, then mark the challenge used in the same operation. Both scripts use Redis server time. Challenge records and hash reservations expire at the signed challenge's expiry; consuming a record preserves its expiry. No scheduled cleanup is needed.

The namespace is wrapped in a Redis hash tag so all script keys share a slot. Use the same `keyPrefix` for a service's instances and a different prefix for independent services. The client must support raw `EVAL` and `HGET` commands and connect to the primary; the SDK does not implement Redis Cluster routing or an HTTP Redis client. Redis ACLs must permit `EVAL` and the script's `TIME`, `EXISTS`, `HSET`, `HGET`, `SET` and `PEXPIREAT` commands on the namespace.

Use Redis persistence appropriate for payment state, with `noeviction`, sufficient capacity, and clocks synchronised between application hosts and Redis. Connection errors and unexpected replies fail closed. Lost state makes outstanding challenges unusable. Rolling back consumed state can permit reuse; persistence and replication/failover guarantees remain properties of the Redis deployment. Never reset or restore older payment state while its challenges remain valid.

`memoryStore({ maxEntries })` defaults to 10,000 entries. It prunes expired records on issuance and refuses further issuance when full rather than evicting active records. It is limited to one process and loses state at restart.

## Release

The only GitHub Actions workflow is `.github/workflows/npm-publish.yml`. It runs on pushed version tags (`v*.*.*`), checks the package version, runs the build and tests including Redis integration, and publishes through npm trusted publishing with provenance. Branch pushes and pull requests do not trigger Actions.

For the first release, publish `@nodana/phoenixd-ts` 0.2.0 first, run `npm install` here to update the lockfile, then authenticate with `npm login` and run `npm publish --access public`. The publish command runs `npm test` through `prepublishOnly`.

After the first publication, configure the package's npm trusted publisher for GitHub organisation `nodana`, repository `phoenixd-mpp-sdk`, workflow `npm-publish.yml`, no environment, with direct `npm publish` allowed.

For subsequent releases, update the package version and lockfile, commit and push, then create and push the matching version tag. For example, release 0.1.1 with:

```sh
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
```

Do not trigger the release workflow for a version already published manually: npm versions cannot be overwritten. Inspect `npm pack --dry-run` before releasing. The package includes declarations, JavaScript builds, source maps, README, licence and attribution.
