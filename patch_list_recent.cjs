const fs = require('fs');
const content = fs.readFileSync('src/tools/list-recent.ts', 'utf8');

// Replace the inlined constants with the import statement
let updated = content.replace(
  /const ALL_TABLES[\s\S]*?const TABLE_ALIAS: Record<Table, string> = \{\n  thoughts: "t",\n  decisions: "d",\n  relationships: "r",\n  projects: "p",\n  sessions: "s",\n\};\n/g,
  `import {
  ALL_TABLES,
  SOURCE_LABELS,
  CONTENT_PREVIEW,
  TABLE_ALIAS,
  VALID_TIERS,
} from "./table-constants.ts";\n`
);

// Add VALID_TIERS check back into buildTableSelect
updated = updated.replace(
  /function buildTableSelect\(\n  table: Table,\n  includeArchived: boolean,\n  tier\?: Tier,\n\): string \{\n  const alias/g,
  `function buildTableSelect(
  table: Table,
  includeArchived: boolean,
  tier?: Tier,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(\`Invalid tier: \${tier}\`);
  const alias`
);

// Add VALID_TIERS check into buildCountSelect as well for defense in depth
updated = updated.replace(
  /function buildCountSelect\(\n  table: Table,\n  includeArchived: boolean,\n  tier\?: Tier,\n\): string \{\n  const alias/g,
  `function buildCountSelect(
  table: Table,
  includeArchived: boolean,
  tier?: Tier,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(\`Invalid tier: \${tier}\`);
  const alias`
);

fs.writeFileSync('src/tools/list-recent.ts', updated);
console.log('list-recent.ts patched successfully.');
