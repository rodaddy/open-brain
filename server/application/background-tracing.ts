// The module moved to server/observability/background-tracing.ts in issue 1210,
// so domain, maintenance and observability stop importing upward. This path
// stays so application-tier composition keeps its import.
export * from "../observability/background-tracing.ts";
