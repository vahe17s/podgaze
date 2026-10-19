import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupKubeconfig, describeContext, redact, removeContext, updateContext, validateEdit } from "./kubeconfig-edit.js";

// Fake values only: nothing here logs in anywhere.
const config = `# team clusters
apiVersion: v1
kind: Config
current-context: prod
clusters:
  - name: prod-cluster
    cluster:
      server: https://prod.example:6443 # primary
      certificate-authority-data: Q0FEQVRB
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-admin
      namespace: shop
  - name: prod-readonly
    context:
      cluster: prod-cluster
      user: viewer
users:
  - name: prod-admin
    user:
      token: fake-token-value
  - name: viewer
    user:
      exec:
        command: /usr/local/bin/aws
        env:
          - name: AWS_SECRET
            value: fake-secret
`;

let dir = "";

function write(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "podgaze-kc-"));
  const file = path.join(dir, "config");
  fs.writeFileSync(file, config, { mode: 0o600 });
  return file;
}

function write2(folder: string): string {
  const file = path.join(folder, "third");
  fs.writeFileSync(file, "apiVersion: v1\nkind: Config\ncontexts:\n  - name: taken\n    context:\n      cluster: c\n", { mode: 0o600 });
  return file;
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

// Windows reports every file as 0o666: it has no Unix permission bits, and the profile folder's ACLs keep
// kubeconfigs private there. Mode checks run on Linux and macOS only.
describe("kubeconfig contexts", () => {
  it("describes a context without leaking any credential", () => {
    const file = write();
    const details = describeContext(file, "prod");
    expect(details).toMatchObject({
      id: "prod",
      file,
      current: true,
      cluster: "prod-cluster",
      user: "prod-admin",
      server: "https://prod.example:6443",
      namespace: "shop",
      auth: "Bearer token",
      ca: "Embedded",
      sharedWith: ["prod-readonly"],
    });
    expect(details.yaml).not.toContain("fake-token-value");
    expect(details.yaml).toContain("token: <hidden>");
    expect(describeContext(file, "prod-readonly").auth).toBe("Exec plugin: aws");
    expect(describeContext(file, "prod-readonly").yaml).not.toContain("fake-secret");
  });

  it("removes a context, keeping entries another context still uses", () => {
    const file = write();
    const first = removeContext(file, "prod", new Date("2026-10-16T10:00:00Z"));
    expect(first.removed).toEqual(["context prod", "user prod-admin"]);
    expect(fs.readFileSync(first.backup, "utf8")).toBe(config);
    let text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# team clusters");
    expect(text).toContain("current-context: prod-readonly");
    expect(text).toContain("prod-cluster");
    expect(text).not.toContain("fake-token-value");
    const second = removeContext(file, "prod-readonly", new Date("2026-10-16T10:00:01Z"));
    expect(second.removed).toEqual(["context prod-readonly", "cluster prod-cluster", "user viewer"]);
    text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("current-context");
    expect(text).not.toContain("prod-cluster");
    expect(() => removeContext(file, "nope")).toThrow();
  });

  it("checks every KUBECONFIG file before removing shared entries or accepting a new name", () => {
    const file = write();
    const second = path.join(dir, "second");
    fs.writeFileSync(second, "apiVersion: v1\nkind: Config\ncontexts:\n  - name: other\n    context:\n      cluster: prod-cluster\n      user: viewer\n", { mode: 0o600 });
    const both = `${file}${path.delimiter}${second}`;
    removeContext(both, "prod", new Date("2026-10-16T10:00:00Z"));
    const result = removeContext(both, "prod-readonly", new Date("2026-10-16T10:00:01Z"));
    // "other" in the second file still uses prod-cluster and viewer, so they stay.
    expect(result.removed).toEqual(["context prod-readonly"]);
    expect(fs.readFileSync(file, "utf8")).toContain("prod-cluster");
    expect(() => updateContext(`${second}${path.delimiter}${write2(dir)}`, "other", { name: "taken" })).toThrow(/already exists/);
  });

  it("keeps backups private and only the newest ten", () => {
    const file = write();
    for (let index = 0; index < 12; index += 1) backupKubeconfig(file, new Date(Date.UTC(2026, 9, 16, 10, 0, index)));
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".podgaze-"));
    expect(backups).toHaveLength(10);
    expect(backups.sort()[0]).toContain("10-00-02");
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, backups[0]!)).mode & 0o777).toBe(0o600);
  });

  it("hides secrets wherever they sit", () => {
    expect(redact({ user: { "client-key-data": "k", token: "t", exec: { env: [{ name: "X", value: "v" }] }, "auth-provider": { config: { "refresh-token": "r", "client-id": "id" } } } })).toEqual({
      user: { "client-key-data": "<hidden>", token: "<hidden>", exec: { env: [{ name: "X", value: "<hidden>" }] }, "auth-provider": { config: { "refresh-token": "<hidden>", "client-id": "id" } } },
    });
  });

  it("renames, sets the namespace, and moves the server, keeping comments and a backup", () => {
    const file = write();
    const saved = updateContext(file, "prod", { name: "prod-eu", namespace: "payments", server: "https://10.0.0.9:6443" }, new Date("2026-10-15T10:00:00Z"));
    expect(saved.name).toBe("prod-eu");
    expect(fs.readFileSync(saved.backup, "utf8")).toBe(config);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# team clusters");
    expect(text).toContain("current-context: prod-eu");
    expect(text).toContain("server: https://10.0.0.9:6443");
    expect(text).toContain("token: fake-token-value");
    const details = describeContext(file, "prod-eu");
    expect(details.namespace).toBe("payments");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("clears the default namespace", () => {
    const file = write();
    updateContext(file, "prod", { namespace: null });
    expect(describeContext(file, "prod").namespace).toBeNull();
  });

  it("refuses bad input before touching the file", () => {
    const file = write();
    expect(() => updateContext(file, "prod", { name: "prod-readonly" })).toThrow(/already exists/);
    expect(fs.readFileSync(file, "utf8")).toBe(config);
    expect(fs.readdirSync(dir)).toEqual(["config"]);
    expect(validateEdit({ namespace: "Bad_NS" }, [])).toMatch(/lowercase/);
    expect(validateEdit({ server: "prod.example:6443" }, [])).toMatch(/https:\/\//);
    expect(validateEdit({ server: "not a url" }, [])).toMatch(/full URL/);
    expect(validateEdit({ name: "has space" }, [])).toMatch(/spaces/);
    expect(() => describeContext(file, "missing")).toThrow(/No kubeconfig file defines/);
  });
});
