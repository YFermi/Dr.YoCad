import * as React from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { HelpCircle, Home } from 'lucide-react';
import { useViewerStore } from '@/stores/viewerStore';
import { getViewerCamera } from './viewerCameraBridge';

/**
 * SOLIDWORKS-style view orientation cube (3D viewer only).
 *
 * The cube is a chamfered box made of 26 clickable regions:
 *   6 faces   -> look straight at the face (Front = from +Z toward -Z, Y up, as the toolbar)
 *  12 edges   -> strips on both adjacent faces (10% of the face width) -> 45° view
 *   8 corners -> triangular facets where the corner is cut off -> isometric view
 * Picking a region reorients the camera, resets the orbit pivot and fits the
 * model (the toolbar preset path). Right-clicking a face opens "View normal
 * to face / View from opposite direction / Section at this face".
 *
 * SmallViewCube: 110 px, top-right, always visible, mirrors the main camera.
 * LargeViewCube: SPACE, 520 px, centred over a 40% dim, with an X-ray clone
 * of the model inside (the main scene is not touched). Drag orbits the large
 * cube's own camera; picking a region animates it there, then the main camera
 * follows and the large cube closes. ESC or a click outside closes it with
 * the main view unchanged.
 */

type Sign = -1 | 0 | 1;
type Coord = [Sign, Sign, Sign];
type RegionKind = 'face' | 'edge' | 'corner';
interface Region {
  key: string;
  label: string;
  coord: Coord;
  kind: RegionKind;
}

const FACE_NAMES: Record<string, string> = {
  '0,0,1': 'Front',
  '0,0,-1': 'Back',
  '1,0,0': 'Right',
  '-1,0,0': 'Left',
  '0,1,0': 'Top',
  '0,-1,0': 'Bottom',
};

function regionLabel([x, y, z]: Coord): string {
  // Order like SOLIDWORKS tooltips: Top/Bottom, then Front/Back, then Left/Right.
  const parts: string[] = [];
  if (y) parts.push(y > 0 ? 'Top' : 'Bottom');
  if (z) parts.push(z > 0 ? 'Front' : 'Back');
  if (x) parts.push(x > 0 ? 'Right' : 'Left');
  return parts.join('-');
}

const REGIONS: Region[] = [];
for (const x of [-1, 0, 1] as Sign[]) {
  for (const y of [-1, 0, 1] as Sign[]) {
    for (const z of [-1, 0, 1] as Sign[]) {
      const nonZero = Math.abs(x) + Math.abs(y) + Math.abs(z);
      if (!nonZero) continue;
      const label = regionLabel([x, y, z]);
      REGIONS.push({
        key: label.toLowerCase(),
        label,
        coord: [x, y, z],
        kind: nonZero === 1 ? 'face' : nonZero === 2 ? 'edge' : 'corner',
      });
    }
  }
}

// --- geometry (cube half-size 1) -------------------------------------------------
const BAND = 0.2; // edge strip width = 10% of the face width (2)
const INNER = 1 - BAND; // half-size of a face's centre square
const CHAMFER = 1 - 2 * BAND; // where a corner's triangle meets the edges

function vec(entries: Array<[number, number]>): THREE.Vector3 {
  const v = [0, 0, 0];
  for (const [axis, value] of entries) v[axis] = value;
  return new THREE.Vector3(v[0], v[1], v[2]);
}

/** Flat polygons (outward-facing) that make up a region's surface. */
function regionPolygons(coord: Coord): THREE.Vector3[][] {
  const axes = [0, 1, 2].filter((a) => coord[a] !== 0);
  if (axes.length === 1) {
    const [a] = axes;
    const [b, c] = [0, 1, 2].filter((i) => i !== a);
    const s = coord[a];
    return [
      [
        vec([[a, s], [b, -INNER], [c, -INNER]]),
        vec([[a, s], [b, INNER], [c, -INNER]]),
        vec([[a, s], [b, INNER], [c, INNER]]),
        vec([[a, s], [b, -INNER], [c, INNER]]),
      ],
    ];
  }
  if (axes.length === 2) {
    const [i, j] = axes;
    const k = [0, 1, 2].find((n) => n !== i && n !== j)!;
    // Trapezoid on the face `fixed`, running along k, cut diagonally at both
    // ends where it meets the corner triangles.
    const strip = (fixed: number, other: number) => {
      const fs = coord[fixed];
      const os = coord[other];
      return [
        vec([[fixed, fs], [k, -INNER], [other, os * INNER]]),
        vec([[fixed, fs], [k, INNER], [other, os * INNER]]),
        vec([[fixed, fs], [k, CHAMFER], [other, os]]),
        vec([[fixed, fs], [k, -CHAMFER], [other, os]]),
      ];
    };
    return [strip(i, j), strip(j, i)];
  }
  const [sx, sy, sz] = coord;
  return [
    [
      new THREE.Vector3(sx * CHAMFER, sy, sz),
      new THREE.Vector3(sx, sy * CHAMFER, sz),
      new THREE.Vector3(sx, sy, sz * CHAMFER),
    ],
  ];
}

function buildRegionGeometry(coord: Coord): { surface: THREE.BufferGeometry; outline: THREE.BufferGeometry; centroid: THREE.Vector3 } {
  const positions: number[] = [];
  const normals: number[] = [];
  const lines: number[] = [];
  const centroid = new THREE.Vector3();
  let count = 0;
  for (const poly of regionPolygons(coord)) {
    const c = poly.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(poly.length);
    centroid.add(c);
    count += 1;
    const n = new THREE.Vector3().subVectors(poly[1], poly[0]).cross(new THREE.Vector3().subVectors(poly[2], poly[0])).normalize();
    const outward = n.dot(c) < 0;
    if (outward) n.negate();
    for (let t = 1; t < poly.length - 1; t++) {
      const tri = outward ? [poly[0], poly[t + 1], poly[t]] : [poly[0], poly[t], poly[t + 1]];
      for (const p of tri) {
        positions.push(p.x, p.y, p.z);
        normals.push(n.x, n.y, n.z);
      }
    }
    poly.forEach((p, idx) => {
      const q = poly[(idx + 1) % poly.length];
      lines.push(p.x, p.y, p.z, q.x, q.y, q.z);
    });
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  surface.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const outline = new THREE.BufferGeometry();
  outline.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  return { surface, outline, centroid: centroid.divideScalar(count) };
}

const REGION_GEOMETRY = new Map(REGIONS.map((r) => [r.key, buildRegionGeometry(r.coord)]));

/** Label plane orientation per face, upright in the matching preset view. */
const FACE_LABEL_ROTATION: Record<string, [number, number, number]> = {
  '0,0,1': [0, 0, 0],
  '0,0,-1': [0, Math.PI, 0],
  '1,0,0': [0, Math.PI / 2, 0],
  '-1,0,0': [0, -Math.PI / 2, 0],
  '0,1,0': [-Math.PI / 2, 0, 0],
  '0,-1,0': [Math.PI / 2, 0, 0],
};

function viewForRegion([x, y, z]: Coord): { dir: [number, number, number]; up: [number, number, number] } {
  const length = Math.hypot(x, y, z);
  const dir: [number, number, number] = [x / length, y / length, z / length];
  // Same ups as the toolbar presets: Top has -Z up, Bottom +Z up, the rest Y up
  // (CameraController orthogonalizes Y against edge/corner directions).
  if (!x && !z) return { dir, up: y > 0 ? [0, 0, -1] : [0, 0, 1] };
  return { dir, up: [0, 1, 0] };
}

function makeTextTexture(text: string, color: string, font: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 132);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// --- label visibility setting (help popover) --------------------------------------
const LABELS_KEY = 'cadline.viewCubeLabels';
const labelListeners = new Set<() => void>();
function readShowLabels(): boolean {
  try {
    return window.localStorage.getItem(LABELS_KEY) !== 'hidden';
  } catch {
    return true;
  }
}
function setShowLabels(show: boolean): void {
  try {
    window.localStorage.setItem(LABELS_KEY, show ? 'visible' : 'hidden');
  } catch {
    // ignore storage errors
  }
  labelListeners.forEach((l) => l());
}
function useShowLabels(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      labelListeners.add(cb);
      return () => labelListeners.delete(cb);
    },
    readShowLabels,
    () => true
  );
}

// --- regions ------------------------------------------------------------------------
type CubeTheme = 'solid' | 'xray';

const THEMES: Record<
  CubeTheme,
  {
    face: string;
    faceNearest: string;
    edge: string;
    corner: string;
    hover: string;
    opacity: Record<RegionKind | 'hover', number>;
    outline: string;
    outlineOpacity: number;
    label: string;
  }
> = {
  solid: {
    face: '#e5e7eb',
    faceNearest: '#dbeafe',
    edge: '#cbd5e1',
    corner: '#b6c2d2',
    hover: '#60a5fa',
    opacity: { face: 1, edge: 1, corner: 1, hover: 1 },
    outline: '#64748b',
    outlineOpacity: 0.9,
    label: '#1f2937',
  },
  xray: {
    face: '#94a3b8',
    faceNearest: '#bfdbfe',
    edge: '#cbd5e1',
    corner: '#e2e8f0',
    hover: '#60a5fa',
    opacity: { face: 0.1, edge: 0.24, corner: 0.34, hover: 0.42 },
    outline: '#cbd5e1',
    outlineOpacity: 0.55,
    label: '#f8fafc',
  },
};

interface FaceMenuRequest {
  region: Region;
  x: number;
  y: number;
}

const _back = new THREE.Vector3();
const _n = new THREE.Vector3();

function CubeRegions({
  theme,
  hovered,
  setHovered,
  onPick,
  onFaceMenu,
  testHookName,
}: {
  theme: CubeTheme;
  hovered: string | null;
  setHovered: React.Dispatch<React.SetStateAction<string | null>>;
  onPick: (region: Region) => void;
  onFaceMenu: (request: FaceMenuRequest) => void;
  testHookName?: 'viewCubePoint' | 'viewCubeLargePoint';
}) {
  const { camera, gl } = useThree();
  const t = THEMES[theme];
  const showLabels = useShowLabels();
  const [nearestFace, setNearestFace] = React.useState<string | null>(null);
  const [facing, setFacing] = React.useState('');
  const facingRef = React.useRef('');
  const nearestRef = React.useRef<string | null>(null);
  const noRaycast = React.useCallback(() => null, []);

  const labelTextures = React.useMemo(() => {
    const map = new Map<string, THREE.Texture>();
    for (const [coord, name] of Object.entries(FACE_NAMES)) {
      map.set(coord, makeTextTexture(name, t.label, '600 54px "DM Sans", system-ui, sans-serif'));
    }
    return map;
  }, [t.label]);
  React.useEffect(() => () => labelTextures.forEach((tex) => tex.dispose()), [labelTextures]);

  // Tint the face nearest the viewer (the one the camera is looking at most).
  useFrame(() => {
    _back.set(0, 0, 1).applyQuaternion(camera.quaternion);
    let best: string | null = null;
    let bestDot = -Infinity;
    for (const coord of Object.keys(FACE_NAMES)) {
      const [x, y, z] = coord.split(',').map(Number);
      const d = _n.set(x, y, z).dot(_back);
      if (d > bestDot) {
        bestDot = d;
        best = coord;
      }
    }
    if (best !== nearestRef.current) {
      nearestRef.current = best;
      setNearestFace(best);
    }
    if (theme === 'xray') {
      // Regions on the far side of the see-through cube: outline only, faded.
      let signature = '';
      for (const region of REGIONS) {
        signature += REGION_GEOMETRY.get(region.key)!.centroid.dot(_back) > 0 ? '1' : '0';
      }
      if (signature !== facingRef.current) {
        facingRef.current = signature;
        setFacing(signature);
      }
    }
  });

  // Dev-only e2e hook: client coordinates of a region's visible centre (null if facing away).
  React.useEffect(() => {
    if (!testHookName || !import.meta.env.DEV) return;
    const hook = (key: string) => {
      const region = REGIONS.find((r) => r.key === key);
      const geo = region && REGION_GEOMETRY.get(region.key);
      if (!region || !geo) return null;
      const facingDot = geo.centroid.clone().normalize().dot(new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion));
      if (facingDot < 0.1) return null;
      const p = geo.centroid.clone().project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    };
    if (window.__viewer) window.__viewer[testHookName] = hook;
    return () => {
      if (window.__viewer?.[testHookName] === hook) delete window.__viewer[testHookName];
    };
  }, [testHookName, camera, gl]);

  return (
    <>
      {REGIONS.map((region) => {
        const geo = REGION_GEOMETRY.get(region.key)!;
        const coordKey = region.coord.join(',');
        const isHovered = hovered === region.key;
        const color = isHovered
          ? t.hover
          : region.kind === 'face'
            ? coordKey === nearestFace
              ? t.faceNearest
              : t.face
            : region.kind === 'edge'
              ? t.edge
              : t.corner;
        const opacity = isHovered ? t.opacity.hover : t.opacity[region.kind];
        const transparent = opacity < 1;
        return (
          <group key={region.key}>
            <mesh
              geometry={geo.surface}
              userData={{ region: region.key }}
              onPointerOver={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                setHovered(region.key);
              }}
              onPointerOut={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                setHovered((current) => (current === region.key ? null : current));
              }}
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                if (e.delta > 4) return; // end of a drag, not a click
                onPick(region);
              }}
              onContextMenu={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                e.nativeEvent.preventDefault();
                if (region.kind === 'face') onFaceMenu({ region, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
              }}
            >
              {theme === 'solid' ? (
                <meshLambertMaterial color={color} side={THREE.DoubleSide} />
              ) : (
                // Front side only: the far half of the see-through cube is not filled
                // (and not hit-testable), so each strip/corner reads once.
                <meshBasicMaterial
                  color={color}
                  transparent={transparent}
                  opacity={opacity}
                  depthWrite={false}
                  side={THREE.FrontSide}
                />
              )}
            </mesh>
            <lineSegments geometry={geo.outline} raycast={noRaycast} scale={1.002}>
              <lineBasicMaterial
                color={t.outline}
                transparent
                opacity={theme === 'xray' && facing[REGIONS.indexOf(region)] === '0' ? 0.12 : t.outlineOpacity}
              />
            </lineSegments>
            {region.kind === 'face' && showLabels && (
              // Subtle by default; brighter and slightly larger when the face is hovered.
              <mesh
                raycast={noRaycast}
                position={region.coord.map((c) => c * 1.004) as unknown as THREE.Vector3}
                rotation={FACE_LABEL_ROTATION[coordKey]}
                scale={isHovered ? 1.12 : 1}
                renderOrder={2}
              >
                <planeGeometry args={[2 * INNER, 2 * INNER]} />
                <meshBasicMaterial
                  map={labelTextures.get(coordKey)}
                  transparent
                  opacity={isHovered ? 1 : theme === 'solid' ? 0.6 : 0.45}
                  depthWrite={false}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </>
  );
}

/** Small cube: mirror the main camera's orientation every frame. */
function MirrorMainCamera() {
  const { camera } = useThree();
  useFrame(() => {
    const main = getViewerCamera()?.camera;
    if (!main) return;
    camera.quaternion.copy(main.quaternion);
    camera.position.set(0, 0, 10).applyQuaternion(main.quaternion);
    camera.updateMatrixWorld();
  });
  return null;
}

// --- actions shared by both cubes -------------------------------------------------
function applyRegionView(region: Region): void {
  const { dir, up } = viewForRegion(region.coord);
  useViewerStore.getState().requestCameraView(dir, up);
}

type FaceAction = 'normal' | 'opposite' | 'section';

/** View for a face-menu action ("Section at this face" views the cut from the side the section tool removes). */
function faceActionView(region: Region, action: FaceAction): Region {
  if (action === 'opposite') {
    const coord = region.coord.map((c) => -c) as Coord;
    return { ...region, coord, key: regionLabel(coord).toLowerCase(), label: regionLabel(coord) };
  }
  if (action === 'section') {
    const coord = region.coord.map((c) => Math.abs(c)) as Coord;
    return { ...region, coord };
  }
  return region;
}

function applySection(region: Region): void {
  const axisIndex = region.coord.findIndex((c) => c !== 0);
  useViewerStore.getState().setSectionPlane({
    enabled: true,
    axis: (['x', 'y', 'z'] as const)[axisIndex],
    offset: 0,
  });
}

function FaceContextMenu({
  request,
  onAction,
  onClose,
}: {
  request: FaceMenuRequest;
  onAction: (action: FaceAction) => void;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
    };
  }, [onClose]);

  const item = (action: FaceAction | 'cancel', text: string) => (
    <button
      type="button"
      role="menuitem"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => (action === 'cancel' ? onClose() : onAction(action))}
      className="block w-full rounded px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-slate-700/70"
    >
      {text}
    </button>
  );
  return (
    <div
      role="menu"
      aria-label={`${request.region.label} face`}
      data-testid="view-cube-face-menu"
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-[60] w-52 rounded-md border border-slate-700 bg-slate-900/95 p-1 shadow-xl"
      style={{ left: request.x, top: request.y }}
    >
      <p className="px-2.5 pb-1 pt-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-400">
        {request.region.label} face
      </p>
      {item('normal', 'View normal to face')}
      {item('opposite', 'View from opposite direction')}
      {item('section', 'Section at this face')}
      <div className="my-1 h-px bg-slate-700" />
      {item('cancel', 'Cancel')}
    </div>
  );
}

function HoverTooltip({ hovered }: { hovered: string | null }) {
  const region = REGIONS.find((r) => r.key === hovered);
  if (!region) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900/90 px-2 py-0.5 text-[11px] font-medium text-slate-100 shadow">
      {region.kind === 'face' ? `${region.label} view` : region.label}
    </div>
  );
}

// --- small cube ----------------------------------------------------------------------
function SmallViewCube({ onFaceMenu }: { onFaceMenu: (r: FaceMenuRequest) => void }) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const half = 1.7;
  return (
    <div className="relative" style={{ width: 110, height: 110 }} onContextMenu={(e) => e.preventDefault()}>
      <Canvas
        orthographic
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={{ left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 40, position: [0, 0, 10] }}
        style={{ cursor: hovered ? 'pointer' : 'default' }}
        data-testid="view-cube"
      >
        <ambientLight intensity={2.1} />
        <directionalLight position={[2, 3, 4]} intensity={0.9} />
        <MirrorMainCamera />
        <CubeRegions
          theme="solid"
          hovered={hovered}
          setHovered={setHovered}
          onPick={applyRegionView}
          onFaceMenu={onFaceMenu}
          testHookName="viewCubePoint"
        />
      </Canvas>
      <HoverTooltip hovered={hovered} />
    </div>
  );
}

// --- large cube ----------------------------------------------------------------------
interface LargeCameraApi {
  animateTo: (region: Region, done: () => void) => void;
  rotateBy: (dx: number, dy: number) => void;
}

/** Large cube's own camera: starts at the main camera orientation, orbits on drag, animates on pick. */
function LargeCubeCamera({ apiRef }: { apiRef: React.MutableRefObject<LargeCameraApi | null> }) {
  const { camera } = useThree();
  const anim = React.useRef<{ from: THREE.Quaternion; to: THREE.Quaternion; t: number; done: () => void } | null>(null);

  const place = React.useCallback(
    (q: THREE.Quaternion) => {
      camera.quaternion.copy(q);
      camera.position.set(0, 0, 10).applyQuaternion(q);
      camera.updateMatrixWorld();
    },
    [camera]
  );

  React.useLayoutEffect(() => {
    const main = getViewerCamera()?.camera;
    if (main) place(main.quaternion.clone());
    apiRef.current = {
      animateTo: (region, done) => {
        const { dir, up } = viewForRegion(region.coord);
        const eye = new THREE.Vector3(...dir).multiplyScalar(10);
        const upV = new THREE.Vector3(...up);
        upV.addScaledVector(eye.clone().normalize(), -upV.dot(eye.clone().normalize())).normalize();
        const m = new THREE.Matrix4().lookAt(eye, new THREE.Vector3(), upV);
        anim.current = { from: camera.quaternion.clone(), to: new THREE.Quaternion().setFromRotationMatrix(m), t: 0, done };
      },
      rotateBy: (dx, dy) => {
        if (anim.current) return;
        const upAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        const rightAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const q = new THREE.Quaternion()
          .setFromAxisAngle(upAxis, -dx * 0.008)
          .multiply(new THREE.Quaternion().setFromAxisAngle(rightAxis, -dy * 0.008));
        place(camera.quaternion.clone().premultiply(q));
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, camera, place]);

  useFrame((_, delta) => {
    const a = anim.current;
    if (!a) return;
    a.t = Math.min(1, a.t + delta / 0.35);
    const eased = 1 - Math.pow(1 - a.t, 3);
    place(a.from.clone().slerp(a.to, eased));
    if (a.t >= 1) {
      anim.current = null;
      a.done();
    }
  });
  return null;
}

/** X-ray copy of the loaded model, scaled to sit inside the cube. Never mutates the main scene. */
function XrayModel() {
  const [group, setGroup] = React.useState<THREE.Group | null>(null);
  React.useEffect(() => {
    const source = getViewerCamera()?.getModelRoot();
    if (!source) return;
    const clone = source.clone(true);
    const owned: Array<{ dispose: () => void }> = [];
    const drop: THREE.Object3D[] = [];
    let triangles = 0;
    clone.traverse((obj) => {
      obj.raycast = () => undefined;
      if (obj.name === '__cadline_edges__') drop.push(obj);
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      const xray = new THREE.MeshStandardMaterial({
        color: src?.color?.clone() ?? new THREE.Color('#94a3b8'),
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
        side: THREE.DoubleSide,
        metalness: 0.1,
        roughness: 0.6,
      });
      mesh.material = xray;
      owned.push(xray);
      const index = mesh.geometry.getIndex();
      triangles += (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
    });
    drop.forEach((o) => o.parent?.remove(o));
    // Crisp feature edges make the surfaces readable through the panels (skipped for heavy models).
    if (triangles < 300_000) {
      const edgeMaterial = new THREE.LineBasicMaterial({ color: '#e2e8f0', transparent: true, opacity: 0.55 });
      owned.push(edgeMaterial);
      clone.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial);
        edges.raycast = () => undefined;
        owned.push(edges.geometry);
        mesh.add(edges);
      });
    }
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = 1.6 / Math.max(size.x, size.y, size.z, 1e-6);
    const wrapper = new THREE.Group();
    wrapper.add(clone);
    wrapper.scale.setScalar(scale);
    wrapper.position.copy(center).multiplyScalar(-scale);
    setGroup(wrapper);
    return () => owned.forEach((o) => o.dispose());
  }, []);
  return group ? <primitive object={group} renderOrder={1} /> : null;
}

function LargeViewCube({ onClose, onFaceMenu, cameraApiRef }: {
  onClose: () => void;
  onFaceMenu: (r: FaceMenuRequest) => void;
  cameraApiRef: React.MutableRefObject<LargeCameraApi | null>;
}) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const drag = React.useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const half = 1.75;

  const pick = React.useCallback(
    (region: Region) => {
      cameraApiRef.current?.animateTo(region, () => {
        applyRegionView(region);
        onClose();
      });
    },
    [cameraApiRef, onClose]
  );

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        // Dark panel behind the widget so the dimmed main view does not show through the cube.
        className="relative rounded-2xl bg-[#0b0e14]/90 shadow-2xl ring-1 ring-slate-700/60"
        style={{ width: 'min(520px, 78vh)', height: 'min(520px, 78vh)' }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button === 0) drag.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          cameraApiRef.current?.rotateBy(dx, dy);
          d.x = e.clientX;
          d.y = e.clientY;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
        }}
      >
        <Canvas
          orthographic
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          camera={{ left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 40, position: [0, 0, 10] }}
          style={{ cursor: hovered ? 'pointer' : 'grab' }}
          data-testid="view-cube-large"
        >
          <ambientLight intensity={1.3} />
          <directionalLight position={[3, 5, 4]} intensity={1.1} />
          <LargeCubeCamera apiRef={cameraApiRef} />
          <XrayModel />
          <CubeRegions
            theme="xray"
            hovered={hovered}
            setHovered={setHovered}
            onPick={pick}
            onFaceMenu={onFaceMenu}
            testHookName="viewCubeLargePoint"
          />
        </Canvas>
      </div>
      <p className="pointer-events-none select-none text-[11px] text-slate-300">
        {hovered
          ? REGIONS.find((r) => r.key === hovered)?.kind === 'face'
            ? `${REGIONS.find((r) => r.key === hovered)?.label} view · right-click for more`
            : REGIONS.find((r) => r.key === hovered)?.label
          : 'Drag to orbit · click a face, edge or corner · right-click a face for more · Esc to close'}
      </p>
    </div>
  );
}

// --- overlay ----------------------------------------------------------------------------
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}

const CONTROLS_HELP: Array<[string, string]> = [
  ['Left-drag', 'Orbit (pivots on the point you press; near the edge = roll)'],
  ['Middle-drag / Shift+Left', 'Pan'],
  ['Right-drag', 'Zoom (dolly)'],
  ['Wheel', 'Zoom to cursor'],
  ['Space', 'Large view cube with the model in X-ray'],
  ['Right-click cube face', 'View normal / opposite / section'],
  ['F / Home', 'Fit and re-center pivot'],
  ['Q / E', 'Roll 15°'],
];

/** Top-right view cube + home + help, the SPACE-toggled large cube, and the face menu. */
export function ViewCubeOverlay() {
  const [large, setLarge] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [faceMenu, setFaceMenu] = React.useState<(FaceMenuRequest & { source: 'small' | 'large' }) | null>(null);
  const showLabels = useShowLabels();
  const largeCameraRef = React.useRef<LargeCameraApi | null>(null);
  const fit = () => useViewerStore.getState().requestCameraPreset('fit');

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) setLarge((v) => !v);
      } else if (event.key === 'Escape') {
        setLarge(false);
        setHelpOpen(false);
      }
    };
    // Space on a focused button would also "click" it on keyup; swallow that.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isEditableTarget(event.target)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const closeLarge = React.useCallback(() => setLarge(false), []);
  const closeMenu = React.useCallback(() => setFaceMenu(null), []);

  const onFaceAction = (action: FaceAction) => {
    if (!faceMenu) return;
    const target = faceActionView(faceMenu.region, action);
    if (action === 'section') applySection(faceMenu.region);
    setFaceMenu(null);
    if (faceMenu.source === 'large' && largeCameraRef.current) {
      largeCameraRef.current.animateTo(target, () => {
        applyRegionView(target);
        setLarge(false);
      });
    } else {
      applyRegionView(target);
    }
  };

  return (
    <>
      <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-start gap-1">
        <div className="pointer-events-auto flex flex-col gap-1 pt-1">
          <button
            type="button"
            onClick={fit}
            title="Home: fit the model and re-center the orbit pivot (F)"
            aria-label="Fit to view"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-900/80 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <Home className="h-4 w-4" />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setHelpOpen((v) => !v)}
              title="Mouse and keyboard controls"
              aria-label="Camera controls help"
              aria-expanded={helpOpen}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-900/80 text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <HelpCircle className="h-4 w-4" />
            </button>
            {helpOpen && (
              <div
                role="dialog"
                aria-label="Camera controls"
                className="absolute right-9 top-0 z-30 w-[380px] rounded-md border border-slate-700 bg-slate-900/95 p-3 text-xs text-slate-200 shadow-xl"
              >
                <p className="mb-2 font-semibold text-slate-100">Camera controls</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {CONTROLS_HELP.map(([key, action]) => (
                    <React.Fragment key={key}>
                      <dt className="whitespace-nowrap font-mono text-[11px] text-slate-400">{key}</dt>
                      <dd>{action}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={showLabels}
                    onChange={(e) => setShowLabels(e.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-500"
                  />
                  Show face names on the view cube
                </label>
                <p className="mt-2 text-[11px] text-slate-400">
                  The view never re-centers on its own. Use Fit, Home, the view cube or a preset view.
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="pointer-events-auto">
          <SmallViewCube onFaceMenu={(r) => setFaceMenu({ ...r, source: 'small' })} />
        </div>
      </div>

      {large && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/40"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) closeLarge();
          }}
          role="dialog"
          aria-label="View orientation"
        >
          <LargeViewCube
            onClose={closeLarge}
            onFaceMenu={(r) => setFaceMenu({ ...r, source: 'large' })}
            cameraApiRef={largeCameraRef}
          />
        </div>
      )}

      {faceMenu && <FaceContextMenu request={faceMenu} onAction={onFaceAction} onClose={closeMenu} />}
    </>
  );
}
