import SDK = require("@nodana/phoenixd-mpp-sdk");
import Core = require("@nodana/phoenixd-ts");
SDK.Mppx.create({
  methods: [
    SDK.phoenixd.charge({
      client: new Core.Phoenixd("https://node.example.test", "password"),
    }),
  ],
  secretKey: "a".repeat(64),
}).charge({ amount: "100" });
