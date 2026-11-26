import { defineConfig } from "wxt";

const api = new URL(process.env.WXT_API_ORIGIN || "http://localhost:3100");
if (
  api.protocol !== "https:" &&
  !(
    ["localhost", "127.0.0.1"].includes(api.hostname) &&
    api.protocol === "http:"
  )
) {
  throw new Error("WXT_API_ORIGIN must use HTTPS or loopback HTTP.");
}
if (
  api.username ||
  api.password ||
  api.pathname !== "/" ||
  api.search ||
  api.hash
) {
  throw new Error("WXT_API_ORIGIN must contain only the API origin.");
}

export default defineConfig({
  manifest: {
    name: "商渡 · Noon 卖家工作台",
    description: "订单同步、跨境报价与商品素材管理。",
    minimum_chrome_version: "100",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuybA3CEqFTHBDzgNLMraJySVqs4lYu34FOhW46pS4d7Q2/FBoQ2WiEVZiEmDQN8YoSEUJIxA4toT9E+uwocz5YnQOd3Z6I4M65odcuMSu9Tp0+/0ZgTtPP0QhQcqUf8MZDqMyi4E89CBZmerZdVInS4c9m4Hm6PLi/PGaN9Jtga280gqG3ukn0uVYw0ek/pxB7FqFgkkdwlcY/eHFw3teRcuFGyY+bj+43a8KFs77qoh7zI7NQ6fSbLRBzCGFl6o4IY9clxy+PC4Zrzh/A0MS1g3OGWxnPyO6lo0n635ZL74/49Pqwix3RmLdV9LIHgzQrRgHiaTcXw5UiqFGCJgtQIDAQAB",
    host_permissions: [api.origin + "/*"],
  },
  vite: () => ({
    define: { __API_ORIGIN__: JSON.stringify(api.origin) },
    build: { target: "chrome100" },
  }),
});
