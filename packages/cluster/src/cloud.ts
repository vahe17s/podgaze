import type { execFile as ExecFile } from "node:child_process";
import type { CloudAccount, CloudAddRequest, CloudCluster, CloudProvider } from "@podgaze/contracts";

export type Run = (command: string, args: string[], options?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<string>;

const INSTALL: Record<string, string> = {
  az: "The Azure CLI (az) is not installed or not on PATH. Install it, run \"az login\", and restart Podgaze.",
  aws: "The AWS CLI (aws) is not installed or not on PATH. Install it, run \"aws configure\" or \"aws sso login\", and restart Podgaze.",
  gcloud: "The Google Cloud CLI (gcloud) is not installed or not on PATH. Install the Google Cloud CLI and its gke-gcloud-auth-plugin component, run \"gcloud auth login\", and restart Podgaze.",
};

const SIGN_IN: [RegExp, string][] = [
  [/az login|AADSTS/i, "The Azure CLI is not signed in. Run \"az login\" in a terminal, then try again."],
  [/Unable to locate credentials|ExpiredToken|sso.*expired|The SSO session/i, "The AWS CLI has no valid credentials for this profile. Run \"aws sso login\" or \"aws configure\", then try again."],
  [/gcloud auth login|Reauthentication|no active account/i, "The Google Cloud CLI is not signed in. Run \"gcloud auth login\", then try again."],
];

export function createRunner(exec: typeof ExecFile): Run {
  return (command, args, options = {}) => new Promise((resolve, reject) => {
    exec(command, args, {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(INSTALL[command] ?? `${command} is not installed or not on PATH.`));
          return;
        }
        const text = String(stderr || error.message).trim();
        const hint = SIGN_IN.find(([pattern]) => pattern.test(text))?.[1];
        reject(new Error(hint ? `${hint}\n${text}` : text));
        return;
      }
      resolve(String(stdout));
    });
  });
}

const SAFE = /^[\w.@:()/-]+$/;

function safe(...values: (string | undefined)[]) {
  for (const value of values) {
    if (value !== undefined && !SAFE.test(value)) throw new Error(`"${value}" does not look like a cloud name.`);
  }
}

type RawSubscription = { id?: string; name?: string; isDefault?: boolean; state?: string };
type RawAks = { name?: string; resourceGroup?: string; location?: string; currentKubernetesVersion?: string; kubernetesVersion?: string; powerState?: { code?: string }; aadProfile?: unknown };
type RawGke = { name?: string; location?: string; zone?: string; currentMasterVersion?: string; status?: string };
type RawProject = { projectId?: string; name?: string; lifecycleState?: string };

export function parseAzureAccounts(json: string): CloudAccount[] {
  return (JSON.parse(json || "[]") as RawSubscription[])
    .filter((item) => item.id && (item.state ?? "Enabled") === "Enabled")
    .map((item) => ({ id: item.id!, name: item.name ?? item.id!, isDefault: Boolean(item.isDefault) }))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
}

export function parseAksClusters(json: string, accountId: string): CloudCluster[] {
  return (JSON.parse(json || "[]") as RawAks[])
    .filter((item) => item.name && item.resourceGroup)
    .map((item) => ({
      provider: "azure" as const,
      name: item.name!,
      group: item.resourceGroup!,
      location: item.location ?? "",
      version: item.currentKubernetesVersion ?? item.kubernetesVersion ?? "",
      state: item.powerState?.code ?? "",
      note: item.aadProfile ? "Entra ID" : "",
      accountId,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseAwsProfiles(text: string, defaultProfile: string | undefined): CloudAccount[] {
  const names = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return names.map((name) => ({ id: name, name, isDefault: name === (defaultProfile || "default") }))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
}

export function parseEksClusters(json: string, accountId: string, region: string): CloudCluster[] {
  const names = ((JSON.parse(json || "{}") as { clusters?: string[] }).clusters ?? []);
  return names.map((name) => ({ provider: "aws" as const, name, group: region, location: region, version: "", state: "", note: "", accountId }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseGcpProjects(json: string): CloudAccount[] {
  return (JSON.parse(json || "[]") as RawProject[])
    .filter((item) => item.projectId && (item.lifecycleState ?? "ACTIVE") === "ACTIVE")
    .map((item) => ({ id: item.projectId!, name: item.name && item.name !== item.projectId ? `${item.name} (${item.projectId})` : item.projectId!, isDefault: false }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseGkeClusters(json: string, accountId: string): CloudCluster[] {
  return (JSON.parse(json || "[]") as RawGke[])
    .filter((item) => item.name)
    .map((item) => ({
      provider: "gcp" as const,
      name: item.name!,
      group: item.location ?? item.zone ?? "",
      location: item.location ?? item.zone ?? "",
      version: item.currentMasterVersion ?? "",
      state: item.status ?? "",
      note: "",
      accountId,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// The commands a person would type for each cloud. Nothing about any particular account is built in: every
// value comes from the CLI's own listing or from the user's choice.
export function addClusterSteps(request: CloudAddRequest, kubeconfig: string): { command: string; args: string[]; env?: Record<string, string> }[] {
  safe(request.accountId, request.group, request.name);
  if (request.provider === "azure") {
    const steps: { command: string; args: string[]; env?: Record<string, string> }[] = [{
      command: "az",
      args: ["aks", "get-credentials", "--resource-group", request.group, "--name", request.name, "--subscription", request.accountId, "--file", kubeconfig, "--overwrite-existing"],
    }];
    if (request.azureCliLogin) steps.push({ command: "kubelogin", args: ["convert-kubeconfig", "-l", "azurecli", "--kubeconfig", kubeconfig, "--context", request.name] });
    return steps;
  }
  if (request.provider === "aws") {
    return [{
      command: "aws",
      args: ["eks", "update-kubeconfig", "--name", request.name, "--region", request.group, "--profile", request.accountId, "--kubeconfig", kubeconfig, "--alias", request.name],
    }];
  }
  // gcloud has no --kubeconfig flag; it writes wherever KUBECONFIG points.
  return [{
    command: "gcloud",
    args: ["container", "clusters", "get-credentials", request.name, "--location", request.group, "--project", request.accountId],
    env: { KUBECONFIG: kubeconfig },
  }];
}

export function contextNameFor(request: CloudAddRequest): string {
  return request.provider === "gcp" ? `gke_${request.accountId}_${request.group}_${request.name}` : request.name;
}

export function createCloud(run: Run) {
  return {
    async accounts(provider: CloudProvider): Promise<CloudAccount[]> {
      if (provider === "azure") return parseAzureAccounts(await run("az", ["account", "list", "--output", "json"], { timeoutMs: 60_000 }));
      if (provider === "aws") {
        const profiles = await run("aws", ["configure", "list-profiles"], { timeoutMs: 30_000 });
        return parseAwsProfiles(profiles, process.env.AWS_PROFILE);
      }
      return parseGcpProjects(await run("gcloud", ["projects", "list", "--format=json"], { timeoutMs: 60_000 }));
    },
    async defaultRegion(accountId: string): Promise<string> {
      safe(accountId);
      try {
        return (await run("aws", ["configure", "get", "region", "--profile", accountId], { timeoutMs: 15_000 })).trim();
      } catch {
        return "";
      }
    },
    async clusters(provider: CloudProvider, accountId: string, region?: string): Promise<CloudCluster[]> {
      safe(accountId, region);
      if (provider === "azure") return parseAksClusters(await run("az", ["aks", "list", "--subscription", accountId, "--output", "json"]), accountId);
      if (provider === "aws") {
        if (!region) throw new Error("Choose an AWS region.");
        return parseEksClusters(await run("aws", ["eks", "list-clusters", "--region", region, "--profile", accountId, "--output", "json"]), accountId, region);
      }
      return parseGkeClusters(await run("gcloud", ["container", "clusters", "list", "--project", accountId, "--format=json"]), accountId);
    },
    async add(request: CloudAddRequest, kubeconfig: string) {
      const notes: string[] = [];
      for (const step of addClusterSteps(request, kubeconfig)) {
        try {
          const output = await run(step.command, step.args, { timeoutMs: 180_000, env: step.env });
          if (output.trim()) notes.push(output.trim());
        } catch (error) {
          // Without kubelogin an AKS context still works; it asks for a device-code sign-in when it connects.
          if (step.command === "kubelogin") {
            notes.push(`kubelogin could not convert the login (${error instanceof Error ? error.message : "failed"}). The context will ask for a device-code sign-in when it connects.`);
            continue;
          }
          throw error;
        }
      }
      return { context: contextNameFor(request), message: notes.join("\n") || `Added ${request.name} to ${kubeconfig}.` };
    },
  };
}
