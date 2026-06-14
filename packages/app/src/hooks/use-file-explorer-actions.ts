import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore, type AgentFileExplorerState } from "@/stores/session-store";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";

// COMPAT(fileListPagination): page size for paginated directory listings. Large directories
// come back one page at a time; smaller directories fit in a single page (hasMore=false).
const DIRECTORY_PAGE_LIMIT = 500;

// B-3: when a directory is listed, speculatively prefetch its manifest/readme files so
// opening one is instant. Scoped to manifests only (few per directory) so the explorer
// cache stays bounded; reads just the head of each file.
const PREFETCH_HEAD_BYTES = 64 * 1024;
const MANIFEST_FILE_NAMES = new Set([
  "package.json",
  "readme.md",
  "readme",
  "readme.txt",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "makefile",
  "dockerfile",
]);

function createExplorerState(): AgentFileExplorerState {
  return {
    directories: new Map(),
    files: new Map(),
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
}

function pushHistory(history: string[], path: string): string[] {
  const normalizedHistory = history.length === 0 ? ["."] : history;
  const last = normalizedHistory[normalizedHistory.length - 1];
  if (last === path) {
    return normalizedHistory;
  }
  return [...normalizedHistory, path];
}

export interface FileExplorerWorkspaceScope {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

function normalizeWorkspaceValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkspaceExplorerStateKey(scope: FileExplorerWorkspaceScope): string | null {
  const normalizedWorkspaceId = normalizeWorkspaceValue(scope.workspaceId);
  if (normalizedWorkspaceId) {
    return `workspace:${normalizedWorkspaceId}`;
  }
  const normalizedWorkspaceRoot = normalizeWorkspaceValue(scope.workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return null;
  }
  return `root:${normalizedWorkspaceRoot}`;
}

export function useFileExplorerActions(params: { serverId: string } & FileExplorerWorkspaceScope) {
  const { t } = useTranslation();
  const { serverId, workspaceId, workspaceRoot } = params;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const normalizedWorkspaceRoot = useMemo(
    () => normalizeWorkspaceValue(workspaceRoot),
    [workspaceRoot],
  );
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [workspaceId, normalizedWorkspaceRoot],
  );

  const updateExplorerState = useCallback(
    (updater: (prev: AgentFileExplorerState) => AgentFileExplorerState) => {
      if (!workspaceStateKey) {
        return;
      }
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(workspaceStateKey) ?? createExplorerState();
        next.set(workspaceStateKey, updater(current));
        return next;
      });
    },
    [serverId, setFileExplorer, workspaceStateKey],
  );

  const prefetchManifestFiles = useCallback(
    (entries: readonly { name: string; path: string; kind: string }[]) => {
      if (!workspaceStateKey || !normalizedWorkspaceRoot || !client) {
        return;
      }
      const cachedFiles = useSessionStore
        .getState()
        .sessions[serverId]?.fileExplorer.get(workspaceStateKey)?.files;
      for (const entry of entries) {
        if (entry.kind !== "file") {
          continue;
        }
        if (!MANIFEST_FILE_NAMES.has(entry.name.toLowerCase())) {
          continue;
        }
        if (cachedFiles?.has(entry.path)) {
          continue;
        }
        void client
          .readFile(normalizedWorkspaceRoot, entry.path, undefined, {
            offset: 0,
            length: PREFETCH_HEAD_BYTES,
          })
          .then((file) => {
            const explorerFile = explorerFileFromReadResult(file);
            return updateExplorerState((state) => {
              if (state.files.has(explorerFile.path)) {
                return state;
              }
              const files = new Map(state.files);
              files.set(explorerFile.path, explorerFile);
              return { ...state, files };
            });
          })
          .catch(() => {
            // Prefetch is best-effort; ignore failures.
          });
      }
    },
    [client, normalizedWorkspaceRoot, serverId, updateExplorerState, workspaceStateKey],
  );

  const requestDirectoryListing = useCallback(
    async (
      path: string,
      options?: { recordHistory?: boolean; setCurrentPath?: boolean },
    ): Promise<boolean> => {
      if (!workspaceStateKey) {
        return false;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      const shouldSetCurrentPath = options?.setCurrentPath ?? true;
      const shouldRecordHistory = options?.recordHistory ?? shouldSetCurrentPath;

      updateExplorerState((state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "list" },
        ...(shouldSetCurrentPath
          ? {
              currentPath: normalizedPath,
              history: shouldRecordHistory
                ? pushHistory(state.history, normalizedPath)
                : state.history,
              lastVisitedPath: normalizedPath,
            }
          : {}),
      }));

      if (!normalizedWorkspaceRoot) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: t("workspace.fileExplorer.states.unavailable"),
          pendingRequest: null,
        }));
        return false;
      }

      if (!client) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: t("workspace.terminal.hostDisconnected"),
          pendingRequest: null,
        }));
        return false;
      }

      try {
        const directory = await client.listDirectory(
          normalizedWorkspaceRoot,
          normalizedPath,
          undefined,
          { limit: DIRECTORY_PAGE_LIMIT },
        );
        updateExplorerState((state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            lastError: null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          const directories = new Map(state.directories);
          directories.set(directory.path, directory);
          nextState.directories = directories;

          return nextState;
        });
        // B-3: prefetch manifest/readme files in this directory so opening them is instant.
        prefetchManifestFiles(directory.entries);
        return true;
      } catch (error) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError:
            error instanceof Error
              ? error.message
              : t("workspace.fileExplorer.errors.failedToListDirectory"),
          pendingRequest: null,
        }));
        return false;
      }
    },
    [
      client,
      normalizedWorkspaceRoot,
      prefetchManifestFiles,
      t,
      updateExplorerState,
      workspaceStateKey,
    ],
  );

  const loadMoreDirectoryEntries = useCallback(
    async (path: string): Promise<boolean> => {
      if (!workspaceStateKey || !normalizedWorkspaceRoot || !client) {
        return false;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      const currentDirectory = useSessionStore
        .getState()
        .sessions[serverId]?.fileExplorer.get(workspaceStateKey)
        ?.directories.get(normalizedPath);
      const cursor = currentDirectory?.nextCursor;
      if (!cursor) {
        return false;
      }
      try {
        const nextPage = await client.listDirectory(
          normalizedWorkspaceRoot,
          normalizedPath,
          undefined,
          { cursor, limit: DIRECTORY_PAGE_LIMIT },
        );
        updateExplorerState((state) => {
          const directories = new Map(state.directories);
          const existing = directories.get(normalizedPath);
          directories.set(normalizedPath, {
            path: nextPage.path,
            entries: existing ? [...existing.entries, ...nextPage.entries] : nextPage.entries,
            nextCursor: nextPage.nextCursor,
            hasMore: nextPage.hasMore,
          });
          return { ...state, directories };
        });
        return true;
      } catch (error) {
        updateExplorerState((state) => ({
          ...state,
          lastError:
            error instanceof Error
              ? error.message
              : t("workspace.fileExplorer.errors.failedToListDirectory"),
        }));
        return false;
      }
    },
    [client, normalizedWorkspaceRoot, serverId, t, updateExplorerState, workspaceStateKey],
  );

  const requestFilePreview = useCallback(
    async (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      updateExplorerState((state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "file" },
      }));

      if (!normalizedWorkspaceRoot) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: t("workspace.fileExplorer.states.unavailable"),
          pendingRequest: null,
        }));
        return;
      }

      if (!client) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: t("workspace.terminal.hostDisconnected"),
          pendingRequest: null,
        }));
        return;
      }

      try {
        const file = await client.readFile(normalizedWorkspaceRoot, normalizedPath);
        updateExplorerState((state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            lastError: null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          const files = new Map(state.files);
          const explorerFile = explorerFileFromReadResult(file);
          files.set(explorerFile.path, explorerFile);
          nextState.files = files;

          return nextState;
        });
      } catch (error) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: error instanceof Error ? error.message : t("panels.file.failedToLoadPreview"),
          pendingRequest: null,
        }));
      }
    },
    [client, normalizedWorkspaceRoot, t, updateExplorerState, workspaceStateKey],
  );

  const requestFileDownloadToken = useCallback(
    async (path: string) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.requestDownloadToken(normalizedWorkspaceRoot, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const selectExplorerEntry = useCallback(
    (path: string | null) => {
      updateExplorerState((state) => ({
        ...state,
        selectedEntryPath: path,
      }));
    },
    [updateExplorerState],
  );

  return {
    workspaceStateKey,
    requestDirectoryListing,
    loadMoreDirectoryEntries,
    requestFilePreview,
    requestFileDownloadToken,
    selectExplorerEntry,
  };
}
