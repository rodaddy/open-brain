import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { Request, Response, NextFunction } from "express";

// Mock logger before importing the module under test
const mockLoggerInfo = mock(() => {});
mock.module("../logger.ts", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

const { requestLogger } = await import("./request-logger.ts");

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

describe("requestLogger middleware", () => {
  beforeEach(() => {
    mockLoggerInfo.mockClear();
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

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const [message, data] = mockLoggerInfo.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
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

    const [, data] = mockLoggerInfo.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(data).toHaveProperty("consumerId", "admin");
  });

  test("consumerId is 'anonymous' when req.auth is undefined", () => {
    const req = mockReq(); // no auth
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = mockLoggerInfo.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(data).toHaveProperty("consumerId", "anonymous");
  });

  test("req.body is NOT present in log output", () => {
    const req = mockReq({ body: { secret: "should-not-appear" } });
    const res = mockRes();
    const next = mock(() => {});

    requestLogger(req, res, next as NextFunction);
    (res as any)._emit("finish");

    const [, data] = mockLoggerInfo.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
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

    const [, data] = mockLoggerInfo.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
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

    const [, data] = mockLoggerInfo.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    const duration = data.durationMs as number;
    expect(typeof duration).toBe("number");
    expect(Number.isInteger(duration)).toBe(true);
  });
});
