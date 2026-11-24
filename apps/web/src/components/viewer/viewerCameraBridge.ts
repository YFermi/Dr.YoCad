import type * as THREE from 'three';

/**
 * Shares the main 3D viewer camera outside its <Canvas>: the view cube (its own
 * canvas) mirrors the camera orientation every frame, and in dev builds the
 * e2e tests read it from `window.__viewer`.
 */
export interface ViewerCameraHandle {
  camera: THREE.Camera;
  getPivot: () => THREE.Vector3 | null;
  getTarget: () => THREE.Vector3;
  getModelCenter: () => THREE.Vector3 | null;
  /** Root of the loaded model (dev / e2e inspection of part meshes). */
  getModelRoot: () => THREE.Object3D | null;
}

let current: ViewerCameraHandle | null = null;

declare global {
  interface Window {
    __viewer?: ViewerCameraHandle & {
      /** Client-space centre of a view cube region, for e2e clicks (dev only). */
      viewCubePoint?: (region: string) => { x: number; y: number } | null;
    };
  }
}

export function getViewerCamera(): ViewerCameraHandle | null {
  return current;
}

/** Registers the active viewer camera; returns an unregister function. */
export function publishViewerCamera(handle: ViewerCameraHandle): () => void {
  current = handle;
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    window.__viewer = { ...window.__viewer, ...handle };
  }
  return () => {
    if (current === handle) current = null;
    if (import.meta.env.DEV && typeof window !== 'undefined' && window.__viewer?.camera === handle.camera) {
      delete window.__viewer;
    }
  };
}
