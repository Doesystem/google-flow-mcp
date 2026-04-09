import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";
import { AuthManager } from "../src/auth-manager.js";

describe("AuthManager", () => {
  let tmpDir: string;
  let authManager: AuthManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
    authManager = new AuthManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("hasSavedSession returns false when no auth file exists", () => {
    expect(authManager.hasSavedSession()).toBe(false);
  });

  test("saveCookies writes cookies to auth.json", async () => {
    const fakeCookies = [
      { name: "SID", value: "abc123", domain: ".google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const },
    ];
    await authManager.saveCookies(fakeCookies);
    expect(authManager.hasSavedSession()).toBe(true);
  });

  test("loadCookies returns saved cookies", async () => {
    const fakeCookies = [
      { name: "SID", value: "abc123", domain: ".google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const },
    ];
    await authManager.saveCookies(fakeCookies);
    const loaded = await authManager.loadCookies();
    expect(loaded).toEqual(fakeCookies);
  });

  test("loadCookies returns null when no session exists", async () => {
    const loaded = await authManager.loadCookies();
    expect(loaded).toBeNull();
  });
});
