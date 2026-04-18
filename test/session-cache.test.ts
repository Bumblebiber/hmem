import { describe, it, expect } from "vitest";
import { SessionCache } from "../src/session-cache.js";

describe("SessionCache.bindSession", () => {
  it("resets cache when session id changes", () => {
    const c = new SessionCache();
    c.bindSession("session-A");
    c.registerDelivered(["P0001", "P0002"]);
    expect(c.size).toBe(2);

    c.bindSession("session-B");
    expect(c.size).toBe(0);
    expect(c.readCount).toBe(0);
  });

  it("keeps cache when same session id is rebound", () => {
    const c = new SessionCache();
    c.bindSession("session-A");
    c.registerDelivered(["P0001"]);
    c.bindSession("session-A");
    expect(c.size).toBe(1);
  });

  it("is a no-op for undefined session id", () => {
    const c = new SessionCache();
    c.bindSession("session-A");
    c.registerDelivered(["P0001"]);
    c.bindSession(undefined);
    expect(c.size).toBe(1);
  });

  it("accepts first binding without reset", () => {
    const c = new SessionCache();
    c.registerDelivered(["P0001"]);
    c.bindSession("session-A");
    expect(c.size).toBe(1);
  });
});
