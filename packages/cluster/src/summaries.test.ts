import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readKubeconfigSummaries, certificateExpiry } from "./summaries.js";

const valid = `
apiVersion: v1
kind: Config
clusters:
- name: prod
  cluster:
    server: https://prod.example:6443
contexts:
- name: prod-eu
  context:
    cluster: prod
    user: admin
    namespace: default
- name: broken
  context:
    cluster: missing
    user: admin
users:
- name: admin
  user:
    token: secret
current-context: prod-eu
`;

function writeTemp(contents: string): string {
  const file = path.join(os.tmpdir(), `podgaze-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
  fs.writeFileSync(file, contents);
  return file;
}

describe("readKubeconfigSummaries", () => {
  it("parses contexts and marks a missing cluster unusable", () => {
    const file = writeTemp(valid);
    const result = readKubeconfigSummaries(file);
    expect(result.error).toBeNull();
    expect(result.summaries).toEqual([
      {
        id: "prod-eu",
        name: "prod-eu",
        server: "https://prod.example:6443",
        namespace: "default",
        usable: true,
        problem: null,
        certExpires: null,
      },
      {
        id: "broken",
        name: "broken",
        server: "",
        namespace: null,
        usable: false,
        problem: "This context has no cluster or user.",
        certExpires: null,
      },
    ]);
  });

  it("returns a parse error and no summaries for malformed YAML", () => {
    const file = writeTemp(":\n  - :\n[");
    const result = readKubeconfigSummaries(file);
    expect(result.summaries).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("names a missing file", () => {
    const missing = path.join(os.tmpdir(), "podgaze-missing-kubeconfig");
    const result = readKubeconfigSummaries(missing);
    expect(result.summaries).toEqual([]);
    expect(result.error).toBe(`No kubeconfig at ${missing}`);
  });

  it("reads when a client certificate expires, and ignores anything that is not one", () => {
    // A throwaway self-signed certificate made for this test; it never had a matching key kept anywhere.
    const testCert = "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJnekNDQVNtZ0F3SUJBZ0lVTUpLMDlMU25HVlpna05qUnlJU2JRVjFYT0s0d0NnWUlLb1pJemowRUF3SXcKRnpFVk1CTUdBMVVFQXd3TWNHOWtaMkY2WlMxMFpYTjBNQjRYRFRJMk1UQXhOVEE1TkRNd01Gb1hEVEkyTVRFeApOREE1TkRNd01Gb3dGekVWTUJNR0ExVUVBd3dNY0c5a1oyRjZaUzEwWlhOME1Ga3dFd1lIS29aSXpqMENBUVlJCktvWkl6ajBEQVFjRFFnQUVnbUNBTE9SaXdsQ3haMVBRZFczazIybVA4cjJaVjR4RzZscHFEeWZJSzQreUlpYlEKdGxHNUsyRm40R01CckpnNlJZaXRkT0VkZ05qTm5JbEpadXhZajZOVE1GRXdIUVlEVlIwT0JCWUVGTVJsR2dhOApyQVk2YkNxUTBUVzJsOURKcDIwNU1COEdBMVVkSXdRWU1CYUFGTVJsR2dhOHJBWTZiQ3FRMFRXMmw5REpwMjA1Ck1BOEdBMVVkRXdFQi93UUZNQU1CQWY4d0NnWUlLb1pJemowRUF3SURTQUF3UlFJZ1p1TU1jR1lWaGJISklxaysKWXFGS3FnbmI5ejA4NVVqQTY0L0FPcGpjNkR3Q0lRRFp6bW5BdTd4UUN6QklZclVhaVo0M0d5L0N4bjlJdWRkLwowNE1UUlBWbXhRPT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=";
    expect(certificateExpiry(testCert, undefined)).toBe("2026-11-14T09:43:00.000Z");
    expect(certificateExpiry("bm90IGEgY2VydA==", undefined)).toBeNull();
    expect(certificateExpiry(undefined, undefined)).toBeNull();
    expect(certificateExpiry(undefined, "/nonexistent/cert.pem")).toBeNull();
  });
});
