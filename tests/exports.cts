import Server = require("@nodana/phoenixd-mpp-sdk/server");
import Client = require("@nodana/phoenixd-mpp-sdk/client");
import Shared = require("@nodana/phoenixd-mpp-sdk");
import Core = require("@nodana/phoenixd-ts");

const node = new Core.Phoenixd("https://node.example.test", "password");

Server.Mppx.create({
  methods: [
    Server.phoenixd.charge({ client: node, store: Server.memoryStore() }),
  ],
  secretKey: "a".repeat(64),
}).charge({ amount: "100" });

Client.Mppx.create({
  methods: [Client.phoenixd.charge({ client: node, maxAmountSat: 100 })],
  polyfill: false,
});

Shared.Methods.charge.schema.credential.payload.parse({
  preimage: "0".repeat(64),
});
