import { Credential, Method } from "mppx";
import type { PhoenixdClient, PaymentResult } from "@nodana/phoenixd-ts";
import * as Methods from "../Methods";
import { PhoenixdPaymentError } from "../errors";
import { invoiceDetails, paymentHash } from "../shared";

export interface ChargeOptions {
  client: Pick<
    PhoenixdClient,
    "decodeInvoice" | "payInvoice" | "getOutgoingPaymentByHash"
  >;
  /** Maximum payment amount per challenge, in satoshis. */
  maxAmountSat: number;
  /** Expected invoice network. Defaults to mainnet. */
  network?: Methods.LightningNetwork;
}

export type ClientChargeMethod = Method.Client<typeof Methods.charge>;

export function charge({
  client,
  maxAmountSat,
  network = "mainnet",
}: ChargeOptions): ClientChargeMethod {
  if (!Number.isSafeInteger(maxAmountSat) || maxAmountSat < 1)
    throw new TypeError("maxAmountSat must be a positive integer");

  const pending = new Map<string, Promise<string>>();

  const verifiedProof = (preimage: string, hash: string) => {
    let actual: string;

    try {
      actual = paymentHash(preimage);
    } catch {
      throw new PhoenixdPaymentError(
        "payment_unknown",
        "Phoenixd returned an invalid payment proof",
      );
    }

    if (actual !== hash)
      throw new PhoenixdPaymentError(
        "payment_unknown",
        "Phoenixd returned a payment proof that does not match the invoice",
      );

    return preimage;
  };

  async function pay(invoice: string, hash: string): Promise<string> {
    // Check history before sending, including after a previous uncertain result.
    const existing = await client.getOutgoingPaymentByHash(hash);

    if (existing?.isPaid) {
      if (!existing.preimage)
        throw new PhoenixdPaymentError(
          "payment_unknown",
          "The invoice is paid but its proof is unavailable; check outgoing payment history",
        );

      return verifiedProof(existing.preimage, hash);
    }

    if (existing && existing.completedAt == null)
      throw new PhoenixdPaymentError(
        "payment_unknown",
        "A payment for this invoice is already pending; check outgoing payment history",
      );

    let result: PaymentResult;

    try {
      result = await client.payInvoice({ invoice });
    } catch {
      try {
        const payment = await client.getOutgoingPaymentByHash(hash);

        if (payment?.isPaid && payment.preimage)
          return verifiedProof(payment.preimage, hash);
      } catch {
        /* The payment outcome remains unknown. */
      }

      throw new PhoenixdPaymentError(
        "payment_unknown",
        "The payment outcome is unknown; check outgoing payment history before retrying",
      );
    }

    if (result.type === "payment_failed")
      throw new PhoenixdPaymentError(
        "payment_failed",
        "Phoenixd rejected the payment",
      );

    if (result.paymentHash !== hash)
      throw new PhoenixdPaymentError(
        "payment_unknown",
        "Phoenixd returned a different payment hash",
      );

    return verifiedProof(result.paymentPreimage, hash);
  }

  return Method.toClient(Methods.charge, {
    async createCredential({ challenge }) {
      const request = Methods.charge.schema.request.parse(challenge.request);
      let details: ReturnType<typeof invoiceDetails>;

      try {
        details = invoiceDetails(
          await client.decodeInvoice({
            invoice: request.methodDetails.invoice,
          }),
          request,
          network,
        );

        if (
          request.methodDetails.paymentHash !== undefined &&
          request.methodDetails.paymentHash !== details.paymentHash
        )
          throw new TypeError("Challenge payment hash does not match invoice");

        if (
          request.methodDetails.network !== undefined &&
          request.methodDetails.network !== details.network
        )
          throw new TypeError("Challenge network does not match invoice");

        if (
          challenge.expires !== undefined &&
          Date.parse(challenge.expires) <= Date.now()
        )
          throw new TypeError("The challenge is expired");
      } catch {
        throw new PhoenixdPaymentError(
          "invalid_invoice",
          "The challenge contains an invalid, expired or mismatched invoice",
        );
      }

      if (Number(request.amount) > maxAmountSat)
        throw new PhoenixdPaymentError(
          "amount_limit",
          "The requested payment exceeds maxAmountSat",
        );

      let promise = pending.get(details.paymentHash);

      if (!promise) {
        promise = pay(request.methodDetails.invoice, details.paymentHash);
        pending.set(details.paymentHash, promise);
      }

      let preimage: string;

      try {
        preimage = await promise;
      } finally {
        if (pending.get(details.paymentHash) === promise)
          pending.delete(details.paymentHash);
      }

      return Credential.serialize({ challenge, payload: { preimage } });
    },
  });
}
