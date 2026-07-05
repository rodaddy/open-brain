import { afterEach, describe, expect, it } from "bun:test";
import {
  canonicalNamespace,
  isSharedNamespace,
  physicalNamespace,
  sharedNamespaceConfig,
} from "./shared-namespace.ts";

const ENV_KEYS = [
  "SHARED_NAMESPACE_CANONICAL",
  "SHARED_NAMESPACE_PHYSICAL",
  "SHARED_NAMESPACE_LEGACY",
  "OPENBRAIN_SHARED_NAMESPACE",
  "OPENBRAIN_LEGACY_SHARED_NAMESPACE",
];

const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

describe("shared namespace config", () => {
  it("defaults canonical/physical to shared-kb and retires the legacy namespace (#167)", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    expect(sharedNamespaceConfig()).toMatchObject({
      canonicalSharedNamespace: "shared-kb",
      physicalSharedNamespace: "shared-kb",
      sharedNamespace: "shared-kb",
      // #167: no default legacy shared namespace anymore; collab is retired.
      legacySharedNamespace: "",
      legacyFallbackEnabled: false,
    });
    // With collab retired, it is NOT canonicalized to shared-kb by default —
    // it is treated as an ordinary (frozen) namespace name.
    expect(canonicalNamespace("collab")).toBe("collab");
    expect(physicalNamespace("shared-kb")).toBe("shared-kb");
  });

  it("still canonicalizes an explicitly configured legacy namespace (#167 escape hatch)", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.SHARED_NAMESPACE_LEGACY = "collab";
    expect(sharedNamespaceConfig().legacySharedNamespace).toBe("collab");
    expect(canonicalNamespace("collab")).toBe("shared-kb");
  });

  it("supports explicit canonical, physical, and legacy namespace env names", () => {
    process.env.SHARED_NAMESPACE_CANONICAL = "public-shared";
    process.env.SHARED_NAMESPACE_PHYSICAL = "shared_storage";
    process.env.SHARED_NAMESPACE_LEGACY = "old_collab";

    expect(sharedNamespaceConfig()).toMatchObject({
      canonicalSharedNamespace: "public-shared",
      physicalSharedNamespace: "shared_storage",
      sharedNamespace: "shared_storage",
      legacySharedNamespace: "old_collab",
    });
    expect(isSharedNamespace("public-shared")).toBe(true);
    expect(isSharedNamespace("shared_storage")).toBe(true);
    expect(physicalNamespace("public-shared")).toBe("shared_storage");
    expect(canonicalNamespace("shared_storage")).toBe("public-shared");
    expect(canonicalNamespace("old_collab")).toBe("public-shared");
  });
});
