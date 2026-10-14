import { Challenge, Method, Receipt } from "mppx";
import { Transport } from "mppx/server";
import type { PhoenixdClient } from "@nodana/phoenixd-ts";
import * as Methods from "../Methods";
import { ChargeError } from "../errors";
import { bodyHash, invoiceDetails, paymentHash, satoshis } from "../shared";
import { memoryStore } from "./store";
import type { ChargeStore, StoredCharge } from "./store";

export interface ChargeOptions {
  client: Pick<PhoenixdClient, "createInvoice" | "decodeInvoice">;
  /** Use a shared durable store for deployed services. Defaults to process-local memory. */
  store?: ChargeStore;
  /** Invoice lifetime in seconds. Defaults to 3600; challenge expiry is capped to it. */
  invoiceExpirySeconds?: number;
  network?: Methods.LightningNetwork;
}

const defaults = { currency: "sat", methodDetails: { invoice: "" } } as const;

export type ServerChargeMethod = Method.Server<
  typeof Methods.charge,
  typeof defaults,
  Transport.Http
>;

interface HttpContext {
  input: Request;
  secretKey: string;
  bodyHash: string;
}

export function charge(options: ChargeOptions): ServerChargeMethod {
  const {
    client,
    store = memoryStore(),
    network,
    invoiceExpirySeconds = 3600,
  } = options;

  if (!Number.isSafeInteger(invoiceExpirySeconds) || invoiceExpirySeconds < 1)
    throw new TypeError("invoiceExpirySeconds must be a positive integer");

  const byInput = new WeakMap<Request, HttpContext>();
  const byCaptured = new WeakMap<Method.CapturedRequest, HttpContext>();
  const http = Transport.http();

  const transport: Transport.Http = {
    ...http,

    async respondChallenge(parameters) {
      const context = byInput.get(parameters.input);

      if (!context)
        throw new ChargeError(
          "invalid_challenge",
          "An HTTP payment handler is required",
        );

      const original = parameters.challenge;
      const request = Methods.charge.schema.request.parse(original.request);
      const amountSat = satoshis(request.amount);
      let details: ReturnType<typeof invoiceDetails>;
      let serialized: string;

      try {
        const invoice = await client.createInvoice({
          amountSat,
          description: original.description ?? request.description ?? "",
          expirySeconds: invoiceExpirySeconds,
        });

        serialized = invoice.serialized;
        details = invoiceDetails(
          await client.decodeInvoice({ invoice: serialized }),
          request,
          network,
        );

        if (
          invoice.paymentHash !== details.paymentHash ||
          invoice.amountSat !== amountSat
        )
          throw new TypeError(
            "Generated invoice does not match the node response",
          );
      } catch {
        throw new ChargeError(
          "invalid_invoice",
          "Phoenixd could not provide a matching, unexpired invoice",
        );
      }

      const requestedExpiry =
        original.expires === undefined
          ? Date.now() + 300_000
          : Date.parse(original.expires);
      const expiresAt = Math.min(requestedExpiry, details.expiresAt);

      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new ChargeError(
          "invoice_expired",
          "The configured challenge expiry is in the past",
        );

      const issuedRequest = {
        ...request,
        methodDetails: {
          invoice: serialized,
          paymentHash: details.paymentHash,
          network: details.network,
        },
      };
      const issued = Challenge.from({
        secretKey: context.secretKey,
        realm: original.realm,
        method: "lightning",
        intent: "charge",
        request: issuedRequest,
        expires: new Date(expiresAt),
        ...(original.description === undefined
          ? {}
          : { description: original.description }),
        ...(original.opaque === undefined ? {} : { opaque: original.opaque }),
        ...(original.digest === undefined ? {} : { digest: original.digest }),
        ...(original.header === undefined ? {} : { header: original.header }),
      });

      // Enrich the framework's challenge in place so its lifecycle event sees
      // the same issued ID/request as the HTTP response. No invoice is created
      // on a successful credential retry; only challenge responses need one.
      Object.assign(original.request, issuedRequest);
      Object.assign(original, issued, { request: original.request });

      const record: StoredCharge = {
        id: original.id,
        serializedChallenge: Challenge.serialize(original),
        paymentHash: details.paymentHash,
        amountSat,
        expiresAt,
        requestUrl: parameters.input.url,
        requestMethod: parameters.input.method,
        bodyHash: context.bodyHash,
      };

      try {
        await store.issue(record);
      } catch {
        throw new ChargeError(
          "store_unavailable",
          "Could not persist the payment challenge",
        );
      }

      // Rejected credentials always receive a fresh invoice/challenge. Neither
      // malformed payloads nor a consumed preimage can trigger reuse.
      return http.respondChallenge({
        ...parameters,
        error: parameters.error,
        challenge: original,
      });
    },

    respondReceipt(parameters) {
      const response = http.respondReceipt(parameters);

      response.headers.set("Cache-Control", "no-store");

      return response;
    },
  };

  async function validate(
    parameters: Method.VerifyContext<typeof Methods.charge>,
  ): Promise<StoredCharge> {
    const { credential, envelope, request } = parameters;
    const context =
      envelope === undefined
        ? undefined
        : byCaptured.get(envelope.capturedRequest);

    if (!context)
      throw new ChargeError(
        "invalid_challenge",
        "Use the configured HTTP payment handler",
      );

    let record: StoredCharge | undefined;

    try {
      record = await store.get(credential.challenge.id);
    } catch {
      throw new ChargeError(
        "store_unavailable",
        "Could not read the payment challenge",
      );
    }

    if (!record)
      throw new ChargeError(
        "unknown_challenge",
        "The payment challenge is unknown",
      );

    if (Date.now() >= record.expiresAt)
      throw new ChargeError(
        "invoice_expired",
        "The payment challenge has expired",
      );

    if (
      record.serializedChallenge !==
        Challenge.serialize(credential.challenge) ||
      record.amountSat !== satoshis(request.amount) ||
      request.currency !== "sat"
    ) {
      throw new ChargeError(
        "invalid_challenge",
        "The credential does not match the issued payment challenge",
      );
    }

    if (
      record.requestUrl !== context.input.url ||
      record.requestMethod !== context.input.method ||
      record.bodyHash !== context.bodyHash
    ) {
      throw new ChargeError(
        "invalid_challenge",
        "The credential does not match this request",
      );
    }

    let hash: string;

    try {
      hash = paymentHash(credential.payload.preimage);
    } catch {
      throw new ChargeError("invalid_preimage", "The payment proof is invalid");
    }

    if (hash !== record.paymentHash)
      throw new ChargeError("invalid_preimage", "The payment proof is invalid");

    return record;
  }

  return Method.toServer(Methods.charge, {
    defaults,
    transport,

    async preflight({ capturedRequest, input, secretKey }) {
      const context: HttpContext = {
        input,
        secretKey,
        bodyHash: await bodyHash(input),
      };

      byInput.set(input, context);

      if (capturedRequest) byCaptured.set(capturedRequest, context);

      return undefined;
    },

    stableBinding: (request) => ({
      amount: request.amount,
      currency: request.currency,
    }),

    async validate(parameters) {
      await validate(parameters);

      return {
        challenge: parameters.credential.challenge,
        credential: parameters.credential,
        details: {},
        intent: "charge",
        method: "lightning",
        request: parameters.credential.challenge.request,
      };
    },

    async broadcast(parameters) {
      const record = await validate(parameters);
      let consumed: boolean;

      try {
        consumed = await store.consume(record.id);
      } catch {
        throw new ChargeError(
          "store_unavailable",
          "Could not consume the payment challenge",
        );
      }

      if (!consumed)
        throw new ChargeError(
          "already_consumed",
          "The payment challenge has already been used or expired",
        );

      return Receipt.from({
        method: "lightning",
        reference: record.paymentHash,
        status: "success",
        timestamp: new Date().toISOString(),
      });
    },
  });
}
