import { SERVER_CONTRACT_PROVIDERS } from "./server-contract-providers.ts";

type Runtime = "both" | "python" | "ts";
type PythonStatus = "implemented";
type TsStatus = "pending" | "implemented" | "runtime-specific";

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
  expected_fixture_ids: Record<string, Runtime>;
  capabilities: CapabilityEntry[];
  not_yet_extracted?: Array<{
    capability: string;
    scenario: string;
    reason: string;
  }>;
}

interface ServerFixture {
  id: string;
  description: string;
  capability: string;
  providers: string[];
  auth: Record<string, unknown>;
  steps: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    expectation: Record<string, unknown>;
  }>;
}

interface ServerParityManifest {
  id: string;
  expected_fixture_ids: string[];
  providers: string[];
  capabilities: string[];
}

const PLACEHOLDER_REASONS = new Set(["-", "n/a", "na", "none", "todo", "tbd"]);
const CONSUMER_ALLOWLIST = new Set(["python", "ts"]);

const fixtureDir = new URL("./memory/", import.meta.url);
const serverFixtureDir = new URL("./server/", import.meta.url);
const errors: string[] = [];

function isPlaceholderReason(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return !normalized || PLACEHOLDER_REASONS.has(normalized);
}

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
const serverManifest = await readJson<ServerParityManifest>(
  new URL("parity-manifest.json", serverFixtureDir),
);
if (!Array.isArray(manifest.capabilities)) {
  errors.push("parity-manifest.json: capabilities must be an array");
}

// The parity path filter is the single source the pre-push hook and the
// CI/PR-body change-detection steps read; an empty or missing file would
// silently disable every path-gated parity check.
const parityPathsFile = Bun.file(new URL("parity-paths.txt", import.meta.url));
const parityPaths = (await parityPathsFile.exists())
  ? (await parityPathsFile.text())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  : [];
if (parityPaths.length === 0) {
  errors.push(
    "contracts/parity-paths.txt must exist and list at least one path prefix",
  );
}

const expectedFixtureIds = isRecord(manifest.expected_fixture_ids)
  ? manifest.expected_fixture_ids
  : {};
if (Object.keys(expectedFixtureIds).length === 0) {
  errors.push(
    "parity-manifest.json: expected_fixture_ids must map every fixture id to its runtime",
  );
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
  if (
    entry.ts !== "pending" &&
    entry.ts !== "implemented" &&
    entry.ts !== "runtime-specific"
  ) {
    errors.push(
      `parity-manifest.json: '${entry.capability}' has invalid ts status '${String(entry.ts)}'`,
    );
  }
  if (entry.ts === "runtime-specific" && isPlaceholderReason(entry.reason)) {
    errors.push(
      `parity-manifest.json: runtime-specific capability '${entry.capability}' needs a non-placeholder reason`,
    );
  }
}

// Every server implementation declares the same reviewed contract identity.
// The running src/ provider derives it from buildContract; the rewrite provider
// is declaration-only until its real schemas and handlers arrive.
const serverDeclarations = SERVER_CONTRACT_PROVIDERS.map((provider) => ({
  provider,
  declaration: provider.declaration("1970-01-01T00:00:00.000Z"),
}));

const fixtureGlob = new Bun.Glob("*.fixture.json");
const fixtureIds = new Set<string>();
const fixtureCapabilities = new Set<string>();
const tsConsumedCapabilities = new Set<string>();
const fixtures: Fixture[] = [];
let fixtureCount = 0;
let contractDeclarationChecked = false;

for await (const name of fixtureGlob.scan({
  cwd: fixtureDir.pathname,
  onlyFiles: true,
})) {
  fixtureCount += 1;
  const fixture = await readJson<Fixture>(new URL(name, fixtureDir));
  fixtures.push(fixture);
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
  const expectedRuntime = expectedFixtureIds[fixture.id];
  if (fixture.id?.trim() && expectedRuntime === undefined) {
    errors.push(
      `${prefix} fixture id '${fixture.id}' is absent from parity-manifest.json expected_fixture_ids`,
    );
  } else if (
    expectedRuntime !== undefined &&
    expectedRuntime !== fixture.runtime
  ) {
    errors.push(
      `${prefix} runtime '${String(fixture.runtime)}' does not match expected_fixture_ids runtime '${String(expectedRuntime)}'`,
    );
  }
  if (!fixture.description?.trim()) {
    errors.push(`${prefix} description must be non-empty`);
  }
  if (!fixture.capability?.trim()) {
    errors.push(`${prefix} capability must be non-empty`);
  }
  fixtureCapabilities.add(fixture.capability);
  if (fixture.consumers?.includes("ts")) {
    tsConsumedCapabilities.add(fixture.capability);
  }
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
  for (const consumer of fixture.consumers ?? []) {
    if (!CONSUMER_ALLOWLIST.has(consumer)) {
      errors.push(`${prefix} unknown consumer '${String(consumer)}'`);
    }
  }
  if (fixture.runtime === "ts" && fixture.consumers?.includes("python")) {
    errors.push(
      `${prefix} TS-only fixture '${fixture.id}' must not declare a Python consumer`,
    );
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
  if (
    fixture.capability === "contract-declaration" &&
    isRecord(fixture.request)
  ) {
    contractDeclarationChecked = true;
    for (const { provider, declaration } of serverDeclarations) {
      if (fixture.request.contract_id !== declaration.contractVersion) {
        errors.push(
          `${prefix} declared contract_id '${String(fixture.request.contract_id)}' does not match ${provider.id} contract '${declaration.contractVersion}'`,
        );
      }
      if (fixture.request.schema_hash !== declaration.schemaHash) {
        errors.push(
          `${prefix} declared schema_hash '${String(fixture.request.schema_hash)}' does not match ${provider.id} schema_hash '${declaration.schemaHash}'`,
        );
      }
    }
  }
}

if (fixtureCount === 0)
  errors.push("contracts/memory: no *.fixture.json files found");
if (!contractDeclarationChecked) {
  errors.push(
    "contracts/memory: no contract-declaration fixture asserts the live TS schema_hash",
  );
}
for (const id of Object.keys(expectedFixtureIds)) {
  if (!fixtureIds.has(id)) {
    errors.push(
      `parity-manifest.json: expected fixture id '${id}' has no fixture file`,
    );
  }
}
for (const capability of capabilityMap.keys()) {
  if (!fixtureCapabilities.has(capability)) {
    errors.push(
      `parity-manifest.json: capability '${capability}' has no extracted fixture`,
    );
  }
}
for (const [capability, entry] of capabilityMap) {
  if (entry.ts === "implemented" && !tsConsumedCapabilities.has(capability)) {
    errors.push(
      `parity-manifest.json: ts-implemented capability '${capability}' has no fixture declared as consumed by ts`,
    );
  }
}
for (const fixture of fixtures) {
  const capability = capabilityMap.get(fixture.capability);
  if (
    fixture.runtime === "both" &&
    capability?.ts === "implemented" &&
    !fixture.consumers?.includes("ts")
  ) {
    errors.push(
      `contracts/memory: both-runtime fixture '${fixture.id}' under TS-implemented capability '${fixture.capability}' must declare a TS consumer`,
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

const providerIds = serverDeclarations.map(({ provider }) => provider.id);
if (JSON.stringify(serverManifest.providers) !== JSON.stringify(providerIds)) {
  errors.push(
    `server/parity-manifest.json: providers must be ${JSON.stringify(providerIds)}`,
  );
}
const expectedServerFixtureIds = new Set(serverManifest.expected_fixture_ids ?? []);
const serverCapabilities = new Set(serverManifest.capabilities ?? []);
const observedServerFixtureIds = new Set<string>();
const observedServerCapabilities = new Set<string>();
let serverFixtureCount = 0;
const serverFixtureGlob = new Bun.Glob("*.fixture.json");
for await (const name of serverFixtureGlob.scan({
  cwd: serverFixtureDir.pathname,
  onlyFiles: true,
})) {
  serverFixtureCount += 1;
  const fixture = await readJson<ServerFixture>(new URL(name, serverFixtureDir));
  const prefix = `server/${name}:`;
  observedServerFixtureIds.add(fixture.id);
  observedServerCapabilities.add(fixture.capability);
  if (!expectedServerFixtureIds.has(fixture.id)) {
    errors.push(`${prefix} fixture id '${fixture.id}' is absent from the server manifest`);
  }
  if (!serverCapabilities.has(fixture.capability)) {
    errors.push(`${prefix} capability '${fixture.capability}' is absent from the server manifest`);
  }
  if (JSON.stringify(fixture.providers) !== JSON.stringify(providerIds)) {
    errors.push(`${prefix} providers must declare current-src and server-rewrite-scaffold`);
  }
  if (!fixture.description) errors.push(`${prefix} description must be non-empty`);
  if (!isRecord(fixture.auth)) errors.push(`${prefix} auth must be an object`);
  if (!Array.isArray(fixture.steps) || fixture.steps.length === 0) {
    errors.push(`${prefix} steps must contain an observed current-src call`);
    continue;
  }
  for (const [index, step] of fixture.steps.entries()) {
    if (!step.tool) errors.push(`${prefix} step ${index} tool must be non-empty`);
    if (!isRecord(step.arguments)) errors.push(`${prefix} step ${index} arguments must be an object`);
    if (!isRecord(step.expectation) || !("is_error" in step.expectation)) {
      errors.push(`${prefix} step ${index} expectation must declare is_error`);
    }
  }
}
for (const id of expectedServerFixtureIds) {
  if (!observedServerFixtureIds.has(id)) {
    errors.push(`server/parity-manifest.json: expected fixture id '${id}' has no fixture file`);
  }
}
for (const capability of serverCapabilities) {
  if (!observedServerCapabilities.has(capability)) {
    errors.push(`server/parity-manifest.json: capability '${capability}' has no fixture`);
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
  `Contract parity check passed: ${fixtureCount + serverFixtureCount} fixtures across ${capabilityMap.size + serverCapabilities.size} capabilities and ${serverDeclarations.length} server providers.`,
);
