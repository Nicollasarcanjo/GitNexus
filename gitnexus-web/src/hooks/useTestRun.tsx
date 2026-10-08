import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { fetchTestRun, type TestRun, type TestStatus } from '../services/backend-client';
import { useAppState } from './useAppState';

/** Poll fast while a run is open, slowly otherwise so a new run is noticed. */
const RUNNING_POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

export const TEST_STATUS_COLORS: Record<TestStatus, string> = {
  pending: '#f59e0b',
  passed: '#22c55e',
  failed: '#ef4444',
  skipped: '#94a3b8',
};

interface TestRunContextValue {
  run: TestRun | null;
  /** Graph node id → status colour, for test files and their test methods. */
  nodeColors: Map<string, string>;
  /** Graph node id → test file path, so a click on the graph finds its results. */
  nodeFiles: Map<string, string>;
  /** Test file path → its File node id, to focus it from the results list. */
  fileNodeIds: Map<string, string>;
  /** Whether the run colours the graph; the results list stays either way. */
  showOnGraph: boolean;
  setShowOnGraph: (show: boolean) => void;
}

const NO_NODES = new Map<string, string>();
const EMPTY: TestRunContextValue = {
  run: null,
  nodeColors: NO_NODES,
  nodeFiles: NO_NODES,
  fileNodeIds: NO_NODES,
  showOnGraph: true,
  setShowOnGraph: () => {},
};
const TestRunContext = createContext<TestRunContextValue>(EMPTY);

export const TestRunProvider = ({ children }: { children: ReactNode }) => {
  const { currentRepo, viewMode, graph } = useAppState();
  const [run, setRun] = useState<TestRun | null>(null);
  const lastStampRef = useRef<string | null>(null);

  useEffect(() => {
    lastStampRef.current = null;
    setRun(null);
    if (viewMode !== 'exploring' || !currentRepo) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next: TestRun | null = null;
      try {
        next = await fetchTestRun(currentRepo);
      } catch {
        // Server briefly away: keep what is on screen and try again.
        if (!cancelled) timer = setTimeout(poll, IDLE_POLL_MS);
        return;
      }
      if (cancelled) return;
      const stamp = next ? `${next.id}:${next.updatedAt}` : null;
      if (stamp !== lastStampRef.current) {
        lastStampRef.current = stamp;
        setRun(next);
      }
      timer = setTimeout(poll, next?.status === 'running' ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [currentRepo, viewMode]);

  const [showOnGraph, setShowOnGraph] = useState(true);
  const runId = run?.id;
  // A new run always shows, even if the previous one was hidden.
  useEffect(() => setShowOnGraph(true), [runId]);

  const value = useMemo<TestRunContextValue>(() => {
    if (!run) return EMPTY;
    const byFile = new Map(run.files.map((file) => [file.filePath, file]));
    const nodeColors = new Map<string, string>();
    const nodeFiles = new Map<string, string>();
    const fileNodeIds = new Map<string, string>();
    for (const node of graph?.nodes ?? []) {
      const filePath = node.properties.filePath;
      const file = filePath ? byFile.get(filePath) : undefined;
      if (!file) continue;
      nodeFiles.set(node.id, file.filePath);
      if (node.label === 'File') {
        fileNodeIds.set(file.filePath, node.id);
        nodeColors.set(node.id, TEST_STATUS_COLORS[file.status]);
        continue;
      }
      // A test method/function carries its own result; other symbols in the
      // file (helpers, the class) follow the file.
      const own = file.tests.find((test) => test.name === node.properties.name);
      nodeColors.set(node.id, TEST_STATUS_COLORS[own ? own.status : file.status]);
    }
    return {
      run,
      nodeColors: showOnGraph ? nodeColors : NO_NODES,
      nodeFiles,
      fileNodeIds,
      showOnGraph,
      setShowOnGraph,
    };
  }, [run, graph, showOnGraph]);

  return <TestRunContext.Provider value={value}>{children}</TestRunContext.Provider>;
};

export const useTestRun = (): TestRunContextValue => useContext(TestRunContext);
