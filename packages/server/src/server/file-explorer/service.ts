import { constants, promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import { expandUserPath, resolvePathFromBase } from "../path-utils.js";

export type ExplorerEntryKind = "file" | "directory";
export type ExplorerFileKind = "text" | "image" | "binary";
export type ExplorerEncoding = "utf-8" | "base64" | "none";

export interface ListDirectoryParams {
  root: string;
  relativePath?: string;
  // COMPAT(fileListPagination): added in v0.1.97. When `limit` is set, return one page
  // plus a cursor; `cursor` resumes after a previous page. Absent ⇒ legacy full listing.
  cursor?: string;
  limit?: number;
}

export interface ReadFileParams {
  root: string;
  relativePath: string;
  // COMPAT(fileRangeRead): added in v0.1.97. Read only [offset, offset+length) when set.
  offset?: number;
  length?: number;
}

export interface FileExplorerEntry {
  name: string;
  path: string;
  kind: ExplorerEntryKind;
  size: number;
  modifiedAt: string;
}

export interface FileExplorerDirectory {
  path: string;
  entries: FileExplorerEntry[];
  // COMPAT(fileListPagination): added in v0.1.97. Cursor for the next page, null when
  // exhausted. Only populated for paginated (limit-bearing) requests.
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface FileExplorerFile {
  path: string;
  kind: ExplorerFileKind;
  encoding: ExplorerEncoding;
  content?: string;
  mimeType?: string;
  size: number;
  modifiedAt: string;
  // COMPAT(fileRangeRead): added in v0.1.97. Slice info for ranged reads; `size` stays
  // the whole-file size, `content` holds the returned slice.
  rangeStart?: number;
  rangeLength?: number;
}

export interface FileExplorerFileBytes {
  path: string;
  kind: ExplorerFileKind;
  encoding: "utf-8" | "binary";
  bytes: Uint8Array;
  mimeType: string;
  size: number;
  modifiedAt: string;
  rangeStart?: number;
  rangeLength?: number;
}

const TEXT_MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
};

const DEFAULT_TEXT_MIME_TYPE = "text/plain";
const FILE_TYPE_SAMPLE_BYTES = 8192;
const READ_FILE_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
const ACCESS_OUTSIDE_WORKSPACE_MESSAGE = "Access outside of workspace is not allowed";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

interface ScopedPathParams {
  root: string;
  relativePath?: string;
}

interface ScopedPath {
  requestedPath: string;
  resolvedPath: string;
}

interface EntryPayloadParams {
  root: string;
  targetPath: string;
  name: string;
  kind: ExplorerEntryKind;
}

// COMPAT(fileListPagination): added in v0.1.97, remove gate after 2026-12-13.
// Opaque cursor encodes the last returned entry's (modifiedAt, name) so the next page
// resumes right after it under the stable (mtime desc, name asc) sort.
interface DirectoryCursor {
  modifiedAt: string;
  name: string;
}

function compareEntries(
  a: { modifiedAt: string; name: string },
  b: { modifiedAt: string; name: string },
): number {
  const modifiedComparison = new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
  if (modifiedComparison !== 0) {
    return modifiedComparison;
  }
  return a.name.localeCompare(b.name);
}

function encodeDirectoryCursor(entry: DirectoryCursor): string {
  return Buffer.from(JSON.stringify([entry.modifiedAt, entry.name]), "utf-8").toString("base64url");
}

function decodeDirectoryCursor(cursor: string): DirectoryCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { modifiedAt: parsed[0], name: parsed[1] };
    }
  } catch {
    // Malformed cursor ⇒ start from the beginning.
  }
  return null;
}

export async function listDirectoryEntries({
  root,
  relativePath = ".",
  cursor,
  limit,
}: ListDirectoryParams): Promise<FileExplorerDirectory> {
  const directoryPath = await resolveScopedPath({ root, relativePath });
  const stats = await fs.stat(directoryPath.resolvedPath);

  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a directory");
  }

  const dirents = await fs.readdir(directoryPath.resolvedPath, {
    withFileTypes: true,
  });

  const entriesWithNulls = await Promise.all(
    dirents.map(async (dirent) => {
      const targetPath = path.join(directoryPath.requestedPath, dirent.name);
      const kind: ExplorerEntryKind = dirent.isDirectory() ? "directory" : "file";
      try {
        return await buildEntryPayload({
          root,
          targetPath,
          name: dirent.name,
          kind,
        });
      } catch (error) {
        // Directories can contain dangling links (e.g. AGENTS.md -> CLAUDE.md).
        // Skip entries whose targets disappeared instead of failing the whole listing.
        if (isMissingEntryError(error) || isOutsideWorkspaceError(error)) {
          return null;
        }
        throw error;
      }
    }),
  );
  const entries = entriesWithNulls.filter((entry): entry is FileExplorerEntry => entry !== null);

  entries.sort(compareEntries);

  const listingPath = normalizeRelativePath({
    root,
    targetPath: directoryPath.requestedPath,
  });

  // Legacy/unpaginated request: return everything in one frame.
  if (typeof limit !== "number") {
    return { path: listingPath, entries };
  }

  // Paginated request. The full readdir+stat+sort above is unavoidable for a stable
  // mtime sort; pagination only trims the transferred/rendered slice, not server cost
  // (see docs/artifact-fs-evaluation.md §5 B-2, decision 5).
  let startIndex = 0;
  if (cursor) {
    const decoded = decodeDirectoryCursor(cursor);
    if (decoded) {
      const found = entries.findIndex((entry) => compareEntries(entry, decoded) > 0);
      startIndex = found === -1 ? entries.length : found;
    }
  }
  const page = entries.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + page.length < entries.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeDirectoryCursor(last) : null;

  return { path: listingPath, entries: page, nextCursor, hasMore };
}

export async function readExplorerFile({
  root,
  relativePath,
  offset,
  length,
}: ReadFileParams): Promise<FileExplorerFile> {
  const file = await readExplorerFileBytes({
    root,
    relativePath,
    offset,
    length,
  });
  const rangeFields = {
    rangeStart: file.rangeStart,
    rangeLength: file.rangeLength,
  };

  if (file.kind === "image") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "base64",
      content: Buffer.from(file.bytes).toString("base64"),
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
      ...rangeFields,
    };
  }

  if (file.kind === "binary") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "none",
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
      ...rangeFields,
    };
  }

  return {
    path: file.path,
    kind: file.kind,
    encoding: "utf-8",
    content: Buffer.from(file.bytes).toString("utf-8"),
    mimeType: file.mimeType,
    size: file.size,
    modifiedAt: file.modifiedAt,
    ...rangeFields,
  };
}

export async function readExplorerFileBytes({
  root,
  relativePath,
  offset,
  length,
}: ReadFileParams): Promise<FileExplorerFileBytes> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    // COMPAT(fileRangeRead): added in v0.1.97. When offset/length are given, read just
    // that slice; `size` stays the whole-file size so the client knows how much remains.
    // Images must be returned whole (a partial slice can't be decoded/rendered), so a
    // range request is ignored for them.
    const isRanged =
      !(ext in IMAGE_MIME_TYPES) && (typeof offset === "number" || typeof length === "number");
    const rangeStart = isRanged ? Math.min(Math.max(offset ?? 0, 0), stats.size) : 0;
    const rangeLength = isRanged
      ? Math.min(length ?? stats.size, stats.size - rangeStart)
      : stats.size;
    const basePayload = {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      ...(isRanged ? { rangeStart, rangeLength } : {}),
    };

    let buffer: Buffer;
    if (isRanged) {
      const target = Buffer.alloc(rangeLength);
      if (rangeLength > 0) {
        const { bytesRead } = await handle.read(target, 0, rangeLength, rangeStart);
        buffer = bytesRead < rangeLength ? target.subarray(0, bytesRead) : target;
      } else {
        buffer = target;
      }
    } else {
      buffer = await handle.readFile();
    }

    // For ranged reads, classify text vs binary from the head sample of the slice
    // rather than scanning the whole (possibly partial) buffer.
    const classificationSample =
      isRanged && buffer.length > FILE_TYPE_SAMPLE_BYTES
        ? buffer.subarray(0, FILE_TYPE_SAMPLE_BYTES)
        : buffer;

    if (ext in IMAGE_MIME_TYPES) {
      return {
        ...basePayload,
        kind: "image",
        encoding: "binary",
        bytes: buffer,
        mimeType: IMAGE_MIME_TYPES[ext],
      };
    }

    if (isLikelyBinary(classificationSample)) {
      return {
        ...basePayload,
        kind: "binary",
        encoding: "binary",
        bytes: buffer,
        mimeType: "application/octet-stream",
      };
    }

    return {
      ...basePayload,
      kind: "text",
      encoding: "utf-8",
      bytes: buffer,
      mimeType: textMimeTypeForExtension(ext),
    };
  } finally {
    await handle.close();
  }
}

export async function getDownloadableFileInfo({ root, relativePath }: ReadFileParams): Promise<{
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    let mimeType = "application/octet-stream";
    if (ext in IMAGE_MIME_TYPES) {
      mimeType = IMAGE_MIME_TYPES[ext];
    } else {
      const sample = Buffer.alloc(FILE_TYPE_SAMPLE_BYTES);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      const chunk = bytesRead < sample.length ? sample.subarray(0, bytesRead) : sample;
      if (!isLikelyBinary(chunk)) {
        mimeType = textMimeTypeForExtension(ext);
      }
    }

    return {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      absolutePath: filePath.resolvedPath,
      fileName: path.basename(filePath.requestedPath),
      mimeType,
      size: stats.size,
    };
  } finally {
    await handle.close();
  }
}

async function resolveScopedPath({
  root,
  relativePath = ".",
}: ScopedPathParams): Promise<ScopedPath> {
  const normalizedRoot = expandUserPath(root);
  const requestedPath = resolvePathFromBase(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, requestedPath);

  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
  }

  const realRoot = await fs.realpath(normalizedRoot);

  try {
    const realPath = await fs.realpath(requestedPath);
    const realRelative = path.relative(realRoot, realPath);
    if (realRelative !== "" && (realRelative.startsWith("..") || path.isAbsolute(realRelative))) {
      throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
    }
    return { requestedPath, resolvedPath: realPath };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { requestedPath, resolvedPath: requestedPath };
    }
    throw error;
  }
}

async function openFileForRead(filePath: string): Promise<FileHandle> {
  return fs.open(filePath, READ_FILE_OPEN_FLAGS);
}

async function buildEntryPayload({
  root,
  targetPath,
  name,
  kind,
}: EntryPayloadParams): Promise<FileExplorerEntry> {
  const entryPath = await resolveScopedPath({
    root,
    relativePath: normalizeRelativePath({ root, targetPath }),
  });
  const stats = await fs.stat(entryPath.resolvedPath);
  return {
    name,
    path: normalizeRelativePath({ root, targetPath }),
    kind,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isOutsideWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === ACCESS_OUTSIDE_WORKSPACE_MESSAGE;
}

function normalizeRelativePath({ root, targetPath }: { root: string; targetPath: string }): string {
  const normalizedRoot = expandUserPath(root);
  const normalizedTarget = expandUserPath(targetPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function textMimeTypeForExtension(ext: string): string {
  return TEXT_MIME_TYPES[ext] ?? DEFAULT_TEXT_MIME_TYPE;
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (let idx = 0; idx < buffer.length; idx += 1) {
    const byte = buffer[idx];
    if (byte === 0) {
      return true;
    }

    const isControl =
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13; // carriage return

    if (isControl || byte === 127) {
      suspicious += 1;
    }
  }

  return suspicious / buffer.length > 0.3;
}
