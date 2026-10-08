import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Eye, EyeOff, FlaskConical, Loader2 } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { TEST_STATUS_COLORS, useTestRun } from '../hooks/useTestRun';
import type { TestRunFile, TestStatus } from '../services/backend-client';
import { IconButton, SegmentedTabs } from './ui';

interface TestRunPanelProps {
  onFocusNode: (nodeId: string) => void;
}

/** Failures first, then what is still pending, then the rest — alphabetical within each. */
const STATUS_ORDER: Record<TestStatus, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };
const TOTAL_ORDER: readonly TestStatus[] = ['passed', 'failed', 'pending', 'skipped'];

const StatusDot = ({ status, pulse = false }: { status: TestStatus; pulse?: boolean }) => (
  <span
    aria-hidden
    className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${pulse ? 'animate-pulse' : ''}`}
    style={{ backgroundColor: TEST_STATUS_COLORS[status] }}
  />
);

const formatDuration = (ms: number | undefined): string | null => {
  if (ms === undefined) return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
};

const splitPath = (filePath: string): { dir: string; base: string } => {
  const cut = filePath.lastIndexOf('/');
  return cut === -1
    ? { dir: '', base: filePath }
    : { dir: filePath.slice(0, cut + 1), base: filePath.slice(cut + 1) };
};

/**
 * Results of the run reported by `gitnexus test-report`: one row per test file,
 * expanding to each test and — for a failure — why it failed. Clicking a file
 * focuses its node; selecting a test node on the graph opens its file here.
 */
export const TestRunPanel = ({ onFocusNode }: TestRunPanelProps) => {
  const { t } = useTranslation('tests');
  const { selectedNode } = useAppState();
  const { run, nodeFiles, fileNodeIds, showOnGraph, setShowOnGraph } = useTestRun();
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // A node picked on the graph opens the results of the file it belongs to.
  const selectedFile = selectedNode ? nodeFiles.get(selectedNode.id) : undefined;
  useEffect(() => {
    if (!selectedFile) return;
    setCollapsed(false);
    // Keep the failures filter unless it would hide the file just picked.
    const picked = run?.files.find((file) => file.filePath === selectedFile);
    if (picked?.status !== 'failed') setFilter('all');
    setOpenFile(selectedFile);
    // Wait for the row to render expanded before bringing it into view.
    requestAnimationFrame(() =>
      rowRefs.current.get(selectedFile)?.scrollIntoView({ block: 'nearest' }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to a new selection, not to every poll of `run`
  }, [selectedFile]);

  const files = useMemo(() => {
    if (!run) return [];
    const visible =
      filter === 'failed' ? run.files.filter((file) => file.status === 'failed') : run.files;
    return [...visible].sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.filePath.localeCompare(b.filePath),
    );
  }, [run, filter]);

  if (!run) return null;

  const running = run.status === 'running';
  const done = run.totals.files - run.totals.pending;
  const progress = run.totals.files === 0 ? 0 : Math.round((done / run.totals.files) * 100);

  const toggleFile = (file: TestRunFile) => {
    const opening = openFile !== file.filePath;
    setOpenFile(opening ? file.filePath : null);
    const nodeId = fileNodeIds.get(file.filePath);
    if (opening && nodeId) onFocusNode(nodeId);
  };

  return (
    <section
      aria-label={t('title')}
      className="pointer-events-auto absolute top-16 right-4 z-20 flex max-h-[calc(100%-9rem)] w-[380px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-xl border border-border-subtle bg-elevated shadow-lg"
    >
      <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <FlaskConical className="h-4 w-4 flex-shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <span>{t('title')}</span>
            <span className="flex items-center gap-1 text-xs font-normal text-text-muted">
              {running && <Loader2 className="h-3 w-3 animate-spin" />}
              {running ? t('running') : t('finished')}
            </span>
          </div>
          {run.label && (
            <div className="truncate font-mono text-[11px] text-text-muted" title={run.label}>
              {run.label}
            </div>
          )}
        </div>
        <IconButton
          label={showOnGraph ? t('hideOnGraph') : t('showOnGraph')}
          tone="ghost"
          size="sm"
          onClick={() => setShowOnGraph(!showOnGraph)}
        >
          {showOnGraph ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </IconButton>
        <IconButton
          label={collapsed ? t('expand') : t('collapse')}
          tone="ghost"
          size="sm"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </IconButton>
      </header>

      <div className="border-b border-border-subtle px-3 py-2">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="h-1.5 overflow-hidden rounded-full bg-surface"
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${progress}%`,
              backgroundColor:
                run.totals.failed > 0 ? TEST_STATUS_COLORS.failed : TEST_STATUS_COLORS.passed,
            }}
          />
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
          {TOTAL_ORDER.filter((status) => run.totals[status] > 0).map((status) => (
            <li key={status} className="flex items-center gap-1.5">
              <StatusDot status={status} />
              {t(`totals.${status}`, { count: run.totals[status] })}
            </li>
          ))}
        </ul>
      </div>

      {!collapsed && (
        <>
          <div className="px-3 pt-2">
            <SegmentedTabs
              label={t('filters.label')}
              value={filter}
              onChange={setFilter}
              className="w-fit"
              options={[
                { value: 'all', label: t('filters.all') },
                { value: 'failed', label: t('filters.failed') },
              ]}
            />
          </div>

          <ul className="flex-1 scrollbar-thin overflow-y-auto px-1.5 py-2">
            {files.length === 0 && (
              <li className="px-2 py-3 text-xs text-text-muted">
                {filter === 'failed' ? t('noFailures') : t('noFiles')}
              </li>
            )}
            {files.map((file) => {
              const isOpen = openFile === file.filePath;
              const { dir, base } = splitPath(file.filePath);
              const passed = file.tests.filter((test) => test.status === 'passed').length;
              return (
                <li
                  key={file.filePath}
                  ref={(element) => {
                    if (element) rowRefs.current.set(file.filePath, element);
                    else rowRefs.current.delete(file.filePath);
                  }}
                >
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggleFile(file)}
                    title={
                      fileNodeIds.has(file.filePath)
                        ? file.filePath
                        : `${file.filePath} — ${t('notInGraph')}`
                    }
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  >
                    <StatusDot status={file.status} pulse={running && file.status === 'pending'} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      <span className="text-text-muted">{dir}</span>
                      <span className="text-text-primary">{base}</span>
                    </span>
                    {file.tests.length > 0 && (
                      <span className="flex-shrink-0 text-[11px] text-text-muted tabular-nums">
                        {t('fileCount', { done: passed, total: file.tests.length })}
                      </span>
                    )}
                  </button>

                  {isOpen && (
                    <ul className="mt-0.5 mb-1.5 ml-4 border-l border-border-subtle pl-3">
                      {file.tests.length === 0 && (
                        <li className="py-1 text-xs text-text-muted">
                          {running ? t('notRunYet') : t('notRun')}
                        </li>
                      )}
                      {file.tests.map((test) => (
                        <li key={test.name} className="py-1">
                          <div className="flex items-baseline gap-2">
                            <span className="translate-y-px">
                              <StatusDot status={test.status} />
                            </span>
                            <span className="min-w-0 flex-1 text-xs break-words text-text-primary">
                              {test.name}
                            </span>
                            <span className="flex-shrink-0 text-[11px] text-text-muted tabular-nums">
                              {formatDuration(test.durationMs) ?? t(`status.${test.status}`)}
                            </span>
                          </div>
                          {test.status !== 'passed' &&
                            (test.message || test.status === 'failed') && (
                              <p
                                className="mt-1 ml-[18px] text-xs break-words whitespace-pre-wrap"
                                style={{
                                  color:
                                    test.status === 'failed'
                                      ? TEST_STATUS_COLORS.failed
                                      : undefined,
                                }}
                              >
                                {test.message || t('noReason')}
                              </p>
                            )}
                          {test.details && test.details !== test.message && (
                            <details className="mt-1 ml-[18px]">
                              <summary className="cursor-pointer text-[11px] text-text-muted hover:text-text-secondary">
                                {t('showDetails')}
                              </summary>
                              <pre className="mt-1 max-h-64 scrollbar-thin overflow-auto rounded-md bg-surface p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-text-secondary">
                                {test.details}
                              </pre>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
};
