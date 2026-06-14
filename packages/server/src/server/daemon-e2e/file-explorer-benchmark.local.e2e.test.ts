import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { listDirectoryEntries, readExplorerFileBytes } from "../file-explorer/service.js";
import { createDaemonTestContext } from "../test-utils/index.js";

// Quantifies the payoff of candidate B (see docs/artifact-fs-evaluation.md §5/§9):
//   B-2 large-directory pagination — first page vs full listing payload
//   B-1 large-file range read — head slice vs whole-file read
//
// Opt-in (heavy I/O), mirroring git-diff-bottleneck.local.e2e.test.ts:
//   PASEO_FILE_EXPLORER_BENCH=1 npx vitest run \
//     src/server/daemon-e2e/file-explorer-benchmark.local.e2e.test.ts
const RUN = process.env.PASEO_FILE_EXPLORER_BENCH === "1";
const DIR_ENTRY_COUNT = Number.parseInt(process.env.PASEO_FILE_EXPLORER_BENCH_DIR ?? "5000", 10);
const FILE_SIZE_MB = Number.parseInt(process.env.PASEO_FILE_EXPLORER_BENCH_FILE_MB ?? "10", 10);
// Mirror the production constants so the benchmark reflects real behavior.
const PAGE_LIMIT = 500; // DIRECTORY_PAGE_LIMIT in use-file-explorer-actions.ts
const HEAD_BYTES = 512 * 1024; // FILE_PREVIEW_HEAD_BYTES in file-pane.tsx

const runDescribe = RUN ? describe : describe.skip;

runDescribe("file explorer candidate-B benchmark", () => {
  test("B-2: first-page payload is a fraction of the full directory listing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-fx-bench-dir-"));

    try {
      for (let i = 0; i < DIR_ENTRY_COUNT; i += 1) {
        writeFileSync(path.join(root, `file-${i}.txt`), `content ${i}\n`);
      }

      const fullStart = performance.now();
      const full = await listDirectoryEntries({ root });
      const fullMs = performance.now() - fullStart;
      const fullBytes = JSON.stringify(full).length;

      const pageStart = performance.now();
      const page = await listDirectoryEntries({ root, limit: PAGE_LIMIT });
      const pageMs = performance.now() - pageStart;
      const pageBytes = JSON.stringify(page).length;

      console.info(
        "[fx-bench:dir]",
        JSON.stringify(
          {
            entryCount: DIR_ENTRY_COUNT,
            fullEntries: full.entries.length,
            fullBytes,
            fullMs: Math.round(fullMs),
            pageEntries: page.entries.length,
            pageBytes,
            pageMs: Math.round(pageMs),
            payloadReductionPct: Number((100 * (1 - pageBytes / fullBytes)).toFixed(1)),
            hasMore: page.hasMore,
          },
          null,
          2,
        ),
      );

      expect(full.entries.length).toBe(DIR_ENTRY_COUNT);
      expect(page.entries.length).toBe(PAGE_LIMIT);
      expect(page.hasMore).toBe(true);
      // The first frame the client renders is a small fraction of the full listing.
      expect(pageBytes).toBeLessThan(fullBytes * 0.2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240000);

  test("B-1: head range read transfers a fraction of the whole file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-fx-bench-file-"));

    try {
      const bytes = Buffer.alloc(FILE_SIZE_MB * 1024 * 1024, 0x61);
      writeFileSync(path.join(root, "big.txt"), bytes);

      const fullStart = performance.now();
      const full = await readExplorerFileBytes({
        root,
        relativePath: "big.txt",
      });
      const fullMs = performance.now() - fullStart;

      const headStart = performance.now();
      const head = await readExplorerFileBytes({
        root,
        relativePath: "big.txt",
        offset: 0,
        length: HEAD_BYTES,
      });
      const headMs = performance.now() - headStart;

      console.info(
        "[fx-bench:file]",
        JSON.stringify(
          {
            fileSizeBytes: bytes.length,
            fullReadBytes: full.bytes.byteLength,
            fullMs: Math.round(fullMs),
            headReadBytes: head.bytes.byteLength,
            headMs: Math.round(headMs),
            bytesReductionPct: Number(
              (100 * (1 - head.bytes.byteLength / full.bytes.byteLength)).toFixed(1),
            ),
            wholeFileSizePreserved: head.size,
          },
          null,
          2,
        ),
      );

      expect(full.bytes.byteLength).toBe(bytes.length);
      expect(head.bytes.byteLength).toBe(HEAD_BYTES);
      expect(head.size).toBe(bytes.length); // whole-file size is preserved
      // The head preview transfers a fraction of the whole file.
      expect(head.bytes.byteLength).toBeLessThan(full.bytes.byteLength * 0.1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240000);

  test("end-to-end over daemon WebSocket: pagination + range across client→daemon→service", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-fx-bench-e2e-"));
    const ctx = await createDaemonTestContext();

    try {
      for (let i = 0; i < DIR_ENTRY_COUNT; i += 1) {
        writeFileSync(path.join(root, `file-${i}.txt`), `content ${i}\n`);
      }
      const bigFile = Buffer.alloc(FILE_SIZE_MB * 1024 * 1024, 0x61);
      writeFileSync(path.join(root, "big.txt"), bigFile);

      // Directory listing over the wire: full vs first page.
      const dirFullStart = performance.now();
      const full = await ctx.client.listDirectory(root, ".");
      const dirFullMs = performance.now() - dirFullStart;

      const dirPageStart = performance.now();
      const page = await ctx.client.listDirectory(root, ".", undefined, {
        limit: PAGE_LIMIT,
      });
      const dirPageMs = performance.now() - dirPageStart;

      // +1 for big.txt, which also lives in this directory.
      expect(full.entries.length).toBe(DIR_ENTRY_COUNT + 1);
      expect(page.entries.length).toBe(PAGE_LIMIT);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeTruthy();

      // Second page via cursor; no overlap with the first page.
      const next = await ctx.client.listDirectory(root, ".", undefined, {
        cursor: page.nextCursor ?? undefined,
        limit: PAGE_LIMIT,
      });
      expect(next.entries.length).toBe(PAGE_LIMIT);
      const firstNames = new Set(page.entries.map((entry) => entry.name));
      expect(next.entries.every((entry) => !firstNames.has(entry.name))).toBe(true);

      // File read over the wire (binary frame transport): full vs head range.
      const fileFullStart = performance.now();
      const fileFull = await ctx.client.readFile(root, "big.txt");
      const fileFullMs = performance.now() - fileFullStart;

      const headStart = performance.now();
      const head = await ctx.client.readFile(root, "big.txt", undefined, {
        offset: 0,
        length: HEAD_BYTES,
      });
      const headMs = performance.now() - headStart;

      expect(fileFull.bytes.byteLength).toBe(bigFile.length);
      expect(head.bytes.byteLength).toBe(HEAD_BYTES);
      expect(head.size).toBe(bigFile.length); // whole-file size preserved over the wire

      console.info(
        "[fx-bench:e2e]",
        JSON.stringify(
          {
            transport: "daemon WebSocket (in-process, real protocol serialization)",
            dirFullEntries: full.entries.length,
            dirFullMs: Math.round(dirFullMs),
            dirPageEntries: page.entries.length,
            dirPageMs: Math.round(dirPageMs),
            fileFullBytes: fileFull.bytes.byteLength,
            fileFullMs: Math.round(fileFullMs),
            fileHeadBytes: head.bytes.byteLength,
            fileHeadMs: Math.round(headMs),
          },
          null,
          2,
        ),
      );
    } finally {
      await ctx.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 240000);
});
