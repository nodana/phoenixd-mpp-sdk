# Phoenixd MPP SDK

Create Lightning payment challenges and verify payment proofs using Phoenixd and the Machine Payments Protocol. The package supplies a receiving method for `mppx`; your application owns its database records and redemption decisions. Use Node.js 22.12 or later.

## Install

```sh
npm install @nodana/phoenixd-mpp-sdk @nodana/phoenixd-ts mppx
```

## Charge for a request

Configure `PHOENIXD_URL` and the restricted node password (`http-password-limited-access`) as `PHOENIXD_PASSWORD` in your backend. Generate an application signing secret with `openssl rand -hex 32` and save it as `MPP_SECRET_KEY`. Keep the same secret across instances and deployments.

This example uses application-owned database functions to save issued challenges and redeem them once:

```ts
import { Challenge, Errors } from "mppx";
import { Phoenixd } from "@nodana/phoenixd-ts";
import { Mppx, phoenixd } from "@nodana/phoenixd-mpp-sdk";
import { db } from "./database"; // Your application's database functions.

const node = new Phoenixd(
  process.env.PHOENIXD_URL!,
  process.env.PHOENIXD_PASSWORD!,
);
const lightning = phoenixd.charge({ client: node });
const payments = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    {
      ...lightning,
      async verify(context: Parameters<typeof lightning.verify>[0]) {
        const receipt = await lightning.verify(context);
        const challenge = context.credential.challenge;
        const accepted = await db.redeemChallengeOnce({
          id: challenge.id,
          challenge: Challenge.serialize(challenge),
          paymentHash: receipt.reference,
        });
        if (!accepted) throw new Errors.PaymentRequiredError();
        return receipt;
      },
    },
  ],
});

export async function handler(request: Request): Promise<Response> {
  const payment = await payments.charge({ amount: "100" })(request);
  if (payment.status === 402) {
    const challenge = Challenge.fromResponse(payment.challenge);
    await db.saveChallenge({
      id: challenge.id,
      challenge: Challenge.serialize(challenge),
      expiresAt: Date.parse(challenge.expires!),
    });
    return payment.challenge;
  }
  return payment.withReceipt(Response.json({ answer: "Your paid result" }));
}
```

Mount the handler at your paid endpoint. `amount: "100"` charges 100 sats. Run the protected operation only after payment verification and successful database redemption.

## Record and redeem payments

Implement `db.saveChallenge` and `db.redeemChallengeOnce` in your application; they are example names for your own database operations.

- Save the exact issued challenge and its expiry before returning the `402` response.
- When redeeming, compare the echoed challenge to the saved original and check that it is unexpired and unused.
- Atomically mark it used and record its payment hash with a uniqueness constraint. Concurrent requests must yield exactly one successful redemption.
- Return `false` for an unknown, expired, mismatched or used challenge. Throw on database errors and stop the request without serving the protected result.

The SDK verifies the signed challenge, request binding, current price, expiry and payment proof. Successful verification does not mean the application has accepted or recorded the payment. MPP Lightning charges require application-side challenge records and single-use redemption; configure these before serving paid requests.

Keep redemption records for at least the challenge lifetime. If the protected operation fails after redemption, handle recovery in your application. Verification and delivery are separate steps.

## Configure invoices and expiry

`phoenixd.charge` accepts a configured Phoenixd `client`, optional `invoiceExpirySeconds` (default 3600), and an optional expected `network` (`mainnet`, `regtest` or `signet`). Prices are positive integer strings in satoshis.

Set a shorter challenge deadline on the handler:

```ts
const payment = await payments.charge({
  amount: "100",
  expires: new Date(Date.now() + 60_000),
})(request);
```

The challenge expires no later than its invoice. A retry must use the same URL, HTTP method and body. Keep your application's normal authentication and permissions checks.

## Troubleshoot

Probe an endpoint without paying with `curl -i https://api.example.com/query`. Expect HTTP `402` and a `WWW-Authenticate: Payment` header.

- **Invoice creation fails:** check the node URL, restricted password, balance/node status and expected network. Handle `ChargeError` with code `invalid_invoice` as a service error.
- **Proof is rejected:** check the current price, challenge expiry, request URL, method and body, and that the application instances use the same signing secret.
- **A valid payment cannot be redeemed:** check the application's issued challenge and redemption records. A previously used payment cannot fund another request.

Use HTTPS and keep node credentials and payment preimages out of logs.

## Reference

- [Custom MPP methods](https://mpp.dev/payment-methods/custom)
- [Lightning charge draft](https://paymentauth.org/draft-lightning-charge-00.html)
- [Phoenixd HTTP API](https://phoenix.acinq.co/server/api)
- [Development](docs/development.md)
