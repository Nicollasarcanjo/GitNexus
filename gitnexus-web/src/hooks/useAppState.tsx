import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  ReactNode,
} from 'react';
import type { GraphNode, NodeLabel, PipelineProgress } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { buildGraphFromConnectResult } from '../lib/apply-connect-result';
import { type EdgeType } from '../lib/constants';
import {
  connectToServer,
  runQuery as backendRunQuery,
  probeBackendStatus,
  // Aliased: switchRepo declares a local `let repoIdentity` that would shadow
  // a plain named import of this helper.
  repoIdentity as repoIdentityOf,
  type BackendRepo,
  type ConnectResult,
} from '../services/backend-client';
import { ERROR_RESET_DELAY_MS } from '../config/ui-constants';
import i18n from '../i18n';
import { normalizePath, resolveUniqueIndexedPath } from '../lib/path-resolution';
import { GraphStateProvider, useGraphState, type GraphMode } from './app-state/graph';

// Resolve a human-readable name for a repo path identity: the registry entry's
// display name first, then the path's basename, then the raw identity. State
// keeps holding the path identity (#2419) — user-facing labels and the agent
// prompt must never show an absolute filesystem path.
const displayNameForIdentity = (repos: BackendRepo[], identity: string): string =>
  repos.find((r) => repoIdentityOf(r) === identity)?.name ??
  identity.split(/[/\\]/).filter(Boolean).at(-1) ??
  identity;

export type ViewMode = 'onboarding' | 'loading' | 'exploring';
export interface QueryResult {
  rows: Record<string, any>[];
  nodeIds: string[];
  executionTime: number;
}

// Code reference from AI grounding or user selection
export interface CodeReference {
  id: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  nodeId?: string; // Associated graph node ID
  label?: string; // File, Function, Class, etc.
  name?: string; // Display name
  source: 'ai' | 'user'; // How it was added
}

export interface CodeReferenceFocus {
  filePath: string;
  startLine?: number;
  endLine?: number;
  ts: number;
}

interface AppState {
  // View state
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Graph data
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;

  // Selection
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;

  // Right panel (execution flows)
  isRightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  openCodePanel: () => void;

  // Filters
  visibleLabels: NodeLabel[];
  toggleLabelVisibility: (label: NodeLabel) => void;
  visibleEdgeTypes: EdgeType[];
  toggleEdgeVisibility: (edgeType: EdgeType) => void;

  // Depth filter (N hops from selection)
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;

  // Graph view mode
  graphViewMode: 'force' | 'tree' | 'circles';
  setGraphViewMode: (mode: 'force' | 'tree' | 'circles') => void;

  // Graph load mode (full download vs chat-only / skipped graph)
  graphMode: GraphMode;
  setGraphMode: (mode: GraphMode) => void;
  // Connected repo's node count while in chat-only mode (null when unknown)
  chatOnlyNodeCount: number | null;
  setChatOnlyNodeCount: (count: number | null) => void;

  // Query state
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  // Impact highlights (rendered in red, on top of query highlights)
  blastRadiusNodeIds: Set<string>;
  setBlastRadiusNodeIds: (ids: Set<string>) => void;
  clearBlastRadius: () => void;
  queryResult: QueryResult | null;
  setQueryResult: (result: QueryResult | null) => void;
  clearQueryHighlights: () => void;

  // Progress
  progress: PipelineProgress | null;
  setProgress: (progress: PipelineProgress | null) => void;

  // Project info
  projectName: string;
  setProjectName: (name: string) => void;
  currentRepo: string | undefined;

  // Multi-repo switching
  serverBaseUrl: string | null;
  setServerBaseUrl: (url: string | null) => void;
  availableRepos: BackendRepo[];
  setAvailableRepos: (repos: BackendRepo[]) => void;
  switchRepo: (repoName: string) => Promise<void>;
  setCurrentRepo: (repoName: string | undefined) => void;
  /** Download the full graph for the current repo after a chat-only connect (#2178). */
  loadGraphAnyway: () => Promise<void>;

  // Worker API (shared across app)
  runQuery: (cypher: string) => Promise<any[]>;
  isDatabaseReady: () => Promise<boolean>;

  // Code References Panel
  codeReferences: CodeReference[];
  isCodePanelOpen: boolean;
  setCodePanelOpen: (open: boolean) => void;
  addCodeReference: (ref: Omit<CodeReference, 'id'>) => void;
  /** Resolve a (possibly partial) file path cited by the agent to a real graph file path. */
  resolveFilePath: (requestedPath: string) => string | null;
  removeCodeReference: (id: string) => void;
  clearCodeReferences: () => void;
  codeReferenceFocus: CodeReferenceFocus | null;
}

const AppStateContext = createContext<AppState | null>(null);

export const AppStateProvider = ({ children }: { children: ReactNode }) => (
  <GraphStateProvider>
    <AppStateProviderInner>{children}</AppStateProviderInner>
  </GraphStateProvider>
);

const AppStateProviderInner = ({ children }: { children: ReactNode }) => {
  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('onboarding');

  const {
    graph,
    setGraph,
    selectedNode,
    setSelectedNode,
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
    graphViewMode,
    setGraphViewMode,
    graphMode,
    setGraphMode,
    chatOnlyNodeCount,
    setChatOnlyNodeCount,
  } = useGraphState();

  // Right Panel
  const [isRightPanelOpen, setRightPanelOpen] = useState(false);

  const openCodePanel = useCallback(() => {
    // Legacy API: used by graph/tree selection.
    // Code is now shown in the Code References Panel (left of the graph),
    // so "openCodePanel" just ensures that panel becomes visible when needed.
    setCodePanelOpen(true);
  }, []);

  // Query state
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  // Impact highlights (separate from user/query highlights)
  const [blastRadiusNodeIds, setBlastRadiusNodeIds] = useState<Set<string>>(new Set());

  const clearBlastRadius = useCallback(() => {
    setBlastRadiusNodeIds(new Set());
  }, []);

  const clearQueryHighlights = useCallback(() => {
    setHighlightedNodeIds(new Set());
    setQueryResult(null);
  }, []);

  // Progress
  const [progress, setProgress] = useState<PipelineProgress | null>(null);

  // Project info
  const [projectName, setProjectName] = useState<string>('');
  const [currentRepo, setCurrentRepoState] = useState<string | undefined>(undefined);

  // Multi-repo switching
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(null);
  const [availableRepos, setAvailableRepos] = useState<BackendRepo[]>([]);

  // Code References Panel state
  const [codeReferences, setCodeReferences] = useState<CodeReference[]>([]);
  const [isCodePanelOpen, setCodePanelOpen] = useState(false);
  const [codeReferenceFocus, setCodeReferenceFocus] = useState<CodeReferenceFocus | null>(null);

  // Map of normalized path → original path for resolving partial paths
  const filePathIndex = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.label === 'File' && n.properties.filePath) {
        map.set(normalizePath(n.properties.filePath), n.properties.filePath);
      }
    }
    return map;
  }, [graph]);

  const resolveFilePath = useCallback(
    (requestedPath: string): string | null =>
      resolveUniqueIndexedPath(filePathIndex, requestedPath),
    [filePathIndex],
  );

  // Code References methods
  const addCodeReference = useCallback((ref: Omit<CodeReference, 'id'>) => {
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newRef: CodeReference = { ...ref, id };

    setCodeReferences((prev) => {
      // Don't add duplicates (same file + line range)
      const isDuplicate = prev.some(
        (r) =>
          r.filePath === ref.filePath && r.startLine === ref.startLine && r.endLine === ref.endLine,
      );
      if (isDuplicate) return prev;
      return [...prev, newRef];
    });

    // Auto-open panel when references are added
    setCodePanelOpen(true);

    // Signal the Code Inspector to focus (scroll + glow) this reference.
    // This should happen even if the reference already exists (duplicates are ignored),
    // so it must be separate from the add-to-list behavior.
    setCodeReferenceFocus({
      filePath: ref.filePath,
      startLine: ref.startLine,
      endLine: ref.endLine,
      ts: Date.now(),
    });
  }, []);

  // Auto-add a code reference when the user selects a node in the graph/tree
  useEffect(() => {
    if (!selectedNode) return;
    // User selection should show in the top "Selected file" viewer,
    // not be appended to the AI citations list.
    setCodePanelOpen(true);
  }, [selectedNode]);

  // Backend client — direct HTTP calls (no Worker/Comlink)
  const repoRef = useRef<string | undefined>(undefined);

  const setCurrentRepo = useCallback((repoName: string | undefined) => {
    repoRef.current = repoName;
    setCurrentRepoState(repoName);
  }, []);

  const runQuery = useCallback(async (cypher: string): Promise<any[]> => {
    return backendRunQuery(cypher, repoRef.current);
  }, []);

  const isDatabaseReady = useCallback(async (): Promise<boolean> => {
    return (await probeBackendStatus()) === 'ok';
  }, []);

  // Switch to a different repo on the connected server
  const switchRepo = useCallback(
    async (repoName: string) => {
      if (!serverBaseUrl) return;

      setProgress({
        phase: 'extracting',
        percent: 0,
        message: i18n.t('common:progress.switchingRepository'),
        detail: i18n.t('common:progress.loadingRepository', {
          // `repoName` is a path identity — show the display name, not the path.
          repo: displayNameForIdentity(availableRepos, repoName),
        }),
      });
      setViewMode('loading');

      // Clear stale graph state from previous repo (highlights, selections, blast radius)
      // Without this, sigma reducers dim ALL nodes/edges because old node IDs don't match
      setHighlightedNodeIds(new Set());
      clearBlastRadius();
      setSelectedNode(null);
      setQueryResult(null);
      setCodeReferences([]);
      setCodePanelOpen(false);
      setCodeReferenceFocus(null);
      // Reset graph-load mode up front so a FAILED switch can't leave the
      // previous repo's stale chat-only overlay showing (#2178). The success
      // path re-derives the mode from the connect result below.
      setGraphMode('full');
      setChatOnlyNodeCount(null);

      let connectedRepo: BackendRepo | undefined;
      // Bare declarations: both are always assigned on the success path before
      // any read, and the catch below returns early (CodeQL alerts 825/826).
      let pNameStr: string;
      let repoIdentity: string | undefined;

      try {
        const result: ConnectResult = await connectToServer(
          serverBaseUrl,
          (phase, downloaded, total) => {
            if (phase === 'validating') {
              setProgress({
                phase: 'extracting',
                percent: 5,
                message: i18n.t('common:progress.switchingRepository'),
                detail: i18n.t('common:progress.validating'),
              });
            } else if (phase === 'downloading') {
              const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
              const mb = (downloaded / (1024 * 1024)).toFixed(1);
              setProgress({
                phase: 'extracting',
                percent: pct,
                message: i18n.t('common:progress.downloadingGraph'),
                detail: i18n.t('common:progress.downloadedMb', { mb }),
              });
            } else if (phase === 'extracting') {
              setProgress({
                phase: 'extracting',
                percent: 97,
                message: i18n.t('common:progress.processing'),
                detail: i18n.t('common:progress.extractingFileContents'),
              });
            }
          },
          undefined,
          repoName,
          { awaitAnalysis: true }, // enable backend hold-queue for repos still being analyzed
        );

        // Build graph for visualization
        const repoPath = result.repoInfo.repoPath ?? result.repoInfo.path;
        // Prefer the registry name, then normalize Windows \ and Unix / paths
        const pName =
          result.repoInfo.name ||
          (repoPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
          repoName ||
          'server-project';
        repoIdentity = repoName || repoPath || pName;
        setProjectName(pName);
        setCurrentRepo(repoIdentity);

        connectedRepo = result.repoInfo;
        pNameStr = pName;

        // In chat-only mode the graph download was skipped; the shared builder
        // keeps an empty (but non-null) graph so existing `graph?.` consumers
        // stay happy, and reports the mode + node count in lockstep.
        const built = buildGraphFromConnectResult(result);
        setGraph(built.graph);
        setGraphMode(built.graphMode);
        setChatOnlyNodeCount(built.graphMode === 'chatOnly' ? built.nodeCount : null);
      } catch (err: unknown) {
        console.error('Repo switch failed:', err);
        setProgress({
          phase: 'error',
          percent: 0,
          message: i18n.t('common:progress.failedSwitchRepository'),
          detail: err instanceof Error ? err.message : i18n.t('common:progress.unknownError'),
        });
        setTimeout(() => {
          setViewMode('exploring');
          setProgress(null);
        }, ERROR_RESET_DELAY_MS);
        return; // Abort the whole switchRepo process
      }

      if (pNameStr) {
        // Persist the selected project in the URL so a refresh re-opens it.
        // `repo` carries the server-resolved path identity (never the
        // request-side string) so the refresh restores this exact repo even
        // when duplicate display names exist (#2419); `project` stays as the
        // readable display name.
        // Drop any `?skipGraph` override: a deliberate repo switch should make a
        // fresh per-repo decision (auto-detect) on the next refresh rather than
        // carry the previous repo's forced mode (#2178).
        const urlObj = new URL(window.location.href);
        urlObj.searchParams.set('project', pNameStr);
        const resolvedRepoPath = connectedRepo?.repoPath ?? connectedRepo?.path;
        if (resolvedRepoPath) {
          urlObj.searchParams.set('repo', resolvedRepoPath);
        }
        urlObj.searchParams.delete('skipGraph');
        window.history.replaceState(null, '', urlObj.toString());
      }

      setViewMode('exploring');
      setProgress(null);
    },
    [
      serverBaseUrl,
      availableRepos,
      setProgress,
      setViewMode,
      setProjectName,
      setGraph,
      setGraphMode,
      setChatOnlyNodeCount,
      setHighlightedNodeIds,
      clearBlastRadius,
      setSelectedNode,
      setQueryResult,
      setCodeReferences,
      setCodePanelOpen,
      setCodeReferenceFocus,
      setCurrentRepo,
    ],
  );

  // Load the full graph for the current repo after a chat-only connection.
  // This is the escape hatch behind the chat-only empty state (#2178). It
  // forces `skipGraph: false` so the size-based auto-detect cannot re-skip it.
  // The override is session-scoped (deliberately NOT persisted to the URL): a
  // persisted `?skipGraph=0` would leak onto a different repo via the other
  // connect entry points and could silently re-trigger the hang on refresh.
  const loadGraphInFlightRef = useRef(false);
  // Cancels the in-flight load-anyway download; mountedRef gates post-await
  // state writes so an unmount mid-download can't setState on a dead instance.
  const loadGraphAbortRef = useRef<AbortController | null>(null);
  const loadGraphMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      loadGraphMountedRef.current = false;
      loadGraphAbortRef.current?.abort();
    };
  }, []);
  const loadGraphAnyway = useCallback(async (): Promise<void> => {
    if (!serverBaseUrl) return;
    // Guard against a double-trigger (rapid double-click or a racing
    // programmatic call) starting two concurrent full-graph downloads.
    if (loadGraphInFlightRef.current) return;
    loadGraphInFlightRef.current = true;
    const repo = repoRef.current;
    const controller = new AbortController();
    loadGraphAbortRef.current = controller;

    setProgress({
      phase: 'extracting',
      percent: 0,
      message: i18n.t('common:progress.downloadingGraph'),
      detail: i18n.t('common:progress.validating'),
    });
    setViewMode('loading');

    try {
      const result = await connectToServer(
        serverBaseUrl,
        (phase, downloaded, total) => {
          if (phase === 'downloading') {
            const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            setProgress({
              phase: 'extracting',
              percent: pct,
              message: i18n.t('common:progress.downloadingGraph'),
              detail: i18n.t('common:progress.downloadedMb', { mb }),
            });
          }
        },
        controller.signal,
        repo,
        { awaitAnalysis: true, skipGraph: false },
      );

      // Bail if we unmounted, or if a concurrent switchRepo changed the active
      // repo while this load was in flight (the late result must not clobber the
      // new repo's state). Guard keyed on the ref — an abort surfaces as a
      // BackendError, not a DOMException AbortError.
      if (!loadGraphMountedRef.current || repoRef.current !== repo) return;

      const built = buildGraphFromConnectResult(result);
      setGraph(built.graph);
      setGraphMode(built.graphMode);
      // Full download succeeded → leave chat-only mode; clear the cached count.
      setChatOnlyNodeCount(built.graphMode === 'chatOnly' ? built.nodeCount : null);

      setProgress(null);
      setViewMode('exploring');
    } catch (err) {
      if (!loadGraphMountedRef.current || repoRef.current !== repo) return;
      console.error('Load graph anyway failed:', err);
      // Stay in chat-only mode (the overlay reappears) and return to the view.
      setProgress(null);
      setViewMode('exploring');
    } finally {
      if (loadGraphAbortRef.current === controller) loadGraphAbortRef.current = null;
      loadGraphInFlightRef.current = false;
    }
  }, [
    serverBaseUrl,
    availableRepos,
    setProgress,
    setViewMode,
    setGraph,
    setGraphMode,
    setChatOnlyNodeCount,
  ]);

  const removeCodeReference = useCallback(
    (id: string) => {
      setCodeReferences((prev) => {
        const newRefs = prev.filter((r) => r.id !== id);

        // Auto-close panel if no references left AND no selection in top viewer
        if (newRefs.length === 0 && !selectedNode) {
          setCodePanelOpen(false);
        }

        return newRefs;
      });
    },
    [selectedNode],
  );

  const clearCodeReferences = useCallback(() => {
    setCodeReferences([]);
    setCodePanelOpen(false);
    setCodeReferenceFocus(null);
  }, []);

  const value: AppState = {
    viewMode,
    setViewMode,
    graph,
    setGraph,
    selectedNode,
    setSelectedNode,
    isRightPanelOpen,
    setRightPanelOpen,
    openCodePanel,
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    graphViewMode,
    setGraphViewMode,
    graphMode,
    setGraphMode,
    chatOnlyNodeCount,
    setChatOnlyNodeCount,
    highlightedNodeIds,
    setHighlightedNodeIds,
    blastRadiusNodeIds,
    setBlastRadiusNodeIds,
    clearBlastRadius,
    queryResult,
    setQueryResult,
    clearQueryHighlights,
    progress,
    setProgress,
    projectName,
    setProjectName,
    currentRepo,
    // Multi-repo switching
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    setCurrentRepo,
    loadGraphAnyway,
    runQuery,
    isDatabaseReady,
    // Code References Panel
    codeReferences,
    isCodePanelOpen,
    setCodePanelOpen,
    addCodeReference,
    resolveFilePath,
    removeCodeReference,
    clearCodeReferences,
    codeReferenceFocus,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
};

export const useAppState = (): AppState => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useAppState must be used within AppStateProvider');
  }
  return context;
};
