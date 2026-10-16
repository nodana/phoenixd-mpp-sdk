import { Mppx, phoenixd, type ChargeOptions } from "@nodana/phoenixd-mpp-sdk";
import { Phoenixd } from "@nodana/phoenixd-ts";
const options: ChargeOptions = {
  client: new Phoenixd("https://node.example.test", "password"),
};
const base = phoenixd.charge(options);
const payments = Mppx.create({
  methods: [
    {
      ...base,
      async verify(context: Parameters<typeof base.verify>[0]) {
        return base.verify(context);
      },
    },
  ],
  secretKey: "a".repeat(64),
});
payments.charge({ amount: "100" })(new Request("https://api.example.test"));
// @ts-expect-error Prices use integer strings.
payments.charge({ amount: 100 });
