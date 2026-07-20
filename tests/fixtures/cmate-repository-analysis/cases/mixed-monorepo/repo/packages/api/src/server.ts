import { createServer } from "node:http";

import { requireScope, resolve } from "./auth";

export function start(port: number) {
  const server = createServer((request, response) => {
    const principal = resolve(request.headers.authorization?.replace("Bearer ", ""));
    try {
      requireScope(principal, "reports.read");
    } catch {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, id: principal?.id }));
  });
  return server.listen(port);
}
