import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import type { SortOption } from "@/stores/panel-store";

// Pure tree-construction logic for the file explorer, extracted from
// file-explorer-pane.tsx so it can be unit-tested without React Native deps.

export type TreeRow =
  | { kind: "entry"; entry: ExplorerEntry; depth: number }
  | { kind: "loadMore"; dirPath: string; depth: number };

export function treeRowKeyExtractor(row: TreeRow): string {
  return row.kind === "loadMore" ? `load-more:${row.dirPath}` : row.entry.path;
}

export function sortEntries(entries: ExplorerEntry[], sortOption: SortOption): ExplorerEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    switch (sortOption) {
      case "name":
        return a.name.localeCompare(b.name);
      case "modified":
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      case "size":
        return b.size - a.size;
      default:
        return 0;
    }
  });
  return sorted;
}

export function buildTreeRows({
  directories,
  expandedPaths,
  sortOption,
  path,
  depth,
}: {
  directories: Map<string, ExplorerDirectory>;
  expandedPaths: Set<string>;
  sortOption: SortOption;
  path: string;
  depth: number;
}): TreeRow[] {
  const directory = directories.get(path);
  if (!directory) {
    return [];
  }

  const rows: TreeRow[] = [];
  const entries = sortEntries(directory.entries, sortOption);

  for (const entry of entries) {
    rows.push({ kind: "entry", entry, depth });
    if (entry.kind === "directory" && expandedPaths.has(entry.path)) {
      rows.push(
        ...buildTreeRows({
          directories,
          expandedPaths,
          sortOption,
          path: entry.path,
          depth: depth + 1,
        }),
      );
    }
  }

  // COMPAT(fileListPagination): when the daemon paginated this directory, append a
  // "load more" row so the user can fetch the next page on demand.
  if (directory.hasMore) {
    rows.push({ kind: "loadMore", dirPath: path, depth });
  }

  return rows;
}

export function resolveTreeRows({
  directories,
  expandedPaths,
  sortOption,
}: {
  directories: Map<string, ExplorerDirectory>;
  expandedPaths: Set<string>;
  sortOption: SortOption;
}): TreeRow[] {
  if (!directories.get(".")) {
    return [];
  }
  return buildTreeRows({
    directories,
    expandedPaths,
    sortOption,
    path: ".",
    depth: 0,
  });
}
