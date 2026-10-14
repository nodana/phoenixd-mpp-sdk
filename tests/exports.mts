import { Phoenixd } from "@nodana/phoenixd-ts";
import {
  Mppx,
  phoenixd,
  redisStore,
  type ChargeStore,
  type RedisClient,
} from "@nodana/phoenixd-mpp-sdk/server";
import {
  Mppx as Client,
  phoenixd as payer,
} from "@nodana/phoenixd-mpp-sdk/client";
import { Methods, type ChargeRequest } from "@nodana/phoenixd-mpp-sdk";

const node = new Phoenixd("https://node.example.test", "password");

declare const redis: RedisClient;

const store: ChargeStore = redisStore(redis);

const server = Mppx.create({
  methods: [phoenixd.charge({ client: node, store })],
  secretKey: "a".repeat(64),
});

server.charge({ amount: "100" })(new Request("https://api.example.test/paid"));

Client.create({
  methods: [payer.charge({ client: node, maxAmountSat: 100 })],
  polyfill: false,
}).fetch("https://api.example.test/paid");

const request: ChargeRequest = {
  amount: "100",
  currency: "sat",
  methodDetails: { invoice: "lnbc..." },
};

Methods.charge.schema.request.parse(request);

// @ts-expect-error A payment amount is required.
server.charge({});

// @ts-expect-error A payer must configure its payment cap.
payer.charge({ client: node });

// @ts-expect-error Prices must use integer strings.
server.charge({ amount: 100 });
