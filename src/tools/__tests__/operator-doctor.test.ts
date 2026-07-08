import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registerOperatorDoctor } from "../operator-doctor.ts";
import { resetOperatorDoctorCache } from "../../operator-doctor.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

function makePool() {
  return {
    query: async (sql: string) => {
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM _migrations")) {
        return { rows: [{ filename: "001_init.sql" }] };
      }
      return { rows: [] };
    },
  };
}

describe("operator_doctor", () => {
  beforeEach(() => {
    resetOperatorDoctorCache();
  });
  afterEach(() => {
    resetOperatorDoctorCache();
  });

  it("allows admin clients to read doctor status", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "operator" };
    const { client, cleanup } = await setupMcpClient(
      registerOperatorDoctor,
      makePool(),
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "operator_doctor",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.contract_version).toBe("2026-07-08.operator-doctor.v2");
      expect(parsed.runtime.service).toBe("open-brain");
      expect(parsed.database.connected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("denies non-privileged clients", async () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupMcpClient(
      registerOperatorDoctor,
      makePool(),
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "operator_doctor",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("admin or ob-admin role required");
    } finally {
      await cleanup();
    }
  });
});
