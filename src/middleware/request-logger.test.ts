import {
  describe,
  expect,
  test,
  mock,
  beforeEach,
  afterAll,
  spyOn,
} from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../logger.ts";
import { requestLogger } from "./request-logger.ts";

// Spy on logger.info instead of mock.module to avoid global module pollution
const loggerInfoSpy = spyOn(logger, "info");
const loggerWarnSpy = spyOn(logger, "warn");

// Helpers
function mockReq(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    method: "GET",
    path: "/health",
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    statusCode: 200,
    on(event: string, cb: () => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      return this;
    },
    _emit(event: string) {
      for (const cb of listeners[event] ?? []) cb();
    },
  } as unknown as Response & { _emit: (event: string) => void };
}

type LogCall = [string, Record<string, unknown>];

function lastInfoCall(): LogCall {
  const call = loggerInfoSpy.mock.calls[0];
  if (!call) throw new Error("No logger.info calls recorded");
  return call as unknown as LogCall;
}

describe("requestLogger middleware", () => {
  beforeEach(() => {
    loggerInfoSpy.mockClear();
    loggerWarnSpy.mockClear();
  });

  afterAll(() => {
    loggerInfoSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  test("calls next() immediately", () => {
    const req = mockReq();
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test("on res finish, logger.info is called with method, path, status, durationMs, consumerId", () => {
    const req = mockReq({ method: "POST", path: "/mcp" });
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    expect(loggerInfoSpy).toHaveBeenCalledTimes(1);
    const [message, data] = lastInfoCall();
    expect(message).toBe("request");
    expect(data).toHaveProperty("method", "POST");
    expect(data).toHaveProperty("path", "/mcp");
    expect(data).toHaveProperty("status", 200);
    expect(data).toHaveProperty("durationMs");
    expect(data).toHaveProperty("consumerId");
  });

  test("consumerId comes from req.auth.clientId when present", () => {
    const req = mockReq({ auth: { role: "admin", clientId: "admin" } });
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = lastInfoCall();
    expect(data).toHaveProperty("consumerId", "admin");
    expect(data).toHaveProperty("effectiveNamespace", "admin");
    expect(data).toHaveProperty("namespaceSource", "token");
  });

  test("delegated namespace is logged separately from token consumer", () => {
    const req = mockReq({
      auth: {
        role: "agent",
        clientId: "bilby",
        tokenClientId: "agent",
        agentId: "bilby",
        namespaceSource: "header",
      },
    });
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = lastInfoCall();
    expect(data).toHaveProperty("consumerId", "agent");
    expect(data).toHaveProperty("effectiveNamespace", "bilby");
    expect(data).toHaveProperty("namespaceSource", "X-Namespace header");
    expect(data).toHaveProperty("agentId", "bilby");
  });

  test("consumerId is 'anonymous' when req.auth is undefined", () => {
    const req = mockReq(); // no auth
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = lastInfoCall();
    expect(data).toHaveProperty("consumerId", "anonymous");
  });

  test("req.body is NOT present in log output", () => {
    const req = mockReq({ body: { secret: "should-not-appear" } });
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = lastInfoCall();
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("should-not-appear");
    expect(data).not.toHaveProperty("body");
  });

  test("req.headers.authorization is NOT present in log output", () => {
    const req = mockReq({
      headers: { authorization: "Bearer super-secret-token" },
    });
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = lastInfoCall();
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("super-secret-token");
    expect(data).not.toHaveProperty("authorization");
    expect(data).not.toHaveProperty("headers");
  });

  test("durationMs is a rounded number", () => {
    const req = mockReq();
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = lastInfoCall();
    const duration = data.durationMs as number;
    expect(typeof duration).toBe("number");
    expect(Number.isInteger(duration)).toBe(true);
  });

  test("warns with structured contract fields when a client declaration mismatches", () => {
    const req = mockReq({
      method: "POST",
      path: "/mcp",
      headers: {
        "x-ob-contract": `${"legacy-contract"};schema_hash=${"0".repeat(64)}`,
      },
    });
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).toHaveBeenCalledWith("client_contract_mismatch", {
      method: "POST",
      path: "/mcp",
      reason: "contract_or_schema_mismatch",
      declaredContractId: "legacy-contract",
      declaredSchemaHash: "0".repeat(64),
      expectedContractId: "2026-07-23.memory-tools.v23",
      expectedSchemaHash:
        "e60ea54f0797548b69722adc205377f100b685721fc69aa9b3a045ffb05bea82",
    });
  });

  test("does not warn when the client declaration matches", () => {
    const req = mockReq({
      headers: {
        "x-ob-contract":
          "2026-07-23.memory-tools.v23;schema_hash=e60ea54f0797548b69722adc205377f100b685721fc69aa9b3a045ffb05bea82",
      },
    });

    requestLogger(req, mockRes(), mock(() => {}) as NextFunction);

    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  test("repeated identical mismatched declarations warn once per bucket", () => {
    const headers = {
      "x-ob-contract": `repeat-contract;schema_hash=${"1".repeat(64)}`,
    };

    requestLogger(
      mockReq({ headers }),
      mockRes(),
      mock(() => {}) as NextFunction,
    );
    requestLogger(
      mockReq({ headers }),
      mockRes(),
      mock(() => {}) as NextFunction,
    );

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
  });

  test("does not log malformed client contract header contents", () => {
    const req = mockReq({
      headers: { "x-ob-contract": "Bearer leakmark-contract-header-secret" },
    });

    requestLogger(req, mockRes(), mock(() => {}) as NextFunction);

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(loggerWarnSpy.mock.calls[0]);
    expect(serialized).toContain("malformed_header");
    expect(serialized).not.toContain("leakmark-contract-header-secret");
  });
});
