import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listDirectoryEntries, readExplorerFile, readExplorerFileBytes } from "./service.js";

async function createHomeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.homedir(), prefix));
}

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("file explorer service", () => {
  it("reads a byte range of a text file with offset/length", async () => {
    const root = await createTempDir("paseo-file-explorer-range-");

    try {
      await writeFile(path.join(root, "data.txt"), "0123456789abcdefghij", "utf-8");

      const slice = await readExplorerFileBytes({
        root,
        relativePath: "data.txt",
        offset: 5,
        length: 4,
      });

      expect(slice.kind).toBe("text");
      expect(slice.size).toBe(20); // whole-file size, not the slice length
      expect(slice.rangeStart).toBe(5);
      expect(slice.rangeLength).toBe(4);
      expect(Buffer.from(slice.bytes).toString("utf-8")).toBe("5678");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clamps a range that runs past the end of the file", async () => {
    const root = await createTempDir("paseo-file-explorer-range-clamp-");

    try {
      await writeFile(path.join(root, "data.txt"), "short", "utf-8");

      const slice = await readExplorerFileBytes({
        root,
        relativePath: "data.txt",
        offset: 2,
        length: 1000,
      });

      expect(slice.size).toBe(5);
      expect(slice.rangeStart).toBe(2);
      expect(slice.rangeLength).toBe(3);
      expect(Buffer.from(slice.bytes).toString("utf-8")).toBe("ort");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores range requests for images and returns the whole file", async () => {
    const root = await createTempDir("paseo-file-explorer-range-image-");

    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      await writeFile(path.join(root, "pixel.png"), png);

      const slice = await readExplorerFileBytes({
        root,
        relativePath: "pixel.png",
        offset: 0,
        length: 2,
      });

      expect(slice.kind).toBe("image");
      expect(slice.bytes.byteLength).toBe(png.byteLength);
      expect(slice.rangeStart).toBeUndefined();
      expect(slice.rangeLength).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("paginates large directories with a stable cursor", async () => {
    const root = await createTempDir("paseo-file-explorer-page-");

    try {
      const names = ["alpha.txt", "bravo.txt", "charlie.txt", "delta.txt", "echo.txt"];
      for (const name of names) {
        await writeFile(path.join(root, name), `content of ${name}\n`, "utf-8");
      }

      const collected: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let sawFinalPage = false;
      while (pages < 10) {
        const page = await listDirectoryEntries({ root, limit: 2, cursor });
        pages += 1;
        expect(page.entries.length).toBeLessThanOrEqual(2);
        collected.push(...page.entries.map((entry) => entry.name));
        if (page.hasMore) {
          expect(page.nextCursor).toBeTruthy();
          cursor = page.nextCursor ?? undefined;
        } else {
          expect(page.nextCursor ?? null).toBeNull();
          sawFinalPage = true;
          break;
        }
      }

      expect(sawFinalPage).toBe(true);
      expect(pages).toBe(3);
      // Every entry is delivered exactly once across the pages.
      expect([...collected].sort()).toEqual([...names].sort());
      expect(new Set(collected).size).toBe(names.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the full listing with no pagination fields when no limit is given", async () => {
    const root = await createTempDir("paseo-file-explorer-full-");

    try {
      for (const name of ["one.txt", "two.txt", "three.txt"]) {
        await writeFile(path.join(root, name), "x\n", "utf-8");
      }

      const result = await listDirectoryEntries({ root });

      expect(result.entries).toHaveLength(3);
      expect(result.nextCursor).toBeUndefined();
      expect(result.hasMore).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads .ex files as text", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "sample.ex");
      const content = "defmodule Sample do\nend\n";
      await writeFile(filePath, content, "utf-8");

      const result = await readExplorerFile({
        root,
        relativePath: "sample.ex",
      });

      expect(result.kind).toBe("text");
      expect(result.encoding).toBe("utf-8");
      expect(result.mimeType).toBe("text/plain");
      expect(result.content).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads unknown extension text files as text", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "notes.customext");
      const content = "hello from a custom text file\n";
      await writeFile(filePath, content, "utf-8");

      const result = await readExplorerFile({
        root,
        relativePath: "notes.customext",
      });

      expect(result.kind).toBe("text");
      expect(result.encoding).toBe("utf-8");
      expect(result.mimeType).toBe("text/plain");
      expect(result.content).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies files with null bytes as binary", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "blob.weird");
      await writeFile(filePath, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]));

      const result = await readExplorerFile({
        root,
        relativePath: "blob.weird",
      });

      expect(result.kind).toBe("binary");
      expect(result.encoding).toBe("none");
      expect(result.content).toBeUndefined();
      expect(result.mimeType).toBe("application/octet-stream");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands a ~ prefix in relative paths against the user home directory", async () => {
    const root = await createHomeTempDir(".paseo-file-explorer-home-");

    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello from home\n", "utf-8");

      const tildePath = `~/${path.relative(os.homedir(), filePath)}`;
      const result = await readExplorerFile({
        root,
        relativePath: tildePath,
      });

      expect(result.kind).toBe("text");
      expect(result.content).toBe("hello from home\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows home to be the scoped root for tilde file previews", async () => {
    const root = await createHomeTempDir(".paseo-file-explorer-home-root-");

    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello from home root\n", "utf-8");

      const tildePath = `~/${path.relative(os.homedir(), filePath)}`;
      const result = await readExplorerFile({
        root: "~",
        relativePath: tildePath,
      });

      expect(result.kind).toBe("text");
      expect(result.path).toBe(path.relative(os.homedir(), filePath).split(path.sep).join("/"));
      expect(result.content).toBe("hello from home root\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ~-prefixed paths that resolve outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-file-explorer-outside-home-"));

    try {
      await expect(
        readExplorerFile({
          root,
          relativePath: "~/some/file.txt",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
