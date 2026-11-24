import * as React from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { HelpCircle, Home } from 'lucide-react';
import { useViewerStore } from '@/stores/viewerStore';
import { getViewerCamera } from './viewerCameraBridge';

/**
 * SOLIDWORKS-style view orientation cube (3D viewer only).
 *
 * Its own small <Canvas> in the top-right corner: it mirrors the main camera's
 * orientation every frame, and only its own container receives pointer events,
 * so clicks that miss the cube reach the model. Built from 26 boxes (6 face
 * centres, 12 edges, 8 corners); each is one clickable region:
 *   face   -> look straight at it (Front = from +Z toward -Z, Y up, like the toolbar)
 *   edge   -> 45° between the two faces
 *   corner -> isometric toward the corner
 * Clicking reorients the camera, resets the orbit pivot and fits the model
 * (same path as the toolbar presets). SPACE opens a large centred cube with
 * X/Y/Z axis labels; ESC, a click outside or picking a view closes it.
 */

type Sign = -1 | 0 | 1;
interface Region {
  key: string;
  label: string;
  coord: [Sign, Sign, Sign];
}

const FACE_NAMES: Record<string, string> = {
  '0,0,1': 'Front',
  '0,0,-1': 'Back',
  '1,0,0': 'Right',
  '-1,0,0': 'Left',
  '0,1,0': 'Top',
  '0,-1,0': 'Bottom',
};

function regionLabel([x, y, z]: [Sign, Sign, Sign]): string {
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
      if (!x && !y && !z) continue;
      const label = regionLabel([x, y, z]);
      REGIONS.push({ key: label.toLowerCase(), label, coord: [x, y, z] });
    }
  }
}

const BORDER = 0.28; // edge / corner band width (cube half-size is 1)
const COLORS = {
  face: '#e5e7eb',
  faceNearest: '#dbeafe',
  band: '#cbd5e1',
  hover: '#60a5fa',
};

function regionGeometry([x, y, z]: [Sign, Sign, Sign]): { pos: THREE.Vector3; size: THREE.Vector3 } {
  const c = (v: Sign) => (v === 0 ? 0 : v * (1 - BORDER / 2));
  const s = (v: Sign) => (v === 0 ? 2 * (1 - BORDER) : BORDER);
  return { pos: new THREE.Vector3(c(x), c(y), c(z)), size: new THREE.Vector3(s(x), s(y), s(z)) };
}

function viewForRegion([x, y, z]: [Sign, Sign, Sign]): {
  dir: [number, number, number];
  up: [number, number, number];
} {
  const len = Math.hypot(x, y, z);
  const dir: [number, number, number] = [x / len, y / len, z / len];
  // Same ups as the toolbar presets: Top has -Z up, Bottom +Z up, the rest Y up
  // (CameraController orthogonalizes Y against edge/corner directions).
  if (!x && !z) return { dir, up: y > 0 ? [0, 0, -1] : [0, 0, 1] };
  return { dir, up: [0, 1, 0] };
}

function makeTextTexture(text: string, opts: { fg: string; bg?: string; font: string }): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, 256, 256);
  }
  ctx.fillStyle = opts.fg;
  ctx.font = opts.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 132);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const _back = new THREE.Vector3();
const _normal = new THREE.Vector3();

function CubeScene({
  hovered,
  setHovered,
  onPick,
  showAxes,
  registerTestHook,
}: {
  hovered: string | null;
  setHovered: React.Dispatch<React.SetStateAction<string | null>>;
  onPick: (region: Region) => void;
  showAxes: boolean;
  registerTestHook: boolean;
}) {
  const { camera, gl } = useThree();
  const [nearestFace, setNearestFace] = React.useState<string | null>(null);
  const nearestRef = React.useRef<string | null>(null);
  const noRaycast = React.useCallback(() => null, []);

  const textures = React.useMemo(() => {
    const map = new Map<string, THREE.Texture>();
    for (const [coord, name] of Object.entries(FACE_NAMES)) {
      map.set(coord, makeTextTexture(name, { fg: '#1f2937', bg: '#ffffff', font: '700 78px "DM Sans", system-ui, sans-serif' }));
    }
    return map;
  }, []);
  const axisTextures = React.useMemo(
    () => ({
      X: makeTextTexture('X', { fg: '#ef4444', font: '700 150px system-ui, sans-serif' }),
      Y: makeTextTexture('Y', { fg: '#22c55e', font: '700 150px system-ui, sans-serif' }),
      Z: makeTextTexture('Z', { fg: '#3b82f6', font: '700 150px system-ui, sans-serif' }),
    }),
    []
  );
  React.useEffect(
    () => () => {
      textures.forEach((t) => t.dispose());
      Object.values(axisTextures).forEach((t) => t.dispose());
    },
    [textures, axisTextures]
  );
  const outline = React.useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), []);

  // Mirror the main camera's orientation (the cube shows the current view).
  useFrame(() => {
    const main = getViewerCamera()?.camera;
    if (!main) return;
    camera.quaternion.copy(main.quaternion);
    camera.position.set(0, 0, 10).applyQuaternion(main.quaternion);
    camera.updateMatrixWorld();

    _back.set(0, 0, 1).applyQuaternion(main.quaternion);
    let best: string | null = null;
    let bestDot = -Infinity;
    for (const coord of Object.keys(FACE_NAMES)) {
      const [x, y, z] = coord.split(',').map(Number);
      const d = _normal.set(x, y, z).dot(_back);
      if (d > bestDot) {
        bestDot = d;
        best = coord;
      }
    }
    if (best !== nearestRef.current) {
      nearestRef.current = best;
      setNearestFace(best);
    }
  });

  // Dev-only e2e hook: client coordinates of a region's visible centre.
  React.useEffect(() => {
    if (!registerTestHook || !import.meta.env.DEV) return;
    const hook = (key: string) => {
      const region = REGIONS.find((r) => r.key === key);
      if (!region) return null;
      // Regions facing away from the camera cannot be clicked; report them as null.
      const [x, y, z] = region.coord;
      const facing = new THREE.Vector3(x, y, z).normalize().dot(new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion));
      if (facing < 0.1) return null;
      const p = regionGeometry(region.coord).pos.project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    };
    if (window.__viewer) window.__viewer.viewCubePoint = hook;
    return () => {
      if (window.__viewer?.viewCubePoint === hook) delete window.__viewer.viewCubePoint;
    };
  }, [registerTestHook, camera, gl]);

  return (
    <>
      <ambientLight intensity={2.1} />
      <directionalLight position={[2, 3, 4]} intensity={0.9} />
      {REGIONS.map((region) => {
        const { pos, size } = regionGeometry(region.coord);
        const coordKey = region.coord.join(',');
        const isFace = coordKey in FACE_NAMES;
        const color =
          hovered === region.key
            ? COLORS.hover
            : isFace
              ? coordKey === nearestFace
                ? COLORS.faceNearest
                : COLORS.face
              : COLORS.band;
        return (
          <mesh
            key={region.key}
            position={pos}
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
              onPick(region);
            }}
          >
            <boxGeometry args={[size.x, size.y, size.z]} />
            <meshLambertMaterial color={color} map={isFace ? textures.get(coordKey) : null} />
          </mesh>
        );
      })}
      <lineSegments geometry={outline} raycast={noRaycast} scale={1.002}>
        <lineBasicMaterial color="#64748b" />
      </lineSegments>
      {showAxes && (
        <group raycast={noRaycast}>
          {(
            [
              ['X', [-1.04, -1.04, 1.04], [1.3, -1.04, 1.04], '#ef4444'],
              ['Y', [-1.04, -1.04, 1.04], [-1.04, 1.3, 1.04], '#22c55e'],
              ['Z', [-1.04, -1.04, -1.04], [-1.04, -1.04, 1.3], '#3b82f6'],
            ] as const
          ).map(([name, from, to, color]) => {
            const geometry = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(...from),
              new THREE.Vector3(...to),
            ]);
            const dir = new THREE.Vector3(...to).sub(new THREE.Vector3(...from)).normalize();
            const labelPos = new THREE.Vector3(...to).addScaledVector(dir, 0.22);
            return (
              <group key={name}>
                <lineSegments geometry={geometry} raycast={noRaycast}>
                  <lineBasicMaterial color={color} />
                </lineSegments>
                <sprite position={labelPos} scale={0.42} raycast={noRaycast}>
                  <spriteMaterial map={axisTextures[name]} depthTest={false} transparent />
                </sprite>
              </group>
            );
          })}
        </group>
      )}
    </>
  );
}

function CubeCanvas({
  sizePx,
  showAxes,
  onPicked,
  registerTestHook,
}: {
  sizePx: number;
  showAxes: boolean;
  onPicked?: () => void;
  registerTestHook: boolean;
}) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const hoveredLabel = REGIONS.find((r) => r.key === hovered)?.label;
  const half = showAxes ? 2.25 : 1.75;

  const pick = React.useCallback(
    (region: Region) => {
      const { dir, up } = viewForRegion(region.coord);
      useViewerStore.getState().requestCameraView(dir, up);
      onPicked?.();
    },
    [onPicked]
  );

  return (
    <div className="relative" style={{ width: sizePx, height: sizePx }}>
      <Canvas
        orthographic
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={{ left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 40, position: [0, 0, 10] }}
        style={{ cursor: hovered ? 'pointer' : 'default' }}
        data-testid={registerTestHook ? 'view-cube' : 'view-cube-large'}
      >
        <CubeScene
          hovered={hovered}
          setHovered={setHovered}
          onPick={pick}
          showAxes={showAxes}
          registerTestHook={registerTestHook}
        />
      </Canvas>
      {hoveredLabel && (
        <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900/90 px-2 py-0.5 text-[11px] font-medium text-slate-100 shadow">
          {hoveredLabel.includes('-') ? hoveredLabel : `${hoveredLabel} view`}
        </div>
      )}
    </div>
  );
}

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
  ['Space', 'View cube (large)'],
  ['F / Home', 'Fit and re-center pivot'],
  ['Q / E', 'Roll 15°'],
];

/** Top-right view cube + home + help, and the SPACE-toggled large cube. */
export function ViewCubeOverlay() {
  const [large, setLarge] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
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
                <p className="mt-2 text-[11px] text-slate-400">
                  The view never re-centers on its own. Use Fit, Home, the view cube or a preset view.
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="pointer-events-auto">
          <CubeCanvas sizePx={110} showAxes={false} registerTestHook />
        </div>
      </div>

      {large && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/45"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) closeLarge();
          }}
          role="dialog"
          aria-label="View orientation"
        >
          <div className="rounded-xl bg-slate-900/40 p-2 backdrop-blur-[1px]">
            <CubeCanvas sizePx={250} showAxes onPicked={closeLarge} registerTestHook={false} />
          </div>
        </div>
      )}
    </>
  );
}
