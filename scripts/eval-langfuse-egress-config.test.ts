import { describe, expect, test } from "vitest";
import {
  captureEnvironment,
  langfuseHost,
  observationOffset,
  readCaptureDriveConfig,
  runEgressCli,
} from "./eval-langfuse-egress.ts";
import {
  CAPTURE_DRIVE_ENV,
  CONFIG,
  OPTED_IN_ENV,
} from "./test-support/eval-langfuse-egress-test-support.ts";

describe("Langfuse egress verification", () => {
  test("drive configuration requires raw capture coordinates", () => {
    expect(() => readCaptureDriveConfig(OPTED_IN_ENV)).toThrow(
      "OPENBRAIN_CAPTURE_BASE_URL and OPENBRAIN_CAPTURE_TOKEN",
    );
  });

  test("empty-string capture vars still reach the shared aliases", () => {
    // Deployed hook-env wrappers pass VAR="${VAR:-}": unset arrives as "", not
    // absence (#525's shape). The alias fallback must engage on both.
    const config = readCaptureDriveConfig({
      ...OPTED_IN_ENV,
      OPENBRAIN_CAPTURE_BASE_URL: "",
      OPENBRAIN_CAPTURE_TOKEN: "",
      OPENBRAIN_BASE_URL: "http://127.0.0.1:3100",
      OPENBRAIN_TOKEN: "alias-token",
    });

    expect(config).toEqual({
      baseUrl: "http://127.0.0.1:3100",
      token: "alias-token",
    });
  });

  test("drive returns a non-zero configuration error before spawning an invalid child", async () => {
    const outcome = await runEgressCli(["--drive", "--tag", "run-tag"], OPTED_IN_ENV);

    expect(outcome).toEqual({
      exitCode: 2,
      error:
        "OPENBRAIN_CAPTURE_BASE_URL and OPENBRAIN_CAPTURE_TOKEN are required for --drive",
    });
  });

  test("drive child keeps declared hook settings and drops foreign Open Brain names", () => {
    const child = captureEnvironment(
      {
        ...CAPTURE_DRIVE_ENV,
        OPENBRAIN_LOCAL_CLONE: "1",
        OPENBRAIN_TRANSPORT: "typescript-only",
        OPENBRAIN_ALLOW_INSECURE_HTTP: "1",
        PATH: "/test/bin",
      },
      CONFIG,
      readCaptureDriveConfig(CAPTURE_DRIVE_ENV),
      "/scratch/watermarks.sqlite",
    );

    expect(child).toMatchObject({
      PATH: "/test/bin",
      OPENBRAIN_CAPTURE_BASE_URL: "http://127.0.0.1:3100",
      OPENBRAIN_CAPTURE_TOKEN: "capture-token",
      OPENBRAIN_ALLOW_INSECURE_HTTP: "1",
      OPENBRAIN_OBSERVATION_ENABLED: "1",
      OPENBRAIN_CAPTURE_WATERMARK_PATH: "/scratch/watermarks.sqlite",
    });
    expect(child.OPENBRAIN_LOCAL_CLONE).toBeUndefined();
    expect(child.OPENBRAIN_TRANSPORT).toBeUndefined();
  });

  test("observation watermark read falls back after a post-child database failure", async () => {
    let fallbackCalls = 0;

    const offset = await observationOffset("/watermarks.sqlite", "run-tag", {
      fileExists: async () => true,
      databaseFactory: () => {
        throw new Error("unable to open database file");
      },
      fallbackOffset: async (path, sessionKey) => {
        fallbackCalls += 1;
        expect(path).toBe("/watermarks.sqlite");
        expect(sessionKey).toBe("observe:run-tag");
        return 42;
      },
    });

    expect(offset).toBe(42);
    expect(fallbackCalls).toBe(1);
  });

  test("normalizes bare hosts and ingestion URLs identically", () => {
    expect(langfuseHost("https://langfuse.example")).toBe("https://langfuse.example");
    expect(langfuseHost("https://langfuse.example/api/public/ingestion/")).toBe(
      "https://langfuse.example",
    );
  });
});
