import { NextRequest, NextResponse } from "next/server";

import { issue, verify } from "../../../lib/auth/session";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { subject?: string };
  if (!body.subject) {
    return NextResponse.json({ error: "subject is required" }, { status: 400 });
  }
  const token = issue(body.subject);
  const response = NextResponse.json({ ok: true });
  response.cookies.set("session", token, { httpOnly: true, sameSite: "lax" });
  return response;
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get("session")?.value;
  const session = token ? verify(token) : null;
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json({ subject: session.subject });
}
