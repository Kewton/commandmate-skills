const REQUIRED = ["SESSION_SECRET"] as const;

export type Env = Record<(typeof REQUIRED)[number], string>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const missing = REQUIRED.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(", ")}`);
  }
  return { SESSION_SECRET: source.SESSION_SECRET as string };
}

export function sessionTtlSeconds(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source.SESSION_TTL_SECONDS;
  const parsed = raw === undefined ? 3600 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600;
}
