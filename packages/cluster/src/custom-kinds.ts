import type { CatalogEntry } from "@podgaze/contracts";

type PrinterColumnSpec = { name?: string; type?: string; jsonPath?: string; priority?: number };

export type CrdLike = {
  spec?: {
    group?: string;
    scope?: string;
    names?: { kind?: string; plural?: string };
    versions?: { name?: string; served?: boolean; storage?: boolean; additionalPrinterColumns?: PrinterColumnSpec[] }[];
  };
};

const MAX_COLUMNS = 4;

// One catalog entry per CRD, using the version kubectl would read and the columns `kubectl get` shows.
export function crdEntries(crds: CrdLike[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const crd of crds) {
    const group = crd.spec?.group;
    const kind = crd.spec?.names?.kind;
    const plural = crd.spec?.names?.plural;
    const served = (crd.spec?.versions ?? []).filter((version) => version.served !== false && version.name);
    const version = served.find((item) => item.storage) ?? served[0];
    if (!group || !kind || !plural || !version?.name) continue;
    const printer = (version.additionalPrinterColumns ?? [])
      .filter((column) => column.name && column.jsonPath && !column.priority && column.jsonPath !== ".metadata.creationTimestamp")
      .slice(0, MAX_COLUMNS);
    const used = new Set(["name", "status", "namespace", "age"]);
    const columns = printer.map((column) => {
      let key = column.name!.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      while (used.has(key)) key = `${key}-`;
      used.add(key);
      return { key, header: column.name!, width: "0.8fr", jsonPath: column.jsonPath!, age: column.type === "date" };
    });
    entries.push({
      kind: `${plural}.${group}`,
      group: "Custom",
      label: kind,
      namespaced: crd.spec?.scope !== "Cluster",
      apiVersion: `${group}/${version.name}`,
      plural,
      apiKind: kind,
      apiGroup: group,
      columns: columns.map(({ key, header, width, age }) => (age ? { key, header, width, age } : { key, header, width })),
      printerColumns: columns.map(({ key, jsonPath }) => ({ key, jsonPath })),
      commands: ["describe", "events", "delete"],
    });
  }
  return entries.sort((left, right) => left.apiGroup!.localeCompare(right.apiGroup!) || left.label.localeCompare(right.label));
}
