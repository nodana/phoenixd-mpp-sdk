import { Errors } from "mppx";

export type ChargeErrorCode =
  | "unknown_challenge"
  | "invalid_challenge"
  | "invalid_preimage"
  | "invoice_expired"
  | "already_consumed"
  | "invalid_invoice"
  | "store_unavailable";

export class ChargeError extends Errors.PaymentError {
  readonly name = "ChargeError";
  readonly title = "Lightning payment rejected";
  readonly type: string;
  override readonly status: number;

  constructor(
    public readonly code: ChargeErrorCode,
    message: string,
  ) {
    super(message);

    const problem =
      code === "store_unavailable" || code === "invalid_invoice"
        ? "internal-payment-error"
        : code === "invoice_expired"
          ? "payment-expired"
          : code === "invalid_preimage" || code === "already_consumed"
            ? "verification-failed"
            : "invalid-challenge";

    this.type = `https://paymentauth.org/problems/${problem}`;
    this.status =
      code === "store_unavailable"
        ? 503
        : code === "invalid_invoice"
          ? 502
          : 402;
  }
}

export type ClientErrorCode =
  "invalid_invoice" | "amount_limit" | "payment_failed" | "payment_unknown";

export class PhoenixdPaymentError extends Error {
  readonly name = "PhoenixdPaymentError";

  constructor(
    public readonly code: ClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}
