/**
 * The journal file itself: reading rows, appending one, rewriting the whole
 * thing.
 *
 * Isolated from the store because this is the only code that touches the disk.
 * Keeping the three filesystem calls together makes the durability surface one
 * short file to audit, rather than three calls scattered through a store whose
 * other job is in-memory bookkeeping.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RecoveryWalRecord } from "./recovery-wal-types.ts";

export function journalExists(walPath: string): boolean {
  return existsSync(walPath);
}

/** Non-blank rows, in order. A torn tail simply yields one row that will not parse. */
export function readJournalRows(walPath: string): string[] {
  if (!existsSync(walPath)) return [];
  return readFileSync(walPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function appendJournalRecord(
  walPath: string,
  record: RecoveryWalRecord,
): void {
  mkdirSync(dirname(walPath), { recursive: true });
  appendFileSync(walPath, `${JSON.stringify(record)}\n`, "utf8");
}

/** Rewrite the journal as exactly these records, replacing whatever was there. */
export function rewriteJournal(
  walPath: string,
  records: RecoveryWalRecord[],
): void {
  mkdirSync(dirname(walPath), { recursive: true });
  writeFileSync(
    walPath,
    records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length > 0 ? "\n" : ""),
    "utf8",
  );
}
