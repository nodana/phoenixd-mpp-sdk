# Phoenixd MPP SDK

Accept or send Lightning payments for API requests using the Machine Payments Protocol (MPP) and a Phoenixd node. This package supplies the Phoenixd payment method for `mppx`; `@nodana/phoenixd-ts` connects it to your node.

Use Node.js 22.12 or later. The package provides TypeScript declarations and ESM and CommonJS exports.

## Install

Install the adapter and its dependencies:

```sh
npm install @nodana/phoenixd-mpp-sdk @nodana/phoenixd-ts mppx
```

## Accept payment for a request

Configure `PHOENIXD_URL`, `PHOENIXD_PASSWORD` and `MPP_SECRET_KEY` in your service's environment. Use your node's HTTPS endpoint and set `PHOENIXD_PASSWORD` to its restricted password (`http-password-limited-access`). The receiving adapter only creates and decodes invoices; it does not need permission to send payments. Generate a signing secret with `openssl rand -hex 32` and save it in your service's secret configuration. Keep the same secret across instances and restarts.

```ts
import { Phoenixd } from "@nodana/phoenixd-ts";
import { Mppx, phoenixd } from "@nodana/phoenixd-mpp-sdk/server";

const node = new Phoenixd(
  process.env.PHOENIXD_URL!,
  process.env.PHOENIXD_PASSWORD!,
  { timeoutMs: 15_000 },
);
const payments = Mppx.create({
  methods: [phoenixd.charge({ client: node })],
  secretKey: process.env.MPP_SECRET_KEY!,
});

export async function handler(request: Request): Promise<Response> {
  const payment = await payments.charge({
    amount: "100",
    description: "Paid API query",
  })(request);

  if (payment.status === 402) return payment.challenge;

  // Run your query or tool only after payment is accepted.
  return payment.withReceipt(Response.json({ answer: "Your paid result" }));
}
```

Mount the handler at your paid endpoint. `amount: '100'` charges 100 satoshis. An unpaid request receives a payment challenge; a paid request receives your result and a receipt.

## Choose payment storage

The adapter uses in-memory storage by default, suitable for development. For deployed services, use Redis so every server instance shares payment state. The adapter handles the checks; you supply a connected Redis client.

Install the Redis client if your application does not already use it:

```sh
npm install redis
```

```ts
import { createClient } from "redis";
import { redisStore } from "@nodana/phoenixd-mpp-sdk/server";

const redis = createClient({ url: process.env.REDIS_URL! });
redis.on("error", () => console.error("Redis connection error"));
await redis.connect();

const payments = Mppx.create({
  methods: [phoenixd.charge({ client: node, store: redisStore(redis) })],
  secretKey: process.env.MPP_SECRET_KEY!,
});
```

Reuse your existing connected client if you have one. Use the same persistent Redis service and signing secret across your server instances. Expired payment records are removed automatically.

If several services share Redis, choose a namespace with `redisStore(redis, { keyPrefix: 'my-api' })` and use it consistently across that service's instances.

## Pay for a request

Run the payer in a backend or a trusted Node.js application with its own funded Phoenixd node. Set its `PHOENIXD_PASSWORD` to the full-access password (`http-password`), since paying invoices requires spending permission. `maxAmountSat` is required and limits the invoice amount for each challenge; routing fees are additional.

```ts
import { Phoenixd } from "@nodana/phoenixd-ts";
import { Mppx, phoenixd } from "@nodana/phoenixd-mpp-sdk/client";

const node = new Phoenixd(
  process.env.PHOENIXD_URL!,
  process.env.PHOENIXD_PASSWORD!,
  { timeoutMs: 15_000 },
);
const payments = Mppx.create({
  methods: [phoenixd.charge({ client: node, maxAmountSat: 100 })],
  polyfill: false,
});

const response = await payments.fetch("https://api.example.com/query");
if (!response.ok) throw new Error(`API request failed: ${response.status}`);
console.log(await response.json());
```

`payments.fetch` pays a supported challenge within the limit and retries the request. Choose a limit appropriate for the API you are calling. Keep Phoenixd credentials in your backend; they allow spending from the node. Use HTTPS for paid endpoints.

## Configure a charge

| Option                 | Server                                                                 | Client                                                         |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `client`               | Configured Phoenixd client for creating and decoding invoices          | Configured client for decoding, paying and looking up payments |
| `store`                | `redisStore(redis)` for shared state; defaults to process-local memory | —                                                              |
| `invoiceExpirySeconds` | Invoice lifetime; defaults to 3600 seconds                             | —                                                              |
| `network`              | Optional expected invoice network                                      | Expected network; defaults to `mainnet`                        |
| `maxAmountSat`         | —                                                                      | Required maximum invoice amount per challenge                  |

Set the challenge expiry on the handler when needed:

```ts
const payment = await payments.charge({
  amount: "100",
  expires: new Date(Date.now() + 60_000),
})(request);
```

The challenge expires no later than its invoice. Use `network: 'regtest'` on both payment methods when testing with regtest nodes.

## Troubleshoot

Probe an endpoint without paying:

```sh
curl -i https://api.example.com/query
```

Expect HTTP `402` and a `WWW-Authenticate: Payment` header. Server failures creating invoices or accessing storage must be caught by your application's error handling; respond with a service error and keep the paid result behind the payment check.

Client errors expose a `code` through `PhoenixdPaymentError`, exported from the client entry point:

| Code              | Action                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `amount_limit`    | Check the endpoint's price and your configured limit.                               |
| `invalid_invoice` | Check the invoice amount, expiry and network. Request a fresh challenge if expired. |
| `payment_failed`  | Check your node balance and outgoing payment history.                               |
| `payment_unknown` | Check outgoing payment history before trying again; the payment may have succeeded. |

If a paid request is rejected, check that you retried the same URL, method and body before expiry. A credential authorises one request. Check that all server instances use the same signing secret and storage.

## Reference

- [MPP overview](https://mpp.dev/overview)
- [mppx SDK](https://mpp.dev/sdk/typescript)
- [Phoenixd HTTP API](https://phoenix.acinq.co/server/api)
- [Development and storage integration](docs/development.md)
