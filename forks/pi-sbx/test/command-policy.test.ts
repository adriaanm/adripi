import { describe, expect, it } from "vitest";
import { isCommandExcluded, splitCommandLeaves } from "../src/command-policy.ts";

describe("command policy", () => {
  it("requires every compound leaf to match broad exclusions", () => {
    expect(isCommandExcluded("docker ps && curl example.com", ["docker:*"])).toBe(false);
    expect(isCommandExcluded("docker ps && curl example.com", ["docker:*", "curl:*"])).toBe(true);
  });

  it("allows an exact compound command", () => {
    expect(isCommandExcluded("docker ps && curl example.com", ["docker ps && curl example.com"])).toBe(true);
  });

  it("strips leading environment variables and safe wrappers", () => {
    expect(isCommandExcluded("timeout 30 FOO=bar docker ps", ["docker:*"])).toBe(true);
    expect(isCommandExcluded("env FOO=bar docker ps", ["docker:*"])).toBe(true);
  });

  it("fails closed for complex or malformed shell syntax", () => {
    expect(isCommandExcluded("docker $(curl example.com)", ["docker:*"])).toBe(false);
    expect(isCommandExcluded("docker `curl example.com`", ["docker:*"])).toBe(false);
    expect(isCommandExcluded("docker <<EOF", ["docker:*"])).toBe(false);
    expect(splitCommandLeaves("echo 'unterminated").safe).toBe(false);
  });

  it("fails closed on unquoted redirection", () => {
    expect(isCommandExcluded("docker ps > ~/.zshrc", ["docker:*"])).toBe(false);
    expect(isCommandExcluded("docker ps >> log.txt", ["docker:*"])).toBe(false);
    expect(isCommandExcluded("docker load < image.tar", ["docker:*"])).toBe(false);
    expect(isCommandExcluded("echo '>' quoted", ["echo:*"])).toBe(true);
    expect(isCommandExcluded("docker ps > ~/.zshrc", ["docker ps > ~/.zshrc"])).toBe(true);
  });

  it("splits quotes without splitting quoted operators", () => {
    expect(splitCommandLeaves("printf 'a|b' | sed 's/a/c/'")).toEqual({
      safe: true,
      leaves: ["printf 'a|b'", "sed 's/a/c/'"],
    });
  });
});
