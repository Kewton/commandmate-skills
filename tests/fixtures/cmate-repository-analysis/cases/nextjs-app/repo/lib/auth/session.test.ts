import { describe, expect, it } from "vitest";

import { issue, verify } from "./session";

describe("session", () => {
  it("round-trips an issued token", () => {
    const token = issue("user-1", 1_000);
    expect(verify(token, 1_000)?.subject).toBe("user-1");
  });

  it("rejects an expired token", () => {
    const token = issue("user-1", 1_000);
    expect(verify(token, 1_000 + 3_600_001)).toBeNull();
  });
});
