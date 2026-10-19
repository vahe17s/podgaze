export function cpuMillicores(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(raw.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  if (match[2] === "n") return value / 1_000_000;
  if (match[2] === "u") return value / 1_000;
  if (match[2] === "m") return value;
  return value * 1000;
}

const memoryUnit: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1000,
  M: 1_000_000,
  G: 1_000_000_000,
  T: 1_000_000_000_000,
  k: 1000,
};

export function memoryBytes(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T|k)?$/.exec(raw.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  return value * (match[2] ? memoryUnit[match[2]] : 1);
}
