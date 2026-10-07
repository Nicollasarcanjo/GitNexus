import { useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Focus,
  RotateCcw,
  Network,
  GitBranch,
  Target,
} from '@/lib/lucide-icons';
import { useSigma } from '../hooks/useSigma';
import { useAppState } from '../hooks/useAppState';
import {
  knowledgeGraphToGraphology,
  knowledgeGraphToTreeGraphology,
  knowledgeGraphToCirclesGraphology,
  filterGraphByLabels,
  SigmaNodeAttributes,
  SigmaEdgeAttributes,
} from '../lib/graph-adapter';
import type { GraphNode } from 'gitnexus-shared';
import { QueryFAB } from './QueryFAB';
import { IconButton, SegmentedTabs } from './ui';
import Graph from 'graphology';
import { useTranslation } from 'react-i18next';
import { LARGE_GRAPH_NODE_THRESHOLD } from '../config/ui-constants';
import { shouldConfirmGraphLoad } from '../lib/graph-load-decision';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle>((_, ref) => {
  const { t } = useTranslation('graph');
  const {
    graph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    visibleEdgeTypes,
    openCodePanel,
    depthFilter,
    highlightedNodeIds,
    blastRadiusNodeIds,
    graphViewMode,
    setGraphViewMode,
    graphMode,
    chatOnlyNodeCount,
    loadGraphAnyway,
  } = useAppState();
  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    return new Map(graph.nodes.map((n) => [n.id, n]));
  }, [graph]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (!graph) return;
      const node = nodeById.get(nodeId);
      if (node) {
        setSelectedNode(node);
        openCodePanel();
      }
    },
    [graph, nodeById, setSelectedNode, openCodePanel],
  );

  const handleNodeHover = useCallback(
    (nodeId: string | null) => {
      if (!nodeId || !graph) {
        setHoveredNodeName(null);
        return;
      }
      const node = nodeById.get(nodeId);
      setHoveredNodeName(node ? node.properties.name : null);
    },
    [graph, nodeById],
  );

  const handleStageClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  const {
    containerRef,
    sigmaRef,
    setGraph: setSigmaGraph,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    isLayoutRunning,
    selectedNode: sigmaSelectedNode,
    setSelectedNode: setSigmaSelectedNode,
    refreshHighlights,
  } = useSigma({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onStageClick: handleStageClick,
    highlightedNodeIds,
    blastRadiusNodeIds,
    visibleEdgeTypes,
    layoutMode: graphViewMode,
    focusDepth: depthFilter,
  });

  const handleViewModeChange = useCallback(
    (mode: 'force' | 'tree' | 'circles') => {
      if (mode === graphViewMode) return;
      setSelectedNode(null);
      setSigmaSelectedNode(null);
      setHoveredNodeName(null);
      setGraphViewMode(mode);
      // Reset zoom when switching views
      resetZoom();
    },
    [graphViewMode, resetZoom, setGraphViewMode, setSelectedNode, setSigmaSelectedNode],
  );

  // Expose focusNode to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      focusNode: (nodeId: string) => {
        // Also update app state so the selection syncs properly
        if (graph) {
          const node = nodeById.get(nodeId);
          if (node) {
            setSelectedNode(node);
            openCodePanel();
          }
        }
        focusNode(nodeId);
      },
    }),
    [focusNode, graph, nodeById, setSelectedNode, openCodePanel],
  );

  // Update Sigma graph when KnowledgeGraph changes
  useEffect(() => {
    // Skip layout work in chat-only mode: `graph` is non-null but empty, the
    // overlay covers the canvas, and this guard also future-proofs against a
    // transient where a populated graph is set while mode is still chat-only.
    if (!graph || graphMode === 'chatOnly') return;

    let sigmaGraph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;

    if (graphViewMode === 'tree') {
      sigmaGraph = knowledgeGraphToTreeGraphology(graph);
    } else if (graphViewMode === 'circles') {
      sigmaGraph = knowledgeGraphToCirclesGraphology(graph);
    } else {
      // Build community memberships map from MEMBER_OF relationships
      const communityMemberships = new Map<string, number>();
      graph.relationships.forEach((rel) => {
        if (rel.type === 'MEMBER_OF') {
          const communityNode = nodeById.get(rel.targetId);
          if (communityNode && communityNode.label === 'Community') {
            const numericPart = rel.targetId.replace('comm_', '');
            const communityIdx = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : 0;
            communityMemberships.set(rel.sourceId, communityIdx);
          }
        }
      });
      sigmaGraph = knowledgeGraphToGraphology(graph, communityMemberships);
    }

    setSigmaGraph(sigmaGraph);
  }, [graph, graphMode, nodeById, setSigmaGraph, graphViewMode]);

  // Update node visibility when filters change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    const sigmaGraph = sigma.getGraph() as Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
    if (sigmaGraph.order === 0) return; // Don't filter empty graph

    // Node-type visibility only. Focus depth around the selection is applied
    // by useSigma's reducers, which avoids rewriting an attribute on every
    // node (one graph event each) for every click.
    filterGraphByLabels(sigmaGraph, visibleLabels);
    refreshHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sigmaRef identity never changes
  }, [graph, graphViewMode, visibleLabels]);

  // Sync app selected node with sigma
  useEffect(() => {
    if (appSelectedNode) {
      setSigmaSelectedNode(appSelectedNode.id);
    } else {
      setSigmaSelectedNode(null);
    }
  }, [appSelectedNode, setSigmaSelectedNode]);

  // Focus on selected node
  const handleFocusSelected = useCallback(() => {
    if (appSelectedNode) {
      focusNode(appSelectedNode.id);
    }
  }, [appSelectedNode, focusNode]);

  // Clear selection
  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
    setSigmaSelectedNode(null);
    resetZoom();
  }, [setSelectedNode, setSigmaSelectedNode, resetZoom]);

  // Chat-only mode (#2178): the graph download was skipped. `chatOnlyNodeCount`
  // comes from app state (captured at connect time), so it is authoritative and
  // available immediately — not derived from the async `availableRepos` list.
  const handleLoadGraphAnyway = useCallback(() => {
    // Warn before re-triggering a potentially browser-hanging download. Confirm
    // whenever the count is large OR unknown — never silently re-load a graph we
    // can't size, which would risk re-introducing the original #2178 hang. Skip
    // the prompt only when the count is known to be below the threshold (a small
    // repo force-skipped via ?skipGraph=1).
    const needsConfirm = shouldConfirmGraphLoad(chatOnlyNodeCount, LARGE_GRAPH_NODE_THRESHOLD);
    if (needsConfirm) {
      // Fail SAFE, not open: if there's no usable confirm dialog (some embedded
      // webviews) or it throws, treat it as declined rather than loading a
      // graph we couldn't warn about (#2178).
      const canPrompt = typeof window !== 'undefined' && typeof window.confirm === 'function';
      if (!canPrompt) return;
      let confirmed = false;
      try {
        confirmed = window.confirm(
          chatOnlyNodeCount != null
            ? t('canvas.chatOnly.loadAnywayWarning', { count: chatOnlyNodeCount.toLocaleString() })
            : t('canvas.chatOnly.loadAnywayWarningUnknown'),
        );
      } catch {
        return;
      }
      if (!confirmed) return;
    }
    void loadGraphAnyway();
  }, [chatOnlyNodeCount, loadGraphAnyway, t]);

  return (
    <div className="relative h-full w-full bg-void">
      {/* Background gradient */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.03) 0%, transparent 70%),
              linear-gradient(to bottom, #06060a, #0a0a10)
            `,
          }}
        />
      </div>

      {/* View Mode Tabs */}
      <SegmentedTabs
        label={t('canvas.viewModes.label')}
        value={graphViewMode}
        onChange={handleViewModeChange}
        className="absolute top-4 left-1/2 z-20 -translate-x-1/2"
        options={[
          {
            value: 'force',
            label: t('canvas.viewModes.force'),
            icon: <Network className="h-3.5 w-3.5" />,
          },
          {
            value: 'tree',
            label: t('canvas.viewModes.tree'),
            icon: <GitBranch className="h-3.5 w-3.5" />,
          },
          {
            value: 'circles',
            label: t('canvas.viewModes.circles'),
            icon: <Target className="h-3.5 w-3.5" />,
          },
        ]}
      />

      {/* Sigma container */}
      <div
        ref={containerRef}
        className="sigma-container h-full w-full cursor-grab active:cursor-grabbing"
      />

      {/* Chat-only empty state (#2178): graph download was skipped for a large
          project. Chat works normally; offer an explicit "load anyway" escape. */}
      {graphMode === 'chatOnly' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-border-subtle bg-elevated p-6 text-center shadow-lg">
            <h3 className="text-lg font-semibold text-text-primary">
              {t('canvas.chatOnly.title')}
            </h3>
            <p className="mt-2 text-sm text-text-secondary">
              {chatOnlyNodeCount != null
                ? t('canvas.chatOnly.descriptionWithCount', {
                    count: chatOnlyNodeCount.toLocaleString(),
                  })
                : t('canvas.chatOnly.description')}
            </p>
            <button
              onClick={handleLoadGraphAnyway}
              className="mt-4 rounded-md border border-accent/30 bg-accent/20 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/30"
            >
              {t('canvas.chatOnly.loadAnyway')}
            </button>
          </div>
        </div>
      )}

      {/* Hovered node tooltip - only show when NOT selected */}
      {hoveredNodeName && !sigmaSelectedNode && (
        <div className="pointer-events-none absolute top-4 left-1/2 z-20 -translate-x-1/2 animate-fade-in rounded-lg border border-border-subtle bg-elevated px-3 py-1.5">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {sigmaSelectedNode && appSelectedNode && (
        <div className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 animate-slide-up items-center gap-2 rounded-xl border border-accent/30 bg-[#2a1d48] px-4 py-2">
          <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">({appSelectedNode.label})</span>
          <button
            onClick={handleClearSelection}
            className="ml-2 rounded px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
          >
            {t('canvas.clear')}
          </button>
        </div>
      )}

      {/* Graph Controls - Bottom Right */}
      <div className="absolute right-4 bottom-4 z-10 flex flex-col gap-1">
        <IconButton label={t('canvas.zoomIn')} onClick={zoomIn}>
          <ZoomIn className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('canvas.zoomOut')} onClick={zoomOut}>
          <ZoomOut className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('canvas.fit')} onClick={resetZoom}>
          <Maximize2 className="h-4 w-4" />
        </IconButton>

        {(appSelectedNode || sigmaSelectedNode) && <div className="my-1 h-px bg-border-subtle" />}

        {appSelectedNode && (
          <IconButton label={t('canvas.focusSelected')} tone="accent" onClick={handleFocusSelected}>
            <Focus className="h-4 w-4" />
          </IconButton>
        )}

        {sigmaSelectedNode && (
          <IconButton label={t('canvas.clearSelection')} onClick={handleClearSelection}>
            <RotateCcw className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-emerald-500/30 bg-[#153733] px-3 py-1.5">
          <div className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
          <span className="text-xs font-medium text-emerald-400">
            {t('canvas.layoutOptimizing')}
          </span>
        </div>
      )}

      {/* Query FAB */}
      <QueryFAB />
    </div>
  );
});

GraphCanvas.displayName = 'GraphCanvas';
