import { describe, it, expect } from "vitest";
import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import { buildTreeRows, resolveTreeRows, treeRowKeyExtractor } from "./file-explorer-tree";

function entry(name: string, kind: ExplorerEntry["kind"] = "file"): ExplorerEntry {
  return {
    name,
    path: `./${name}`,
    kind,
    size: 0,
    modifiedAt: "2026-01-01T00:00:00Z",
  };
}

function dir(
  path: string,
  entries: ExplorerEntry[],
  extra?: Partial<ExplorerDirectory>,
): ExplorerDirectory {
  return { path, entries, ...extra };
}

describe("buildTreeRows", () => {
  it("emits one entry row per file", () => {
    const directories = new Map([[".", dir(".", [entry("a.txt"), entry("b.txt")])]]);
    const rows = buildTreeRows({
      directories,
      expandedPaths: new Set(["."]),
      sortOption: "name",
      path: ".",
      depth: 0,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "entry")).toBe(true);
  });

  it("appends a load-more row when the directory has more pages", () => {
    const directories = new Map([[".", dir(".", [entry("a.txt")], { hasMore: true })]]);
    const rows = buildTreeRows({
      directories,
      expandedPaths: new Set(["."]),
      sortOption: "name",
      path: ".",
      depth: 0,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe("entry");
    expect(rows[1]).toEqual({ kind: "loadMore", dirPath: ".", depth: 0 });
  });

  it("omits the load-more row when there are no more pages", () => {
    const directories = new Map([[".", dir(".", [entry("a.txt")], { hasMore: false })]]);
    const rows = buildTreeRows({
      directories,
      expandedPaths: new Set(["."]),
      sortOption: "name",
      path: ".",
      depth: 0,
    });
    expect(rows).toHaveLength(1);
    expect(rows.some((row) => row.kind === "loadMore")).toBe(false);
  });

  it("recurses into expanded directories with increasing depth", () => {
    const directories = new Map([
      [".", dir(".", [entry("sub", "directory")])],
      ["./sub", dir("./sub", [entry("nested.txt")])],
    ]);
    const rows = buildTreeRows({
      directories,
      expandedPaths: new Set([".", "./sub"]),
      sortOption: "name",
      path: ".",
      depth: 0,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "entry", depth: 0 });
    expect(rows[1]).toMatchObject({ kind: "entry", depth: 1 });
  });

  it("does not recurse into collapsed directories", () => {
    const directories = new Map([
      [".", dir(".", [entry("sub", "directory")])],
      ["./sub", dir("./sub", [entry("nested.txt")])],
    ]);
    const rows = buildTreeRows({
      directories,
      expandedPaths: new Set(["."]),
      sortOption: "name",
      path: ".",
      depth: 0,
    });
    expect(rows).toHaveLength(1);
  });

  it("sorts directories before files, then by name", () => {
    const directories = new Map([
      [".", dir(".", [entry("z.txt"), entry("a.txt"), entry("m-dir", "directory")])],
    ]);
    const rows = buildTreeRows({
      directories,
      expandedPaths: new Set(["."]),
      sortOption: "name",
      path: ".",
      depth: 0,
    });
    const names = rows.flatMap((row) => (row.kind === "entry" ? [row.entry.name] : []));
    expect(names).toEqual(["m-dir", "a.txt", "z.txt"]);
  });
});

describe("resolveTreeRows", () => {
  it("returns empty when the root directory is not loaded", () => {
    expect(
      resolveTreeRows({
        directories: new Map(),
        expandedPaths: new Set(["."]),
        sortOption: "name",
      }),
    ).toEqual([]);
  });
});

describe("treeRowKeyExtractor", () => {
  it("keys entry rows by their path", () => {
    expect(treeRowKeyExtractor({ kind: "entry", entry: entry("a.txt"), depth: 0 })).toBe("./a.txt");
  });

  it("gives load-more rows a distinct namespaced key", () => {
    expect(treeRowKeyExtractor({ kind: "loadMore", dirPath: "./sub", depth: 1 })).toBe(
      "load-more:./sub",
    );
  });
});
