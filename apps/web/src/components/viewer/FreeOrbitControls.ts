import * as THREE from 'three';

/**
 * Free CAD camera (SOLIDWORKS / Fusion / Onshape style), replacing TrackballControls.
 *
 * - `pivot` is the orbit centre. A left-drag that starts on the model moves the
 *   pivot to the surface point under the cursor; it stays there until
 *   `resetPivot()` (Fit / presets / view cube). Missing the model keeps the
 *   previous pivot.
 * - `target` is the focus point on the camera's view axis. It exists for code
 *   that expects OrbitControls-like controls (presets, annotation camera
 *   poses, realtime camera sync, drei GizmoHelper). It always lies on the view
 *   axis and moves rigidly with the camera; orbiting never re-centres on it.
 * - Rotation is a quaternion virtual trackball (Bell): no up-vector
 *   constraint, so rolls persist and there is no gimbal lock. Dragging near
 *   the viewport edge rolls around the view axis.
 * - Wheel zooms toward the surface point under the cursor (or the cursor ray's
 *   hit on the plane through the pivot), without moving the pivot.
 * - Middle-drag or Shift+left-drag pans in the screen plane; the pivot pans
 *   with the camera so it stays at the same screen position.
 * - Right-drag dollies. Nothing ever auto-refits or snaps back.
 */
export type FreeOrbitPicker = (clientX: number, clientY: number) => THREE.Vector3 | null;

type DragMode = 'none' | 'pending-rotate' | 'rotate' | 'pan' | 'dolly';

interface FreeOrbitEvents {
  start: object;
  change: object;
  end: object;
}

const DRAG_THRESHOLD_PX = 3;

const _q = new THREE.Quaternion();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _plane = new THREE.Plane();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

export class FreeOrbitControls extends THREE.EventDispatcher<FreeOrbitEvents> {
  enabled = true;
  readonly target = new THREE.Vector3();
  readonly pivot = new THREE.Vector3();
  minDistance = 0.2;
  maxDistance = 5000;
  rotateSpeed = 1.6;
  /** Surface point under the cursor for pivot-on-drag; null when the model is missed. */
  pickPivot: FreeOrbitPicker = () => null;
  /** Surface point under the cursor for zoom-to-cursor; null falls back to the pivot plane. */
  pickZoomAnchor: FreeOrbitPicker = () => null;

  private mode: DragMode = 'none';
  private pointerId: number | null = null;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    private readonly domElement: HTMLElement
  ) {
    super();
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this.onContextMenu);
    domElement.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.domElement.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  /** Static controller: no inertia, nothing to integrate per frame. */
  update(): void {}

  resetPivot(point: THREE.Vector3): void {
    this.pivot.copy(point);
    this.dispatchEvent({ type: 'change' });
  }

  /** Re-derives camera.up from the orientation (call after external lookAt/up edits). */
  private syncUp(): void {
    this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.camera.updateMatrixWorld();
  }

  private basis(): void {
    _fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
  }

  /** Depth of a point along the view axis, never below minDistance. */
  private depthOf(point: THREE.Vector3): number {
    this.basis();
    return Math.max(_delta.copy(point).sub(this.camera.position).dot(_fwd), this.minDistance);
  }

  /** Keeps `target` on the view axis at a sane depth (after zoom/dolly). */
  private keepTargetInFront(): void {
    this.basis();
    const depth = _delta.copy(this.target).sub(this.camera.position).dot(_fwd);
    if (depth < this.minDistance) {
      const pivotDepth = this.depthOf(this.pivot);
      this.target.copy(this.camera.position).addScaledVector(_fwd, pivotDepth);
    }
  }

  // --- rotation: Bell virtual trackball in camera space ------------------------
  private projectToTrackball(clientX: number, clientY: number, out: THREE.Vector3): THREE.Vector3 {
    const rect = this.domElement.getBoundingClientRect();
    const radius = Math.max(Math.min(rect.width, rect.height) * 0.5, 1);
    const x = (clientX - (rect.left + rect.width / 2)) / radius;
    const y = -(clientY - (rect.top + rect.height / 2)) / radius;
    const d2 = x * x + y * y;
    // Sphere inside, hyperbolic sheet outside: dragging near the edge becomes roll.
    const z = d2 < 0.5 ? Math.sqrt(1 - d2) : 0.5 / Math.sqrt(d2);
    return out.set(x, y, z).normalize();
  }

  private rotate(fromX: number, fromY: number, toX: number, toY: number): void {
    this.projectToTrackball(fromX, fromY, _v0);
    this.projectToTrackball(toX, toY, _v1);
    _axis.crossVectors(_v0, _v1);
    const sin = _axis.length();
    if (sin < 1e-7) return;
    const angle = Math.atan2(sin, _v0.dot(_v1)) * this.rotateSpeed;
    // The model should follow the cursor, so the camera rig turns the opposite way.
    _axis.divideScalar(sin).applyQuaternion(this.camera.quaternion);
    _q.setFromAxisAngle(_axis, -angle);
    this.rotateRigAroundPivot(_q);
  }

  /** Rigidly rotates camera + target around the pivot (full 3-DOF, no up constraint). */
  rotateRigAroundPivot(q: THREE.Quaternion): void {
    const cam = this.camera;
    cam.position.sub(this.pivot).applyQuaternion(q).add(this.pivot);
    this.target.sub(this.pivot).applyQuaternion(q).add(this.pivot);
    cam.quaternion.premultiply(q).normalize();
    this.syncUp();
    this.dispatchEvent({ type: 'change' });
  }

  // --- pan --------------------------------------------------------------------
  private worldPerPixel(depth: number): number {
    const rect = this.domElement.getBoundingClientRect();
    const h = Math.max(rect.height, 1);
    const cam = this.camera;
    if (cam instanceof THREE.OrthographicCamera) {
      return (cam.top - cam.bottom) / (h * Math.max(cam.zoom, 1e-4));
    }
    const fov = THREE.MathUtils.degToRad(cam.fov);
    return (2 * depth * Math.tan(fov / 2)) / (h * Math.max(cam.zoom, 1e-4));
  }

  private pan(dx: number, dy: number): void {
    // Scale by the pivot's depth so the pivot tracks the cursor 1:1.
    const wpp = this.worldPerPixel(this.depthOf(this.pivot));
    this.basis();
    _delta.set(0, 0, 0).addScaledVector(_right, -dx * wpp).addScaledVector(_up, dy * wpp);
    this.camera.position.add(_delta);
    this.target.add(_delta);
    this.pivot.add(_delta);
    this.camera.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  // --- zoom / dolly -----------------------------------------------------------
  /** Moves the camera (and target) toward `anchor` by `factor` (<1 = closer), clamped. */
  private scaleToward(anchor: THREE.Vector3, factor: number): void {
    const dist = this.camera.position.distanceTo(anchor);
    if (dist < 1e-9) return;
    const nextDist = THREE.MathUtils.clamp(dist * factor, this.minDistance, this.maxDistance);
    const f = nextDist / dist;
    this.camera.position.sub(anchor).multiplyScalar(f).add(anchor);
    this.target.sub(anchor).multiplyScalar(f).add(anchor);
    this.keepTargetInFront();
    this.camera.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  private zoomAnchorAt(clientX: number, clientY: number, out: THREE.Vector3): THREE.Vector3 {
    const hit = this.pickZoomAnchor(clientX, clientY);
    if (hit) return out.copy(hit);
    // Missed the model: use the cursor ray's hit on the plane through the pivot.
    const rect = this.domElement.getBoundingClientRect();
    _ndc.set(
      ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1
    );
    _ray.setFromCamera(_ndc, this.camera);
    this.basis();
    _plane.setFromNormalAndCoplanarPoint(_fwd, this.pivot);
    if (_ray.ray.intersectPlane(_plane, out) && out.clone().sub(this.camera.position).dot(_fwd) > 0) {
      return out;
    }
    return out.copy(this.camera.position).addScaledVector(_fwd, this.depthOf(this.pivot));
  }

  // --- DOM handlers -------------------------------------------------------------
  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.mode !== 'none') return;
    if (event.button === 0 && !event.shiftKey) this.mode = 'pending-rotate';
    else if (event.button === 1 || (event.button === 0 && event.shiftKey)) this.mode = 'pan';
    else if (event.button === 2) this.mode = 'dolly';
    else return;

    // Do not stop propagation: R3F click handlers (selection, measure, annotate)
    // still see the pointerdown and ignore it themselves when it becomes a drag.
    this.pointerId = event.pointerId;
    this.downX = this.lastX = event.clientX;
    this.downY = this.lastY = event.clientY;
    if (this.mode !== 'pending-rotate') {
      event.preventDefault();
      this.dispatchEvent({ type: 'start' });
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.mode === 'none' || event.pointerId !== this.pointerId) return;
    if (!this.enabled) {
      this.endDrag();
      return;
    }

    if (this.mode === 'pending-rotate') {
      if (Math.hypot(event.clientX - this.downX, event.clientY - this.downY) < DRAG_THRESHOLD_PX) {
        return;
      }
      // Drag confirmed: pivot on the surface point where the press started.
      const hit = this.pickPivot(this.downX, this.downY);
      if (hit) this.pivot.copy(hit);
      this.mode = 'rotate';
      this.dispatchEvent({ type: 'start' });
    }

    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    if (this.mode === 'rotate') {
      this.rotate(this.lastX, this.lastY, event.clientX, event.clientY);
    } else if (this.mode === 'pan') {
      this.pan(dx, dy);
    } else if (this.mode === 'dolly') {
      this.basis();
      _anchor.copy(this.camera.position).addScaledVector(_fwd, this.depthOf(this.pivot));
      this.scaleToward(_anchor, Math.exp(dy * 0.005));
    }
    this.lastX = event.clientX;
    this.lastY = event.clientY;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.mode === 'none' || event.pointerId !== this.pointerId) return;
    this.endDrag();
  };

  private endDrag(): void {
    const wasActive = this.mode !== 'pending-rotate' && this.mode !== 'none';
    this.mode = 'none';
    this.pointerId = null;
    if (wasActive) this.dispatchEvent({ type: 'end' });
  }

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    const rect = this.domElement.getBoundingClientRect();
    let raw = event.deltaY;
    if (event.deltaMode === 1) raw *= 24;
    else if (event.deltaMode === 2) raw *= rect.height;
    const normalized = THREE.MathUtils.clamp(raw / 100, -3, 3);
    if (Math.abs(normalized) < 1e-5) return;
    // Ctrl+wheel (and trackpad pinch) = fine zoom.
    const factor = Math.exp(normalized * (event.ctrlKey ? 0.015 : 0.14));
    this.dispatchEvent({ type: 'start' });
    this.scaleToward(this.zoomAnchorAt(event.clientX, event.clientY, _anchor), factor);
    this.dispatchEvent({ type: 'end' });
  };

  private onContextMenu = (event: MouseEvent): void => {
    if (this.enabled) event.preventDefault();
  };

  private onMouseDown = (event: MouseEvent): void => {
    // Middle button would otherwise start the browser's autoscroll.
    if (event.button === 1) event.preventDefault();
  };
}
