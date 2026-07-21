type Runtime = "both" | "python" | "ts";
type PythonStatus = "implemented";
type TsStatus = "pending" | "runtime-specific";

interface Fixture {
  id: string;
  description: string;
  capability: string;
  runtime: Runtime;
  consumers: string[];
  request: Record<string, unknown>;
  expectation: Record<string, unknown>;
}

interface CapabilityEntry {
  capability: string;
  python: PythonStatus;
  ts: TsStatus;
  reason?: string;
}

interface ParityManifest {
  id: string;
  capabilities: CapabilityEntry[];
  not_yet_extracted?: Array<{
    capability: string;
    scenario: string;
    reason: string;
  }>;
}

const fixtureDir = new URL("./memory/", import.meta.url);
const errors: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<T>(url: URL): Promise<T> {
  try {
    return (await Bun.file(url).json()) as T;
  } catch (error) {
    throw new Error(`${url.pathname}: ${String(error)}`);
  }
}

const manifest = await readJson<ParityManifest>(
  new URL("parity-manifest.json", fixtureDir),
);
if (!Array.isArray(manifest.capabilities)) {
  errors.push("parity-manifest.json: capabilities must be an array");
}

const capabilityMap = new Map<string, CapabilityEntry>();
for (const entry of manifest.capabilities ?? []) {
  if (!entry.capability) {
    errors.push("parity-manifest.json: capability name must be non-empty");
    continue;
  }
  if (capabilityMap.has(entry.capability)) {
    errors.push(
      `parity-manifest.json: duplicate capability '${entry.capability}'`,
    );
  }
  capabilityMap.set(entry.capability, entry);
  if (entry.python !== "implemented") {
    errors.push(
      `parity-manifest.json: '${entry.capability}' has invalid python status '${String(entry.python)}'`,
    );
  }
  if (entry.ts !== "pending" && entry.ts !== "runtime-specific") {
    errors.push(
      `parity-manifest.json: '${entry.capability}' has invalid ts status '${String(entry.ts)}'`,
    );
  }
  if (entry.ts === "runtime-specific" && !entry.reason?.trim()) {
    errors.push(
      `parity-manifest.json: runtime-specific capability '${entry.capability}' needs a reason`,
    );
  }
}

const fixtureGlob = new Bun.Glob("*.fixture.json");
const fixtureIds = new Set<string>();
const fixtureCapabilities = new Set<string>();
let fixtureCount = 0;

for await (const name of fixtureGlob.scan({
  cwd: fixtureDir.pathname,
  onlyFiles: true,
})) {
  fixtureCount += 1;
  const fixture = await readJson<Fixture>(new URL(name, fixtureDir));
  const prefix = `${name}:`;
  for (const key of [
    "id",
    "description",
    "capability",
    "runtime",
    "request",
    "expectation",
  ] as const) {
    if (!(key in fixture)) errors.push(`${prefix} missing '${key}'`);
  }
  if (!fixture.id?.trim()) errors.push(`${prefix} id must be non-empty`);
  if (fixtureIds.has(fixture.id)) {
    errors.push(`${prefix} duplicate fixture id '${fixture.id}'`);
  }
  fixtureIds.add(fixture.id);
  if (!fixture.description?.trim()) {
    errors.push(`${prefix} description must be non-empty`);
  }
  if (!fixture.capability?.trim()) {
    errors.push(`${prefix} capability must be non-empty`);
  }
  fixtureCapabilities.add(fixture.capability);
  const manifestEntry = capabilityMap.get(fixture.capability);
  if (!manifestEntry) {
    errors.push(
      `${prefix} capability '${fixture.capability}' is absent from parity-manifest.json`,
    );
  }
  if (!["both", "python", "ts"].includes(fixture.runtime)) {
    errors.push(`${prefix} invalid runtime '${String(fixture.runtime)}'`);
  }
  if (!Array.isArray(fixture.consumers)) {
    errors.push(`${prefix} consumers must be an array`);
  }
  if (
    (fixture.runtime === "both" || fixture.runtime === "python") &&
    !fixture.consumers?.includes("python")
  ) {
    errors.push(
      `${prefix} ${fixture.runtime} fixture '${fixture.id}' is not declared as consumed by Python`,
    );
  }
  if (fixture.runtime === "ts" && manifestEntry?.ts !== "runtime-specific") {
    errors.push(
      `${prefix} TS-only fixture '${fixture.id}' requires a runtime-specific manifest entry`,
    );
  }
  if (!isRecord(fixture.request)) {
    errors.push(`${prefix} request must be an object`);
  }
  if (!isRecord(fixture.expectation)) {
    errors.push(`${prefix} expectation must be an object`);
  }
}

if (fixtureCount === 0)
  errors.push("contracts/memory: no *.fixture.json files found");
for (const capability of capabilityMap.keys()) {
  if (!fixtureCapabilities.has(capability)) {
    errors.push(
      `parity-manifest.json: capability '${capability}' has no extracted fixture`,
    );
  }
}
for (const pending of manifest.not_yet_extracted ?? []) {
  if (!pending.capability || !pending.scenario || !pending.reason) {
    errors.push(
      "parity-manifest.json: not_yet_extracted entries require capability, scenario, and reason",
    );
  }
}

if (errors.length > 0) {
  console.error(
    `Contract parity check failed with ${errors.length} violation(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Contract parity check passed: ${fixtureCount} fixtures across ${capabilityMap.size} capabilities.`,
);
