import * as React from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  ContactShadows,
  Environment,
  GizmoHelper,
  GizmoViewport,
  Grid,
  Lightformer,
  useGLTF,
} from '@react-three/drei';
import type { FileFeaturesResponse, PartNode, SmartMeasurement, Vec3Tuple } from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import {
  computePartBbox,
  diameterCircleOrCylinder,
  extractFeaturesFromObject3D,
  readLocalFeatureCache,
  resolveHitToMeasurementReference,
  toFeatureCachePayload,
  writeLocalFeatureCache,
} from '@/lib/geometry';
import { useViewerStore, type ViewMode } from '@/stores/viewerStore';
import { useMeasureStore } from '@/stores/measureStore';
import {
  CameraController,
  type ModelBounds,
} from '@/components/viewer/CameraController';
import { ViewCubeOverlay } from '@/components/viewer/ViewCube';
import {
  AnnotationsLayer,
  AnnotationsPinOverlay,
} from '@/components/viewer/AnnotationsLayer';
import {
  AnnotationCreateTool,
  type CaptureAnnotationHitFn,
} from '@/components/viewer/AnnotationCreateTool';
import {
  MeasureLabelOverlay,
  MeasureOverlay3D,
} from '@/components/viewer/MeasureOverlay';
import { usePresenceStore } from '@/stores/presenceStore';
import { useCursorStore } from '@/stores/cursorStore';
import { emitRealtimeCursorMove } from '@/hooks/useRealtimeSync';
import { Spinner } from '@/components/ui/spinner';

function collectDescendantIds(nodes: PartNode[], targetId: string): Set<string> | null {
  for (const node of nodes) {
    if (node.id === targetId) {
      const ids = new Set<string>();
      const gather = (n: PartNode) => {
        ids.add(n.id);
        for (const child of n.children) gather(child);
      };
      gather(node);
      return ids;
    }
    const found = collectDescendantIds(node.children, targetId);
    if (found) return found;
  }
  return null;
}

function collectAncestorIds(
  nodes: PartNode[],
  targetId: string,
  trail: string[] = []
): string[] | null {
  for (const node of nodes) {
    const nextTrail = [...trail, node.id];
    if (node.id === targetId) return nextTrail;
    const found = collectAncestorIds(node.children, targetId, nextTrail);
    if (found) return found;
  }
  return null;
}

function resolvePartId(object: THREE.Object3D): string | null {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    const candidate = cursor.userData?.partId;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
    cursor = cursor.parent;
  }
  return null;
}

interface ClonedMeshRecord {
  mesh: THREE.Mesh;
  partId: string;
  baseMaterial: THREE.MeshStandardMaterial;
  originalColor: THREE.Color;
  originalOpacity: number;
  originalTransparent: boolean;
}

interface ModelSceneProps {
  modelUrl: string;
  fileId?: string;
  versionId?: string;
  shareToken?: string;
  onBoundsComputed: (modelUrl: string, bounds: ModelBounds) => void;
  captureAnnotationHitRef: React.RefObject<CaptureAnnotationHitFn | null>;
  modelRootRef: React.MutableRefObject<THREE.Object3D | null>;
}

function ModelScene({
  modelUrl,
  fileId,
  versionId,
  shareToken,
  onBoundsComputed,
  captureAnnotationHitRef,
  modelRootRef,
}: ModelSceneProps) {
  const { camera, gl } = useThree();
  const gltf = useGLTF(modelUrl);
  const partTree = useViewerStore((s) => s.partTree);
  const hiddenPartIds = useViewerStore((s) => s.hiddenPartIds);
  const isolatedPartId = useViewerStore((s) => s.isolatedPartId);
  const selectedPartId = useViewerStore((s) => s.selectedPartId);
  const viewMode = useViewerStore((s) => s.viewMode);
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const annotationMode = useViewerStore((s) => s.annotationMode);
  const selectPart = useViewerStore((s) => s.selectPart);
  const setSelectedFace = useViewerStore((s) => s.setSelectedFace);
  const requestZoomToPart = useViewerStore((s) => s.requestZoomToPart);

  const measureMode = useMeasureStore((s) => s.mode);
  const setHovered = useMeasureStore((s) => s.setHovered);
  const addSelection = useMeasureStore((s) => s.addSelection);
  const commitResult = useMeasureStore((s) => s.commitResult);
  const setFeatureIndex = useMeasureStore((s) => s.setFeatureIndex);
  const setCachedFeatures = useMeasureStore((s) => s.setCachedFeatures);
  const setExtractingFeatures = useMeasureStore((s) => s.setExtractingFeatures);

  const pointerDownClientRef = React.useRef<{ x: number; y: number } | null>(null);

  const { clonedScene, meshRecords, bounds } = React.useMemo(() => {
    const root = gltf.scene.clone(true);
    const records: ClonedMeshRecord[] = [];
    let autoCounter = 0;

    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        autoCounter += 1;
        let partId = resolvePartId(obj);
        if (!partId) {
          partId = `part-${autoCounter}`;
          obj.userData.partId = partId;
        }

        const sourceMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        let clonedMat: THREE.MeshStandardMaterial;

        if (sourceMat instanceof THREE.MeshStandardMaterial) {
          clonedMat = sourceMat.clone();
        } else {
          clonedMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color('#94a3b8'),
            metalness: 0.35,
            roughness: 0.4,
          });
        }

        clonedMat.side = THREE.DoubleSide;
        obj.material = clonedMat;
        obj.castShadow = true;
        obj.receiveShadow = true;

        records.push({
          mesh: obj,
          partId,
          baseMaterial: clonedMat,
          originalColor: clonedMat.color.clone(),
          originalOpacity: clonedMat.opacity,
          originalTransparent: clonedMat.transparent,
        });
      }
    });

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    if (!box.isEmpty()) {
      box.getCenter(center);
      box.getSize(size);
    } else {
      center.set(0, 0, 0);
      size.set(50, 50, 50);
    }
    const resolvedBox = !box.isEmpty()
      ? box.clone()
      : new THREE.Box3(new THREE.Vector3(-25, -25, -25), new THREE.Vector3(25, 25, 25));
    const radius = Math.max(size.length() * 0.5, 10);
    const computedBounds: ModelBounds = {
      box: resolvedBox,
      center,
      size,
      radius,
      minY: Number.isFinite(box.min.y) ? box.min.y : 0,
    };

    return { clonedScene: root, meshRecords: records, bounds: computedBounds };
  }, [gltf.scene]);

  React.useEffect(() => {
    modelRootRef.current = clonedScene;
    return () => {
      if (modelRootRef.current === clonedScene) {
        modelRootRef.current = null;
      }
    };
  }, [clonedScene, modelRootRef]);

  React.useEffect(() => {
    onBoundsComputed(modelUrl, bounds);
  }, [modelUrl, bounds, onBoundsComputed]);

  // Session 7: Client-side L2 geometry feature extraction + server/local cache sync
  React.useEffect(() => {
    let cancelled = false;
    setExtractingFeatures(true);

    if (fileId && versionId) {
      const localCached = readLocalFeatureCache(fileId, versionId);
      if (localCached) {
        setCachedFeatures(localCached.features, localCached.partSummaries);
      }
    }

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const index = extractFeaturesFromObject3D(clonedScene);
      if (cancelled) return;
      setFeatureIndex(index);

      if (fileId && versionId) {
        const cachePayload = toFeatureCachePayload(index);
        writeLocalFeatureCache(fileId, versionId, cachePayload);

        // Check server cache; if absent, persist once so subsequent clients get instant features
        const qs = `?versionId=${encodeURIComponent(versionId)}`;
        void apiFetch<FileFeaturesResponse>(`/files/${fileId}/features${qs}`, {
          shareToken,
          skipAuth: Boolean(shareToken),
        })
          .then((resp) => {
            if (cancelled || resp.cached) return;
            return apiFetch<FileFeaturesResponse>(`/files/${fileId}/features${qs}`, {
              method: 'POST',
              body: JSON.stringify(cachePayload),
              shareToken,
              skipAuth: Boolean(shareToken),
            });
          })
          .catch(() => {
            // Non-fatal: feature cache is strictly an optimization
          });
      }
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    clonedScene,
    fileId,
    versionId,
    shareToken,
    setFeatureIndex,
    setCachedFeatures,
    setExtractingFeatures,
  ]);

  React.useEffect(() => {
    return () => {
      for (const rec of meshRecords) {
        rec.baseMaterial.dispose();
      }
    };
  }, [meshRecords]);

  React.useEffect(() => {
    if (viewMode !== 'shadedEdges') return;

    const edgeObjects: Array<{ parent: THREE.Mesh; line: THREE.LineSegments }> = [];
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.72,
    });

    for (const rec of meshRecords) {
      const edgesGeom = new THREE.EdgesGeometry(rec.mesh.geometry, 24);
      const segments = new THREE.LineSegments(edgesGeom, edgeMat);
      segments.name = '__cadline_edges__';
      segments.raycast = () => undefined;
      rec.mesh.add(segments);
      edgeObjects.push({ parent: rec.mesh, line: segments });
    }

    return () => {
      for (const item of edgeObjects) {
        item.parent.remove(item.line);
        item.line.geometry.dispose();
      }
      edgeMat.dispose();
    };
  }, [meshRecords, viewMode]);

  const activeClipPlane = React.useMemo(() => {
    if (!sectionPlane.enabled) return null;
    const normal = new THREE.Vector3(
      sectionPlane.axis === 'x' ? -1 : 0,
      sectionPlane.axis === 'y' ? -1 : 0,
      sectionPlane.axis === 'z' ? -1 : 0
    );
    const axisSpan =
      sectionPlane.axis === 'x'
        ? bounds.size.x
        : sectionPlane.axis === 'y'
          ? bounds.size.y
          : bounds.size.z;
    const axisCenter =
      sectionPlane.axis === 'x'
        ? bounds.center.x
        : sectionPlane.axis === 'y'
          ? bounds.center.y
          : bounds.center.z;
    const cutCoord = axisCenter + sectionPlane.offset * Math.max(axisSpan * 0.6, 5);
    return new THREE.Plane(normal, cutCoord);
  }, [sectionPlane, bounds]);

  React.useEffect(() => {
    const isolatedSet = isolatedPartId
      ? collectDescendantIds(partTree, isolatedPartId) ?? new Set([isolatedPartId])
      : null;

    const hiddenExpanded = new Set<string>();
    for (const hid of hiddenPartIds) {
      const descendants = collectDescendantIds(partTree, hid);
      if (descendants) {
        for (const id of descendants) hiddenExpanded.add(id);
      } else {
        hiddenExpanded.add(hid);
      }
    }

    const selectedSet = selectedPartId
      ? collectDescendantIds(partTree, selectedPartId) ?? new Set([selectedPartId])
      : null;

    const clipPlanes = activeClipPlane ? [activeClipPlane] : [];

    for (const rec of meshRecords) {
      const ancestors = collectAncestorIds(partTree, rec.partId) ?? [rec.partId];
      const isHidden = ancestors.some((id) => hiddenExpanded.has(id));
      const isIsolatedOut = isolatedSet !== null && !isolatedSet.has(rec.partId);

      rec.mesh.visible = !isHidden && !isIsolatedOut;

      const mat = rec.baseMaterial;
      mat.clippingPlanes = clipPlanes;
      mat.clipShadows = true;
      mat.wireframe = viewMode === 'wireframe';

      if (viewMode === 'xray') {
        mat.transparent = true;
        mat.opacity = 0.28;
        mat.depthWrite = false;
      } else {
        mat.transparent = rec.originalTransparent;
        mat.opacity = rec.originalOpacity;
        mat.depthWrite = true;
      }

      const isSelected = selectedSet?.has(rec.partId) ?? false;
      if (isSelected) {
        mat.emissive.set('#0b5fff');
        mat.emissiveIntensity = 0.35;
      } else {
        mat.emissive.set('#000000');
        mat.emissiveIntensity = 0;
      }

      mat.needsUpdate = true;
    }
  }, [
    meshRecords,
    partTree,
    hiddenPartIds,
    isolatedPartId,
    selectedPartId,
    viewMode,
    activeClipPlane,
  ]);

  const extractWorldHitNormal = (event: ThreeEvent<MouseEvent | PointerEvent>): Vec3Tuple | undefined => {
    if (!event.face) return undefined;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(event.object.matrixWorld);
    const worldNormal = event.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    return [worldNormal.x, worldNormal.y, worldNormal.z];
  };

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    pointerDownClientRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();

    // Ignore clicks that were actually TrackballControls / Orbit drags (> 5px travel)
    if (pointerDownClientRef.current) {
      const moved = Math.hypot(
        event.clientX - pointerDownClientRef.current.x,
        event.clientY - pointerDownClientRef.current.y
      );
      if (moved > 5) return;
    }

    if (annotationMode) {
      const partId = resolvePartId(event.object);
      captureAnnotationHitRef.current?.(event, partId);
      return;
    }

    if (measureMode !== 'off') {
      const partId = resolvePartId(event.object) ?? 'part-1';
      const hitPoint: Vec3Tuple = [event.point.x, event.point.y, event.point.z];
      const hitNormal = extractWorldHitNormal(event);
      const index = useMeasureStore.getState().featureIndex;

      if (index) {
        const { reference } = resolveHitToMeasurementReference(
          index,
          partId,
          hitPoint,
          hitNormal,
          measureMode === 'diameter'
        );
        addSelection(reference);
        if (measureMode === 'quick') {
          const pending = useMeasureStore.getState().pendingResult;
          if (pending) commitResult();
        }
      } else {
        addSelection({
          kind: 'point',
          partId,
          position: hitPoint,
          ...(hitNormal ? { normal: hitNormal } : {}),
        });
      }
      return;
    }

    const partId = resolvePartId(event.object);
    selectPart(partId);

    if (event.face) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(event.object.matrixWorld);
      const worldNormal = event.face.normal.clone().applyMatrix3(normalMatrix).normalize();
      // Ensure normal faces toward camera on DoubleSide meshes so Normal-to-Selection looks at the clicked side
      const toCamera = camera.position.clone().sub(event.point);
      if (worldNormal.dot(toCamera) < 0) {
        worldNormal.negate();
      }
      setSelectedFace({
        point: [event.point.x, event.point.y, event.point.z],
        normal: [worldNormal.x, worldNormal.y, worldNormal.z],
        partId,
      });
    }
  };

  const handleDoubleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (annotationMode || measureMode !== 'off') return;
    if (usePresenceStore.getState().activeUserId !== null) return;
    const partId = resolvePartId(event.object);
    if (partId) {
      selectPart(partId);
      requestZoomToPart(partId);
    }
  };

  const planeHelperTransform = React.useMemo(() => {
    if (!sectionPlane.enabled) return null;
    const axisSpan =
      sectionPlane.axis === 'x'
        ? bounds.size.x
        : sectionPlane.axis === 'y'
          ? bounds.size.y
          : bounds.size.z;
    const axisCenter =
      sectionPlane.axis === 'x'
        ? bounds.center.x
        : sectionPlane.axis === 'y'
          ? bounds.center.y
          : bounds.center.z;
    const cutCoord = axisCenter + sectionPlane.offset * Math.max(axisSpan * 0.6, 5);
    const pos: [number, number, number] = [bounds.center.x, bounds.center.y, bounds.center.z];
    let rot: [number, number, number] = [0, 0, 0];

    if (sectionPlane.axis === 'x') {
      pos[0] = cutCoord;
      rot = [0, Math.PI / 2, 0];
    } else if (sectionPlane.axis === 'y') {
      pos[1] = cutCoord;
      rot = [-Math.PI / 2, 0, 0];
    } else {
      pos[2] = cutCoord;
      rot = [0, 0, 0];
    }

    const quadSize = Math.max(bounds.radius * 2.4, 40);
    return { pos, rot, quadSize };
  }, [sectionPlane, bounds]);

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    emitRealtimeCursorMove({
      x: event.point.x,
      y: event.point.y,
      z: event.point.z,
    });

    if (measureMode === 'off') return;
    const index = useMeasureStore.getState().featureIndex;
    if (!index) return;

    const partId = resolvePartId(event.object) ?? 'part-1';
    const hitPoint: Vec3Tuple = [event.point.x, event.point.y, event.point.z];
    const hitNormal = extractWorldHitNormal(event);
    const { reference, feature } = resolveHitToMeasurementReference(
      index,
      partId,
      hitPoint,
      hitNormal,
      measureMode === 'diameter'
    );

    const rect = gl.domElement.getBoundingClientRect();
    const screenPos = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };

    let preview: SmartMeasurement | null = null;
    if (measureMode === 'quick') {
      if (reference.kind === 'circle' || reference.kind === 'cylinder') {
        preview = diameterCircleOrCylinder(reference);
      } else if (reference.kind === 'plane' && typeof reference.area === 'number') {
        preview = {
          id: 'quick_plane',
          kind: 'area',
          value: Number(reference.area.toFixed(2)),
          unit: 'mm²',
          references: [reference],
          anchor: reference.position,
          label: feature?.summaryLabel ?? 'Planar Face',
          createdAt: '',
        };
      } else {
        const partCol = index.parts.get(partId);
        if (partCol) {
          preview = computePartBbox(partCol.mesh);
        }
      }
    }

    setHovered(feature?.id ?? null, partId, preview, screenPos);
  };

  const handlePointerOut = () => {
    if (measureMode !== 'off') {
      setHovered(null, null, null, null);
    }
  };

  return (
    <group>
      <primitive
        object={clonedScene}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
      />

      {planeHelperTransform && (
        <mesh
          position={planeHelperTransform.pos}
          rotation={planeHelperTransform.rot}
          raycast={() => undefined}
        >
          <planeGeometry
            args={[planeHelperTransform.quadSize, planeHelperTransform.quadSize]}
          />
          <meshBasicMaterial
            color="#0b5fff"
            transparent
            opacity={0.09}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

// Session 7 Smart Measurement overlay is rendered via MeasureOverlay3D + MeasureLabelOverlay.



interface RemoteCursors3DProps {
  labelElementsRef: React.RefObject<Map<string, HTMLDivElement>>;
}

/**
 * Renders remote collaborator 3D surface cursors as screen-space-constant
 * colored RingGeometry + inner dot meshes (no drei <Html>), with proper disposal.
 */
function RemoteCursors3D({ labelElementsRef }: RemoteCursors3DProps) {
  const { camera, size } = useThree();
  const cursors = useCursorStore((s) => s.cursors);
  const groupRefs = React.useRef<Map<string, THREE.Group>>(new Map());
  const projectedVecRef = React.useRef(new THREE.Vector3());
  const worldVecRef = React.useRef(new THREE.Vector3());

  const { ringGeom, dotGeom } = React.useMemo(() => {
    return {
      ringGeom: new THREE.RingGeometry(0.62, 1.0, 24),
      dotGeom: new THREE.CircleGeometry(0.32, 16),
    };
  }, []);

  React.useEffect(() => {
    return () => {
      ringGeom.dispose();
      dotGeom.dispose();
    };
  }, [ringGeom, dotGeom]);

  const cursors3D = React.useMemo(
    () => Object.values(cursors).filter((c) => c.z !== undefined),
    [cursors]
  );

  useFrame(() => {
    const projected = projectedVecRef.current;
    const worldPos = worldVecRef.current;
    const labelMap = labelElementsRef.current;
    const fovRad =
      camera instanceof THREE.PerspectiveCamera
        ? THREE.MathUtils.degToRad(camera.fov)
        : THREE.MathUtils.degToRad(40);
    const tanHalfFov = Math.tan(fovRad / 2);

    for (const c of cursors3D) {
      const z = c.z ?? 0;
      worldPos.set(c.x, c.y, z);

      const group = groupRefs.current.get(c.userId);
      if (group) {
        group.position.copy(worldPos);
        group.quaternion.copy(camera.quaternion);
        const dist = camera.position.distanceTo(worldPos);
        // Keep ~10px radius regardless of distance or zoom
        const worldPerPx = (2 * dist * tanHalfFov) / Math.max(size.height * camera.zoom, 1);
        const scaleVal = Math.max(worldPerPx * 10, 0.05);
        group.scale.setScalar(scaleVal);
      }

      const labelEl = labelMap?.get(c.userId);
      if (labelEl) {
        projected.copy(worldPos).project(camera);
        if (projected.z > 1 || projected.z < -1) {
          labelEl.style.opacity = '0';
        } else {
          const sx = (projected.x * 0.5 + 0.5) * size.width;
          const sy = (-projected.y * 0.5 + 0.5) * size.height;
          labelEl.style.transform = `translate3d(${(sx + 12).toFixed(1)}px, ${(sy + 8).toFixed(1)}px, 0)`;
          labelEl.style.opacity = '1';
        }
      }
    }
  });

  return (
    <group>
      {cursors3D.map((c) => (
        <group
          key={c.userId}
          ref={(node) => {
            if (node) {
              groupRefs.current.set(c.userId, node);
            } else {
              groupRefs.current.delete(c.userId);
            }
          }}
        >
          <mesh geometry={ringGeom} raycast={() => undefined} renderOrder={999}>
            <meshBasicMaterial
              color={c.color}
              side={THREE.DoubleSide}
              depthTest={false}
              transparent
              opacity={0.95}
            />
          </mesh>
          <mesh geometry={dotGeom} raycast={() => undefined} renderOrder={1000}>
            <meshBasicMaterial
              color="#ffffff"
              side={THREE.DoubleSide}
              depthTest={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}



function ScreenshotBridge({ fileName }: { fileName?: string }) {
  const { gl, scene, camera } = useThree();
  const registerScreenshotHandler = useViewerStore((s) => s.registerScreenshotHandler);

  React.useEffect(() => {
    const handler = () => {
      gl.render(scene, camera);
      const dataUrl = gl.domElement.toDataURL('image/png');
      const link = document.createElement('a');
      const safeBase = (fileName ?? 'cadline-view').replace(/[^a-zA-Z0-9._-]/g, '_');
      link.download = `${safeBase}-snapshot.png`;
      link.href = dataUrl;
      link.click();
    };
    registerScreenshotHandler(handler);
    return () => registerScreenshotHandler(null);
  }, [gl, scene, camera, fileName, registerScreenshotHandler]);

  return null;
}

class ViewerErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message || 'Failed to render 3D model' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center bg-[#0d1117] p-6 text-center">
          <p className="text-sm font-medium text-red-400">3D Viewport Error</p>
          <p className="mt-1 max-w-md font-mono text-xs text-muted-foreground">
            {this.state.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Viewer3DProps {
  modelUrl: string;
  fileId?: string;
  fileName?: string;
  versionId?: string;
  shareToken?: string;
  canEditMeasurements?: boolean;
}

export function Viewer3D({
  modelUrl,
  fileId,
  fileName,
  versionId,
  shareToken,
  canEditMeasurements = true,
}: Viewer3DProps) {
  const [loadedModel, setLoadedModel] = React.useState<{
    modelUrl: string;
    bounds: ModelBounds;
  } | null>(null);
  const [contextLost, setContextLost] = React.useState(false);

  const measureMode = useMeasureStore((s) => s.mode);
  const annotationMode = useViewerStore((s) => s.annotationMode);
  const remoteCursors = useCursorStore((s) => s.cursors);

  const labelElementsRef = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const pinElementsRef = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const remoteCursorLabelsRef = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const draftPinRef = React.useRef<HTMLDivElement | null>(null);
  const captureAnnotationHitRef = React.useRef<CaptureAnnotationHitFn | null>(null);
  const modelRootRef = React.useRef<THREE.Object3D | null>(null);

  const remoteCursors3D = React.useMemo(
    () => Object.values(remoteCursors).filter((c) => c.z !== undefined),
    [remoteCursors]
  );

  const handleBoundsComputed = React.useCallback((url: string, nextBounds: ModelBounds) => {
    setLoadedModel({ modelUrl: url, bounds: nextBounds });
  }, []);

  const bounds = loadedModel?.modelUrl === modelUrl ? loadedModel.bounds : null;

  const gridCellSize = bounds ? Math.max(5, Math.round(bounds.radius / 8)) : 10;
  const gridSectionSize = gridCellSize * 5;
  const gridY = bounds ? bounds.minY - 0.05 : 0;
  const markerRadius = bounds ? Math.max(bounds.radius * 0.016, 0.45) : 1;

  if (contextLost) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-[#0d1117] p-6 text-center">
        <p className="text-sm font-medium text-foreground">WebGL context was lost</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Reload the viewport to restore hardware-accelerated 3D rendering.
        </p>
      </div>
    );
  }

  return (
    <ViewerErrorBoundary>
      <div
        className={`relative h-full w-full overflow-hidden bg-[#0d1117] ${
          measureMode !== 'off' || annotationMode
            ? 'cursor-crosshair'
            : 'cursor-grab active:cursor-grabbing'
        }`}
      >
        <Canvas
          data-testid="viewer-3d-canvas"
          shadows
          dpr={[1, 2]}
          camera={{ position: [120, 90, 120], fov: 40, near: 0.1, far: 25000 }}
          gl={{
            antialias: true,
            preserveDrawingBuffer: true,
            localClippingEnabled: true,
            powerPreference: 'high-performance',
          }}
          onCreated={({ gl }) => {
            const canvas = gl.domElement;
            canvas.addEventListener(
              'webglcontextlost',
              (event) => {
                event.preventDefault();
                setContextLost(true);
              },
              false
            );
          }}
        >
          <color attach="background" args={['#0d1117']} />
          <ambientLight intensity={0.45} />
          <directionalLight position={[120, 180, 120]} intensity={1.15} castShadow />
          <directionalLight position={[-100, -60, -100]} intensity={0.35} />

          <Environment resolution={256} frames={1}>
            <Lightformer
              form="rect"
              intensity={2}
              color="#ffffff"
              position={[0, 10, 0]}
              rotation={[Math.PI / 2, 0, 0]}
              scale={[16, 16, 1]}
            />
            <Lightformer
              form="rect"
              intensity={1.5}
              color="#dbeafe"
              position={[12, 4, 10]}
              rotation={[0, -Math.PI / 4, 0]}
              scale={[12, 8, 1]}
            />
            <Lightformer
              form="rect"
              intensity={1.1}
              color="#e2e8f0"
              position={[-12, 2, -8]}
              rotation={[0, Math.PI / 3, 0]}
              scale={[10, 8, 1]}
            />
          </Environment>

          <React.Suspense fallback={null}>
            <ModelScene
              modelUrl={modelUrl}
              fileId={fileId}
              versionId={versionId}
              shareToken={shareToken}
              onBoundsComputed={handleBoundsComputed}
              captureAnnotationHitRef={captureAnnotationHitRef}
              modelRootRef={modelRootRef}
            />
          </React.Suspense>

          <AnnotationCreateTool captureHitRef={captureAnnotationHitRef} />

          <AnnotationsLayer
            versionId={versionId}
            markerRadius={markerRadius}
            pinElementsRef={pinElementsRef}
            draftPinRef={draftPinRef}
          />

          <MeasureOverlay3D
            markerRadius={markerRadius}
            labelElementsRef={labelElementsRef}
          />

          <RemoteCursors3D labelElementsRef={remoteCursorLabelsRef} />

          <Grid
            position={[bounds?.center.x ?? 0, gridY, bounds?.center.z ?? 0]}
            args={[gridSectionSize * 10, gridSectionSize * 10]}
            cellSize={gridCellSize}
            cellThickness={0.5}
            cellColor="#1e293b"
            sectionSize={gridSectionSize}
            sectionThickness={1}
            sectionColor="#334155"
            fadeDistance={Math.max((bounds?.radius ?? 50) * 8, 400)}
            fadeStrength={1.5}
            infiniteGrid
          />

          <ContactShadows
            position={[bounds?.center.x ?? 0, gridY + 0.02, bounds?.center.z ?? 0]}
            opacity={0.35}
            scale={Math.max((bounds?.radius ?? 50) * 4, 150)}
            blur={2.2}
            far={Math.max((bounds?.radius ?? 50) * 2.5, 100)}
          />

          <CameraController
            bounds={bounds}
            modelUrl={modelUrl}
            modelRootRef={modelRootRef}
          />
          <ScreenshotBridge fileName={fileName} />

          <GizmoHelper alignment="bottom-right" margin={[68, 68]}>
            <GizmoViewport
              axisColors={['#ef4444', '#22c55e', '#3b82f6']}
              labelColor="#f8fafc"
            />
          </GizmoHelper>
        </Canvas>

        {/* View orientation cube (own canvas, top-right) + SPACE large cube + controls help */}
        <ViewCubeOverlay />

        {/* React-19-safe DOM overlay for interactive 3D annotation pins */}
        <AnnotationsPinOverlay
          versionId={versionId}
          pinElementsRef={pinElementsRef}
          draftPinRef={draftPinRef}
        />

        {/* React-19-safe DOM overlay for remote collaborator 3D cursor name tags */}
        {remoteCursors3D.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
            {remoteCursors3D.map((cursor) => (
              <div
                key={cursor.userId}
                ref={(node) => {
                  if (node) {
                    remoteCursorLabelsRef.current.set(cursor.userId, node);
                  } else {
                    remoteCursorLabelsRef.current.delete(cursor.userId);
                  }
                }}
                style={{ backgroundColor: cursor.color }}
                className="pointer-events-none absolute left-0 top-0 select-none whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold text-white opacity-0 shadow-md"
              >
                {cursor.name.split(' ')[0] || cursor.name}
              </div>
            ))}
          </div>
        )}

        {/* React-19-safe DOM overlay for Smart Measurements, Quick Measure tooltip, and edit popup */}
        <MeasureLabelOverlay
          fileId={fileId}
          canEdit={canEditMeasurements}
          labelElementsRef={labelElementsRef}
        />

        {/* React-19-safe DOM loading overlay while GLB geometry streams in */}
        {!bounds && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground shadow-lg">
              <Spinner size="sm" />
              <span>Loading 3D geometry...</span>
            </div>
          </div>
        )}
      </div>
    </ViewerErrorBoundary>
  );
}

export type { ViewMode };
