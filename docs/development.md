# Development

## Checks

Use Node.js 22.12 or later. Run `npm ci` followed by `npm test`. Tests cover the real mppx HTTP lifecycle, request and proof validation, invoice reuse on paid retries, expiration, application-owned recording/redemption, ESM/CommonJS builds and consumer declarations. Node responses and settlement are mocked; a funded regtest test with a separate client is still needed before production release.

## MPP extension

`Method.from` defines the Lightning schema; `Method.toServer` supplies the receiving method. The `request` hook creates and validates an invoice on an unpaid call, and reuses the echoed invoice on a credential submission. Dynamic invoice fields, expiry and request binding live under `methodDetails`.

The HTTP transport caps the signed challenge expiry to the invoice and creates fresh invoices for rejected credentials. `verify` checks framework-authenticated challenge provenance, original signed fields, current price, request binding, network, expiry and SHA-256 preimage proof. Invalid proofs throw `ChargeError`. Receipts use the payment hash as their public reference, never the preimage. mppx owns the standard challenge and receipt response handling.

The two WeakMaps carry only transient invocation metadata between mppx hooks. They do not retain issued challenges, paid invoices, redemption records or cross-request usage state. There are no persistence interfaces or adapters. `mppx` is a peer dependency; the node HTTP client is `@nodana/phoenixd-ts`.

Amounts are integer satoshi strings parsed with BigInt. Conversion to the Phoenixd API's numeric representation occurs only after an exact millisatoshi-range bound check. No floating-point monetary calculations or fractional amounts are accepted.

## Application responsibilities

The current Lightning charge draft requires saving issued challenges and comparing the presented credential to the original, then atomically consuming the challenge before granting access. The SDK's cryptographic verification is one part of that service; it does not perform redemption.

The README shows wrapping the returned method's `verify` function with the application's own redemption transaction, and saving the exact final challenge before returning its response. A database error must stop the request. Ensure unique payment hashes and challenge IDs, match the full original challenge, and retain used records through expiry. The example database functions belong to the application; no SDK storage API is required.

Do not use mppx lifecycle events as an authorization or persistence gate: its event dispatcher deliberately isolates handler errors. Record issued challenges explicitly before returning a 402, and perform redemption in the application's awaited verification path.

Body hashing buffers a clone of each request. Apply request-size limits before the handler. URL, method and body are bound to the challenge; application headers are not. Enforce authentication and any header-dependent access separately. The SDK supports the HTTP lifecycle; standalone verification without request context is rejected.

Delivery may fail after redemption; handle fulfilment recovery in the application. Never log payment preimages or node passwords. The wire schema attribution remains in NOTICE.

## Release

Publishing a GitHub Release triggers `.github/workflows/npm-publish.yml`. Pushes to branches or tags, pull requests, draft releases and release-note edits do not trigger publication.

1. Update the version in `package.json` and `package-lock.json`, for example with `npm version patch --no-git-tag-version`.
2. Commit and push the version change and release code to `main`.
3. In GitHub, open **Releases → Draft a new release**. Create a tag matching the package version exactly, such as `v0.2.0`, targeting the release commit on `main`.
4. Add the release title and notes, then click **Publish release**.
5. Check the **Publish to npm** workflow. It validates the release tag and both manifest versions, installs dependencies, runs the checks, and publishes the tagged code to npm with provenance. Its summary reports whether publication succeeded.

The npm trusted publisher must point to organisation `nodana`, repository `phoenixd-mpp-sdk`, workflow `npm-publish.yml`, with no environment and direct publishing allowed. The source repository must be public for npm provenance. Stable releases publish to the `latest` npm dist-tag; GitHub prereleases publish to `next`.

The workflow checks and builds before publishing, then uses `--ignore-scripts` to avoid running `prepublishOnly` a second time. Manual `npm publish` still runs the full test/build hook. Test results remain in the logs; the Actions summary reports the release outcome.

npm versions cannot be overwritten. If a release fails before publication, fix the cause before retrying. For versions already on npm, create a GitHub Release from the tag matching their original source commit rather than publishing the package again.

When retrying an unpublished version after changing the workflow or code, its tag must include those fixes. Commit and push the fixes first, then replace the failed tag before creating the GitHub Release. Do not move a tag for a version already published to npm.
