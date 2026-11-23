import { create } from 'zustand';
import type * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import {
  normalizeMeasurementToSmart,
  type ExtractedFeature,
  type Measurement,
  type MeasurementReference,
  type PartMetricsSummary,
  type SmartMeasurement,
} from '@cadline/shared';
import {
  anglePlanePlane,
  angleThreePoints,
  autoResolveSmartMeasurement,
  computePartArea,
  computePartBbox,
  diameterCircleOrCylinder,
  minWallBetween,
  type GeometryFeatureIndex,
  type MeasurementContext,
  type TriangleMeshData,
} from '@/lib/geometry';
import { useViewerStore } from '@/stores/viewerStore';

export type MeasureMode =
  | 'off'
  | 'quick'
  | 'smart'
  | 'diameter'
  | 'angle'
  | 'min-wall'
  | 'area'
  | 'bbox'
  | 'surface';

interface MeasureState {
  mode: MeasureMode;
  hoveredFeatureId: string | null;
  hoveredPartId: string | null;
  hoveredScreenPos: { x: number; y: number } | null;
  quickPreview: SmartMeasurement | null;
  selection: MeasurementReference[];
  pendingResult: SmartMeasurement | null;
  relatedResults: SmartMeasurement[];
  pendingError: string | null;
  persistedResults: SmartMeasurement[];
  localResults: SmartMeasurement[];
  lastCommittedSmart: SmartMeasurement | null;

  featureIndex: GeometryFeatureIndex | null;
  bvhCache: Map<string, { geometry: THREE.BufferGeometry; bvh: MeshBVH }>;
  features: ExtractedFeature[];
  partSummaries: PartMetricsSummary[];
  extractingFeatures: boolean;

  inspectedPartId: string | null;
  focusedFeatureId: string | null;
  editingMeasurementId: string | null;
  requestedPanelSeq: number;
  displayUnit: 'mm' | 'in';

  setMode: (mode: MeasureMode) => void;
  setHovered: (
    featureId: string | null,
    partId: string | null,
    preview: SmartMeasurement | null,
    screenPos?: { x: number; y: number } | null
  ) => void;
  addSelection: (ref: MeasurementReference) => void;
  removeLastSelection: () => void;
  clearSelection: () => void;
  commitResult: () => void;
  consumeCommittedSmart: () => void;
  removeLocalResult: (id: string) => void;
  cancel: () => void;

  setExtractingFeatures: (extracting: boolean) => void;
  setFeatureIndex: (index: GeometryFeatureIndex | null) => void;
  setCachedFeatures: (features: ExtractedFeature[], partSummaries: PartMetricsSummary[]) => void;
  setPersistedMeasurements: (list: Measurement[] | null) => void;

  inspectPart: (partId: string) => void;
  clearInspectedPart: () => void;
  focusFeature: (featureId: string | null) => void;
  setEditingMeasurementId: (id: string | null) => void;
  setDisplayUnit: (unit: 'mm' | 'in') => void;
  resetForModel: () => void;
}

function buildContext(
  index: GeometryFeatureIndex | null,
  bvhCache: Map<string, { geometry: THREE.BufferGeometry; bvh: MeshBVH }>
): MeasurementContext {
  const partMeshes = new Map<string, TriangleMeshData>();
  if (index) {
    for (const [partId, col] of index.parts.entries()) {
      partMeshes.set(partId, col.mesh);
    }
  }
  return { partMeshes, bvhCache };
}

function computeForMode(
  mode: MeasureMode,
  selection: MeasurementReference[],
  index: GeometryFeatureIndex | null,
  bvhCache: Map<string, { geometry: THREE.BufferGeometry; bvh: MeshBVH }>
): { primary: SmartMeasurement | null; related: SmartMeasurement[]; error: string | null } {
  if (selection.length === 0) {
    return { primary: null, related: [], error: null };
  }
  const ctx = buildContext(index, bvhCache);

  switch (mode) {
    case 'diameter': {
      const ref = selection[selection.length - 1];
      if (ref.kind === 'circle' || ref.kind === 'cylinder') {
        return { primary: diameterCircleOrCylinder(ref), related: [], error: null };
      }
      return {
        primary: null,
        related: [],
        error: 'Click a circular hole, rim, or cylindrical bore/shaft to measure diameter.',
      };
    }

    case 'angle': {
      if (selection.length === 2 && selection[0].kind === 'plane' && selection[1].kind === 'plane') {
        return { primary: anglePlanePlane(selection[0], selection[1]), related: [], error: null };
      }
      if (selection.length >= 3) {
        return {
          primary: angleThreePoints(selection[0], selection[1], selection[2]),
          related: [],
          error: null,
        };
      }
      return { primary: null, related: [], error: null };
    }

    case 'min-wall': {
      const a = selection[0];
      const meshA = ctx.partMeshes.get(a.partId);
      if (!meshA) {
        return { primary: null, related: [], error: 'Geometry not ready yet.' };
      }
      if (selection.length === 1) {
        // Compute internal wall thickness on the clicked part immediately (user can also click a 2nd part for clearance)
        const wall = minWallBetween(meshA, meshA, bvhCache);
        return {
          primary: wall,
          related: [],
          error: wall ? null : 'Could not find opposing interior wall on this part.',
        };
      }
      const b = selection[1];
      const meshB = ctx.partMeshes.get(b.partId) ?? meshA;
      const wall = minWallBetween(meshA, meshB, bvhCache);
      return {
        primary: wall,
        related: [],
        error: wall ? null : 'Could not compute minimum wall clearance.',
      };
    }

    case 'area': {
      const ref = selection[selection.length - 1];
      if (ref.kind === 'plane' && typeof ref.area === 'number') {
        return {
          primary: {
            id: `sm_farea_${Date.now().toString(36)}`,
            kind: 'area',
            value: Number(ref.area.toFixed(4)),
            unit: 'mm²',
            references: [ref],
            anchor: ref.position,
            label: 'Face Area',
            createdAt: new Date().toISOString(),
          },
          related: [],
          error: null,
        };
      }
      const mesh = ctx.partMeshes.get(ref.partId);
      if (!mesh) return { primary: null, related: [], error: 'Part mesh unavailable.' };
      return { primary: computePartArea(mesh), related: [], error: null };
    }

    case 'bbox': {
      const ref = selection[selection.length - 1];
      const mesh = ctx.partMeshes.get(ref.partId);
      if (!mesh) return { primary: null, related: [], error: 'Part mesh unavailable.' };
      return { primary: computePartBbox(mesh), related: [], error: null };
    }

    case 'smart':
    case 'surface':
    case 'quick':
    default: {
      const res = autoResolveSmartMeasurement(selection, ctx);
      return {
        primary: res.primary,
        related: res.related,
        error: res.error ?? null,
      };
    }
  }
}

export const useMeasureStore = create<MeasureState>((set, get) => ({
  mode: 'off',
  hoveredFeatureId: null,
  hoveredPartId: null,
  hoveredScreenPos: null,
  quickPreview: null,
  selection: [],
  pendingResult: null,
  relatedResults: [],
  pendingError: null,
  persistedResults: [],
  localResults: [],
  lastCommittedSmart: null,

  featureIndex: null,
  bvhCache: new Map(),
  features: [],
  partSummaries: [],
  extractingFeatures: false,

  inspectedPartId: null,
  focusedFeatureId: null,
  editingMeasurementId: null,
  requestedPanelSeq: 0,
  displayUnit: 'mm',

  setMode: (mode) => {
    if (mode !== 'off') {
      const viewer = useViewerStore.getState();
      if (viewer.annotationMode) {
        viewer.setAnnotationMode(false);
      }
      if (viewer.measurementMode !== 'none') {
        viewer.setMeasurementMode('none');
      }
    }
    set({
      mode,
      selection: [],
      pendingResult: null,
      relatedResults: [],
      pendingError: null,
      quickPreview: null,
      hoveredFeatureId: null,
      hoveredPartId: null,
      hoveredScreenPos: null,
    });
  },

  setHovered: (featureId, partId, preview, screenPos = null) =>
    set({
      hoveredFeatureId: featureId,
      hoveredPartId: partId,
      quickPreview: preview,
      hoveredScreenPos: screenPos,
    }),

  addSelection: (ref) => {
    const state = get();
    if (state.mode === 'off') return;

    // Single-pick modes replace selection directly
    const isSinglePick =
      state.mode === 'diameter' || state.mode === 'area' || state.mode === 'bbox';

    let nextSelection: MeasurementReference[];
    if (isSinglePick) {
      nextSelection = [ref];
    } else if (state.mode === 'angle') {
      // 2 planes OR 3 points
      if (state.selection.length === 2 && state.selection[0].kind === 'plane' && state.selection[1].kind === 'plane') {
        nextSelection = [ref];
      } else if (state.selection.length >= 3) {
        nextSelection = [ref];
      } else {
        nextSelection = [...state.selection, ref];
      }
    } else if (state.mode === 'min-wall') {
      nextSelection = state.selection.length >= 2 ? [ref] : [...state.selection, ref];
    } else {
      // Smart Dimension: up to 2 references (or starts a new pair after 2)
      nextSelection = state.selection.length >= 2 ? [ref] : [...state.selection, ref];
    }

    const computed = computeForMode(
      state.mode,
      nextSelection,
      state.featureIndex,
      state.bvhCache
    );

    set({
      selection: nextSelection,
      pendingResult: computed.primary,
      relatedResults: computed.related,
      pendingError: computed.error,
    });
  },

  removeLastSelection: () => {
    const state = get();
    if (state.selection.length === 0) return;
    const nextSelection = state.selection.slice(0, -1);
    const computed = computeForMode(
      state.mode,
      nextSelection,
      state.featureIndex,
      state.bvhCache
    );
    set({
      selection: nextSelection,
      pendingResult: computed.primary,
      relatedResults: computed.related,
      pendingError: computed.error,
    });
  },

  clearSelection: () =>
    set({
      selection: [],
      pendingResult: null,
      relatedResults: [],
      pendingError: null,
    }),

  commitResult: () => {
    const state = get();
    if (!state.pendingResult) return;
    const committed: SmartMeasurement = {
      ...state.pendingResult,
      createdAt: new Date().toISOString(),
    };
    set({
      localResults: [...state.localResults, committed],
      lastCommittedSmart: committed,
      selection: [],
      pendingResult: null,
      relatedResults: [],
      pendingError: null,
    });
  },

  consumeCommittedSmart: () => set({ lastCommittedSmart: null }),

  removeLocalResult: (id) =>
    set((state) => ({
      localResults: state.localResults.filter((r) => r.id !== id),
    })),

  cancel: () => {
    const state = get();
    if (state.editingMeasurementId) {
      set({ editingMeasurementId: null });
      return;
    }
    if (state.selection.length > 0 || state.pendingResult) {
      set({
        selection: [],
        pendingResult: null,
        relatedResults: [],
        pendingError: null,
      });
      return;
    }
    set({
      mode: 'off',
      quickPreview: null,
      hoveredFeatureId: null,
      hoveredPartId: null,
      hoveredScreenPos: null,
    });
  },

  setExtractingFeatures: (extracting) => set({ extractingFeatures: extracting }),

  setFeatureIndex: (index) => {
    // Dispose any prior BVH geometries before resetting cache
    const prevCache = get().bvhCache;
    for (const entry of prevCache.values()) {
      entry.geometry.dispose();
    }
    set({
      featureIndex: index,
      bvhCache: new Map(),
      features: index ? index.features : [],
      partSummaries: index ? index.partSummaries : [],
      extractingFeatures: false,
    });
  },

  setCachedFeatures: (features, partSummaries) =>
    set({ features, partSummaries }),

  setPersistedMeasurements: (list) => {
    if (!list) {
      set({ persistedResults: [] });
      return;
    }
    const normalized: SmartMeasurement[] = [];
    for (const m of list) {
      const smart = normalizeMeasurementToSmart(m);
      if (smart) normalized.push(smart);
    }
    set({ persistedResults: normalized });
  },

  inspectPart: (partId) => {
    const viewer = useViewerStore.getState();
    viewer.selectPart(partId);
    if (viewer.annotationMode) viewer.setAnnotationMode(false);
    set((state) => ({
      inspectedPartId: partId,
      mode: 'surface',
      requestedPanelSeq: state.requestedPanelSeq + 1,
    }));
  },

  clearInspectedPart: () => set({ inspectedPartId: null, focusedFeatureId: null }),

  focusFeature: (featureId) => set({ focusedFeatureId: featureId }),

  setEditingMeasurementId: (id) => set({ editingMeasurementId: id }),

  setDisplayUnit: (unit) => set({ displayUnit: unit }),

  resetForModel: () => {
    const prevCache = get().bvhCache;
    for (const entry of prevCache.values()) {
      entry.geometry.dispose();
    }
    set({
      mode: 'off',
      hoveredFeatureId: null,
      hoveredPartId: null,
      hoveredScreenPos: null,
      quickPreview: null,
      selection: [],
      pendingResult: null,
      relatedResults: [],
      pendingError: null,
      localResults: [],
      lastCommittedSmart: null,
      featureIndex: null,
      bvhCache: new Map(),
      features: [],
      partSummaries: [],
      extractingFeatures: false,
      inspectedPartId: null,
      focusedFeatureId: null,
      editingMeasurementId: null,
    });
  },
}));
