import { useEffect, useState } from "react";
import type { ResourceRef } from "@podgaze/contracts";

const KEY = "podgaze.pins";
const listeners = new Set<() => void>();

type Pins = Record<string, ResourceRef[]>;

function read(): Pins {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Pins) : {};
  } catch {
    return {};
  }
}

function write(pins: Pins) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // Pins last until the window closes.
  }
  for (const listener of listeners) listener();
}

export function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.kind === right.kind && left.name === right.name && (left.namespace ?? null) === (right.namespace ?? null);
}

// Objects someone checks often, per cluster, at the top of the sidebar.
export function usePins(clusterId: string | null) {
  const [pins, setPins] = useState<ResourceRef[]>(() => (clusterId ? read()[clusterId] ?? [] : []));
  useEffect(() => {
    const refresh = () => setPins(clusterId ? read()[clusterId] ?? [] : []);
    refresh();
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [clusterId]);
  function toggle(ref: ResourceRef) {
    if (!clusterId) return;
    const all = read();
    const current = all[clusterId] ?? [];
    const next = current.some((item) => sameRef(item, ref))
      ? current.filter((item) => !sameRef(item, ref))
      : [...current, { kind: ref.kind, namespace: ref.namespace ?? null, name: ref.name }].slice(-30);
    write({ ...all, [clusterId]: next });
  }
  return { pins, toggle, pinned: (ref: ResourceRef) => pins.some((item) => sameRef(item, ref)) };
}
