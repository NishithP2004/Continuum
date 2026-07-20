import { afterEach, describe, expect, it } from "vitest";
import { configuredApiUrl, isLocalServiceUrl, saveApiUrl, validateApiUrl } from "../lib/config";
import { CONTINUUM_AUTH0_SCOPES } from "../lib/auth";

afterEach(() => window.localStorage.clear());

describe("Continuum API URL policy", () => {
  it("distinguishes local chat services from synchronized remote services", () => {
    expect(isLocalServiceUrl("http://127.0.0.1:43117")).toBe(true);
    expect(isLocalServiceUrl("https://collector.localhost")).toBe(true);
    expect(isLocalServiceUrl("https://continuum.example")).toBe(false);
  });
  it("requests every scope used by the authenticated companion", () => {
    expect(CONTINUUM_AUTH0_SCOPES.split(" ")).toEqual(expect.arrayContaining([
      "openid", "profile", "email", "offline_access", "context:read",
      "sync:read", "sync:write", "devices:write", "keys:write"
    ]));
  });

  it.each([
    ["https://continuum.example/", "https://continuum.example"],
    ["http://localhost:43117/", "http://localhost:43117"],
    ["http://collector.localhost:43117", "http://collector.localhost:43117"],
    ["http://127.0.0.42:43117/", "http://127.0.0.42:43117"],
    ["http://[::1]:43117/", "http://[::1]:43117"]
  ])("allows protected or loopback service URL %s", (input, expected) => {
    expect(validateApiUrl(input)).toBe(expected);
  });

  it.each([
    "http://continuum.example",
    "http://127.evil.example",
    "ws://localhost:43117",
    "https://user:secret@continuum.example",
    "https://continuum.example?token=secret",
    "https://continuum.example/#settings"
  ])("rejects unsafe service URL %s", (input) => {
    expect(() => saveApiUrl(input)).toThrow();
    expect(window.localStorage.getItem("continuum.apiUrl")).toBeNull();
  });

  it("stores only the validated normalized endpoint", () => {
    saveApiUrl("  https://continuum.example/api/  ");
    expect(configuredApiUrl()).toBe("https://continuum.example/api");
    expect(window.localStorage.getItem("continuum.apiUrl")).toBe("https://continuum.example/api");
  });

  it("discards a legacy unsafe stored endpoint instead of contacting it", () => {
    window.localStorage.setItem("continuum.apiUrl", "http://continuum.example");
    expect(configuredApiUrl()).toBe(window.location.origin);
    expect(window.localStorage.getItem("continuum.apiUrl")).toBeNull();
  });
});
