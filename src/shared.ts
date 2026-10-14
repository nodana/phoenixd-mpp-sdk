import { createHash } from "node:crypto";
import type { DecodedInvoice } from "@nodana/phoenixd-ts";
import type { ChargeRequest, LightningNetwork } from "./Methods";

export function satoshis(amount: string): number {
  if (!/^[1-9][0-9]*$/.test(amount))
    throw new TypeError("amount must be a positive integer string in satoshis");

  const value = Number(amount);

  if (!Number.isSafeInteger(value * 1000))
    throw new TypeError(
      "amount exceeds the safely representable millisatoshi range",
    );

  return value;
}

export function paymentHash(preimage: string): string {
  if (!/^[0-9a-f]{64}$/.test(preimage))
    throw new TypeError("Invalid payment preimage");

  return createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
}

export function invoiceDetails(
  invoice: DecodedInvoice,
  request: Pick<ChargeRequest, "amount" | "currency">,
  expected?: LightningNetwork,
): { paymentHash: string; network: LightningNetwork; expiresAt: number } {
  if (
    request.currency !== "sat" ||
    invoice.amount !== satoshis(request.amount) * 1000
  )
    throw new TypeError("Invoice amount does not match the requested satoshis");

  if (!/^[0-9a-f]{64}$/.test(invoice.paymentHash))
    throw new TypeError("Invoice has an invalid payment hash");

  const network = invoice.chain;

  if (network !== "mainnet" && network !== "regtest" && network !== "signet")
    throw new TypeError("Invoice uses an unsupported Lightning network");

  if (expected !== undefined && network !== expected)
    throw new TypeError(
      "Invoice network does not match the configured network",
    );

  const expiresAt =
    (invoice.timestampSeconds + (invoice.expirySeconds ?? 3600)) * 1000;

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
    throw new TypeError("Invoice is expired or has an invalid expiry");

  return { paymentHash: invoice.paymentHash, network, expiresAt };
}

export async function bodyHash(request: Request): Promise<string> {
  // Clone preserves the body for the application handler.
  return createHash("sha256")
    .update(Buffer.from(await request.clone().arrayBuffer()))
    .digest("hex");
}
