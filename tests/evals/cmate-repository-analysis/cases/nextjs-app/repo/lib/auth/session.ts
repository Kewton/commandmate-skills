import { createHmac, timingSafeEqual } from "node:crypto";

import { readEnv, sessionTtlSeconds } from "../config";

export type Session = {
  subject: string;
  issuedAt: number;
  expiresAt: number;
};

export function issue(subject: string, now = Date.now()): string {
  const ttl = sessionTtlSeconds();
  const payload: Session = {
    subject,
    issuedAt: now,
    expiresAt: now + ttl * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verify(token: string, now = Date.now()): Session | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) {
    return null;
  }
  const expected = sign(body);
  if (mac.length !== expected.length) {
    return null;
  }
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  const session = JSON.parse(Buffer.from(body, "base64url").toString()) as Session;
  return session.expiresAt > now ? session : null;
}

function sign(body: string): string {
  return createHmac("sha256", readEnv().SESSION_SECRET).update(body).digest("base64url");
}
