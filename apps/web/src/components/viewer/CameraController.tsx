import * as React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, TrackballControls } from 'three-stdlib';
import type { PartNode } from '@cadline/shared';
import { useViewerStore, type CameraPreset } from '@/stores/viewerStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useCursorStore } from '@/stores/cursorStore';
import { emitRealtimeCameraSync } from '@/hooks/useRealtimeSync';

export interface ModelBounds {
  box: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
  radius: number;
  minY: number;
}

export interface CameraControllerProps {
  bounds: ModelBounds | null;
  modelUrl: string;
  modelRootRef: React.RefObject<THREE.Object3D | null>;
}

type ActiveControls = TrackballControls | OrbitControls;

interface CameraAnimation {
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
  startUp: THREE.Vector3;
  endUp: THREE.Vector3;
  startZoom: number;
  endZoom: number;
  elapsedMs: number;
  durationMs: number;
}

const PRESET_ANIMATION_MS = 400;
const ROLL_ANIMATION_MS = 240;
const OUTER_ROLL_RING_RATIO = 0.78;

// Reusable scratch vectors (zero per-frame allocations)
const _tmpDir = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
const _tmpRight = new THREE.Vector3();
const _tmpEye = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpRaycaster = new THREE.Raycaster();
const _tmpNdc = new THREE.Vector2();
const _tmpPlane = new THREE.Plane();
const _tmpAnchor = new THREE.Vector3();
const _tmpDelta = new THREE.Vector3();
const _tmpNewPos = new THREE.Vector3();
const _tmpNewTarget = new THREE.Vector3();
const _tmpCorner = new THREE.Vector3();
const _tmpFollowPos = new THREE.Vector3();
const _tmpFollowTarget = new THREE.Vector3();

function isTrackballControls(controls: ActiveControls): controls is TrackballControls {
  return 'dynamicDampingFactor' in controls;
}

function flushControlsInertia(controls: ActiveControls | null): void {
  if (!controls) return;
  if (isTrackballControls(controls)) {
    const prevStatic = controls.staticMoving;
    controls.staticMoving = true;
    controls.update();
    controls.staticMoving = prevStatic;
  }
}

function getPresetOrientation(preset: CameraPreset): {
  dir: THREE.Vector3;
  up: THREE.Vector3;
} {
  switch (preset) {
    case 'front':
      return { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) };
    case 'back':
      return { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) };
    case 'top':
      return { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) };
    case 'bottom':
      return { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) };
    case 'left':
      return { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) };
    case 'right':
      return { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) };
    case 'iso':
    case 'fit':
    default:
      return {
        dir: new THREE.Vector3(1, 0.78, 1).normalize(),
        up: new THREE.Vector3(0, 1, 0),
      };
  }
}

/**
 * Computes an orthogonal camera-up vector perpendicular to `viewDir` (camera->target negated,
 * i.e. outward direction from target toward camera), preferring `preferredUp`.
 */
function orthogonalizeUp(viewDir: THREE.Vector3, preferredUp: THREE.Vector3): THREE.Vector3 {
  const dir = viewDir.clone().normalize();
  const projected = preferredUp
    .clone()
    .addScaledVector(dir, -preferredUp.dot(dir));
  if (projected.lengthSq() > 1e-6) {
    return projected.normalize();
  }
  const fallback = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
  return fallback.addScaledVector(dir, -fallback.dot(dir)).normalize();
}

/**
 * Computes the exact camera distance required to tightly frame an arbitrary 3D Box3
 * along `viewDir` (unit vector pointing from box center toward camera) and `upVec`.
 */
function computeFitDistanceForBox(
  box: THREE.Box3,
  viewDir: THREE.Vector3,
  upVec: THREE.Vector3,
  camera: THREE.Camera,
  aspect: number,
  padding = 1.18
): number {
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  const forward = viewDir.clone().normalize();
  const up = orthogonalizeUp(forward, upVec);
  const right = new THREE.Vector3().crossVectors(up, forward).normalize();

  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;

  const xs = [box.min.x, box.max.x];
  const ys = [box.min.y, box.max.y];
  const zs = [box.min.z, box.max.z];

  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        _tmpCorner.set(x - center.x, y - center.y, z - center.z);
        maxX = Math.max(maxX, Math.abs(_tmpCorner.dot(right)));
        maxY = Math.max(maxY, Math.abs(_tmpCorner.dot(up)));
        maxZ = Math.max(maxZ, Math.abs(_tmpCorner.dot(forward)));
      }
    }
  }

  const vFovRad =
    camera instanceof THREE.PerspectiveCamera
      ? THREE.MathUtils.degToRad(camera.fov)
      : THREE.MathUtils.degToRad(40);
  const safeAspect = Number.isFinite(aspect) && aspect > 0.1 ? aspect : 1.5;
  const tanHalfV = Math.tan(vFovRad / 2);
  const tanHalfH = tanHalfV * safeAspect;

  const distV = maxY / Math.max(tanHalfV, 1e-4);
  const distH = maxX / Math.max(tanHalfH, 1e-4);
  const baseDist = Math.max(distV, distH, size.length() * 0.25, 2);

  return baseDist * padding + maxZ;
}

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

function computePartBoundingBox(
  modelRoot: THREE.Object3D | null,
  partId: string,
  partTree: PartNode[]
): THREE.Box3 | null {
  if (!modelRoot) return null;
  const targetIds = collectDescendantIds(partTree, partId) ?? new Set([partId]);
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  let found = false;

  modelRoot.updateMatrixWorld(true);
  modelRoot.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.visible) {
      const objPartId = resolvePartId(obj);
      if (objPartId && targetIds.has(objPartId)) {
        meshBox.setFromObject(obj);
        if (!meshBox.isEmpty()) {
          box.union(meshBox);
          found = true;
        }
      }
    }
  });

  return found && !box.isEmpty() ? box : null;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

export function CameraController({
  bounds,
  modelUrl,
  modelRootRef,
}: CameraControllerProps) {
  const { camera, gl, size, set } = useThree();
  const cameraControlMode = useViewerStore((s) => s.cameraControlMode);
  const cameraCommand = useViewerStore((s) => s.cameraCommand);
  const cameraPoseCommand = useViewerStore((s) => s.cameraPoseCommand);
  const cameraRollCommand = useViewerStore((s) => s.cameraRollCommand);
  const normalToSelectionCommand = useViewerStore((s) => s.normalToSelectionCommand);
  const zoomToPartCommand = useViewerStore((s) => s.zoomToPartCommand);
  const activeFollowUserId = usePresenceStore((s) => s.activeUserId);
  const isFollowing = activeFollowUserId !== null;

  const controlsRef = React.useRef<ActiveControls | null>(null);
  const targetRef = React.useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 0));
  const animRef = React.useRef<CameraAnimation | null>(null);
  const initializedModelRef = React.useRef<string | null>(null);
  const boundsRef = React.useRef<ModelBounds | null>(bounds);
  const isFollowingRef = React.useRef<boolean>(isFollowing);
  const sizeRef = React.useRef(size);

  boundsRef.current = bounds;
  isFollowingRef.current = isFollowing;
  sizeRef.current = size;

  const startAnimation = React.useCallback(
    (
      endPos: THREE.Vector3,
      endTarget: THREE.Vector3,
      endUp: THREE.Vector3,
      endZoom: number,
      durationMs = PRESET_ANIMATION_MS
    ) => {
      flushControlsInertia(controlsRef.current);
      const currentTarget = controlsRef.current
        ? controlsRef.current.target.clone()
        : targetRef.current.clone();
      const viewDir = endPos.clone().sub(endTarget);
      const orthoEndUp =
        viewDir.lengthSq() > 1e-8
          ? orthogonalizeUp(viewDir, endUp)
          : endUp.clone().normalize();

      animRef.current = {
        startPos: camera.position.clone(),
        endPos: endPos.clone(),
        startTarget: currentTarget,
        endTarget: endTarget.clone(),
        startUp: camera.up.clone().normalize(),
        endUp: orthoEndUp,
        startZoom: camera.zoom,
        endZoom: Number.isFinite(endZoom) && endZoom > 0 ? endZoom : 1,
        elapsedMs: 0,
        durationMs,
      };
    },
    [camera]
  );

  // Instantiate TrackballControls (default SOLIDWORKS free-tumble) or OrbitControls (fallback)
  React.useEffect(() => {
    const domElement = gl.domElement;
    const prevTarget = controlsRef.current
      ? controlsRef.current.target.clone()
      : targetRef.current.clone();

    let controls: ActiveControls;

    if (cameraControlMode === 'trackball') {
      const tb = new TrackballControls(camera, domElement);
      tb.staticMoving = false;
      tb.dynamicDampingFactor = 0.15;
      tb.rotateSpeed = 2.6;
      tb.zoomSpeed = 1.1;
      tb.panSpeed = 0.85;
      tb.noRotate = false;
      tb.noZoom = false;
      tb.noPan = false;
      // Wheel zoom-to-cursor is handled via capture-phase raycast below;
      // keep TrackballControls.cursorZoom false so right-drag dolly stays centered on target
      tb.cursorZoom = false;
      // Disable A/S/D modal keys so typing in comments/chat never hijacks controls
      tb.keys = ['', '', ''];
      // In three-stdlib TrackballControls:
      // case mouseButtons.LEFT -> ROTATE, case mouseButtons.MIDDLE -> ZOOM (dolly), case mouseButtons.RIGHT -> PAN
      tb.mouseButtons = {
        LEFT: THREE.MOUSE.LEFT,
        MIDDLE: THREE.MOUSE.RIGHT, // Right-drag = smooth dolly (P2)
        RIGHT: THREE.MOUSE.MIDDLE, // Middle-drag = screen-plane pan (P0)
      };
      tb.target.copy(prevTarget);
      tb.enabled = !isFollowingRef.current;
      tb.handleResize();
      controls = tb;
    } else {
      // Turntable fallback mode — restore world-Y upright vector
      camera.up.set(0, 1, 0);
      const oc = new OrbitControls(camera, domElement);
      oc.enableDamping = true;
      oc.dampingFactor = 0.08;
      oc.screenSpacePanning = true;
      oc.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.DOLLY,
      };
      oc.target.copy(prevTarget);
      oc.enabled = !isFollowingRef.current;
      oc.update();
      controls = oc;
    }

    const onStart = () => {
      animRef.current = null;
    };
    controls.addEventListener('start', onStart);

    controlsRef.current = controls;
    targetRef.current.copy(controls.target);

    // Expose controller to R3F state (used by AnnotationCreateTool and GizmoHelper)
    set({ controls: controls as unknown as THREE.EventDispatcher });

    const handleResize = () => {
      if (isTrackballControls(controls)) {
        controls.handleResize();
      }
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    resizeObserver?.observe(domElement);
    window.addEventListener('resize', handleResize);

    return () => {
      controls.removeEventListener('start', onStart);
      window.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect();
      targetRef.current.copy(controls.target);
      controls.dispose();
      if (controlsRef.current === controls) {
        controlsRef.current = null;
      }
      set({ controls: null });
    };
  }, [camera, gl, cameraControlMode, set]);

  // Keep enabled flag synchronized with follow mode
  React.useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.enabled = !isFollowing;
      if (isFollowing) {
        animRef.current = null;
        flushControlsInertia(controlsRef.current);
      }
    }
  }, [isFollowing]);

  // Keep TrackballControls / OrbitControls distance bounds proportional to model scale
  React.useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !bounds) return;
    controls.minDistance = Math.max(bounds.radius * 0.02, 0.2);
    controls.maxDistance = Math.max(bounds.radius * 40, 2000);
  }, [bounds, cameraControlMode]);

  // Custom SOLIDWORKS pointer & wheel enhancements (capture phase on canvas):
  // - Wheel: true raycast zoom-to-cursor (+ Ctrl+wheel 10% fine zoom)
  // - Shift + Left drag: screen-plane pan respecting current rolled camera-up
  // - Outer-ring Left drag (trackball mode): direct screen-Z roll around view axis
  React.useEffect(() => {
    const domElement = gl.domElement;

    let activeCustomDrag: 'none' | 'shift-pan' | 'screen-roll' = 'none';
    let lastClientX = 0;
    let lastClientY = 0;
    let lastRollAngle = 0;

    const getMinMaxDistance = (): { minDist: number; maxDist: number } => {
      const b = boundsRef.current;
      return {
        minDist: b ? Math.max(b.radius * 0.02, 0.2) : 0.2,
        maxDist: b ? Math.max(b.radius * 40, 2000) : 5000,
      };
    };

    const onWheelCapture = (event: WheelEvent) => {
      const controls = controlsRef.current;
      if (!controls) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (isFollowingRef.current) return;

      animRef.current = null;
      flushControlsInertia(controls);

      const rect = domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      // Normalize wheel delta across mouse wheel lines, pages, and smooth trackpads
      let rawDelta = event.deltaY;
      if (event.deltaMode === 1) rawDelta *= 24;
      else if (event.deltaMode === 2) rawDelta *= rect.height;

      const normalized = Math.max(-3, Math.min(3, rawDelta / 100));
      if (Math.abs(normalized) < 1e-5) return;

      // Ctrl + wheel = 10% fine zoom step (also tames browser pinch-to-zoom wheel events)
      const zoomScale = event.ctrlKey ? 0.015 : 0.14;
      let factor = Math.exp(normalized * zoomScale);

      // Compute cursor NDC
      _tmpNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      _tmpRaycaster.setFromCamera(_tmpNdc, camera);

      // Prefer exact surface hit under cursor; fallback to camera-facing plane through target
      let hasAnchor = false;
      const root = modelRootRef.current;
      if (root) {
        const hits = _tmpRaycaster.intersectObject(root, true);
        for (const hit of hits) {
          if (hit.object instanceof THREE.Mesh && hit.object.visible) {
            _tmpAnchor.copy(hit.point);
            hasAnchor = true;
            break;
          }
        }
      }

      if (!hasAnchor) {
        _tmpDir.copy(controls.target).sub(camera.position);
        if (_tmpDir.lengthSq() < 1e-8) {
          _tmpDir.set(0, 0, -1);
        } else {
          _tmpDir.normalize();
        }
        _tmpPlane.setFromNormalAndCoplanarPoint(_tmpDir, controls.target);
        const hitPlane = _tmpRaycaster.ray.intersectPlane(_tmpPlane, _tmpAnchor);
        if (!hitPlane) {
          _tmpAnchor.copy(controls.target);
        }
      }

      const currentDist = camera.position.distanceTo(controls.target);
      const { minDist, maxDist } = getMinMaxDistance();
      const targetDist = currentDist * factor;

      if (targetDist < minDist) {
        factor = minDist / Math.max(currentDist, 1e-6);
      } else if (targetDist > maxDist) {
        factor = maxDist / Math.max(currentDist, 1e-6);
      }

      // Scale both camera.position and controls.target toward cursor anchor so the
      // 3D point under the cursor remains pixel-locked during zoom
      _tmpNewPos.copy(camera.position).sub(_tmpAnchor).multiplyScalar(factor).add(_tmpAnchor);
      _tmpNewTarget.copy(controls.target).sub(_tmpAnchor).multiplyScalar(factor).add(_tmpAnchor);

      camera.position.copy(_tmpNewPos);
      controls.target.copy(_tmpNewTarget);
      camera.lookAt(controls.target);
    };

    const onPointerDownCapture = (event: PointerEvent) => {
      if (isFollowingRef.current) {
        event.stopImmediatePropagation();
        return;
      }

      const controls = controlsRef.current;
      if (!controls) return;

      // Only intercept mouse/pen left button when Shift is held (pan) or on outer roll ring
      if (event.pointerType === 'touch' || event.button !== 0) return;

      const viewerState = useViewerStore.getState();
      const isToolActive =
        viewerState.annotationMode || viewerState.measurementMode !== 'none';

      // SHIFT + LEFT = screen-plane pan (P0 #3)
      if (event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        animRef.current = null;
        flushControlsInertia(controls);
        activeCustomDrag = 'shift-pan';
        lastClientX = event.clientX;
        lastClientY = event.clientY;
        domElement.setPointerCapture?.(event.pointerId);
        return;
      }

      // Outer perimeter ring LEFT drag = direct screen-Z roll (P0 #1, trackball mode only)
      if (cameraControlMode === 'trackball' && !isToolActive) {
        const rect = domElement.getBoundingClientRect();
        const cx = rect.left + rect.width * 0.5;
        const cy = rect.top + rect.height * 0.5;
        const halfMin = Math.max(Math.min(rect.width, rect.height) * 0.5, 1);
        const nx = (event.clientX - cx) / halfMin;
        const ny = (event.clientY - cy) / halfMin;
        const radiusRatio = Math.hypot(nx, ny);

        if (radiusRatio >= OUTER_ROLL_RING_RATIO) {
          event.preventDefault();
          event.stopImmediatePropagation();
          animRef.current = null;
          flushControlsInertia(controls);
          activeCustomDrag = 'screen-roll';
          lastRollAngle = Math.atan2(event.clientY - cy, event.clientX - cx);
          domElement.setPointerCapture?.(event.pointerId);
        }
      }
    };

    const onPointerMoveWindow = (event: PointerEvent) => {
      if (activeCustomDrag === 'none') return;
      const controls = controlsRef.current;
      if (!controls || isFollowingRef.current) {
        activeCustomDrag = 'none';
        return;
      }

      if (activeCustomDrag === 'shift-pan') {
        const dx = event.clientX - lastClientX;
        const dy = event.clientY - lastClientY;
        lastClientX = event.clientX;
        lastClientY = event.clientY;

        const rect = domElement.getBoundingClientRect();
        const viewportHeight = Math.max(rect.height, 1);
        const dist = camera.position.distanceTo(controls.target);
        const fovRad =
          camera instanceof THREE.PerspectiveCamera
            ? THREE.MathUtils.degToRad(camera.fov)
            : THREE.MathUtils.degToRad(40);
        const worldPerPx = (2 * dist * Math.tan(fovRad / 2)) / (viewportHeight * Math.max(camera.zoom, 1e-4));

        // Camera screen basis respecting arbitrary rolled camera.up
        _tmpEye.copy(camera.position).sub(controls.target).normalize();
        _tmpUp.copy(camera.up).normalize();
        _tmpRight.crossVectors(_tmpUp, _tmpEye).normalize();
        _tmpUp.crossVectors(_tmpEye, _tmpRight).normalize();

        _tmpDelta
          .set(0, 0, 0)
          .addScaledVector(_tmpRight, -dx * worldPerPx)
          .addScaledVector(_tmpUp, dy * worldPerPx);

        camera.position.add(_tmpDelta);
        controls.target.add(_tmpDelta);
        camera.lookAt(controls.target);
        return;
      }

      if (activeCustomDrag === 'screen-roll') {
        const rect = domElement.getBoundingClientRect();
        const cx = rect.left + rect.width * 0.5;
        const cy = rect.top + rect.height * 0.5;
        const nextAngle = Math.atan2(event.clientY - cy, event.clientX - cx);
        let deltaAngle = nextAngle - lastRollAngle;
        if (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
        if (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
        lastRollAngle = nextAngle;

        if (Math.abs(deltaAngle) > 1e-6) {
          _tmpEye.copy(camera.position).sub(controls.target).normalize();
          _tmpQuat.setFromAxisAngle(_tmpEye, deltaAngle);
          camera.up.applyQuaternion(_tmpQuat).normalize();
          camera.lookAt(controls.target);
        }
      }
    };

    const onPointerUpWindow = (event: PointerEvent) => {
      if (activeCustomDrag === 'none') return;
      activeCustomDrag = 'none';
      if (domElement.hasPointerCapture?.(event.pointerId)) {
        domElement.releasePointerCapture(event.pointerId);
      }
      flushControlsInertia(controlsRef.current);
    };

    const onMouseDownPreventMiddleScroll = (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    };

    domElement.addEventListener('mousedown', onMouseDownPreventMiddleScroll);
    domElement.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
    domElement.addEventListener('pointerdown', onPointerDownCapture, { capture: true });
    window.addEventListener('pointermove', onPointerMoveWindow);
    window.addEventListener('pointerup', onPointerUpWindow);
    window.addEventListener('pointercancel', onPointerUpWindow);

    return () => {
      domElement.removeEventListener('mousedown', onMouseDownPreventMiddleScroll);
      domElement.removeEventListener('wheel', onWheelCapture, { capture: true });
      domElement.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
      window.removeEventListener('pointermove', onPointerMoveWindow);
      window.removeEventListener('pointerup', onPointerUpWindow);
      window.removeEventListener('pointercancel', onPointerUpWindow);
    };
  }, [camera, gl, cameraControlMode, modelRootRef]);

  // Keyboard shortcuts: Q / E roll camera ±15° around view axis (P1 #6)
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isFollowingRef.current) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableKeyboardTarget(event.target)) return;

      if (event.code === 'KeyQ') {
        event.preventDefault();
        useViewerStore.getState().requestCameraRoll(-15);
      } else if (event.code === 'KeyE') {
        event.preventDefault();
        useViewerStore.getState().requestCameraRoll(15);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const applyPreset = React.useCallback(
    (preset: CameraPreset, immediate = false) => {
      const currentBounds = boundsRef.current;
      if (!currentBounds) return;

      const aspect = sizeRef.current.width / Math.max(sizeRef.current.height, 1);

      let dir: THREE.Vector3;
      let targetUp: THREE.Vector3;

      if (preset === 'fit') {
        // Fit bounding box while preserving current view direction & rolled camera-up
        const curTarget = controlsRef.current?.target ?? targetRef.current;
        dir = camera.position.clone().sub(curTarget);
        if (dir.lengthSq() < 1e-6) {
          dir.set(1, 0.78, 1);
        }
        dir.normalize();
        targetUp = orthogonalizeUp(dir, camera.up);
      } else {
        const orientation = getPresetOrientation(preset);
        dir = orientation.dir;
        targetUp =
          cameraControlMode === 'orbit'
            ? new THREE.Vector3(0, 1, 0)
            : orientation.up;
      }

      const dist = computeFitDistanceForBox(
        currentBounds.box,
        dir,
        targetUp,
        camera,
        aspect,
        1.18
      );
      const nextPos = currentBounds.center.clone().addScaledVector(dir, dist);

      if (camera instanceof THREE.PerspectiveCamera) {
        camera.near = Math.max(currentBounds.radius * 0.001, 0.01);
        camera.far = Math.max(currentBounds.radius * 100, 25000);
        camera.updateProjectionMatrix();
      }

      if (immediate) {
        camera.position.copy(nextPos);
        camera.up.copy(orthogonalizeUp(dir, targetUp));
        camera.zoom = 1;
        camera.updateProjectionMatrix();
        if (controlsRef.current) {
          controlsRef.current.target.copy(currentBounds.center);
          flushControlsInertia(controlsRef.current);
        }
        targetRef.current.copy(currentBounds.center);
        camera.lookAt(currentBounds.center);
        animRef.current = null;
      } else {
        startAnimation(nextPos, currentBounds.center, targetUp, 1, PRESET_ANIMATION_MS);
      }
    },
    [camera, cameraControlMode, startAnimation]
  );

  // Initial framing on model load
  React.useEffect(() => {
    if (bounds && initializedModelRef.current !== modelUrl) {
      initializedModelRef.current = modelUrl;
      applyPreset('iso', true);
    }
  }, [bounds, modelUrl, applyPreset]);

  // Preset view buttons (Front/Back/Top/Bottom/Left/Right/Iso/Fit)
  React.useEffect(() => {
    if (cameraCommand && boundsRef.current && !isFollowingRef.current) {
      applyPreset(cameraCommand.preset, false);
    }
  }, [cameraCommand, applyPreset]);

  // Roll ±15° command (Q/E or toolbar roll buttons)
  React.useEffect(() => {
    if (!cameraRollCommand || isFollowingRef.current) return;
    const controls = controlsRef.current;
    const target = controls ? controls.target.clone() : targetRef.current.clone();

    // If an animation is already running, stack the roll onto its destination up vector
    const basePos = animRef.current ? animRef.current.endPos.clone() : camera.position.clone();
    const baseTarget = animRef.current ? animRef.current.endTarget.clone() : target;
    const baseUp = animRef.current ? animRef.current.endUp.clone() : camera.up.clone();
    const baseZoom = animRef.current ? animRef.current.endZoom : camera.zoom;

    const viewAxis = basePos.clone().sub(baseTarget);
    if (viewAxis.lengthSq() < 1e-8) return;
    viewAxis.normalize();

    const rollRad = THREE.MathUtils.degToRad(cameraRollCommand.deltaDeg);
    const nextUp = baseUp
      .clone()
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(viewAxis, rollRad))
      .normalize();

    startAnimation(basePos, baseTarget, nextUp, baseZoom, ROLL_ANIMATION_MS);
  }, [cameraRollCommand, camera, startAnimation]);

  // Normal to Selection (P1 #5): align perpendicular to last raycast face or selected part box
  React.useEffect(() => {
    if (!normalToSelectionCommand || isFollowingRef.current) return;
    const state = useViewerStore.getState();
    const partId = state.selectedPartIdForNormal;
    const faceHit = state.lastSelectedFace;
    if (!partId && !faceHit) return;

    const partBox = partId
      ? computePartBoundingBox(modelRootRef.current, partId, state.partTree)
      : null;
    const targetBox = partBox ?? boundsRef.current?.box;
    if (!targetBox || targetBox.isEmpty()) return;

    const boxCenter = new THREE.Vector3();
    const boxSize = new THREE.Vector3();
    targetBox.getCenter(boxCenter);
    targetBox.getSize(boxSize);

    let viewDir: THREE.Vector3;

    if (faceHit && (!partId || faceHit.partId === partId)) {
      viewDir = new THREE.Vector3(faceHit.normal[0], faceHit.normal[1], faceHit.normal[2]);
      if (viewDir.lengthSq() < 1e-6) {
        viewDir.set(0, 0, 1);
      } else {
        viewDir.normalize();
      }
    } else {
      // No raycast face: align normal to the selected part's primary planar face (thinnest axis)
      // oriented toward the side currently facing the camera
      const toCam = camera.position.clone().sub(boxCenter);
      const dims = [
        { axis: new THREE.Vector3(1, 0, 0), span: boxSize.x },
        { axis: new THREE.Vector3(0, 1, 0), span: boxSize.y },
        { axis: new THREE.Vector3(0, 0, 1), span: boxSize.z },
      ].sort((a, b) => a.span - b.span);

      const minSpan = dims[0].span;
      const maxSpan = Math.max(dims[2].span, 1e-4);

      if (minSpan / maxSpan < 0.75) {
        viewDir = dims[0].axis.clone();
      } else {
        // Nearly cubic part: snap to nearest cardinal face facing the current camera
        const absX = Math.abs(toCam.x);
        const absY = Math.abs(toCam.y);
        const absZ = Math.abs(toCam.z);
        if (absX >= absY && absX >= absZ) {
          viewDir = new THREE.Vector3(1, 0, 0);
        } else if (absY >= absX && absY >= absZ) {
          viewDir = new THREE.Vector3(0, 1, 0);
        } else {
          viewDir = new THREE.Vector3(0, 0, 1);
        }
      }

      if (viewDir.dot(toCam) < 0) {
        viewDir.negate();
      }
    }

    const preferredUp =
      cameraControlMode === 'orbit'
        ? new THREE.Vector3(0, 1, 0)
        : orthogonalizeUp(viewDir, camera.up);
    const aspect = sizeRef.current.width / Math.max(sizeRef.current.height, 1);
    const dist = computeFitDistanceForBox(targetBox, viewDir, preferredUp, camera, aspect, 1.35);
    const endPos = boxCenter.clone().addScaledVector(viewDir, dist);

    startAnimation(endPos, boxCenter, preferredUp, 1, PRESET_ANIMATION_MS);
  }, [normalToSelectionCommand, camera, cameraControlMode, modelRootRef, startAnimation]);

  // Double-click part zoom-to-fit (P2 #10)
  React.useEffect(() => {
    if (!zoomToPartCommand || isFollowingRef.current) return;
    const state = useViewerStore.getState();
    const partBox = computePartBoundingBox(
      modelRootRef.current,
      zoomToPartCommand.partId,
      state.partTree
    );
    if (!partBox) return;

    const boxCenter = new THREE.Vector3();
    partBox.getCenter(boxCenter);

    const curTarget = controlsRef.current?.target ?? targetRef.current;
    const viewDir = camera.position.clone().sub(curTarget);
    if (viewDir.lengthSq() < 1e-6) {
      viewDir.set(1, 0.78, 1);
    }
    viewDir.normalize();

    const upVec =
      cameraControlMode === 'orbit'
        ? new THREE.Vector3(0, 1, 0)
        : orthogonalizeUp(viewDir, camera.up);
    const aspect = sizeRef.current.width / Math.max(sizeRef.current.height, 1);
    const dist = computeFitDistanceForBox(partBox, viewDir, upVec, camera, aspect, 1.35);
    const endPos = boxCenter.clone().addScaledVector(viewDir, dist);

    startAnimation(endPos, boxCenter, upVec, 1, PRESET_ANIMATION_MS);
  }, [zoomToPartCommand, camera, cameraControlMode, modelRootRef, startAnimation]);

  // Annotation / comment camera pose fly-to
  React.useEffect(() => {
    if (!cameraPoseCommand || isFollowingRef.current) return;
    const { pose } = cameraPoseCommand;
    const endPos = new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]);
    const endTarget = new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]);
    const dir = endPos.clone().sub(endTarget);
    const endUp =
      dir.lengthSq() > 1e-6
        ? orthogonalizeUp(dir, new THREE.Vector3(0, 1, 0))
        : new THREE.Vector3(0, 1, 0);
    startAnimation(endPos, endTarget, endUp, pose.zoom, 500);
  }, [cameraPoseCommand, startAnimation]);

  // Per-frame update: follow mode -> scripted easing animation -> Trackball/Orbit controls -> realtime broadcast
  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Follow mode (Session 5): lerp to leader's pose & suppress local control updates/emit
    if (usePresenceStore.getState().activeUserId !== null) {
      const remotePose = useCursorStore.getState().remoteCameraPose;
      if (remotePose) {
        animRef.current = null;
        _tmpFollowPos.set(
          remotePose.position[0],
          remotePose.position[1],
          remotePose.position[2]
        );
        _tmpFollowTarget.set(
          remotePose.target[0],
          remotePose.target[1],
          remotePose.target[2]
        );
        camera.position.lerp(_tmpFollowPos, 0.15);
        controls.target.lerp(_tmpFollowTarget, 0.15);
        const nextZoom =
          Number.isFinite(remotePose.zoom) && remotePose.zoom > 0
            ? remotePose.zoom
            : 1;
        camera.zoom = THREE.MathUtils.lerp(camera.zoom, nextZoom, 0.15);
        camera.updateProjectionMatrix();
        camera.lookAt(controls.target);
      }
      return;
    }

    const anim = animRef.current;
    if (anim) {
      anim.elapsedMs += Math.min(delta, 0.05) * 1000;
      const rawT = Math.min(1, anim.elapsedMs / anim.durationMs);
      // Ease-out cubic for crisp CAD view transitions
      const easedT = 1 - Math.pow(1 - rawT, 3);

      camera.position.lerpVectors(anim.startPos, anim.endPos, easedT);
      controls.target.lerpVectors(anim.startTarget, anim.endTarget, easedT);

      // Smoothly interpolate camera.up while keeping it orthogonal to the view ray
      _tmpUp.lerpVectors(anim.startUp, anim.endUp, easedT);
      _tmpEye.copy(camera.position).sub(controls.target);
      if (_tmpEye.lengthSq() > 1e-8) {
        _tmpEye.normalize();
        _tmpUp.addScaledVector(_tmpEye, -_tmpUp.dot(_tmpEye));
        if (_tmpUp.lengthSq() > 1e-6) {
          camera.up.copy(_tmpUp.normalize());
        }
      }

      camera.zoom = THREE.MathUtils.lerp(anim.startZoom, anim.endZoom, easedT);
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);

      if (rawT >= 1) {
        camera.position.copy(anim.endPos);
        controls.target.copy(anim.endTarget);
        camera.up.copy(anim.endUp);
        camera.zoom = anim.endZoom;
        camera.updateProjectionMatrix();
        camera.lookAt(controls.target);
        animRef.current = null;
        flushControlsInertia(controls);
      }
    } else {
      controls.update();
    }

    targetRef.current.copy(controls.target);

    // Broadcast camera pose at <= 15 Hz when not following
    emitRealtimeCameraSync({
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      zoom: camera.zoom,
    });
  });

  return null;
}
