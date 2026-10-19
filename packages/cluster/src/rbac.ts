import type { WhoCanRequest, WhoCanSubject } from "@podgaze/contracts";

export type RuleLike = { verbs?: string[]; apiGroups?: string[]; resources?: string[]; resourceNames?: string[] };
export type RoleLike = { metadata?: { name?: string; namespace?: string }; rules?: RuleLike[] };
export type BindingLike = {
  metadata?: { name?: string; namespace?: string };
  roleRef?: { kind?: string; name?: string };
  subjects?: { kind?: string; name?: string; namespace?: string }[];
};

function covers(list: string[] | undefined, value: string): boolean {
  return (list ?? []).some((item) => item === "*" || item === value);
}

export function ruleAllows(rule: RuleLike, request: WhoCanRequest): boolean {
  const [resource, subresource] = request.resource.split("/");
  const resources = rule.resources ?? [];
  const resourceMatch = resources.some((item) => item === "*" || item === request.resource || (!subresource && item === resource) || item === `${resource}/*`);
  return covers(rule.verbs, request.verb) && covers(rule.apiGroups, request.group) && resourceMatch;
}

// Who is granted a verb on a resource by RBAC. It reads bindings the way the API server does; it does not
// know about webhooks or other authorizers, so it can miss people, but never invents access.
export function whoCan(
  request: WhoCanRequest,
  inputs: { clusterRoles: RoleLike[]; roles: RoleLike[]; clusterRoleBindings: BindingLike[]; roleBindings: BindingLike[] },
): WhoCanSubject[] {
  const clusterRoles = new Map(inputs.clusterRoles.map((role) => [role.metadata?.name ?? "", role]));
  const roles = new Map(inputs.roles.map((role) => [`${role.metadata?.namespace ?? ""}/${role.metadata?.name ?? ""}`, role]));
  const found: WhoCanSubject[] = [];
  const seen = new Set<string>();

  function add(binding: BindingLike, role: RoleLike | undefined, scope: "cluster" | "namespace") {
    if (!role || !(role.rules ?? []).some((rule) => ruleAllows(rule, request))) return;
    for (const subject of binding.subjects ?? []) {
      if (!subject.kind || !subject.name) continue;
      const bindingName = `${scope === "cluster" ? "ClusterRoleBinding" : "RoleBinding"}/${binding.metadata?.name ?? ""}`;
      const key = `${subject.kind}/${subject.namespace ?? ""}/${subject.name}/${bindingName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        kind: subject.kind,
        name: subject.name,
        ...(subject.namespace ? { namespace: subject.namespace } : {}),
        binding: bindingName,
        role: `${binding.roleRef?.kind ?? "Role"}/${binding.roleRef?.name ?? ""}`,
        scope,
      });
    }
  }

  for (const binding of inputs.clusterRoleBindings) add(binding, clusterRoles.get(binding.roleRef?.name ?? ""), "cluster");
  for (const binding of inputs.roleBindings) {
    const namespace = binding.metadata?.namespace ?? "";
    if (request.namespace && namespace !== request.namespace) continue;
    const role = binding.roleRef?.kind === "ClusterRole"
      ? clusterRoles.get(binding.roleRef.name ?? "")
      : roles.get(`${namespace}/${binding.roleRef?.name ?? ""}`);
    add(binding, role, "namespace");
  }
  return found.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}
