import { z } from "zod";

const RELAXED_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const graphUuid = z
  .string()
  .regex(RELAXED_UUID_RE, "Invalid UUID")
  .describe("Graph node UUID");
