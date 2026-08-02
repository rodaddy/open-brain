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
    capture?: Record<string, unknown>;
    expectation: Record<string, unknown>;
  }>;
}

type ServerCapabilityStatus = "implemented" | "scaffold-declared";

interface ServerParityManifest {
  id: string;
  expected_fixture_ids: string[];
  providers: string[];
  capabilities: string[];
  provider_capability_status: Record<string, Record<string, ServerCapabilityStatus>>;
}

interface ServerToolGap {
  tool: string;
  capability: string;
  reason: string;
}

interface ServerToolGapMap {
  id: string;
  source: string;
  registered_tool_count: number;
  fixture_covered_tool_count: number;
  without_parity_fixture_count: number;
  fixture_covered_tools: string[];
  without_parity_fixture: ServerToolGap[];
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
const serverToolGapMap = await readJson<ServerToolGapMap>(
  new URL("tool-gap-map.json", serverFixtureDir),
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

// Every server implementation declares the same reviewed contract identity, and
// BOTH providers now derive it from buildContract rather than asserting it. The
// rewrite's declaration used to be two string literals, so the fixture
// comparison below matched a constant against itself and reported green no
// matter what the rewrite had actually built.
//
// Deriving the identity makes that comparison honest but also makes it weak:
// two derived values agree by construction. The identity check is therefore no
// longer the load-bearing assertion for the rewrite -- `satisfaction` is. A
// contract is a promise about tools, so the question worth failing on is
// whether the provider REGISTERS what its contract names.
const serverDeclarations = SERVER_CONTRACT_PROVIDERS.map((provider) => ({
  provider,
  declaration: provider.declaration("1970-01-01T00:00:00.000Z"),
  satisfaction: provider.satisfaction?.("1970-01-01T00:00:00.000Z"),
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
for (const providerId of providerIds) {
  const statuses = serverManifest.provider_capability_status?.[providerId];
  if (!statuses) {
    errors.push(`server/parity-manifest.json: missing capability status for '${providerId}'`);
    continue;
  }
  const declaredCapabilities = Object.keys(statuses).sort();
  const expectedCapabilities = [...serverCapabilities].sort();
  if (JSON.stringify(declaredCapabilities) !== JSON.stringify(expectedCapabilities)) {
    errors.push(`server/parity-manifest.json: '${providerId}' must declare every capability exactly once`);
  }
  for (const [capability, status] of Object.entries(statuses)) {
    if (status !== "implemented" && status !== "scaffold-declared") {
      errors.push(`server/parity-manifest.json: '${providerId}' capability '${capability}' has invalid status '${String(status)}'`);
    }
  }
}
const observedServerFixtureIds = new Set<string>();
const observedServerCapabilities = new Set<string>();
const observedServerTools = new Set<string>();
const serverFixtures: ServerFixture[] = [];
let serverFixtureCount = 0;
const serverFixtureGlob = new Bun.Glob("*.fixture.json");
for await (const name of serverFixtureGlob.scan({
  cwd: serverFixtureDir.pathname,
  onlyFiles: true,
})) {
  serverFixtureCount += 1;
  const fixture = await readJson<ServerFixture>(new URL(name, serverFixtureDir));
  serverFixtures.push(fixture);
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
    if (step.tool) observedServerTools.add(step.tool);
    if (!isRecord(step.arguments)) errors.push(`${prefix} step ${index} arguments must be an object`);
    if (!isRecord(step.expectation) || !("is_error" in step.expectation)) {
      errors.push(`${prefix} step ${index} expectation must declare is_error`);
    }
    // `capture` binds a value out of this step's response for later steps to
    // substitute. Each entry must be a dot path string; anything else would be
    // silently ignored by the harness and leave the fixture asserting less than
    // it appears to.
    if (step.capture !== undefined) {
      if (!isRecord(step.capture)) {
        errors.push(`${prefix} step ${index} capture must be an object`);
      } else {
        for (const [name, path] of Object.entries(step.capture)) {
          if (typeof path !== "string" || path.length === 0) {
            errors.push(`${prefix} step ${index} capture '${name}' must be a non-empty path`);
          }
        }
      }
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

// Does each provider's registered tool set satisfy the contract it declares?
//
// This is the assertion the old gate was missing. It compared the rewrite's
// hardcoded {contractVersion, schemaHash} literals to buildContract() -- a
// constant against itself -- so it stayed green regardless of what the rewrite
// had actually built.
//
// The predicate is LEDGER-AWARE rather than absolute, and that is the design
// decision. `contracts/README.md` says parity-manifest.json "declares the
// current implementation asymmetry", and the server manifest already records
// per capability which provider has really built it (`implemented`) versus only
// declared it (`scaffold-declared`). The rewrite carries 6 scaffold-declared
// capabilities today, `citation-recall` among them. A gate that ignored that
// ledger would not measure drift; it would re-litigate a port schedule the repo
// has already written down, and the only way to green it would be to lie in the
// manifest. So this reads the declared asymmetry instead of overriding it:
//
//   - a tool whose capability the provider claims `implemented` MUST be
//     registered. Claiming it and not registering it is drift -- exactly the
//     failure the literals hid.
//   - a tool whose capability is `scaffold-declared` may be absent, and is
//     REPORTED so the remaining port surface stays visible instead of silent.
//
// Registering MORE than the contract requires is allowed: the rewrite carries
// `record_skill_usage`/`skill_usage_report` (#469), which the frozen contract
// never named. Only a shortfall against a claim can break a client.
const satisfactionNotes: string[] = [];
for (const { provider, satisfaction } of serverDeclarations) {
  if (!satisfaction) continue;
  if (satisfaction.registeredTools.length === 0) {
    errors.push(
      `${provider.id}: registry walk returned zero tools -- the walk is broken, not the registry empty`,
    );
    continue;
  }

  const statuses = serverManifest.provider_capability_status?.[provider.id] ?? {};
  // Map each tool to the capability the server fixtures file it under, so a
  // missing tool can be judged against that capability's declared status.
  const toolCapability = new Map<string, string>();
  for (const fixture of serverFixtures) {
    for (const step of fixture.steps ?? []) {
      if (step.tool && !toolCapability.has(step.tool)) {
        toolCapability.set(step.tool, fixture.capability);
      }
    }
  }

  const claimedMissing: string[] = [];
  const scaffoldMissing: string[] = [];
  for (const tool of satisfaction.missingTools) {
    const capability = toolCapability.get(tool);
    // No mapping means no fixture files this tool at all, so nothing has
    // declared it deferred -- treat it as claimed and fail rather than excuse it.
    if (capability && statuses[capability] === "scaffold-declared") {
      scaffoldMissing.push(`${tool} (${capability})`);
    } else {
      claimedMissing.push(
        capability ? `${tool} (${capability})` : `${tool} (unmapped)`,
      );
    }
  }

  if (claimedMissing.length > 0) {
    errors.push(
      `${provider.id}: registry does not satisfy the contract it declares -- ${claimedMissing.length} of ${satisfaction.requiredTools.length} required tool(s) missing while their capability is claimed implemented: ${claimedMissing.join(", ")}`,
    );
  }
  if (scaffoldMissing.length > 0) {
    satisfactionNotes.push(
      `${provider.id}: ${scaffoldMissing.length} contract-required tool(s) still unported, each covered by a scaffold-declared capability: ${scaffoldMissing.join(", ")}`,
    );
  }
  const extra = satisfaction.registeredTools.filter(
    (tool) => !satisfaction.requiredTools.includes(tool),
  );
  if (extra.length > 0) {
    satisfactionNotes.push(
      `${provider.id}: registers ${extra.length} tool(s) beyond the frozen contract (allowed): ${extra.join(", ")}`,
    );
  }
}

const toolSourceDir = new URL("../src/tools/", import.meta.url);
const toolSourceGlob = new Bun.Glob("*.ts");
const registeredServerTools = new Set<string>();
for await (const name of toolSourceGlob.scan({
  cwd: toolSourceDir.pathname,
  onlyFiles: true,
})) {
  const source = await Bun.file(new URL(name, toolSourceDir)).text();
  for (const match of source.matchAll(
    /server\.registerTool\(\s*["'`]([^"'`]+)["'`]/g,
  )) {
    const tool = match[1];
    if (!tool) continue;
    registeredServerTools.add(tool);
  }
}

const declaredCoveredTools = new Set(serverToolGapMap.fixture_covered_tools ?? []);
const declaredGapTools = new Set<string>();
for (const entry of serverToolGapMap.without_parity_fixture ?? []) {
  if (!entry.tool || entry.tool.length === 0) {
    errors.push("server/tool-gap-map.json: every gap needs a tool name");
    continue;
  }
  if (declaredGapTools.has(entry.tool)) {
    errors.push(`server/tool-gap-map.json: duplicate gap tool '${entry.tool}'`);
  }
  declaredGapTools.add(entry.tool);
  if (!entry.capability || entry.capability.length === 0) {
    errors.push(`server/tool-gap-map.json: '${entry.tool}' needs a capability`);
  }
  if (isPlaceholderReason(entry.reason)) {
    errors.push(`server/tool-gap-map.json: '${entry.tool}' needs a non-placeholder reason`);
  }
}

const observedToolsSorted = [...observedServerTools].sort();
const declaredCoveredSorted = [...declaredCoveredTools].sort();
if (JSON.stringify(declaredCoveredSorted) !== JSON.stringify(observedToolsSorted)) {
  errors.push(
    "server/tool-gap-map.json: fixture_covered_tools must exactly match tools exercised by server fixtures",
  );
}
for (const tool of declaredCoveredTools) {
  if (declaredGapTools.has(tool)) {
    errors.push(`server/tool-gap-map.json: '${tool}' is both covered and listed as a gap`);
  }
}

const mappedServerTools = new Set([...declaredCoveredTools, ...declaredGapTools]);
const registeredToolsSorted = [...registeredServerTools].sort();
const mappedToolsSorted = [...mappedServerTools].sort();
if (JSON.stringify(mappedToolsSorted) !== JSON.stringify(registeredToolsSorted)) {
  errors.push(
    "server/tool-gap-map.json: covered tools plus gaps must exactly match current-src registrations",
  );
}
if (serverToolGapMap.registered_tool_count !== registeredServerTools.size) {
  errors.push("server/tool-gap-map.json: registered_tool_count does not match current-src");
}
if (serverToolGapMap.fixture_covered_tool_count !== declaredCoveredTools.size) {
  errors.push("server/tool-gap-map.json: fixture_covered_tool_count does not match its tool list");
}
if (serverToolGapMap.without_parity_fixture_count !== declaredGapTools.size) {
  errors.push("server/tool-gap-map.json: without_parity_fixture_count does not match its gap list");
}

if (errors.length > 0) {
  console.error(
    `Contract parity check failed with ${errors.length} violation(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

for (const note of satisfactionNotes) console.log(`note: ${note}`);

const satisfactionSummary = serverDeclarations
  .filter((entry) => entry.satisfaction)
  .map((entry) => {
    const { registeredTools, requiredTools, missingTools } = entry.satisfaction!;
    const met = requiredTools.length - missingTools.length;
    return `${entry.provider.id} registers ${registeredTools.length} tools covering ${met}/${requiredTools.length} contract-required${missingTools.length > 0 ? ` (${missingTools.length} scaffold-declared, not yet ported)` : ""}`;
  })
  .join("; ");

console.log(
  `Contract parity check passed: ${fixtureCount + serverFixtureCount} fixtures across ${capabilityMap.size + serverCapabilities.size} capabilities and ${serverDeclarations.length} server providers; ${observedServerTools.size}/${registeredServerTools.size} current-src MCP tools fixture-covered with ${declaredGapTools.size} explicit gaps${satisfactionSummary ? `; ${satisfactionSummary}` : ""}.`,
);
