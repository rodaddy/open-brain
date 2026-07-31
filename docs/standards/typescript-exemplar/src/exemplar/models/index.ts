/**
 * Data shapes -- Zod schemas and the types inferred from them. No behaviour.
 *
 * Every schema here is declared ONCE and used two ways: `.parse()` validates at
 * runtime, `z.infer` gives the static type. That is the whole reason for the
 * dependency -- an `interface` describes what you hope arrives and checks
 * nothing, so a malformed payload flows in and fails two hundred lines later.
 *
 * Nothing in this package performs IO, logs, or knows about an app. A model
 * that can fetch itself couples the schema to the transport and makes both
 * untestable without the other.
 */

export { CheckResult, CheckStatus, CheckTarget, TargetState } from "./check.ts";
