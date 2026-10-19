import { describe, expect, it } from "vitest";
import { decodeSecretData, encodeSecretValue, secretManager, secretPatch } from "./secret.js";

describe("decodeSecretData", () => {
  it("turns base64 secret values into text and keeps the stored form", () => {
    expect(decodeSecretData({ password: Buffer.from("s3cret").toString("base64"), user: Buffer.from("ada").toString("base64") })).toEqual([
      { key: "password", value: "s3cret", binary: false, encoded: "czNjcmV0" },
      { key: "user", value: "ada", binary: false, encoded: "YWRh" },
    ]);
  });

  it("marks values that are not text", () => {
    const encoded = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64");
    expect(decodeSecretData({ key: encoded })).toEqual([{ key: "key", value: "", binary: true, encoded }]);
  });
});

describe("secret writes", () => {
  it("encodes text as UTF-8 base64 and checks base64 given as is", () => {
    expect(encodeSecretValue({ key: "p", value: "pässwörd ✓\n", encoding: "text" })).toBe(Buffer.from("pässwörd ✓\n", "utf8").toString("base64"));
    expect(encodeSecretValue({ key: "p", value: "czNj\ncmV0", encoding: "base64" })).toBe("czNjcmV0");
    expect(() => encodeSecretValue({ key: "p", value: "not base64!", encoding: "base64" })).toThrow(/not valid base64/);
  });

  it("builds a merge patch that sets, removes, and pins the version", () => {
    expect(secretPatch({
      namespace: "shop",
      name: "api",
      resourceVersion: "41",
      set: [{ key: "DB_PASSWORD", value: "hunter2", encoding: "text" }],
      remove: ["OLD_KEY"],
    })).toEqual({ metadata: { resourceVersion: "41" }, data: { DB_PASSWORD: "aHVudGVyMg==", OLD_KEY: null } });
    expect(() => secretPatch({ namespace: "s", name: "a", resourceVersion: "1", set: [{ key: "bad key", value: "x", encoding: "text" }], remove: [] })).toThrow(/may only use/);
    expect(() => secretPatch({ namespace: "s", name: "a", resourceVersion: "1", set: [], remove: [] })).toThrow(/no changes/);
  });

  it("names who manages a secret", () => {
    expect(secretManager({ ownerReferences: [{ kind: "ExternalSecret" }] })).toBe("External Secrets");
    expect(secretManager({ labels: { "app.kubernetes.io/managed-by": "Helm" } })).toBe("Helm");
    expect(secretManager({ annotations: { "argocd.argoproj.io/tracking-id": "x" } })).toBe("Argo CD");
    expect(secretManager({})).toBeUndefined();
  });
});
