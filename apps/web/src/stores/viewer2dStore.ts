import { create } from 'zustand';
import type {
  DxfLayerManifestItem,
  Point2D,
} from '@cadline/shared';

export type Viewer2DTool =
  | 'pan'
  | 'select'
  | 'distance'
  | 'angle'
  | 'area'
  | 'freehand'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'cloud'
  | 'text'
  | 'pin';

export type SnapKey = 'endpoint' | 'midpoint' | 'intersection' | 'grid';

export interface SnapConfig {
  endpoint: boolean;
  midpoint: boolean;
  intersection: boolean;
  grid: boolean;
}

export interface ShapeDraft {
  tool: Exclude<Viewer2DTool, 'pan' | 'select'>;
  sheet: 'dxf' | 'pdf';
  page?: number;
  points: Point2D[];
  currentPoint?: Point2D;
  label?: string;
  text?: string;
  color: string;
}

export interface Viewer2DState {
  tool: Viewer2DTool;
  snap: SnapConfig;
  gridStep: number;
  draftShape: ShapeDraft | null;
  selection: string | null; // annotation id
  activeLayerId: string | null;

  // Sheet metadata & layer visibility
  layers: DxfLayerManifestItem[];
  hiddenLayers: Set<string>;
  soloLayer: string | null;
  units: string;
  zoom: number;
  offsetX: number;
  offsetY: number;

  // Imperative bridges registered by active <DxfStage> / <PdfStage> / <Viewer2D>
  commitHandler: ((draft: ShapeDraft) => Promise<void>) | null;
  fitHandler: (() => void) | null;
  zoomStepHandler: ((factor: number) => void) | null;
  screenshotHandler: (() => void) | null;
  focusAnnotationHandler: ((annotationId: string) => void) | null;

  setTool: (t: Viewer2DTool) => void;
  toggleSnap: (k: SnapKey) => void;
  setGridStep: (step: number) => void;
  beginShape: (shape: ShapeDraft) => void;
  updateShape: (shape: ShapeDraft) => void;
  commitShape: () => Promise<void>;
  cancelShape: () => void;
  setSelection: (id: string | null) => void;
  setActiveLayer: (id: string | null) => void;

  setLayers: (layers: DxfLayerManifestItem[]) => void;
  toggleLayerVisibility: (layerName: string) => void;
  toggleSoloLayer: (layerName: string) => void;
  showAllLayers: () => void;
  setUnits: (units: string) => void;
  setViewportTransform: (zoom: number, offsetX: number, offsetY: number) => void;

  registerCommitHandler: (fn: ((draft: ShapeDraft) => Promise<void>) | null) => void;
  registerStageHandlers: (handlers: {
    fit?: (() => void) | null;
    zoomStep?: ((factor: number) => void) | null;
    screenshot?: (() => void) | null;
    focusAnnotation?: ((annotationId: string) => void) | null;
  }) => void;
  fitToView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  takeScreenshot: () => void;
  focusAnnotation: (annotationId: string) => void;
  reset2DState: () => void;
}

export const useViewer2DStore = create<Viewer2DState>((set, get) => ({
  tool: 'pan',
  snap: {
    endpoint: true,
    midpoint: true,
    intersection: true,
    grid: false,
  },
  gridStep: 1,
  draftShape: null,
  selection: null,
  activeLayerId: null,

  layers: [],
  hiddenLayers: new Set<string>(),
  soloLayer: null,
  units: 'mm',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,

  commitHandler: null,
  fitHandler: null,
  zoomStepHandler: null,
  screenshotHandler: null,
  focusAnnotationHandler: null,

  setTool: (t) =>
    set({
      tool: t,
      draftShape: null,
    }),

  toggleSnap: (k) =>
    set((state) => ({
      snap: {
        ...state.snap,
        [k]: !state.snap[k],
      },
    })),

  setGridStep: (step) =>
    set({
      gridStep: Number.isFinite(step) && step > 0 ? step : 1,
    }),

  beginShape: (shape) => set({ draftShape: shape }),

  updateShape: (shape) => set({ draftShape: shape }),

  commitShape: async () => {
    const { draftShape, commitHandler } = get();
    if (!draftShape) return;
    if (!commitHandler) {
      set({ draftShape: null });
      return;
    }
    set({ draftShape: null });
    await commitHandler(draftShape);
  },

  cancelShape: () => set({ draftShape: null }),

  setSelection: (id) => set({ selection: id }),

  setActiveLayer: (id) => set({ activeLayerId: id }),

  setLayers: (layers) => {
    const initiallyHidden = new Set<string>();
    for (const l of layers) {
      if (l.visible === false) {
        initiallyHidden.add(l.name);
      }
    }
    set({
      layers,
      hiddenLayers: initiallyHidden,
      soloLayer: null,
      activeLayerId: layers[0]?.name ?? null,
    });
  },

  toggleLayerVisibility: (layerName) =>
    set((state) => {
      const next = new Set(state.hiddenLayers);
      if (next.has(layerName)) {
        next.delete(layerName);
      } else {
        next.add(layerName);
      }
      return {
        hiddenLayers: next,
        soloLayer: state.soloLayer === layerName ? null : state.soloLayer,
      };
    }),

  toggleSoloLayer: (layerName) =>
    set((state) => ({
      soloLayer: state.soloLayer === layerName ? null : layerName,
    })),

  showAllLayers: () =>
    set({
      hiddenLayers: new Set<string>(),
      soloLayer: null,
    }),

  setUnits: (units) => set({ units: units || 'mm' }),

  setViewportTransform: (zoom, offsetX, offsetY) =>
    set({ zoom, offsetX, offsetY }),

  registerCommitHandler: (fn) => set({ commitHandler: fn }),

  registerStageHandlers: (handlers) =>
    set((state) => ({
      fitHandler: handlers.fit !== undefined ? handlers.fit : state.fitHandler,
      zoomStepHandler:
        handlers.zoomStep !== undefined ? handlers.zoomStep : state.zoomStepHandler,
      screenshotHandler:
        handlers.screenshot !== undefined
          ? handlers.screenshot
          : state.screenshotHandler,
      focusAnnotationHandler:
        handlers.focusAnnotation !== undefined
          ? handlers.focusAnnotation
          : state.focusAnnotationHandler,
    })),

  fitToView: () => {
    const fn = get().fitHandler;
    if (fn) fn();
  },

  zoomIn: () => {
    const fn = get().zoomStepHandler;
    if (fn) fn(1.25);
  },

  zoomOut: () => {
    const fn = get().zoomStepHandler;
    if (fn) fn(0.8);
  },

  takeScreenshot: () => {
    const fn = get().screenshotHandler;
    if (fn) fn();
  },

  focusAnnotation: (annotationId) => {
    set({ selection: annotationId });
    const fn = get().focusAnnotationHandler;
    if (fn) fn(annotationId);
  },

  reset2DState: () =>
    set({
      tool: 'pan',
      draftShape: null,
      selection: null,
      layers: [],
      hiddenLayers: new Set<string>(),
      soloLayer: null,
      units: 'mm',
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      commitHandler: null,
      fitHandler: null,
      zoomStepHandler: null,
      screenshotHandler: null,
      focusAnnotationHandler: null,
    }),
}));

/**
 * Imperative 2D viewer API (B9) for pan/zoom focus from CommentsPanel or external controls.
 */
export function useViewer2D() {
  const focusAnnotation = useViewer2DStore((s) => s.focusAnnotation);
  const fitToView = useViewer2DStore((s) => s.fitToView);
  const takeScreenshot = useViewer2DStore((s) => s.takeScreenshot);
  return {
    focusAnnotation,
    fitToView,
    takeScreenshot,
  };
}
