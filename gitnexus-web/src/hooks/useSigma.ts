import { useRef, useEffect, useCallback, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';
import EdgeCurveProgram from '@sigma/edge-curve';
import { EdgeRectangleProgram } from 'sigma/rendering';
import type { CameraState } from 'sigma/types';
import { SigmaNodeAttributes, SigmaEdgeAttributes, getNodesWithinHops } from '../lib/graph-adapter';
import type { EdgeType } from '../lib/constants';
// Helper: Parse hex color to RGB
const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 100, g: 100, b: 100 };
};

// Helper: RGB to hex
const rgbToHex = (r: number, g: number, b: number): string => {
  return (
    '#' +
    [r, g, b]
      .map((x) => {
        const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('')
  );
};

// The reducers run for every node/edge on each refresh, but only ever see a
// handful of distinct (color, amount) pairs — cache instead of re-parsing hex.
const dimColorCache = new Map<string, string>();
const brightenColorCache = new Map<string, string>();

// Dim a color by mixing with dark background (keeps color hint)
const dimColor = (hex: string, amount: number): string => {
  const cacheKey = `${hex}|${amount}`;
  const cached = dimColorCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = computeDimColor(hex, amount);
  dimColorCache.set(cacheKey, result);
  return result;
};

const computeDimColor = (hex: string, amount: number): string => {
  const rgb = hexToRgb(hex);
  const darkBg = { r: 18, g: 18, b: 28 }; // #12121c - dark background
  return rgbToHex(
    darkBg.r + (rgb.r - darkBg.r) * amount,
    darkBg.g + (rgb.g - darkBg.g) * amount,
    darkBg.b + (rgb.b - darkBg.b) * amount,
  );
};

// Brighten a color (increase luminosity)
const brightenColor = (hex: string, factor: number): string => {
  const cacheKey = `${hex}|${factor}`;
  const cached = brightenColorCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = computeBrightenColor(hex, factor);
  brightenColorCache.set(cacheKey, result);
  return result;
};

const computeBrightenColor = (hex: string, factor: number): string => {
  const rgb = hexToRgb(hex);
  return rgbToHex(
    rgb.r + ((255 - rgb.r) * (factor - 1)) / factor,
    rgb.g + ((255 - rgb.g) * (factor - 1)) / factor,
    rgb.b + ((255 - rgb.b) * (factor - 1)) / factor,
  );
};

interface UseSigmaOptions {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onStageClick?: () => void;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
  visibleEdgeTypes?: EdgeType[];
  layoutMode?: 'force' | 'tree' | 'circles';
  /**
   * With a node selected, render only what is within this many hops of it and
   * hide everything else. `null` keeps the whole graph visible (dimmed).
   */
  focusDepth?: number | null;
}

interface UseSigmaReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sigmaRef: React.RefObject<Sigma | null>;
  setGraph: (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusNode: (nodeId: string) => void;
  isLayoutRunning: boolean;
  selectedNode: string | null;
  setSelectedNode: (nodeId: string | null) => void;
  refreshHighlights: () => void;
}

// Noverlap for final cleanup - minimal since it starts with good positions
const NOVERLAP_SETTINGS = {
  maxIterations: 20, // Reduced - less cleanup needed
  ratio: 1.1,
  margin: 10,
  expansion: 1.05,
};

// ForceAtlas2 settings - FAST convergence since nodes start near their parents
const getFA2Settings = (nodeCount: number) => {
  const isSmall = nodeCount < 500;
  const isMedium = nodeCount >= 500 && nodeCount < 2000;
  const isLarge = nodeCount >= 2000 && nodeCount < 10000;

  return {
    // Lower gravity allows folders to stay spread out
    gravity: isSmall ? 0.8 : isMedium ? 0.5 : isLarge ? 0.3 : 0.15,

    // Higher scaling ratio = more spread out overall
    scalingRatio: isSmall ? 15 : isMedium ? 30 : isLarge ? 60 : 100,

    // LOW slowDown = FASTER movement (converges quicker)
    slowDown: isSmall ? 1 : isMedium ? 2 : isLarge ? 3 : 5,

    // Barnes-Hut for performance - use it even on smaller graphs
    barnesHutOptimize: nodeCount > 200,
    barnesHutTheta: isLarge ? 0.8 : 0.6, // Higher = faster but less accurate

    // These help with clustering while keeping spread
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: true,
    edgeWeightInfluence: 1,
  };
};

// Layout duration. The worker keeps the CPU off the main thread, but every
// iteration still re-uploads the whole graph to the GPU, so the canvas stays
// expensive for as long as this runs. Nodes start near their parents and
// converge fast; the play button re-runs the layout if more passes are wanted.
const getLayoutDuration = (nodeCount: number): number => {
  if (nodeCount > 10000) return 30000; // 30s for huge graphs
  if (nodeCount > 5000) return 25000; // 25s
  if (nodeCount > 2000) return 20000; // 20s
  if (nodeCount > 1000) return 15000; // 15s
  if (nodeCount > 500) return 12000; // 12s
  return 8000; // 8s for small graphs
};

// Above these sizes the per-edge curve shader and per-frame label pass are the
// dominant render cost, and individual curves are no longer distinguishable.
const STRAIGHT_EDGE_THRESHOLD = 5000;
const HIDE_LABELS_ON_MOVE_NODE_THRESHOLD = 3000;
// While a layout runs every repaint re-indexes all edges, which is most of the
// cost on big graphs. Above this edge count they are hidden until it settles
// (same idea as hideEdgesOnMove).
const HIDE_EDGES_DURING_LAYOUT_THRESHOLD = 20000;
// Sigma draws a label pill on the 2D hover canvas for every `highlighted` node
// on every frame. Past this many highlighted nodes the pills are unreadable and
// dominate render time, so nodes keep their highlight color / size only.
const MAX_HIGHLIGHT_LABELS = 300;
// ForceAtlas2 writes every iteration back to the graph, and Sigma answers each
// write by re-reducing and re-indexing everything on the main thread. Above
// this node count the worker runs on a detached copy instead and positions are
// copied over at the paced repaint cadence.
const DETACHED_FA2_NODE_THRESHOLD = 5000;
// Noverlap runs synchronously on the main thread and its cost explodes with
// dense clusters: on a ~31k-node graph the "light cleanup" froze the tab for
// about two minutes when the layout ended. FA2 already runs with adjustSizes,
// so past this size the cleanup pass is skipped.
const NOVERLAP_MAX_NODES = 5000;
// In focus mode the selected node's neighbours always show their label up to
// this many; beyond it Sigma's normal label density rules apply.
const FOCUS_FORCE_LABEL_MAX = 60;

const sameSet = (a: Set<string>, b: Set<string>): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
};

const sameList = <T>(a: T[] | null, b: T[] | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
// Tree / circles layouts wait this many multiples of the last repaint's cost
// before repainting again.
const LAYOUT_RENDER_BACKOFF = 2;

const TREE_MAX_X = 540;
const TREE_REPULSION_RANGE = 130;
const TREE_LAYOUT_MAX_DURATION = 18000;
const TREE_LAYOUT_STABILITY_FRAMES = 24;
const TREE_TARGET_FRAME_MS = 32;
const TREE_LAYOUT_MIN_DURATION = 1500;
const TREE_FORCE_DEADZONE = 0.005;
const TREE_VELOCITY_DEADZONE = 0.01;
// Y is free within each layer's band; gravity + boundary resistance keep layers separate.
// Band half kept at 55px so nodes don't drift far past the initial camera-fit viewport.
const TREE_LAYER_GRAVITY = 0.06; // stronger gravity keeps nodes near their layer center
const TREE_LAYER_BAND_HALF = 55; // ±55px from layer center Y
const TREE_LAYER_BOUNDARY_RESISTANCE = 10; // progressive resistance near band edges
// Spread force: fine-tune density within each layer during physics.
// Kept deliberately weak (0.003) because the initial proportional layout already
// distributes nodes near their ideal positions — aggressive spread would fight
// the hierarchy springs and push edge-parented children away from their parents.
const TREE_SPREAD_STRENGTH = 0.003;

// ---------------------------------------------------------------------------
// Circles View constants
// ---------------------------------------------------------------------------

/** Target radius for each ring — must match CIRCLES_RING_RADII in circles-layout.ts */
const CIRCLES_RING_RADII = [90, 240, 420, 620] as const;
const CIRCLES_RING_COUNT = CIRCLES_RING_RADII.length;

/**
 * Half-width of the allowed radial band.  Must match CIRCLES_BAND_HALF in
 * circles-layout.ts.  Keep it small enough that adjacent ring bands never
 * overlap: current ring gaps are 150/180/200 px, so 45 px leaves 60-110 px
 * of clear air between rings.
 *
 * Nodes distribute within this band driven by repulsion (outward) and
 * soft-wall gravity (inward, growing cubically near the edge).
 * No hard clamp — nodes float freely inside the band.
 */
const CIRCLES_BAND_HALF = 45;

/**
 * Base radial gravity rate.  Effective gravity grows cubically near the band
 * edge via CIRCLES_RADIAL_BOUNDARY_RESISTANCE:
 *
 *   rOffset =  0 px → k = k_base × 1    (almost no pull)
 *   rOffset = 22 px → k ≈ k_base × 4.2  (moderate)
 *   rOffset = 40 px → k ≈ k_base × 16   (strong)
 *   rOffset = 45 px → k ≈ k_base × 21   (very strong — prevents crossing)
 */
const CIRCLES_RADIAL_GRAVITY = 0.06;

/**
 * Cubic-growth multiplier near the band edge.
 * Effective k = CIRCLES_RADIAL_GRAVITY × (1 + normR³ × this).
 */
const CIRCLES_RADIAL_BOUNDARY_RESISTANCE = 22;

/**
 * Angular spread force: kept very weak — edge springs are the primary
 * mechanism for angular positioning.  A too-strong spread competes with
 * springs and keeps connected nodes far apart.
 */
const CIRCLES_ANGULAR_SPREAD = 0.002;

/** Repulsion range — same as tree view so nodes from dense rings don't clump. */
const CIRCLES_REPULSION_RANGE = 130;

const CIRCLES_LAYOUT_MAX_DURATION = 24000;
const CIRCLES_LAYOUT_STABILITY_FRAMES = 24;
const CIRCLES_LAYOUT_MIN_DURATION = 1500;
const CIRCLES_FORCE_DEADZONE = 0.005;
const CIRCLES_VELOCITY_DEADZONE = 0.01;

const CIRCLES_EDGE_WEIGHTS: Record<string, number> = {
  // Hierarchy edges: moderate — angular alignment without fighting radial gravity
  // (rest length is now set to ring-gap distance, not zero).
  CONTAINS: 0.18,
  DEFINES: 0.22,
  // Cross edges: stronger so same-ring connected nodes cluster angularly.
  IMPORTS: 0.2,
  CALLS: 0.24,
  EXTENDS: 0.2,
  IMPLEMENTS: 0.2,
};

// ---------------------------------------------------------------------------

const TREE_EDGE_WEIGHTS: Record<string, number> = {
  CONTAINS: 0.09,
  DEFINES: 0.12,
  IMPORTS: 0.14,
  CALLS: 0.18,
  EXTENDS: 0.13,
  IMPLEMENTS: 0.13,
};

/** A folder plus every sub-folder and file below it (no in-file symbols). */
const getFolderSubtree = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  folderId: string,
): Set<string> => {
  const subtree = new Set<string>([folderId]);
  const queue = [folderId];
  for (let head = 0; head < queue.length; head++) {
    graph.forEachOutEdge(
      queue[head],
      (_edge, attrs, _source, target, _sourceAttrs, targetAttrs) => {
        if (attrs.relationType !== 'CONTAINS' || subtree.has(target)) return;
        if (targetAttrs.nodeType !== 'Folder' && targetAttrs.nodeType !== 'File') return;
        subtree.add(target);
        if (targetAttrs.nodeType === 'Folder') queue.push(target);
      },
    );
  }
  return subtree;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

export const useSigma = (options: UseSigmaOptions = {}): UseSigmaReturn => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  // Direct neighbours of the selected node (null when nothing in the graph is selected).
  const selectedNeighborsRef = useRef<Set<string> | null>(null);
  // Focus mode: with a node selected and a focus depth set, only the nodes in
  // this set (selection + everything within `focusDepth` hops) are rendered.
  // Null means no focus — the whole graph renders, dimmed around the selection.
  const focusSetRef = useRef<Set<string> | null>(null);
  const focusDepthRef = useRef<number | null>(options.focusDepth ?? null);
  // True when the focus set is a folder's containment subtree rather than an
  // N-hop neighbourhood.
  const focusIsSubtreeRef = useRef(false);
  // Camera state from just before focus mode zoomed in, restored on leaving it.
  const preFocusCameraRef = useRef<CameraState | null>(null);
  const highlightedRef = useRef<Set<string>>(new Set());
  const blastRadiusRef = useRef<Set<string>>(new Set());
  const visibleEdgeTypesRef = useRef<EdgeType[] | null>(null);
  const useStraightEdgesRef = useRef(false);

  // Keep callback refs fresh so the one-time sigma event handlers always
  // call the latest version (avoids stale-closure bugs when graph loads).
  const onNodeClickRef = useRef(options.onNodeClick);
  const onNodeHoverRef = useRef(options.onNodeHover);
  const onStageClickRef = useRef(options.onStageClick);
  onNodeClickRef.current = options.onNodeClick;
  onNodeHoverRef.current = options.onNodeHover;
  onStageClickRef.current = options.onStageClick;
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeLayoutFrameRef = useRef<number | null>(null);
  const treeLastTickRef = useRef<number | null>(null);
  const treeAccumulatorRef = useRef(0);
  const treeLayoutStartRef = useRef<number | null>(null);
  const treeStableFramesRef = useRef(0);

  // Circles layout state (mirrors tree layout state)
  const circlesLayoutFrameRef = useRef<number | null>(null);
  const circlesLastTickRef = useRef<number | null>(null);
  const circlesAccumulatorRef = useRef(0);
  const circlesLayoutStartRef = useRef<number | null>(null);
  const circlesStableFramesRef = useRef(0);
  const [isLayoutRunning, setIsLayoutRunningState] = useState(false);
  const isLayoutRunningRef = useRef(false);
  const hideEdgesDuringLayoutRef = useRef(false);
  // True between setGraph and the layout it starts, so the graph's first paint
  // already has edges hidden and no second full refresh is needed.
  const layoutStartingRef = useRef(false);
  const refreshFrameRef = useRef<number | null>(null);
  // Stops the detached-FA2 position sync; `true` copies the final positions first.
  const stopFA2SyncRef = useRef<((finalSync: boolean) => void) | null>(null);
  const [selectedNode, setSelectedNodeState] = useState<string | null>(null);

  const setIsLayoutRunning = useCallback((running: boolean) => {
    isLayoutRunningRef.current = running;
    setIsLayoutRunningState(running);
  }, []);

  // A full refresh re-runs both reducers over the whole graph. One user action
  // (e.g. clicking a node) used to trigger several of them back to back from
  // different effects; coalesce them into a single pass on the next frame.
  const requestRefresh = useCallback(() => {
    if (refreshFrameRef.current !== null) return;
    refreshFrameRef.current = requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      sigmaRef.current?.refresh();
    });
  }, []);

  useEffect(() => {
    const highlighted = options.highlightedNodeIds || new Set<string>();
    const blastRadius = options.blastRadiusNodeIds || new Set<string>();
    const visibleEdgeTypes = options.visibleEdgeTypes || null;

    // Upstream state often hands over a new Set with the same members (every
    // AI tool call does) — only pay for a refresh when something really changed.
    const unchanged =
      sameSet(highlightedRef.current, highlighted) &&
      sameSet(blastRadiusRef.current, blastRadius) &&
      sameList(visibleEdgeTypesRef.current, visibleEdgeTypes);

    highlightedRef.current = highlighted;
    blastRadiusRef.current = blastRadius;
    visibleEdgeTypesRef.current = visibleEdgeTypes;
    if (!unchanged) requestRefresh();
  }, [
    requestRefresh,
    options.highlightedNodeIds,
    options.blastRadiusNodeIds,
    options.visibleEdgeTypes,
  ]);

  const updateFocus = useCallback((nodeId: string | null) => {
    const graph = graphRef.current;
    const restorePreFocusCamera = () => {
      const saved = preFocusCameraRef.current;
      preFocusCameraRef.current = null;
      if (saved) sigmaRef.current?.getCamera().animate(saved, { duration: 300 });
    };

    if (nodeId === null || !graph || !graph.hasNode(nodeId)) {
      selectedNeighborsRef.current = null;
      focusSetRef.current = null;
      focusIsSubtreeRef.current = false;
      restorePreFocusCamera();
      return;
    }
    const depth = focusDepthRef.current;
    selectedNeighborsRef.current = new Set(graph.neighbors(nodeId));
    // A folder's files usually sit several CONTAINS hops below it, so an N-hop
    // neighbourhood shows its sub-folders but not what is inside them. Focus a
    // folder on its whole subtree instead.
    focusIsSubtreeRef.current =
      depth !== null && graph.getNodeAttribute(nodeId, 'nodeType') === 'Folder';
    focusSetRef.current =
      depth === null
        ? null
        : focusIsSubtreeRef.current
          ? getFolderSubtree(graph, nodeId)
          : getNodesWithinHops(graph, nodeId, depth);
    if (focusSetRef.current) {
      if (!preFocusCameraRef.current && sigmaRef.current) {
        preFocusCameraRef.current = sigmaRef.current.getCamera().getState();
      }
    } else {
      restorePreFocusCamera();
    }
  }, []);

  // Point the camera at the selection. In focus mode everything outside the
  // focus set is hidden, so the view is fitted to the whole set — otherwise the
  // linked nodes can sit off-screen with nothing else on the canvas. Camera
  // coordinates are Sigma's normalized ones, hence getNodeDisplayData.
  const frameFocus = useCallback((duration: number) => {
    const sigma = sigmaRef.current;
    const selected = selectedNodeRef.current;
    if (!sigma || selected === null) return;

    const focusSet = focusSetRef.current;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const nodeId of focusSet ?? [selected]) {
      const display = sigma.getNodeDisplayData(nodeId);
      if (!display) continue;
      if (display.x < minX) minX = display.x;
      if (display.x > maxX) maxX = display.x;
      if (display.y < minY) minY = display.y;
      if (display.y > maxY) maxY = display.y;
    }
    if (minX === Infinity) return;

    const span = Math.max(maxX - minX, maxY - minY);
    const target = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      ratio: focusSet ? clamp(span * 1.6, 0.05, 1.3) : 0.15,
    };
    const camera = sigma.getCamera();
    if (duration > 0) camera.animate(target, { duration });
    else camera.setState(target);
  }, []);

  useEffect(() => {
    const depth = options.focusDepth ?? null;
    if (focusDepthRef.current === depth) return;
    focusDepthRef.current = depth;
    updateFocus(selectedNodeRef.current);
    requestRefresh();
    if (focusSetRef.current) frameFocus(400);
  }, [options.focusDepth, updateFocus, requestRefresh, frameFocus]);

  const setSelectedNode = useCallback(
    (nodeId: string | null) => {
      // The click handler and the app-state sync effect both report the same
      // selection; the second call has nothing left to do.
      if (selectedNodeRef.current === nodeId) return;
      const leavingFocus = preFocusCameraRef.current !== null;
      selectedNodeRef.current = nodeId;
      updateFocus(nodeId);
      setSelectedNodeState(nodeId);

      const sigma = sigmaRef.current;
      if (!sigma) return;

      if (focusSetRef.current) {
        frameFocus(400);
      } else if (!leavingFocus) {
        // (Leaving focus mode already animates the camera back in updateFocus.)
        // Tiny camera nudge to force edge refresh (workaround for Sigma edge caching)
        const camera = sigma.getCamera();
        const currentRatio = camera.ratio;
        // Imperceptible zoom change that triggers re-render
        camera.animate({ ratio: currentRatio * 1.0001 }, { duration: 50 });
      }

      requestRefresh();
    },
    [requestRefresh, updateFocus, frameFocus],
  );

  const stopTreeLayout = useCallback(
    (refresh: boolean = false) => {
      if (treeLayoutFrameRef.current) {
        cancelAnimationFrame(treeLayoutFrameRef.current);
        treeLayoutFrameRef.current = null;
      }
      treeLastTickRef.current = null;
      treeAccumulatorRef.current = 0;
      treeLayoutStartRef.current = null;
      treeStableFramesRef.current = 0;
      setIsLayoutRunning(false);

      if (refresh) {
        sigmaRef.current?.refresh();
        // Re-fit camera to the actual settled positions — nodes may have drifted
        // from their initial anchors during simulation (especially small/leaf nodes).
        if (focusSetRef.current) frameFocus(600);
        else sigmaRef.current?.getCamera().animatedReset({ duration: 600 });
      }
    },
    [setIsLayoutRunning, frameFocus],
  );

  const stopCirclesLayout = useCallback(
    (refresh: boolean = false) => {
      if (circlesLayoutFrameRef.current) {
        cancelAnimationFrame(circlesLayoutFrameRef.current);
        circlesLayoutFrameRef.current = null;
      }
      circlesLastTickRef.current = null;
      circlesAccumulatorRef.current = 0;
      circlesLayoutStartRef.current = null;
      circlesStableFramesRef.current = 0;
      setIsLayoutRunning(false);

      if (refresh) {
        sigmaRef.current?.refresh();
        if (focusSetRef.current) frameFocus(600);
        else sigmaRef.current?.getCamera().animatedReset({ duration: 600 });
      }
    },
    [setIsLayoutRunning, frameFocus],
  );

  const stopAllLayouts = useCallback(
    (refresh: boolean = false) => {
      if (layoutTimeoutRef.current) {
        clearTimeout(layoutTimeoutRef.current);
        layoutTimeoutRef.current = null;
      }

      if (layoutRef.current) {
        layoutRef.current.stop();
        layoutRef.current.kill();
        layoutRef.current = null;
        stopFA2SyncRef.current?.(true);

        const graph = graphRef.current;
        if (
          graph &&
          graph.order <= NOVERLAP_MAX_NODES &&
          options.layoutMode !== 'tree' &&
          options.layoutMode !== 'circles'
        ) {
          noverlap.assign(graph, NOVERLAP_SETTINGS);
        }
      }

      stopTreeLayout(false);
      stopCirclesLayout(false);

      if (refresh) {
        sigmaRef.current?.refresh();
      }
    },
    [options.layoutMode, stopTreeLayout, stopCirclesLayout],
  );

  // Initialize Sigma ONCE
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
    graphRef.current = graph;

    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelFont: 'JetBrains Mono, monospace',
      labelSize: 11,
      labelWeight: '500',
      labelColor: { color: '#e4e4ed' },
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.1,
      labelGridCellSize: 70,

      defaultNodeColor: '#6b7280',
      defaultEdgeColor: '#2a2a3a',

      defaultEdgeType: 'curved',
      edgeProgramClasses: {
        curved: EdgeCurveProgram,
        line: EdgeRectangleProgram,
      },

      // Custom hover renderer - dark background instead of white
      defaultDrawNodeHover: (context, data, settings) => {
        const label = data.label;
        if (!label) return;

        const size = settings.labelSize || 11;
        const font = settings.labelFont || 'JetBrains Mono, monospace';
        const weight = settings.labelWeight || '500';

        context.font = `${weight} ${size}px ${font}`;
        const textWidth = context.measureText(label).width;

        const nodeSize = data.size || 8;
        const x = data.x;
        const y = data.y - nodeSize - 10;
        const paddingX = 8;
        const paddingY = 5;
        const height = size + paddingY * 2;
        const width = textWidth + paddingX * 2;
        const radius = 4;

        // Dark background pill
        context.fillStyle = '#12121c';
        context.beginPath();
        context.roundRect(x - width / 2, y - height / 2, width, height, radius);
        context.fill();

        // Border matching node color
        context.strokeStyle = data.color || '#6366f1';
        context.lineWidth = 2;
        context.stroke();

        // Label text - light color
        context.fillStyle = '#f5f5f7';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, x, y);

        // Also draw a subtle glow ring around the node
        context.beginPath();
        context.arc(data.x, data.y, nodeSize + 4, 0, Math.PI * 2);
        context.strokeStyle = data.color || '#6366f1';
        context.lineWidth = 2;
        context.globalAlpha = 0.5;
        context.stroke();
        context.globalAlpha = 1;
      },

      minCameraRatio: 0.002,
      maxCameraRatio: 50,
      hideEdgesOnMove: true,
      zIndex: true,

      nodeReducer: (node, data) => {
        // Sigma passes a shallow copy of the attributes, so mutate it directly.
        const res = data;

        if (data.hidden) {
          res.hidden = true;
          return res;
        }

        const currentSelected = selectedNodeRef.current;
        const highlighted = highlightedRef.current;
        const blastRadius = blastRadiusRef.current;
        const hasHighlights = highlighted.size > 0;
        const hasBlastRadius = blastRadius.size > 0;
        const isQueryHighlighted = highlighted.has(node);
        const isBlastRadiusNode = blastRadius.has(node);
        const showHighlightLabels = highlighted.size + blastRadius.size <= MAX_HIGHLIGHT_LABELS;

        // Blast radius takes priority (red highlighting)
        if (hasBlastRadius && !currentSelected) {
          if (isBlastRadiusNode) {
            res.color = '#ef4444'; // Red for blast radius
            res.size = (data.size || 8) * 1.8;
            res.zIndex = 3;
            res.highlighted = showHighlightLabels;
          } else if (isQueryHighlighted) {
            // Regular cyan highlight for non-blast-radius nodes
            res.color = '#06b6d4';
            res.size = (data.size || 8) * 1.4;
            res.zIndex = 2;
            res.highlighted = showHighlightLabels;
          } else {
            res.color = dimColor(data.color, 0.15);
            res.size = (data.size || 8) * 0.4;
            res.zIndex = 0;
          }
          return res;
        }

        if (hasHighlights && !currentSelected) {
          if (isQueryHighlighted) {
            res.color = '#06b6d4';
            res.size = (data.size || 8) * 1.6;
            res.zIndex = 2;
            res.highlighted = showHighlightLabels;
          } else {
            res.color = dimColor(data.color, 0.2);
            res.size = (data.size || 8) * 0.5;
            res.zIndex = 0;
          }
          return res;
        }

        const neighbors = selectedNeighborsRef.current;
        if (currentSelected && neighbors) {
          // Focus mode: anything outside the focus set is hidden outright (not
          // just dimmed), so Sigma skips it in indexing, labels and drawing.
          const focusSet = focusSetRef.current;
          if (focusSet && !focusSet.has(node)) {
            res.hidden = true;
            return res;
          }

          if (node === currentSelected) {
            res.color = data.color;
            res.size = (data.size || 8) * 1.8;
            res.zIndex = 2;
            res.highlighted = true;
          } else if (neighbors.has(node)) {
            res.color = data.color;
            res.size = (data.size || 8) * 1.3;
            res.zIndex = 1;
            res.forceLabel = focusSet !== null && neighbors.size <= FOCUS_FORCE_LABEL_MAX;
          } else if (focusIsSubtreeRef.current) {
            // Deeper members of a folder subtree keep their natural look.
          } else {
            res.color = dimColor(data.color, 0.25);
            res.size = (data.size || 8) * 0.6;
            res.zIndex = 0;
          }
        }

        return res;
      },

      edgeReducer: (edge, data) => {
        const res = data;

        const currentSelected = selectedNodeRef.current;
        const graph = graphRef.current;
        const hasSelection = currentSelected !== null && selectedNeighborsRef.current !== null;
        const focusSet = hasSelection ? focusSetRef.current : null;
        const touchesSelected =
          hasSelection &&
          !!graph &&
          (graph.source(edge) === currentSelected || graph.target(edge) === currentSelected);

        if (focusSet && graph) {
          // Focus mode. Folder subtree: just the containment hierarchy. One
          // hop: only the selected node's own edges. Deeper: every edge whose
          // two ends are both inside the focus set. Either way it is a small
          // subset, so it stays visible during a layout.
          const bothEndsInFocus = () =>
            focusSet.has(graph.source(edge)) && focusSet.has(graph.target(edge));
          const inFocus = focusIsSubtreeRef.current
            ? data.relationType === 'CONTAINS' && bothEndsInFocus()
            : focusDepthRef.current === 1
              ? touchesSelected
              : bothEndsInFocus();
          if (!inFocus) {
            res.hidden = true;
            return res;
          }
        } else if (
          hideEdgesDuringLayoutRef.current &&
          (isLayoutRunningRef.current || layoutStartingRef.current)
        ) {
          res.hidden = true;
          return res;
        }

        if (useStraightEdgesRef.current) res.type = 'line';

        // Check edge type visibility first.
        // HAS_METHOD / HAS_PROPERTY are Kotlin/Java hierarchy edges not in the
        // EdgeType union — normalize them so they follow DEFINES / CONTAINS
        // visibility instead of being silently hidden.
        const visibleTypes = visibleEdgeTypesRef.current;
        if (visibleTypes && data.relationType) {
          const normalizedType =
            data.relationType === 'HAS_METHOD'
              ? 'DEFINES'
              : data.relationType === 'HAS_PROPERTY'
                ? 'CONTAINS'
                : data.relationType;
          if (!visibleTypes.includes(normalizedType as EdgeType)) {
            res.hidden = true;
            return res;
          }
        }

        // Tree view: hierarchy edges are subtle, cross-cutting edges are more visible
        const isHierarchyEdge = (data as any).isHierarchyEdge;
        if (isHierarchyEdge !== undefined) {
          if (isHierarchyEdge) {
            // Subtle hierarchy edges in tree view
            res.color = dimColor(data.color, 0.5);
            res.size = Math.max(0.3, (data.size || 1) * 0.5);
          } else {
            // Cross-cutting edges are more visible
            res.color = brightenColor(data.color, 1.2);
            res.size = Math.max(1, (data.size || 1) * 1.2);
          }
        }

        const highlighted = highlightedRef.current;
        const blastRadius = blastRadiusRef.current;
        const hasHighlights = highlighted.size > 0 || blastRadius.size > 0; // Check BOTH sets

        if (hasHighlights && !currentSelected) {
          if (graph) {
            const source = graph.source(edge);
            const target = graph.target(edge);

            // Check if nodes are in EITHER set
            const isSourceActive = highlighted.has(source) || blastRadius.has(source);
            const isTargetActive = highlighted.has(target) || blastRadius.has(target);

            const bothHighlighted = isSourceActive && isTargetActive;
            const oneHighlighted = isSourceActive || isTargetActive;

            if (bothHighlighted) {
              // If both nodes are in blast radius, use red edge
              if (blastRadius.has(source) && blastRadius.has(target)) {
                res.color = '#ef4444';
              } else {
                res.color = '#06b6d4';
              }
              res.size = Math.max(2, (data.size || 1) * 3);
              res.zIndex = 2;
            } else if (oneHighlighted) {
              res.color = dimColor('#06b6d4', 0.4);
              res.size = 1;
              res.zIndex = 1;
            } else {
              res.color = dimColor(data.color, 0.08);
              res.size = 0.2;
              res.zIndex = 0;
            }
          }
          return res;
        }

        if (hasSelection && !(focusSet && focusIsSubtreeRef.current)) {
          if (touchesSelected) {
            res.color = brightenColor(data.color, 1.5);
            res.size = Math.max(3, (data.size || 1) * 4);
            res.zIndex = 2;
          } else {
            res.color = dimColor(data.color, 0.1);
            res.size = 0.3;
            res.zIndex = 0;
          }
        }

        return res;
      },
    });

    sigmaRef.current = sigma;

    sigma.on('clickNode', ({ node }) => {
      setSelectedNode(node);
      onNodeClickRef.current?.(node);
    });

    sigma.on('clickStage', () => {
      setSelectedNode(null);
      onStageClickRef.current?.();
    });

    sigma.on('enterNode', ({ node }) => {
      onNodeHoverRef.current?.(node);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'pointer';
      }
    });

    sigma.on('leaveNode', () => {
      onNodeHoverRef.current?.(null);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'grab';
      }
    });

    return () => {
      if (treeLayoutFrameRef.current) {
        cancelAnimationFrame(treeLayoutFrameRef.current);
        treeLayoutFrameRef.current = null;
      }
      if (circlesLayoutFrameRef.current) {
        cancelAnimationFrame(circlesLayoutFrameRef.current);
        circlesLayoutFrameRef.current = null;
      }
      if (layoutTimeoutRef.current) {
        clearTimeout(layoutTimeoutRef.current);
      }
      layoutRef.current?.kill();
      stopFA2SyncRef.current?.(false);
      if (refreshFrameRef.current !== null) {
        cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, []);

  const runTreeLayout = useCallback(
    (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
      if (graph.order === 0) return;

      stopAllLayouts(false);

      // Compute each layer's Y center from initial anchor positions
      const layerYSum = new Map<number, number>();
      const layerYCount = new Map<number, number>();

      graph.forEachNode((nodeId, attrs) => {
        const layer = attrs.treeLayer ?? 0;
        const ay = attrs.treeAnchorY ?? attrs.y;
        layerYSum.set(layer, (layerYSum.get(layer) ?? 0) + ay);
        layerYCount.set(layer, (layerYCount.get(layer) ?? 0) + 1);
        graph.setNodeAttribute(nodeId, 'x', attrs.treeAnchorX ?? attrs.x);
        graph.setNodeAttribute(nodeId, 'y', ay);
      });

      const layerCenterY = new Map<number, number>();
      for (const [layer, sum] of layerYSum) {
        layerCenterY.set(layer, sum / (layerYCount.get(layer) ?? 1));
      }

      // Compute each node's preferred Y position within its layer band.
      //
      // A node in Layer L that connects upward (to Layer L-1, which has higher Y)
      // should sit near the TOP of the band — it shortens those vertical edges.
      // A node connecting only downward (to Layer L+1) should sit at the BOTTOM.
      // A node that connects in both directions, or only within its own layer,
      // goes to the center — freeing the edges of the band for directional nodes.
      //
      // bias ∈ [-1, +1]:  +1 = top of band (higher Y, toward layer above),
      //                    -1 = bottom of band (lower Y, toward layer below),
      //                     0 = layer center.
      const nodeYBias = new Map<string, number>();
      graph.forEachNode((nodeId, attrs) => {
        const layer = attrs.treeLayer ?? 0;
        let aboveCount = 0;
        let belowCount = 0;
        graph.forEachNeighbor(nodeId, (_, nAttrs) => {
          const nLayer = nAttrs.treeLayer ?? 0;
          if (nLayer < layer) aboveCount++;
          if (nLayer > layer) belowCount++;
        });
        // Weighted ratio: (above − below) / total, scaled to ±0.55 of band half.
        const total = aboveCount + belowCount;
        nodeYBias.set(nodeId, total > 0 ? ((aboveCount - belowCount) / total) * 0.55 : 0);
      });

      // Pre-position nodes at their preferred Y to reduce physics convergence time.
      graph.forEachNode((nodeId, attrs) => {
        const layer = attrs.treeLayer ?? 0;
        const cy = layerCenterY.get(layer) ?? attrs.y;
        const bias = nodeYBias.get(nodeId) ?? 0;
        graph.setNodeAttribute(nodeId, 'y', cy + bias * TREE_LAYER_BAND_HALF * 0.6);
      });

      setIsLayoutRunning(true);
      if (hideEdgesDuringLayoutRef.current && !layoutStartingRef.current) {
        sigmaRef.current?.refresh();
      }
      layoutStartingRef.current = false;

      // Flatten the graph into typed arrays once. The simulation below touches
      // every node and every in-range pair on each sub-step; string-keyed Map
      // lookups there dominated the frame time. Topology and layer assignment
      // are fixed for the lifetime of a layout run, so only positions change.
      const layoutNodeIds = graph.nodes();
      const nodeTotal = layoutNodeIds.length;
      const nodeIndex = new Map<string, number>();
      const posX = new Float64Array(nodeTotal);
      const posY = new Float64Array(nodeTotal);
      const velX = new Float64Array(nodeTotal);
      const velY = new Float64Array(nodeTotal);
      const forceX = new Float64Array(nodeTotal);
      const forceY = new Float64Array(nodeTotal);
      const nodeSize = new Float64Array(nodeTotal);
      const nodeLayer = new Int32Array(nodeTotal);
      const nodeCenterY = new Float64Array(nodeTotal);
      const nodeTargetY = new Float64Array(nodeTotal);
      const layerMembers = new Map<number, number[]>();
      for (let i = 0; i < nodeTotal; i++) {
        const nodeId = layoutNodeIds[i];
        const attrs = graph.getNodeAttributes(nodeId);
        const layer = attrs.treeLayer ?? 0;
        const centerY = layerCenterY.get(layer) ?? attrs.y;
        nodeIndex.set(nodeId, i);
        posX[i] = attrs.x;
        posY[i] = attrs.y;
        nodeSize[i] = attrs.size ?? 6;
        nodeLayer[i] = layer;
        nodeCenterY[i] = centerY;
        nodeTargetY[i] = centerY + (nodeYBias.get(nodeId) ?? 0) * TREE_LAYER_BAND_HALF;
        if (!layerMembers.has(layer)) layerMembers.set(layer, []);
        layerMembers.get(layer)!.push(i);
      }

      const edgeTotal = graph.size;
      const edgeSource = new Int32Array(edgeTotal);
      const edgeTarget = new Int32Array(edgeTotal);
      const edgeWeight = new Float64Array(edgeTotal);
      const edgeXWeight = new Float64Array(edgeTotal);
      const edgeXRest = new Float64Array(edgeTotal);
      const edgeYRest = new Float64Array(edgeTotal);
      let edgeCursor = 0;
      graph.forEachEdge((_edge, edgeAttrs, source, target, sourceAttrs, targetAttrs) => {
        const rawWeight = TREE_EDGE_WEIGHTS[edgeAttrs.relationType] ?? 0.18;
        const layerGap = Math.abs((targetAttrs.treeLayer ?? 0) - (sourceAttrs.treeLayer ?? 0));
        edgeSource[edgeCursor] = nodeIndex.get(source)!;
        edgeTarget[edgeCursor] = nodeIndex.get(target)!;
        edgeWeight[edgeCursor] = rawWeight;
        // Hierarchy edges: zero X rest length so children want to sit directly
        // under their parent (repulsion then spreads siblings out naturally).
        // Cross edges: 60 px rest so far-spanning CALLS/IMPORTS edges only
        // pull when really stretched, and their weight is capped so they
        // don't override the hierarchy structure.
        edgeXRest[edgeCursor] = edgeAttrs.isHierarchyEdge ? 0 : 60;
        edgeXWeight[edgeCursor] = edgeAttrs.isHierarchyEdge ? rawWeight : Math.min(rawWeight, 0.1);
        edgeYRest[edgeCursor] =
          (edgeAttrs.isHierarchyEdge ? 70 : 95) + layerGap * (edgeAttrs.isHierarchyEdge ? 28 : 36);
        edgeCursor++;
      });

      // Scratch buffers reused by the per-step sorts.
      const sweepOrder: number[] = new Array(nodeTotal);
      const spreadScratch: number[] = [];
      const byPosX = (a: number, b: number) => posX[a] - posX[b];

      // Adaptive tuning — mirrors the circles layout strategy.
      // The repulsion pass is O(N × k) after sorting; for large graphs k
      // can be thousands, making each frame multi-hundred ms → apparent freeze.
      const treeNodeCount = graph.order;
      const treeIsLarge = treeNodeCount > 5000;
      const treeIsMedium = treeNodeCount > 1500;
      const treeUseRepulsion = !treeIsLarge; // skip O(N×k) repulsion for large graphs
      const treeUseSpread = !treeIsLarge; // skip O(N log N) spread sort for large graphs
      const treeDamping = treeIsLarge ? 0.58 : 0.62;
      const treeVelocityCapX = treeIsLarge ? 12 : treeIsMedium ? 6 : 3;
      const treeVelocityCapY = treeIsLarge ? 6 : treeIsMedium ? 3 : 2;
      const treeMaxSimSteps = treeIsLarge ? 1 : 2;
      let nextRenderAt = 0;
      const treeEffectiveMaxDuration = treeIsLarge
        ? 30000
        : treeIsMedium
          ? 24000
          : TREE_LAYOUT_MAX_DURATION;
      const treeStopMaxVelocity = treeIsLarge ? 0.05 : 0.022;
      const treeStopAvgVelocity = treeIsLarge ? 0.03 : 0.016;
      const treeStopActiveNodeFraction = treeIsLarge ? 0.02 : 0.008;
      const treeStopStabilityFrames = treeIsLarge ? 20 : TREE_LAYOUT_STABILITY_FRAMES;

      const step = (timestamp: number) => {
        if (!graphRef.current || graphRef.current !== graph) {
          stopTreeLayout(false);
          return;
        }

        if (treeLayoutStartRef.current === null) {
          treeLayoutStartRef.current = timestamp;
        }

        const frameDelta =
          treeLastTickRef.current === null
            ? TREE_TARGET_FRAME_MS
            : clamp(timestamp - treeLastTickRef.current, 8, 64);
        treeLastTickRef.current = timestamp;
        treeAccumulatorRef.current = Math.min(
          TREE_TARGET_FRAME_MS * 3,
          treeAccumulatorRef.current + frameDelta,
        );

        if (treeAccumulatorRef.current < TREE_TARGET_FRAME_MS) {
          treeLayoutFrameRef.current = requestAnimationFrame(step);
          return;
        }

        const simulationSteps = Math.min(
          treeMaxSimSteps,
          Math.floor(treeAccumulatorRef.current / TREE_TARGET_FRAME_MS),
        );
        treeAccumulatorRef.current -= simulationSteps * TREE_TARGET_FRAME_MS;
        const dtScale = 0.6;

        // --- Apply forces: velocity integration with boundary resistance ---
        // Forces are recomputed from current node positions each sub-step so that
        // slow frames (simulationSteps > 1) integrate correctly and don't double-apply.
        let totalVelocity = 0;
        let maxVelocity = 0;
        let activeNodes = 0;

        for (let simulationStep = 0; simulationStep < simulationSteps; simulationStep++) {
          // 1. Layer gravity: soft pull toward each node's preferred Y within its band.
          // Directional nodes (above-only or below-only connections) are pulled to the
          // top or bottom of the band; bidirectional / same-layer-only nodes go to
          // the center.  This leaves band edges free for nodes that actually use them.
          for (let i = 0; i < nodeTotal; i++) {
            forceX[i] = 0;
            forceY[i] = (nodeTargetY[i] - posY[i]) * TREE_LAYER_GRAVITY * dtScale;
          }

          // 2. Edge springs — X and Y handled separately.
          //
          // Root cause of long horizontal edges: the previous 2D spring projected
          // force through (dx/distance, dy/distance).  When the Y layer gap
          // dominates (|dy|≈200, |dx|≈30) the X component shrinks to ~15% of
          // the total spring force, too weak to overcome sibling repulsion.
          //
          // Fix: compute X spring from |dx| alone.  This keeps full strength
          // regardless of how far apart two nodes are in Y.
          for (let e = 0; e < edgeTotal; e++) {
            const source = edgeSource[e];
            const target = edgeTarget[e];
            const dx = posX[target] - posX[source];

            // 2a. Pure X spring (rest length / weight precomputed per edge).
            const xStretch = Math.abs(dx) - edgeXRest[e];
            if (xStretch > 0) {
              const fxX = Math.sign(dx) * xStretch * edgeXWeight[e] * 0.3 * dtScale;
              forceX[source] += fxX;
              forceX[target] -= fxX;
            }

            // 2b. Weak Y spring — layer gravity handles most vertical placement;
            // this just prevents extreme cross-layer stretching.
            const dy = posY[target] - posY[source];
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;
            const yStretch = distance - edgeYRest[e];
            if (yStretch > 0) {
              const fy = (dy / distance) * yStretch * edgeWeight[e] * 0.008 * dtScale;
              forceY[source] += fy;
              forceY[target] -= fy;
            }
          }

          // 3. Node repulsion in 2D: all pairs within range (cross-layer included)
          // Sort by X for O(n·k) early-exit: once dx > range, all further pairs are too far.
          //
          // Skipped for large graphs (N > 5 000) — sorting + pair comparisons make each
          // frame take hundreds of ms, leaving the canvas apparently frozen.  Layer gravity
          // and edge springs provide sufficient structure without repulsion.
          if (treeUseRepulsion) {
            for (let i = 0; i < nodeTotal; i++) sweepOrder[i] = i;
            sweepOrder.sort(byPosX);

            for (let i = 0; i < nodeTotal; i++) {
              const a = sweepOrder[i];
              const ax = posX[a];
              const ay = posY[a];
              for (let j = i + 1; j < nodeTotal; j++) {
                const b = sweepOrder[j];
                const dx = posX[b] - ax;
                if (dx > TREE_REPULSION_RANGE) break; // X-sorted: all further pairs are also too far

                const dy = posY[b] - ay;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                if (dist > TREE_REPULSION_RANGE) continue;

                const sameLayer = nodeLayer[a] === nodeLayer[b];
                // Same-layer repulsion reduced from 160→100 so the stronger X spring
                // (0.30) can now overcome collective repulsion from 3-4 nearby nodes.
                // Cross-layer kept low (28) so intermediate-layer nodes don't block
                // parent-child X alignment.
                const repulsionStrength = sameLayer ? 100 : 28;
                const minGap = Math.max(28, (nodeSize[a] + nodeSize[b]) * 1.8);
                let repulsion =
                  (1 / (dist + 8) - 1 / (TREE_REPULSION_RANGE + 8)) * repulsionStrength * dtScale;
                if (dist < minGap && sameLayer) {
                  repulsion += (minGap - dist) * 0.1 * dtScale;
                }
                if (repulsion <= 0) continue;

                const fx = (dx / dist) * repulsion;
                const fy = (dy / dist) * repulsion;

                forceX[a] -= fx;
                forceY[a] -= fy;
                forceX[b] += fx;
                forceY[b] += fy;
              }
            }
          }

          // 4. Spread force: equalize node density within each layer.
          //
          // For each layer, rank nodes by current X, compute where they would sit
          // in a perfectly even distribution, then add a weak force toward that
          // ideal position.  Nodes that are held by strong hierarchy springs
          // (force ≈ 1–2 units) resist and stay clustered; nodes without a
          // strong spring anchor (isolated or same-layer-only) drift to fill gaps.
          // Net effect: dense centre spreads outward, sparse edges fill in.
          // Skipped for large graphs — per-layer sort is O(N log N) per frame.
          if (treeUseSpread) {
            for (const members of layerMembers.values()) {
              const count = members.length;
              if (count < 2) continue;
              spreadScratch.length = count;
              for (let k = 0; k < count; k++) spreadScratch[k] = members[k];
              spreadScratch.sort(byPosX);
              const spacing = (TREE_MAX_X * 2) / count;
              for (let k = 0; k < count; k++) {
                const i = spreadScratch[k];
                const idealX = -TREE_MAX_X + (k + 0.5) * spacing;
                forceX[i] += (idealX - posX[i]) * TREE_SPREAD_STRENGTH * dtScale;
              }
            }
          }

          totalVelocity = 0;
          maxVelocity = 0;
          activeNodes = 0;

          for (let i = 0; i < nodeTotal; i++) {
            const fx = forceX[i];
            const fy = forceY[i];

            // X boundary resistance: grows as node approaches canvas edge
            const normX = Math.min(1, Math.abs(posX[i]) / TREE_MAX_X);
            const resistX = 1 + normX * normX * 4;

            // Y boundary resistance: grows as node drifts from its layer band center
            const centerY = nodeCenterY[i];
            const yOffset = posY[i] - centerY;
            const normY = Math.min(1, Math.abs(yOffset) / TREE_LAYER_BAND_HALF);
            const resistY = 1 + normY * normY * TREE_LAYER_BOUNDARY_RESISTANCE;

            const rawVx = (velX[i] + fx / resistX) * treeDamping;
            const rawVy = (velY[i] + fy / resistY) * treeDamping;
            const newVx =
              Math.abs(fx) < TREE_FORCE_DEADZONE && Math.abs(rawVx) < TREE_VELOCITY_DEADZONE
                ? 0
                : clamp(rawVx, -treeVelocityCapX, treeVelocityCapX);
            const newVy =
              Math.abs(fy) < TREE_FORCE_DEADZONE && Math.abs(rawVy) < TREE_VELOCITY_DEADZONE
                ? 0
                : clamp(rawVy, -treeVelocityCapY, treeVelocityCapY);

            velX[i] = newVx;
            velY[i] = newVy;

            const speed = Math.sqrt(newVx * newVx + newVy * newVy);
            totalVelocity += speed;
            maxVelocity = Math.max(maxVelocity, speed);
            if (
              speed > TREE_VELOCITY_DEADZONE ||
              Math.abs(fx) > TREE_FORCE_DEADZONE ||
              Math.abs(fy) > TREE_FORCE_DEADZONE
            ) {
              activeNodes += 1;
            }

            posX[i] = clamp(posX[i] + newVx, -TREE_MAX_X, TREE_MAX_X);
            posY[i] = clamp(
              posY[i] + newVy,
              centerY - TREE_LAYER_BAND_HALF,
              centerY + TREE_LAYER_BAND_HALF,
            );
          }
        }

        // Publish positions straight onto the node attributes: setNodeAttribute
        // would emit one graph event (and one reducer pass) per node per axis.
        // Only positions moved, so the refresh re-reduces nodes and keeps the
        // cached edge data.
        for (let i = 0; i < nodeTotal; i++) {
          const attrs = graph.getNodeAttributes(layoutNodeIds[i]);
          attrs.x = posX[i];
          attrs.y = posY[i];
        }
        // The simulation is cheap; re-indexing every node and edge for the GPU
        // is not. Pace repaints by what the last one cost so rendering never
        // takes more than ~1/3 of the main thread, and the physics keeps
        // converging (and the UI keeps responding) in between.
        if (timestamp >= nextRenderAt) {
          const renderStart = performance.now();
          sigmaRef.current?.refresh({ partialGraph: { nodes: layoutNodeIds } });
          // Nothing else is on screen in focus mode — follow the set as it moves.
          if (focusSetRef.current) frameFocus(0);
          const renderEnd = performance.now();
          nextRenderAt = renderEnd + (renderEnd - renderStart) * LAYOUT_RENDER_BACKOFF;
        }

        const averageVelocity = totalVelocity / Math.max(1, graph.order);
        const elapsed = timestamp - (treeLayoutStartRef.current ?? timestamp);

        if (
          elapsed >= TREE_LAYOUT_MIN_DURATION &&
          maxVelocity < treeStopMaxVelocity &&
          activeNodes <= Math.max(2, Math.floor(graph.order * treeStopActiveNodeFraction)) &&
          averageVelocity < treeStopAvgVelocity
        ) {
          treeStableFramesRef.current += 1;
        } else {
          treeStableFramesRef.current = 0;
        }

        if (
          treeStableFramesRef.current >= treeStopStabilityFrames ||
          elapsed >= treeEffectiveMaxDuration
        ) {
          stopTreeLayout(true);
          return;
        }

        treeLayoutFrameRef.current = requestAnimationFrame(step);
      };

      treeLayoutFrameRef.current = requestAnimationFrame(step);
    },
    [stopAllLayouts, stopTreeLayout, setIsLayoutRunning, frameFocus],
  );

  const runCirclesLayout = useCallback(
    (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
      if (graph.order === 0) return;

      stopAllLayouts(false);

      // Compute ring target radii and centre Y (all rings are centred at 0,0)
      const ringTargetR = CIRCLES_RING_RADII as unknown as number[];

      // ---------------------------------------------------------------------------
      // Adaptive physics parameters — scale to graph size.
      //
      // For large graphs the two most expensive passes are:
      //   • Repulsion: O(n × k) where k = neighbours in the sweep window
      //     (can be hundreds when nodes are dense on a ring arc).
      //   • Angular spread: O(k log k) per ring — O(n log n) total.
      //
      // Neither is needed for layout correctness: gravity pulls nodes to their
      // ring, edge springs cluster connected nodes angularly.  Repulsion and
      // spread are purely cosmetic polish — worth skipping at large n.
      // ---------------------------------------------------------------------------
      const nodeCount = graph.order;
      const isLargeGraph = nodeCount > 5000;
      const isMediumGraph = nodeCount > 1500;

      // Repulsion range — 0 means skip the pass entirely.
      const effectiveRepulsionRange = isLargeGraph
        ? 0
        : isMediumGraph
          ? 70
          : CIRCLES_REPULSION_RANGE;

      // Damping: moderate for large graphs so nodes don't overshoot but still
      // settle within the time budget.  Very aggressive damping (0.48) causes
      // nodes to stop mid-path before reaching equilibrium.
      const dampingFactor = isLargeGraph ? 0.58 : isMediumGraph ? 0.58 : 0.62;

      // Higher velocity cap → each frame moves nodes further (faster convergence).
      const velocityCap = isLargeGraph ? 10 : 5;

      // Fewer simulation sub-steps per rAF tick to keep frames fast for large graphs.
      const maxSimSteps = isLargeGraph ? 1 : 2;
      let nextRenderAt = 0;

      // Tighter per-frame budget for repulsion sweep when range > 0.
      const useAngularSpread = !isLargeGraph;

      // Max wall-clock budget.  Large graphs skip the expensive passes so each
      // frame is fast (full 60 fps); 30 s × 60 fps = 1 800 frames is enough to
      // converge 20 k+ node layouts with only gravity + edge springs.
      const effectiveMaxDuration = isLargeGraph
        ? 30000
        : isMediumGraph
          ? 18000
          : CIRCLES_LAYOUT_MAX_DURATION;

      // Early-stop velocity thresholds.
      const stopMaxVelocity = isLargeGraph ? 0.05 : 0.022;
      const stopAvgVelocity = isLargeGraph ? 0.03 : 0.016;
      const stopActiveNodeFraction = isLargeGraph ? 0.02 : 0.008;
      const stopStabilityFrames = isLargeGraph ? 20 : CIRCLES_LAYOUT_STABILITY_FRAMES;

      // Pre-position nodes at their anchor and initialise velocities
      graph.forEachNode((nodeId, attrs) => {
        const ax = attrs.circlesAnchorX ?? attrs.x;
        const ay = attrs.circlesAnchorY ?? attrs.y;
        graph.setNodeAttribute(nodeId, 'x', ax);
        graph.setNodeAttribute(nodeId, 'y', ay);
      });

      setIsLayoutRunning(true);
      if (hideEdgesDuringLayoutRef.current && !layoutStartingRef.current) {
        sigmaRef.current?.refresh();
      }
      layoutStartingRef.current = false;

      // Typed-array view of the graph — see runTreeLayout for the rationale.
      const layoutNodeIds = graph.nodes();
      const nodeTotal = layoutNodeIds.length;
      const nodeIndex = new Map<string, number>();
      const posX = new Float64Array(nodeTotal);
      const posY = new Float64Array(nodeTotal);
      const velX = new Float64Array(nodeTotal);
      const velY = new Float64Array(nodeTotal);
      const forceX = new Float64Array(nodeTotal);
      const forceY = new Float64Array(nodeTotal);
      const nodeSize = new Float64Array(nodeTotal);
      const nodeRing = new Int32Array(nodeTotal);
      const nodeTargetR = new Float64Array(nodeTotal);
      const nodeAngle = new Float64Array(nodeTotal);
      const ringMembers = new Map<number, number[]>();
      for (let i = 0; i < nodeTotal; i++) {
        const nodeId = layoutNodeIds[i];
        const attrs = graph.getNodeAttributes(nodeId);
        const ring = attrs.circlesRing ?? 0;
        nodeIndex.set(nodeId, i);
        posX[i] = attrs.x;
        posY[i] = attrs.y;
        nodeSize[i] = attrs.size ?? 6;
        nodeRing[i] = ring;
        nodeTargetR[i] = ringTargetR[Math.min(ring, CIRCLES_RING_COUNT - 1)];
        if (!ringMembers.has(ring)) ringMembers.set(ring, []);
        ringMembers.get(ring)!.push(i);
      }

      // Rest length strategy:
      //   Hierarchy edges (cross-ring): use the radial gap between the two
      //     ring centres as rest length.  This means the spring only activates
      //     when nodes are angularly misaligned — it does NOT fight radial
      //     gravity (which was the main cause of long edges in previous builds).
      //   Cross edges (same or different ring): rest length = 30 px so the
      //     spring activates sooner and pulls connected nodes closer.
      const edgeTotal = graph.size;
      const edgeSource = new Int32Array(edgeTotal);
      const edgeTarget = new Int32Array(edgeTotal);
      const edgeWeight = new Float64Array(edgeTotal);
      const edgeRest = new Float64Array(edgeTotal);
      let edgeCursor = 0;
      graph.forEachEdge((_edge, edgeAttrs, source, target, sourceAttrs, targetAttrs) => {
        const sourceRing = sourceAttrs.circlesRing ?? 0;
        const targetRing = targetAttrs.circlesRing ?? 0;
        edgeSource[edgeCursor] = nodeIndex.get(source)!;
        edgeTarget[edgeCursor] = nodeIndex.get(target)!;
        edgeWeight[edgeCursor] = CIRCLES_EDGE_WEIGHTS[edgeAttrs.relationType] ?? 0.2;
        edgeRest[edgeCursor] = edgeAttrs.isHierarchyEdge
          ? Math.abs(
              ringTargetR[Math.min(sourceRing, CIRCLES_RING_COUNT - 1)] -
                ringTargetR[Math.min(targetRing, CIRCLES_RING_COUNT - 1)],
            )
          : 30;
        edgeCursor++;
      });

      // Scratch buffers reused by the per-step sorts.
      const sweepOrder: number[] = new Array(nodeTotal);
      const spreadScratch: number[] = [];
      const byPosX = (a: number, b: number) => posX[a] - posX[b];
      const byAngle = (a: number, b: number) => nodeAngle[a] - nodeAngle[b];

      const step = (timestamp: number) => {
        if (!graphRef.current || graphRef.current !== graph) {
          stopCirclesLayout(false);
          return;
        }

        if (circlesLayoutStartRef.current === null) {
          circlesLayoutStartRef.current = timestamp;
        }

        const frameDelta =
          circlesLastTickRef.current === null
            ? TREE_TARGET_FRAME_MS
            : clamp(timestamp - circlesLastTickRef.current, 8, 64);
        circlesLastTickRef.current = timestamp;
        circlesAccumulatorRef.current = Math.min(
          TREE_TARGET_FRAME_MS * 3,
          circlesAccumulatorRef.current + frameDelta,
        );

        if (circlesAccumulatorRef.current < TREE_TARGET_FRAME_MS) {
          circlesLayoutFrameRef.current = requestAnimationFrame(step);
          return;
        }

        const simulationSteps = Math.min(
          maxSimSteps,
          Math.floor(circlesAccumulatorRef.current / TREE_TARGET_FRAME_MS),
        );
        circlesAccumulatorRef.current -= simulationSteps * TREE_TARGET_FRAME_MS;
        const dtScale = 0.6;

        // --- Apply forces with radial boundary resistance ---
        let totalVelocity = 0;
        let maxVelocity = 0;
        let activeNodes = 0;

        for (let _step = 0; _step < simulationSteps; _step++) {
          totalVelocity = 0;
          maxVelocity = 0;
          activeNodes = 0;

          // 1. Radial gravity with soft wall.
          //
          // Base gravity is weak, allowing repulsion to spread nodes radially
          // within the band.  The effective rate grows cubically as the node
          // approaches the band edge so nodes never cross into adjacent rings.
          // This replaces the previous hard position clamp, which caused nodes
          // to pile against the boundary instead of distributing within the band.
          for (let i = 0; i < nodeTotal; i++) {
            const x = posX[i];
            const y = posY[i];
            const r = Math.sqrt(x * x + y * y) || 1;
            const stretch = nodeTargetR[i] - r; // positive = node inside ring, negative = outside
            const normR = Math.min(1, Math.abs(stretch) / CIRCLES_BAND_HALF);
            const k =
              CIRCLES_RADIAL_GRAVITY *
              (1 + normR * normR * normR * CIRCLES_RADIAL_BOUNDARY_RESISTANCE);
            forceX[i] = (x / r) * stretch * k * dtScale;
            forceY[i] = (y / r) * stretch * k * dtScale;
          }

          // 2. Edge springs — radial and tangential components (rest length and
          //    weight precomputed per edge).  All edges use their full weight so
          //    cross-ring CALLS/IMPORTS springs are strong enough to pull nodes
          //    into position.
          for (let e = 0; e < edgeTotal; e++) {
            const source = edgeSource[e];
            const target = edgeTarget[e];
            const dx = posX[target] - posX[source];
            const dy = posY[target] - posY[source];
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;

            const stretch = dist - edgeRest[e];
            if (stretch > 0) {
              const f = stretch * edgeWeight[e] * 0.55 * dtScale;
              const fx = (dx / dist) * f;
              const fy = (dy / dist) * f;
              forceX[source] += fx;
              forceY[source] += fy;
              forceX[target] -= fx;
              forceY[target] -= fy;
            }
          }

          // 3. 2D repulsion — skipped for large graphs (effectiveRepulsionRange = 0).
          //    For large graphs, gravity + edge springs are sufficient; the O(n×k)
          //    repulsion sweep is the dominant per-frame cost and not worth the
          //    quality gain when nodes are already tiny.
          if (effectiveRepulsionRange > 0) {
            for (let i = 0; i < nodeTotal; i++) sweepOrder[i] = i;
            sweepOrder.sort(byPosX);

            for (let i = 0; i < nodeTotal; i++) {
              const a = sweepOrder[i];
              const ax = posX[a];
              const ay = posY[a];
              for (let j = i + 1; j < nodeTotal; j++) {
                const b = sweepOrder[j];
                const dx = posX[b] - ax;
                if (dx > effectiveRepulsionRange) break;

                const dy = posY[b] - ay;
                const dist2 = dx * dx + dy * dy;
                const distVal = Math.sqrt(dist2) || 1;
                if (distVal > effectiveRepulsionRange) continue;

                const sameRing = nodeRing[a] === nodeRing[b];
                const repulsionStrength = sameRing ? 100 : 28;
                const minGap = Math.max(28, (nodeSize[a] + nodeSize[b]) * 1.8);
                let repulsion =
                  (1 / (distVal + 8) - 1 / (effectiveRepulsionRange + 8)) *
                  repulsionStrength *
                  dtScale;
                if (distVal < minGap && sameRing) repulsion += (minGap - distVal) * 0.1 * dtScale;
                if (repulsion <= 0) continue;

                const fx = (dx / distVal) * repulsion;
                const fy = (dy / distVal) * repulsion;
                forceX[a] -= fx;
                forceY[a] -= fy;
                forceX[b] += fx;
                forceY[b] += fy;
              }
            }
          }

          // 4. Angular spread — skipped for large graphs.
          //    Sorting each ring's nodes every frame is O(k log k); for ring 3
          //    with 15k+ nodes this costs several ms/frame.  For large graphs
          //    edge springs already provide angular clustering.
          if (useAngularSpread) {
            for (const members of ringMembers.values()) {
              const count = members.length;
              if (count < 2) continue;
              spreadScratch.length = count;
              for (let k = 0; k < count; k++) {
                const i = members[k];
                spreadScratch[k] = i;
                nodeAngle[i] = Math.atan2(posY[i], posX[i]);
              }
              spreadScratch.sort(byAngle);
              for (let k = 0; k < count; k++) {
                const i = spreadScratch[k];
                const x = posX[i];
                const y = posY[i];
                const idealAngle = ((k + 0.5) / count) * Math.PI * 2 - Math.PI;
                let dAngle = idealAngle - nodeAngle[i];
                while (dAngle > Math.PI) dAngle -= Math.PI * 2;
                while (dAngle < -Math.PI) dAngle += Math.PI * 2;
                const r = Math.sqrt(x * x + y * y) || 1;
                // Tangential unit vector: (-y/r, x/r)
                const tx = -y / r;
                const ty = x / r;
                const fMag = dAngle * CIRCLES_ANGULAR_SPREAD * dtScale;
                forceX[i] += tx * fMag;
                forceY[i] += ty * fMag;
              }
            }
          }

          for (let i = 0; i < nodeTotal; i++) {
            const fx = forceX[i];
            const fy = forceY[i];
            const targetR = nodeTargetR[i];

            // Soft-wall gravity (force 1) already handles radial boundary
            // enforcement — no separate resistance decomposition needed.
            const rawVx = (velX[i] + fx) * dampingFactor;
            const rawVy = (velY[i] + fy) * dampingFactor;
            const newVx =
              Math.abs(fx) < CIRCLES_FORCE_DEADZONE && Math.abs(rawVx) < CIRCLES_VELOCITY_DEADZONE
                ? 0
                : clamp(rawVx, -velocityCap, velocityCap);
            const newVy =
              Math.abs(fy) < CIRCLES_FORCE_DEADZONE && Math.abs(rawVy) < CIRCLES_VELOCITY_DEADZONE
                ? 0
                : clamp(rawVy, -velocityCap, velocityCap);

            velX[i] = newVx;
            velY[i] = newVy;

            const speed = Math.sqrt(newVx * newVx + newVy * newVy);
            totalVelocity += speed;
            maxVelocity = Math.max(maxVelocity, speed);
            if (
              speed > CIRCLES_VELOCITY_DEADZONE ||
              Math.abs(fx) > CIRCLES_FORCE_DEADZONE ||
              Math.abs(fy) > CIRCLES_FORCE_DEADZONE
            ) {
              activeNodes += 1;
            }

            const newX = posX[i] + newVx;
            const newY = posY[i] + newVy;
            // Wide safety clamp (1.5 × band_half): the soft-wall gravity keeps
            // nodes inside [targetR ± BAND_HALF] naturally.  This catches only
            // extreme numerical edge cases (e.g. very large forces on first frame).
            const newR = Math.sqrt(newX * newX + newY * newY) || 1;
            const safeMin = Math.max(1, targetR - CIRCLES_BAND_HALF * 1.5);
            const safeMax = targetR + CIRCLES_BAND_HALF * 1.5;
            const safeR = clamp(newR, safeMin, safeMax);
            const safeScale = safeR / newR;
            posX[i] = newX * safeScale;
            posY[i] = newY * safeScale;
          }
        }

        // Publish positions without per-node graph events (see runTreeLayout).
        for (let i = 0; i < nodeTotal; i++) {
          const attrs = graph.getNodeAttributes(layoutNodeIds[i]);
          attrs.x = posX[i];
          attrs.y = posY[i];
        }
        // The simulation is cheap; re-indexing every node and edge for the GPU
        // is not. Pace repaints by what the last one cost so rendering never
        // takes more than ~1/3 of the main thread, and the physics keeps
        // converging (and the UI keeps responding) in between.
        if (timestamp >= nextRenderAt) {
          const renderStart = performance.now();
          sigmaRef.current?.refresh({ partialGraph: { nodes: layoutNodeIds } });
          // Nothing else is on screen in focus mode — follow the set as it moves.
          if (focusSetRef.current) frameFocus(0);
          const renderEnd = performance.now();
          nextRenderAt = renderEnd + (renderEnd - renderStart) * LAYOUT_RENDER_BACKOFF;
        }

        const averageVelocity = totalVelocity / Math.max(1, graph.order);
        const elapsed = timestamp - (circlesLayoutStartRef.current ?? timestamp);

        if (
          elapsed >= CIRCLES_LAYOUT_MIN_DURATION &&
          maxVelocity < stopMaxVelocity &&
          activeNodes <= Math.max(2, Math.floor(graph.order * stopActiveNodeFraction)) &&
          averageVelocity < stopAvgVelocity
        ) {
          circlesStableFramesRef.current += 1;
        } else {
          circlesStableFramesRef.current = 0;
        }

        if (
          circlesStableFramesRef.current >= stopStabilityFrames ||
          elapsed >= effectiveMaxDuration
        ) {
          stopCirclesLayout(true);
          return;
        }

        circlesLayoutFrameRef.current = requestAnimationFrame(step);
      };

      circlesLayoutFrameRef.current = requestAnimationFrame(step);
    },
    [stopAllLayouts, stopCirclesLayout, setIsLayoutRunning, frameFocus],
  );

  // Run ForceAtlas2 layout
  const runLayout = useCallback(
    (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
      const nodeCount = graph.order;
      if (nodeCount === 0) return;

      stopAllLayouts(false);

      // Get settings
      const inferredSettings = forceAtlas2.inferSettings(graph);
      const customSettings = getFA2Settings(nodeCount);
      const settings = { ...inferredSettings, ...customSettings };

      const detached = nodeCount > DETACHED_FA2_NODE_THRESHOLD;
      const layoutGraph = detached ? graph.copy() : graph;
      const layout = new FA2Layout(layoutGraph, { settings });

      layoutRef.current = layout;
      layout.start();
      setIsLayoutRunning(true);
      if (hideEdgesDuringLayoutRef.current && !layoutStartingRef.current) {
        sigmaRef.current?.refresh();
      }
      layoutStartingRef.current = false;

      if (detached) {
        const nodeIds = graph.nodes();
        const syncPositions = () => {
          for (let i = 0; i < nodeIds.length; i++) {
            const from = layoutGraph.getNodeAttributes(nodeIds[i]);
            const to = graph.getNodeAttributes(nodeIds[i]);
            to.x = from.x;
            to.y = from.y;
          }
        };

        let frame: number | null = null;
        let nextRenderAt = 0;
        const tick = (timestamp: number) => {
          frame = requestAnimationFrame(tick);
          if (timestamp < nextRenderAt || graphRef.current !== graph) return;
          const renderStart = performance.now();
          syncPositions();
          sigmaRef.current?.refresh({ partialGraph: { nodes: nodeIds } });
          if (focusSetRef.current) frameFocus(0);
          const renderEnd = performance.now();
          nextRenderAt = renderEnd + (renderEnd - renderStart) * LAYOUT_RENDER_BACKOFF;
        };
        frame = requestAnimationFrame(tick);

        stopFA2SyncRef.current = (finalSync: boolean) => {
          stopFA2SyncRef.current = null;
          if (frame !== null) cancelAnimationFrame(frame);
          frame = null;
          if (finalSync && graphRef.current === graph) syncPositions();
        };
      }

      const duration = getLayoutDuration(nodeCount);

      layoutTimeoutRef.current = setTimeout(() => {
        if (layoutRef.current) {
          // stop() only flips the supervisor's running flag; kill() terminates
          // the Web Worker and unbinds its graph listeners. Nulling the ref
          // without kill() leaked one worker per completed layout.
          layoutRef.current.stop();
          layoutRef.current.kill();
          layoutRef.current = null;
          stopFA2SyncRef.current?.(true);

          // Light noverlap cleanup
          if (graph.order <= NOVERLAP_MAX_NODES) noverlap.assign(graph, NOVERLAP_SETTINGS);
          // Flag first: the refresh below is what brings hidden edges back.
          setIsLayoutRunning(false);
          sigmaRef.current?.refresh();
          if (focusSetRef.current) frameFocus(600);
        }
      }, duration);
    },
    [stopAllLayouts, setIsLayoutRunning, frameFocus],
  );

  const setGraph = useCallback(
    (newGraph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
      const sigma = sigmaRef.current;
      if (!sigma) return;

      stopAllLayouts(false);

      graphRef.current = newGraph;
      useStraightEdgesRef.current = newGraph.size > STRAIGHT_EDGE_THRESHOLD;
      hideEdgesDuringLayoutRef.current = newGraph.size > HIDE_EDGES_DURING_LAYOUT_THRESHOLD;
      sigma.setSetting('hideLabelsOnMove', newGraph.order > HIDE_LABELS_ON_MOVE_NODE_THRESHOLD);
      layoutStartingRef.current = newGraph.order > 0;
      preFocusCameraRef.current = null; // belongs to the previous graph
      sigma.setGraph(newGraph);
      setSelectedNode(null);

      if (options.layoutMode === 'tree') {
        runTreeLayout(newGraph);
      } else if (options.layoutMode === 'circles') {
        runCirclesLayout(newGraph);
      } else {
        runLayout(newGraph);
      }

      sigma.getCamera().animatedReset({ duration: 500 });
    },
    [
      options.layoutMode,
      runLayout,
      runTreeLayout,
      runCirclesLayout,
      setSelectedNode,
      stopAllLayouts,
    ],
  );

  const focusNode = useCallback(
    (nodeId: string) => {
      const sigma = sigmaRef.current;
      const graph = graphRef.current;
      if (!sigma || !graph || !graph.hasNode(nodeId)) return;

      // Skip if already focused on this node (prevents double-click issues)
      const alreadySelected = selectedNodeRef.current === nodeId;

      // Set selection state directly (without the camera nudge from setSelectedNode)
      selectedNodeRef.current = nodeId;
      updateFocus(nodeId);
      setSelectedNodeState(nodeId);

      // Only animate camera if selecting a new node
      if (!alreadySelected) frameFocus(400);

      requestRefresh();
    },
    [requestRefresh, updateFocus, frameFocus],
  );

  const zoomIn = useCallback(() => {
    sigmaRef.current?.getCamera().animatedZoom({ duration: 200 });
  }, []);

  const zoomOut = useCallback(() => {
    sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 });
  }, []);

  const resetZoom = useCallback(() => {
    preFocusCameraRef.current = null; // an explicit fit wins over restoring
    sigmaRef.current?.getCamera().animatedReset({ duration: 300 });
    setSelectedNode(null);
  }, [setSelectedNode]);

  const refreshHighlights = useCallback(() => {
    requestRefresh();
  }, [requestRefresh]);

  return {
    containerRef,
    sigmaRef,
    setGraph,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    isLayoutRunning,
    selectedNode,
    setSelectedNode,
    refreshHighlights,
  };
};
