import { readRecentTurns } from "/Users/rico/.local/share/openbrain-memory/adapters/versions/sha256-cd5fb4e4d7f940f5ec0cb5b6ac4bf5ce615d22ebb566d27f665bfa36abfba3a2/ob-memory-provider/raw-turns.ts";

const T =
  "/Users/rico/.claude/projects/-Volumes-ThunderBolt-Development-open-brain/1a8a6f53-d172-4c00-abca-0e7b6caaa1c7.jsonl";

const old8 = readRecentTurns(T, { limit: 8 });
const now = readRecentTurns(T);

const humans = (rows: any[]) => rows.filter((r) => r.is_human_prompt).length;

console.log(`old default (8):  ${old8.length} turns, ${humans(old8)} operator`);
console.log(`new default:      ${now.length} turns, ${humans(now)} operator`);
console.log(
  `\nfirst turn now:   ${now[0]?.role} "${(now[0]?.content ?? "").slice(0, 60).replace(/\n/g, " ")}..."`,
);
console.log(
  `chronological:    ${now.length > 1 ? (now[0].turn_index <= now[now.length - 1].turn_index ? "yes (oldest first)" : "NO -- order broken") : "n/a"}`,
);
console.log(
  `within MAX_BATCH: ${now.length <= 100 ? "yes" : "NO -- exceeds server cap"}`,
);
