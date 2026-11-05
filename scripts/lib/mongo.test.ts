import { describe, expect, it } from "vitest";
import { linuxTarget, MONGOD_VERSION, mongodUrl, mongoTargetFrom } from "./mongo.ts";

const release = (id: string, version: string, like = "") =>
  `ID=${id}\nVERSION_ID="${version}"\n${like ? `ID_LIKE="${like}"\n` : ""}NAME="whatever"\n`;

describe("linuxTarget", () => {
  it.each([
    [release("ubuntu", "24.04"), "x86_64", "ubuntu2404"],
    [release("ubuntu", "25.10"), "x86_64", "ubuntu2404"],
    [release("ubuntu", "22.04"), "aarch64", "ubuntu2204"],
    [release("ubuntu", "20.04"), "x86_64", "ubuntu2004"],
    [release("linuxmint", "21", "ubuntu debian"), "x86_64", "ubuntu2204"],
    [release("debian", "12"), "x86_64", "debian12"],
    [release("debian", "13"), "x86_64", "debian12"],
    [release("debian", "12"), "aarch64", "ubuntu2204"],
    [release("rhel", "8.9", "fedora"), "x86_64", "rhel8"],
    [release("rocky", "9.4", "rhel centos fedora"), "x86_64", "rhel93"],
    [release("almalinux", "10.0", "rhel centos fedora"), "aarch64", "rhel10"],
    [release("fedora", "42"), "x86_64", "rhel10"],
    [release("amzn", "2023", "fedora"), "x86_64", "amazon2023"],
    ["", "x86_64", "ubuntu2204"],
  ] as const)("%j on %s is %s", (osRelease, arch, expected) => {
    expect(linuxTarget(osRelease, arch)).toBe(expected);
  });
});

describe("mongodUrl", () => {
  it("covers macOS on both architectures", () => {
    expect(mongodUrl("darwin", "arm64", "")).toBe(
      `https://fastdl.mongodb.org/osx/mongodb-macos-arm64-${MONGOD_VERSION}.tgz`,
    );
    expect(mongodUrl("darwin", "x64", "")).toContain("mongodb-macos-x86_64");
  });
  it("uses the distro build on Linux", () => {
    expect(mongodUrl("linux", "x64", release("ubuntu", "24.04"))).toBe(
      `https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2404-${MONGOD_VERSION}.tgz`,
    );
    expect(mongodUrl("linux", "arm64", release("ubuntu", "22.04"))).toContain(
      "mongodb-linux-aarch64-ubuntu2204",
    );
  });
  it("is null where there is no build", () => {
    expect(mongodUrl("win32", "x64", "")).toBeNull();
    expect(mongodUrl("linux", "riscv64", "")).toBeNull();
  });
});

describe("mongoTargetFrom", () => {
  it("defaults to the local port, and reads MONGODB_URI", () => {
    expect(mongoTargetFrom({})).toMatchObject({ host: "127.0.0.1", port: 27017, local: true });
    expect(mongoTargetFrom({ MONGODB_URI: "mongodb://127.0.0.1:27999/x" }).port).toBe(27999);
  });
});
