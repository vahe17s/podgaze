import type { ContextGuard } from "@podgaze/contracts";

// The guard that applies to one object: a namespace exception wins over the cluster setting.
export function effectiveGuard(guard: ContextGuard, namespace: string | null | undefined): ContextGuard {
  const exception = namespace ? guard.namespaces?.[namespace] : undefined;
  if (!exception) return guard;
  return { ...guard, readOnly: exception === "readOnly" };
}
