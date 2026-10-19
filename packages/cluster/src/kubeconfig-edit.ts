import fs from "node:fs";
import path from "node:path";
import { isMap, isSeq, parseDocument, stringify, type Document, type YAMLMap } from "yaml";
import type { ContextDetails, ContextEdit, ContextRemoved } from "@podgaze/contracts";
import { certificateExpiry } from "./summaries.js";

type Raw = Record<string, unknown>;

// Anything that can log someone in is replaced before it leaves this module, including inside exec env and auth-provider config.
const SECRET_KEY = /token|secret|password|key-data|private/i;
const BULKY_KEY = /certificate-data|authority-data/i;

export function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (SECRET_KEY.test(key)) return "<hidden>";
    if (BULKY_KEY.test(key)) return `<${value.length} characters, base64>`;
    return value;
  }
  if (Array.isArray(value)) {
    // exec env is a list of {name, value}; the value is often a credential, so hide all of them.
    return value.map((item) => {
      if (key === "env" && item && typeof item === "object" && "value" in item) return { ...(item as Raw), value: "<hidden>" };
      return redact(item, key);
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Raw).map(([name, inner]) => [name, redact(inner, name)]));
  }
  return value;
}

function files(kubeconfig: string): string[] {
  return kubeconfig.split(path.delimiter).filter((file) => file.length > 0);
}

function findNamed(doc: Document, list: string, name: string): YAMLMap | null {
  const seq = doc.get(list);
  if (!isSeq(seq)) return null;
  for (const item of seq.items) {
    if (isMap(item) && item.get("name") === name) return item;
  }
  return null;
}

function names(doc: Document, list: string): string[] {
  const seq = doc.get(list);
  if (!isSeq(seq)) return [];
  return seq.items.flatMap((item) => (isMap(item) && typeof item.get("name") === "string" ? [item.get("name") as string] : []));
}

// The first file in KUBECONFIG that defines the context is the one kubectl uses, so it is the one edited.
function locate(kubeconfig: string, contextName: string): { file: string; doc: Document } {
  for (const file of files(kubeconfig)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const doc = parseDocument(text);
    if (findNamed(doc, "contexts", contextName)) return { file, doc };
  }
  throw new Error(`No kubeconfig file defines the context ${contextName}.`);
}

// Every other file in KUBECONFIG, parsed: names and references must be checked across all of them, because
// kubectl and client-node merge them into one config.
function otherDocs(kubeconfig: string, except: string): Document[] {
  return files(kubeconfig).filter((file) => file !== except).flatMap((file) => {
    try {
      return [parseDocument(fs.readFileSync(file, "utf8"))];
    } catch {
      return [];
    }
  });
}

const KEEP_BACKUPS = 10;

// A private copy of the file before Podgaze changes it. Only the newest few are kept, so removed credentials do
// not stay on disk forever.
export function backupKubeconfig(file: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.podgaze-${stamp}.bak`;
  fs.writeFileSync(backup, fs.readFileSync(file), { mode: 0o600, flag: "wx" });
  try {
    const folder = path.dirname(file);
    const prefix = `${path.basename(file)}.podgaze-`;
    const old = fs.readdirSync(folder).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();
    for (const name of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(folder, name), { force: true });
  } catch {
    // Pruning is housekeeping; the backup itself is written.
  }
  return backup;
}

function authOf(user: Raw | undefined): string {
  if (!user) return "None";
  if (user.exec && typeof user.exec === "object") {
    const command = (user.exec as Raw).command;
    return `Exec plugin: ${typeof command === "string" ? path.basename(command) : "command"}`;
  }
  if (user["auth-provider"] && typeof user["auth-provider"] === "object") {
    return `Auth provider: ${String((user["auth-provider"] as Raw).name ?? "unknown")}`;
  }
  if (user["client-certificate-data"] || user["client-certificate"]) return "Client certificate";
  if (user.token || user.tokenFile || user["token-file"]) return "Bearer token";
  if (user.username) return "Username and password";
  return "None";
}

export function describeContext(kubeconfig: string, contextName: string): ContextDetails {
  const { file, doc } = locate(kubeconfig, contextName);
  const context = (findNamed(doc, "contexts", contextName)?.toJSON() ?? {}) as Raw;
  const body = (context.context ?? {}) as Raw;
  const clusterName = typeof body.cluster === "string" ? body.cluster : "";
  const userName = typeof body.user === "string" ? body.user : "";
  const clusterEntry = (findNamed(doc, "clusters", clusterName)?.toJSON() ?? null) as Raw | null;
  const userEntry = (findNamed(doc, "users", userName)?.toJSON() ?? null) as Raw | null;
  const cluster = (clusterEntry?.cluster ?? {}) as Raw;
  const user = (userEntry?.user ?? undefined) as Raw | undefined;
  const sharedWith = (doc.get("contexts") && isSeq(doc.get("contexts")) ? (doc.get("contexts") as { items: unknown[] }).items : [])
    .flatMap((item) => {
      if (!isMap(item)) return [];
      const name = item.get("name");
      const target = (item.toJSON() as Raw).context as Raw | undefined;
      return typeof name === "string" && name !== contextName && target?.cluster === clusterName ? [name] : [];
    });
  const certData = typeof user?.["client-certificate-data"] === "string" ? user["client-certificate-data"] as string : undefined;
  const certFile = typeof user?.["client-certificate"] === "string" ? path.resolve(path.dirname(file), user["client-certificate"] as string) : undefined;
  return {
    id: contextName,
    file,
    current: doc.get("current-context") === contextName,
    cluster: clusterName,
    user: userName,
    server: typeof cluster.server === "string" ? cluster.server : "",
    namespace: typeof body.namespace === "string" && body.namespace ? body.namespace : null,
    auth: authOf(user),
    certExpires: user ? certificateExpiry(certData, certFile) : null,
    skipTLSVerify: cluster["insecure-skip-tls-verify"] === true,
    ca: cluster["certificate-authority-data"] ? "Embedded" : typeof cluster["certificate-authority"] === "string" ? `File ${cluster["certificate-authority"]}` : "System trust store",
    sharedWith,
    yaml: stringify({
      contexts: [context],
      clusters: clusterEntry ? [redact(clusterEntry)] : [],
      users: userEntry ? [redact(userEntry)] : [],
    }),
  };
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function validateEdit(edit: ContextEdit, taken: string[]): string | null {
  if (edit.name !== undefined) {
    const name = edit.name.trim();
    if (!name) return "The context name cannot be empty.";
    if (/\s/.test(name)) return "The context name cannot contain spaces.";
    if (taken.includes(name)) return `A context named ${name} already exists.`;
  }
  if (edit.namespace !== undefined && edit.namespace !== null && edit.namespace !== "" && !DNS_LABEL.test(edit.namespace)) {
    return "A namespace is lowercase letters, digits, and dashes, up to 63 characters.";
  }
  if (edit.server !== undefined) {
    let url: URL;
    try {
      url = new URL(edit.server);
    } catch {
      return "The server must be a full URL, like https://10.0.0.1:6443.";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The server URL must start with https:// or http://.";
  }
  return null;
}

// Edits one context in place, keeping comments and layout, after copying the file aside.
export function updateContext(kubeconfig: string, contextName: string, edit: ContextEdit, now = new Date()): { backup: string; file: string; name: string } {
  const { file, doc } = locate(kubeconfig, contextName);
  const context = findNamed(doc, "contexts", contextName)!;
  const renaming = edit.name !== undefined && edit.name.trim() !== contextName;
  const problem = validateEdit(
    { ...edit, name: renaming ? edit.name : undefined },
    [...names(doc, "contexts").filter((name) => name !== contextName), ...otherDocs(kubeconfig, file).flatMap((other) => names(other, "contexts"))],
  );
  if (problem) throw new Error(problem);

  const backup = backupKubeconfig(file, now);

  const name = renaming ? edit.name!.trim() : contextName;
  if (renaming) {
    context.set("name", name);
    if (doc.get("current-context") === contextName) doc.set("current-context", name);
  }
  if (edit.namespace !== undefined) {
    if (edit.namespace) context.setIn(["context", "namespace"], edit.namespace);
    else context.deleteIn(["context", "namespace"]);
  }
  if (edit.server !== undefined) {
    const clusterName = context.getIn(["context", "cluster"]);
    const cluster = typeof clusterName === "string" ? findNamed(doc, "clusters", clusterName) : null;
    if (!cluster) throw new Error("This context points at a cluster entry that does not exist.");
    cluster.setIn(["cluster", "server"], edit.server.trim());
  }
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(file, doc.toString(), { mode });
  return { backup, file, name };
}

function dropNamed(doc: Document, list: string, name: string): boolean {
  const seq = doc.get(list);
  if (!isSeq(seq)) return false;
  const index = seq.items.findIndex((item) => isMap(item) && item.get("name") === name);
  if (index < 0) return false;
  seq.delete(index);
  return true;
}

// Deletes one context, after copying the file aside. Its cluster and user entries go too, unless another context
// in the same file still points at them.
export function removeContext(kubeconfig: string, contextName: string, now = new Date()): ContextRemoved {
  const { file, doc } = locate(kubeconfig, contextName);
  const context = findNamed(doc, "contexts", contextName)!;
  const clusterName = context.getIn(["context", "cluster"]);
  const userName = context.getIn(["context", "user"]);

  const backup = backupKubeconfig(file, now);

  const removed = [`context ${contextName}`];
  dropNamed(doc, "contexts", contextName);
  // A cluster or user entry stays if any context in any KUBECONFIG file still points at it.
  const everyDoc = [doc, ...otherDocs(kubeconfig, file)];
  const stillUsed = (field: "cluster" | "user", name: unknown) => everyDoc.some((each) => {
    const seq = each.get("contexts");
    return isSeq(seq) && seq.items.some((item) => isMap(item) && item.getIn(["context", field]) === name);
  });
  if (typeof clusterName === "string" && !stillUsed("cluster", clusterName) && dropNamed(doc, "clusters", clusterName)) removed.push(`cluster ${clusterName}`);
  if (typeof userName === "string" && !stillUsed("user", userName) && dropNamed(doc, "users", userName)) removed.push(`user ${userName}`);
  if (doc.get("current-context") === contextName) {
    const next = names(doc, "contexts")[0];
    if (next) doc.set("current-context", next);
    else doc.delete("current-context");
  }
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(file, doc.toString(), { mode });
  return { file, backup, removed };
}
