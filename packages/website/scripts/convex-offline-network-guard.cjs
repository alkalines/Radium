"use strict";

const blocked = (name) => {
  throw new Error(`Unexpected network access through ${name}`);
};

global.fetch = () => blocked("fetch");

for (const moduleName of [
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:dns",
  "node:dns/promises",
]) {
  const module = require(moduleName);
  for (const name of [
    "connect",
    "createConnection",
    "request",
    "get",
    "lookup",
    "resolve",
    "resolve4",
    "resolve6",
  ]) {
    if (typeof module[name] === "function") module[name] = () => blocked(`${moduleName}.${name}`);
  }
}
