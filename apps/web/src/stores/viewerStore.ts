import { create } from 'zustand';
import {
  isAnnotationAnchor3D,
  normalizeAnnotationAnchor,
  type Annotation,
  type AnnotationAnchor3D,
  type AnnotationCameraPose,
  type Measurement,
  type PartNode,
} from '@cadline/shared';

export type ViewMode = 'shaded' | 'wireframe' | 'shadedEdges' | 'xray';
export type CameraPreset = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'iso' | 'fit';
export type MeasurementMode = 'none' | 'distance' | 'angle';
export type CameraControlMode = 'trackball' | 'orbit';

const CAMERA_MODE_STORAGE_KEY = 'cadline.cameraControlMode';

function loadInitialCameraControlMode(): CameraControlMode {
  try {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(CAMERA_MODE_STORAGE_KEY);
      if (saved === 'orbit' || saved === 'trackball') {
        return saved;
      }
    }
  } catch {
    // Ignore storage read errors in restricted iframe environments
  }
  return 'trackball';
}

export interface SelectedFaceHit {
  point: [number, number, number];
  normal: [number, number, number];
  partId: string | null;
}

export interface MeasurementPoint {
  x: number;
  y: number;
  z: number;
}

export interface ViewerMeasurement {
  id: string;
  type: 'distance' | 'angle';
  points: MeasurementPoint[];
  value: number;
  unit: string;
}

export interface AnnotationDraft {
  anchor: AnnotationAnchor3D;
  label: string;
}

export interface CommentFilters {
  versionId?: string;
  onlyUnresolved: boolean;
}

interface ViewerState {
  modelUrl: string | null;
  partTree: PartNode[];
  hiddenPartIds: Set<string>;
  isolatedPartId: string | null;
  selectedPartId: string | null;
  selectedPartIdForNormal: string | null;
  lastSelectedFace: SelectedFaceHit | null;
  cameraControlMode: CameraControlMode;
  viewMode: ViewMode;
  sectionPlane: { enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number };
  measurementMode: MeasurementMode;
  pendingMeasurePoints: MeasurementPoint[];
  measurements: ViewerMeasurement[];
  lastCompletedMeasurement: ViewerMeasurement | null;
  persistedMeasurements: Measurement[] | null;

  // Session 3 — Annotations & Comment Filters
  annotationMode: boolean;
  annotations: Annotation[] | null;
  selectedAnnotationId: string | null;
  annotationDraft: AnnotationDraft | null;
  commentFilters: CommentFilters;

  cameraCommand: { preset: CameraPreset; seq: number } | null;
  /** View cube: look along -dir (camera on the +dir side) with the given up. */
  cameraViewCommand: {
    dir: [number, number, number];
    up: [number, number, number];
    seq: number;
  } | null;
  cameraPoseCommand: { pose: AnnotationCameraPose; seq: number } | null;
  cameraRollCommand: { deltaDeg: number; seq: number } | null;
  normalToSelectionCommand: { seq: number } | null;
  zoomToPartCommand: { partId: string; seq: number } | null;
  screenshotHandler: (() => void) | null;

  setModel: (url: string | null, tree: PartNode[]) => void;
  togglePartVisibility: (partId: string) => void;
  isolatePart: (partId: string | null) => void;
  selectPart: (partId: string | null) => void;
  setSelectedFace: (hit: SelectedFaceHit | null) => void;
  setCameraControlMode: (mode: CameraControlMode) => void;
  showAllParts: () => void;
  setViewMode: (mode: ViewMode) => void;
  setSectionPlane: (
    patch: Partial<{ enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number }>
  ) => void;
  setMeasurementMode: (mode: MeasurementMode) => void;
  addMeasurementPoint: (point: MeasurementPoint) => void;
  removeLocalMeasurement: (id: string) => void;
  consumeCompletedMeasurement: () => void;
  clearMeasurements: () => void;
  setPersistedMeasurements: (list: Measurement[] | null) => void;

  setAnnotationMode: (active: boolean) => void;
  setAnnotations: (list: Annotation[] | null) => void;
  addAnnotationLocal: (annotation: Annotation) => void;
  updateAnnotationLocal: (id: string, patch: Partial<Annotation>) => void;
  removeAnnotationLocal: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  startAnnotationDraft: (anchor: AnnotationAnchor3D) => void;
  cancelAnnotationDraft: () => void;
  setAnnotationDraftLabel: (label: string) => void;
  setCommentFilters: (patch: Partial<CommentFilters>) => void;

  requestCameraPreset: (preset: CameraPreset) => void;
  requestCameraView: (dir: [number, number, number], up: [number, number, number]) => void;
  requestCameraPose: (pose: AnnotationCameraPose) => void;
  requestCameraRoll: (deltaDeg: number) => void;
  requestNormalToSelection: () => void;
  requestZoomToPart: (partId: string) => void;
  registerScreenshotHandler: (handler: (() => void) | null) => void;
  takeScreenshot: () => void;
  resetView: () => void;
}

function computeDistance(a: MeasurementPoint, b: MeasurementPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeAngleDeg(
  a: MeasurementPoint,
  vertex: MeasurementPoint,
  c: MeasurementPoint
): number {
  const v1x = a.x - vertex.x;
  const v1y = a.y - vertex.y;
  const v1z = a.z - vertex.z;
  const v2x = c.x - vertex.x;
  const v2y = c.y - vertex.y;
  const v2z = c.z - vertex.z;
  const len1 = Math.sqrt(v1x * v1x + v1y * v1y + v1z * v1z);
  const len2 = Math.sqrt(v2x * v2x + v2y * v2y + v2z * v2z);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  const dot = (v1x * v2x + v1y * v2y + v1z * v2z) / (len1 * len2);
  const clamped = Math.max(-1, Math.min(1, dot));
  return (Math.acos(clamped) * 180) / Math.PI;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  modelUrl: null,
  partTree: [],
  hiddenPartIds: new Set<string>(),
  isolatedPartId: null,
  selectedPartId: null,
  selectedPartIdForNormal: null,
  lastSelectedFace: null,
  cameraControlMode: loadInitialCameraControlMode(),
  viewMode: 'shaded',
  sectionPlane: { enabled: false, axis: 'y', offset: 0 },
  measurementMode: 'none',
  pendingMeasurePoints: [],
  measurements: [],
  lastCompletedMeasurement: null,
  persistedMeasurements: null,

  annotationMode: false,
  annotations: null,
  selectedAnnotationId: null,
  annotationDraft: null,
  commentFilters: { versionId: undefined, onlyUnresolved: false },

  cameraCommand: null,
  cameraViewCommand: null,
  cameraPoseCommand: null,
  cameraRollCommand: null,
  normalToSelectionCommand: null,
  zoomToPartCommand: null,
  screenshotHandler: null,

  setModel: (url, tree) =>
    set({
      modelUrl: url,
      partTree: tree,
      hiddenPartIds: new Set<string>(),
      isolatedPartId: null,
      selectedPartId: null,
      selectedPartIdForNormal: null,
      lastSelectedFace: null,
      pendingMeasurePoints: [],
      measurements: [],
      lastCompletedMeasurement: null,
      annotationMode: false,
      annotationDraft: null,
      selectedAnnotationId: null,
      sectionPlane: { enabled: false, axis: 'y', offset: 0 },
    }),

  togglePartVisibility: (partId) =>
    set((state) => {
      const next = new Set(state.hiddenPartIds);
      if (next.has(partId)) {
        next.delete(partId);
      } else {
        next.add(partId);
      }
      return { hiddenPartIds: next };
    }),

  isolatePart: (partId) =>
    set((state) => ({
      isolatedPartId: state.isolatedPartId === partId ? null : partId,
    })),

  selectPart: (partId) =>
    set((state) => ({
      selectedPartId: partId,
      selectedPartIdForNormal: partId,
      lastSelectedFace:
        partId !== null && state.lastSelectedFace?.partId === partId
          ? state.lastSelectedFace
          : null,
    })),

  setSelectedFace: (hit) =>
    set((state) => ({
      lastSelectedFace: hit,
      selectedPartIdForNormal: hit?.partId ?? state.selectedPartId,
    })),

  setCameraControlMode: (mode) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(CAMERA_MODE_STORAGE_KEY, mode);
      }
    } catch {
      // Ignore storage write errors
    }
    set({ cameraControlMode: mode });
  },

  showAllParts: () =>
    set({
      hiddenPartIds: new Set<string>(),
      isolatedPartId: null,
    }),

  setViewMode: (mode) => set({ viewMode: mode }),

  setSectionPlane: (patch) =>
    set((state) => ({
      sectionPlane: { ...state.sectionPlane, ...patch },
    })),

  setMeasurementMode: (mode) =>
    set({
      measurementMode: mode,
      pendingMeasurePoints: [],
      annotationMode: mode !== 'none' ? false : get().annotationMode,
    }),

  addMeasurementPoint: (point) =>
    set((state) => {
      if (state.measurementMode === 'none') return state;

      const nextPoints = [...state.pendingMeasurePoints, point];

      if (state.measurementMode === 'distance' && nextPoints.length === 2) {
        const dist = computeDistance(nextPoints[0], nextPoints[1]);
        const measurement: ViewerMeasurement = {
          id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'distance',
          points: nextPoints,
          value: dist,
          unit: 'mm',
        };
        return {
          pendingMeasurePoints: [],
          measurements: [...state.measurements, measurement],
          lastCompletedMeasurement: measurement,
        };
      }

      if (state.measurementMode === 'angle' && nextPoints.length === 3) {
        const angle = computeAngleDeg(nextPoints[0], nextPoints[1], nextPoints[2]);
        const measurement: ViewerMeasurement = {
          id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'angle',
          points: nextPoints,
          value: angle,
          unit: '°',
        };
        return {
          pendingMeasurePoints: [],
          measurements: [...state.measurements, measurement],
          lastCompletedMeasurement: measurement,
        };
      }

      return { pendingMeasurePoints: nextPoints };
    }),

  removeLocalMeasurement: (id) =>
    set((state) => ({
      measurements: state.measurements.filter((m) => m.id !== id),
    })),

  consumeCompletedMeasurement: () => set({ lastCompletedMeasurement: null }),

  clearMeasurements: () =>
    set({
      pendingMeasurePoints: [],
      measurements: [],
      lastCompletedMeasurement: null,
    }),

  setPersistedMeasurements: (list) => set({ persistedMeasurements: list }),

  setAnnotationMode: (active) =>
    set({
      annotationMode: active,
      measurementMode: active ? 'none' : get().measurementMode,
      pendingMeasurePoints: active ? [] : get().pendingMeasurePoints,
      annotationDraft: active ? get().annotationDraft : null,
    }),

  setAnnotations: (list) => set({ annotations: list }),

  addAnnotationLocal: (annotation) =>
    set((state) => {
      const current = state.annotations ?? [];
      if (current.some((a) => a.id === annotation.id)) {
        return { annotations: current };
      }
      return { annotations: [...current, annotation] };
    }),

  updateAnnotationLocal: (id, patch) =>
    set((state) => ({
      annotations: state.annotations
        ? state.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a))
        : null,
    })),

  removeAnnotationLocal: (id) =>
    set((state) => ({
      annotations: state.annotations
        ? state.annotations.filter((a) => a.id !== id)
        : null,
      selectedAnnotationId:
        state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
    })),

  selectAnnotation: (id) =>
    set((state) => {
      if (!id) {
        return { selectedAnnotationId: null };
      }
      const target = (state.annotations ?? []).find((a) => a.id === id);
      const rawAnchor = target?.payload?.anchor;
      const anchor = rawAnchor ? normalizeAnnotationAnchor(rawAnchor) : null;
      const pose = isAnnotationAnchor3D(anchor) ? anchor.cameraPose : undefined;
      return {
        selectedAnnotationId: id,
        ...(pose
          ? {
              cameraPoseCommand: {
                pose,
                seq: (state.cameraPoseCommand?.seq ?? 0) + 1,
              },
            }
          : {}),
      };
    }),

  startAnnotationDraft: (anchor) =>
    set({
      annotationDraft: { anchor, label: '' },
    }),

  cancelAnnotationDraft: () =>
    set({
      annotationDraft: null,
    }),

  setAnnotationDraftLabel: (label) =>
    set((state) =>
      state.annotationDraft
        ? { annotationDraft: { ...state.annotationDraft, label } }
        : state
    ),

  setCommentFilters: (patch) =>
    set((state) => ({
      commentFilters: { ...state.commentFilters, ...patch },
    })),

  requestCameraPreset: (preset) =>
    set((state) => ({
      cameraCommand: { preset, seq: (state.cameraCommand?.seq ?? 0) + 1 },
    })),

  requestCameraView: (dir, up) =>
    set((state) => ({
      cameraViewCommand: { dir, up, seq: (state.cameraViewCommand?.seq ?? 0) + 1 },
    })),

  requestCameraPose: (pose) =>
    set((state) => ({
      cameraPoseCommand: { pose, seq: (state.cameraPoseCommand?.seq ?? 0) + 1 },
    })),

  requestCameraRoll: (deltaDeg) =>
    set((state) => ({
      cameraRollCommand: {
        deltaDeg,
        seq: (state.cameraRollCommand?.seq ?? 0) + 1,
      },
    })),

  requestNormalToSelection: () =>
    set((state) => ({
      normalToSelectionCommand: {
        seq: (state.normalToSelectionCommand?.seq ?? 0) + 1,
      },
    })),

  requestZoomToPart: (partId) =>
    set((state) => ({
      zoomToPartCommand: {
        partId,
        seq: (state.zoomToPartCommand?.seq ?? 0) + 1,
      },
    })),

  registerScreenshotHandler: (handler) => set({ screenshotHandler: handler }),

  takeScreenshot: () => {
    const handler = get().screenshotHandler;
    if (handler) handler();
  },

  resetView: () =>
    set((state) => ({
      hiddenPartIds: new Set<string>(),
      isolatedPartId: null,
      selectedPartId: null,
      selectedPartIdForNormal: null,
      lastSelectedFace: null,
      viewMode: 'shaded',
      sectionPlane: { enabled: false, axis: 'y', offset: 0 },
      measurementMode: 'none',
      annotationMode: false,
      annotationDraft: null,
      selectedAnnotationId: null,
      pendingMeasurePoints: [],
      cameraCommand: { preset: 'iso', seq: (state.cameraCommand?.seq ?? 0) + 1 },
    })),
}));
