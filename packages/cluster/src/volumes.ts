import { memoryBytes, type StorageClassInfo, type VolumeInfo } from "@podgaze/contracts";

export type ClaimLike = {
  metadata?: { name?: string; namespace?: string };
  spec?: { storageClassName?: string; resources?: { requests?: { storage?: string } } };
  status?: { phase?: string; capacity?: { storage?: string } };
};

export type ClassLike = {
  metadata?: { name?: string; annotations?: Record<string, string> };
  provisioner?: string;
  parameters?: Record<string, string>;
};

export type MountingPod = {
  metadata?: { name?: string; namespace?: string };
  spec?: { volumes?: { persistentVolumeClaim?: { claimName?: string } }[] };
};

export function storageClasses(items: ClassLike[]): StorageClassInfo[] {
  return items.map((item) => ({
    name: item.metadata?.name ?? "",
    provisioner: item.provisioner ?? "",
    // Azure Disk calls it skuName, AWS EBS and GCE PD call it type.
    sku: item.parameters?.skuName ?? item.parameters?.skuname ?? item.parameters?.type ?? "",
    isDefault: item.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true",
  }));
}

export function volumeRows(claims: ClaimLike[], pods: MountingPod[], classes: StorageClassInfo[]): VolumeInfo[] {
  const mounts = new Map<string, string[]>();
  for (const pod of pods) {
    for (const volume of pod.spec?.volumes ?? []) {
      const claim = volume.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      const key = `${pod.metadata?.namespace}/${claim}`;
      mounts.set(key, [...(mounts.get(key) ?? []), pod.metadata?.name ?? ""]);
    }
  }
  const fallback = classes.find((item) => item.isDefault)?.name ?? "";
  return claims.map((claim) => {
    const namespace = claim.metadata?.namespace ?? "";
    const name = claim.metadata?.name ?? "";
    return {
      namespace,
      name,
      storageClass: claim.spec?.storageClassName ?? fallback,
      sizeBytes: memoryBytes(claim.status?.capacity?.storage ?? claim.spec?.resources?.requests?.storage ?? "0"),
      phase: claim.status?.phase ?? "",
      usedBy: mounts.get(`${namespace}/${name}`) ?? [],
    };
  });
}
