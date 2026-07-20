import { createHash } from "node:crypto";

export type Principal = { id: string; scopes: string[] };

const registry = new Map<string, Principal>();

export function registerToken(token: string, principal: Principal): void {
  registry.set(fingerprint(token), principal);
}

export function resolve(token: string | undefined): Principal | null {
  if (!token) {
    return null;
  }
  return registry.get(fingerprint(token)) ?? null;
}

export function requireScope(principal: Principal | null, scope: string): void {
  if (!principal || !principal.scopes.includes(scope)) {
    throw new Error("forbidden");
  }
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
