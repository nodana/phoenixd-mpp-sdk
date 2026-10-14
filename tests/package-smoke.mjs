import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Methods } from "@nodana/phoenixd-mpp-sdk";
import {
  Mppx as Server,
  phoenixd as receiver,
  memoryStore,
  redisStore,
} from "@nodana/phoenixd-mpp-sdk/server";
import {
  Mppx as Client,
  phoenixd as payer,
} from "@nodana/phoenixd-mpp-sdk/client";

const require = createRequire(import.meta.url);

for (const suffix of ["", "/server", "/client"]) {
  const cjs = require(`@nodana/phoenixd-mpp-sdk${suffix}`);

  assert.ok(suffix ? cjs.Mppx && cjs.phoenixd.charge : cjs.Methods.charge);
}

assert.equal(Methods.charge.name, "lightning");

assert.equal(typeof receiver.charge, "function");

assert.equal(typeof redisStore, "function");

assert.equal("fileStore" in require("@nodana/phoenixd-mpp-sdk/server"), false);

assert.equal(typeof payer.charge, "function");

assert.equal(typeof Server.create, "function");

assert.equal(typeof Client.create, "function");

assert.equal(await memoryStore().consume("unknown"), false);

const result = spawnSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "tests/exports.mts",
    "tests/exports.cts",
  ],
  { stdio: "inherit" },
);

assert.equal(
  result.status,
  0,
  "Published declarations must work for ESM and CommonJS consumers",
);

console.log(
  "Package exports and consumer declarations passed (ESM + CommonJS).",
);
