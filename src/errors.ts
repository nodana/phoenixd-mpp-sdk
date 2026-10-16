import { Errors } from "mppx";
export type ChargeErrorCode =
  | "invalid_challenge"
  | "invalid_preimage"
  | "invoice_expired"
  | "invalid_invoice";
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
    this.type = `https://paymentauth.org/problems/${code === "invalid_invoice" ? "internal-payment-error" : code === "invoice_expired" ? "payment-expired" : code === "invalid_preimage" ? "verification-failed" : "invalid-challenge"}`;
    this.status = code === "invalid_invoice" ? 502 : 402;
  }
}
