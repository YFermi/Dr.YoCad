import * as React from 'react';
import * as THREE from 'three';
import { Save } from 'lucide-react';
import type { SmartMeasurement, Vec3Tuple } from '@cadline/shared';
import { convertSmartMeasurementUnit, formatSmartMeasurementDisplay } from '@/lib/geometry';
import { useMeasureStore } from '@/stores/measureStore';
import { getViewerCamera } from './viewerCameraBridge';

/**
 * Engineering-style (eDrawings-like) measurement dimensions, drawn as a 2D
 * HTML/SVG overlay above the 3D canvas. Every frame the measurement's 3D points
 * are projected with the main camera, so all sizes are in screen pixels and
 * stay constant at any zoom:
 *   - 1.5 px dimension line, offset 20 px from the measured points
 *   - 1 px extension lines from the points to 8 px past the dimension line
 *   - 8 x 3 px filled arrowheads, 4 px point dots
 *   - compact 11 px mono label 2 px above the line, never over line/arrows
 *   - dashed leader to a clamped label when the label would leave the view
 * Colors come from CSS variables (--dimension-*), see index.css.
 * The data model (SmartMeasurement) and the measurement math are unchanged.
 */

type Variant = 'preview' | 'session' | 'related' | 'persisted';

interface Entry {
  key: string;
  m: SmartMeasurement;
  variant: Variant;
  selected: boolean;
  showLabel: boolean;
}

interface EntryElements {
  group: SVGGElement | null;
  stroke: SVGPathElement | null;
  thin: SVGPathElement | null;
  fill: SVGPathElement | null;
  leader: SVGPathElement | null;
  leaderFill: SVGPathElement | null;
  label: HTMLDivElement | null;
}

const EMPTY_ELEMENTS: EntryElements = {
  group: null,
  stroke: null,
  thin: null,
  fill: null,
  leader: null,
  leaderFill: null,
  label: null,
};

const OFFSET_PX = 20;
const EXT_BEYOND_PX = 8;
const EXT_GAP_PX = 3;
const ARROW_LEN = 8;
const ARROW_HALF_W = 1.5;
const DOT_R = 2;
const LABEL_GAP = 2;
const EDGE_MARGIN = 6;
const OCCLUSION_INTERVAL_MS = 100;

const COLOR: Record<Variant, string> = {
  preview: 'var(--dimension-session)',
  session: 'var(--dimension-session)',
  related: 'var(--dimension-session)',
  persisted: 'var(--dimension-persisted)',
};

type P2 = { x: number; y: number };

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ray = new THREE.Raycaster();

// --- small 2D vector helpers -----------------------------------------------
const add = (a: P2, b: P2): P2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: P2, s: number): P2 => ({ x: a.x * s, y: a.y * s });
const len = (a: P2) => Math.hypot(a.x, a.y);
const f = (n: number) => n.toFixed(1);
const moveLine = (a: P2, b: P2) => `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`;
const dotPath = (c: P2, r = DOT_R) =>
  `M${f(c.x - r)} ${f(c.y)}a${r} ${r} 0 1 0 ${f(2 * r)} 0a${r} ${r} 0 1 0 ${f(-2 * r)} 0Z`;
/** Filled triangle with its tip at `tip`, pointing along unit `dir`. */
function arrowPath(tip: P2, dir: P2): string {
  const base = sub(tip, mul(dir, ARROW_LEN));
  const n = { x: -dir.y, y: dir.x };
  const a = add(base, mul(n, ARROW_HALF_W));
  const b = sub(base, mul(n, ARROW_HALF_W));
  return `M${f(tip.x)} ${f(tip.y)}L${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}Z`;
}

function ringPoints(center: Vec3Tuple, axis: Vec3Tuple, radius: number, segments = 48): Vec3Tuple[] {
  const n = new THREE.Vector3(...axis).normalize();
  const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(ref, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  const pts: Vec3Tuple[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t) * radius;
    const s = Math.sin(t) * radius;
    pts.push([center[0] + u.x * c + v.x * s, center[1] + u.y * c + v.y * s, center[2] + u.z * c + v.z * s]);
  }
  return pts;
}

function bboxEdges(min: Vec3Tuple, max: Vec3Tuple): Array<[Vec3Tuple, Vec3Tuple]> {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = (i: number): Vec3Tuple => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const out: Array<[Vec3Tuple, Vec3Tuple]> = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) out.push([c(i), c(i | bit)]);
  return out;
}

function isClippedAway(point: THREE.Vector3, material: THREE.Material | THREE.Material[]): boolean {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((m) => (m.clippingPlanes ?? []).some((pl) => pl.distanceToPoint(point) < 0));
}

/** True when model geometry sits between the camera and `p` (section-clipped geometry ignored). */
function isOccluded(p: Vec3Tuple, camera: THREE.Camera, root: THREE.Object3D | null): boolean {
  if (!root) return false;
  const camPos = camera.getWorldPosition(new THREE.Vector3());
  _v.set(p[0], p[1], p[2]);
  const dist = camPos.distanceTo(_v);
  if (dist < 1e-6) return false;
  _dir.copy(_v).sub(camPos).divideScalar(dist);
  _ray.set(camPos, _dir);
  _ray.far = dist;
  const tol = Math.max(dist * 0.004, 0.05);
  for (const hit of _ray.intersectObject(root, true)) {
    const obj = hit.object as THREE.Mesh;
    if (!(obj as { isMesh?: boolean }).isMesh) continue;
    let visible = true;
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (!o.visible) visible = false;
    if (!visible || isClippedAway(hit.point, obj.material)) continue;
    return hit.distance < dist - tol;
  }
  return false;
}

type Register = (key: string, patch: Partial<EntryElements>) => void;

/** SVG part of one dimension (lines, arrows, dots, leader); geometry is set per frame. */
function DimensionGeometry({ entry, register }: { entry: Entry; register: Register }) {
  const color = COLOR[entry.variant];
  const dashed = entry.variant === 'preview' || entry.variant === 'related';
  const set = (part: keyof EntryElements) => (n: SVGGElement | SVGPathElement | null) =>
    register(entry.key, { [part]: n } as Partial<EntryElements>);
  return (
    <g
      ref={set('group')}
      display="none"
      style={{
        color,
        opacity: entry.variant === 'related' ? 0.75 : 1,
        filter: entry.selected ? `drop-shadow(0 0 3px ${color})` : undefined,
      }}
    >
      <path ref={set('thin')} fill="none" stroke="currentColor" strokeWidth={1} />
      <path
        ref={set('stroke')}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={dashed ? '5 3' : undefined}
      />
      <path ref={set('fill')} fill="currentColor" stroke="none" />
      <path ref={set('leader')} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" />
      <path ref={set('leaderFill')} fill="currentColor" stroke="none" />
    </g>
  );
}

/** HTML label of one dimension; position is set per frame. */
function DimensionLabel({
  entry,
  register,
  canEdit,
  text,
}: {
  entry: Entry;
  register: Register;
  canEdit: boolean;
  text: string;
}) {
  const color = COLOR[entry.variant];
  const interactive = entry.variant === 'persisted' && canEdit;
  return (
    <div
      ref={(n) => register(entry.key, { label: n })}
      data-dimension-label={entry.variant}
      onDoubleClick={
        interactive
          ? (e) => {
              e.stopPropagation();
              useMeasureStore.getState().setEditingMeasurementId(entry.m.id);
            }
          : undefined
      }
      title={interactive ? 'Double-click to edit label, unit, or delete' : undefined}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        display: 'none',
        color,
        background: 'var(--dimension-label-bg)',
        border: '1px solid var(--dimension-label-border)',
        borderRadius: 3,
        padding: '2px 3px',
        fontSize: 11,
        lineHeight: '13px',
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: interactive ? 'pointer' : 'default',
        boxShadow: entry.selected ? `0 0 0 1px ${color}, 0 0 6px ${color}` : undefined,
      }}
      className="select-none items-center gap-1 whitespace-nowrap font-mono tabular-nums"
    >
      {entry.variant === 'persisted' && (
        <Save className="h-2.5 w-2.5 shrink-0 opacity-80" aria-label="saved" />
      )}
      <span>{text}</span>
    </div>
  );
}

/**
 * Mounted outside <Canvas>, absolutely over it. Renders every visible
 * measurement (quick preview, pending, related, session, persisted) and the
 * currently selected references.
 */
export function DimensionOverlay2D({ canEdit = true }: { canEdit?: boolean }) {
  const mode = useMeasureStore((s) => s.mode);
  const quickPreview = useMeasureStore((s) => s.quickPreview);
  const pendingResult = useMeasureStore((s) => s.pendingResult);
  const relatedResults = useMeasureStore((s) => s.relatedResults);
  const localResults = useMeasureStore((s) => s.localResults);
  const persistedResults = useMeasureStore((s) => s.persistedResults);
  const selection = useMeasureStore((s) => s.selection);
  const editingMeasurementId = useMeasureStore((s) => s.editingMeasurementId);
  const displayUnit = useMeasureStore((s) => s.displayUnit);

  const entries = React.useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    // Quick Measure hover preview: geometry only, the cursor tooltip shows the value.
    if (mode === 'quick' && quickPreview) {
      list.push({ key: `preview:${quickPreview.id}`, m: quickPreview, variant: 'preview', selected: false, showLabel: false });
    }
    if (pendingResult) {
      list.push({ key: `pending:${pendingResult.id}`, m: pendingResult, variant: 'session', selected: true, showLabel: true });
    }
    for (const rel of relatedResults) {
      list.push({ key: `related:${rel.id}`, m: rel, variant: 'related', selected: false, showLabel: true });
    }
    for (const loc of localResults) {
      list.push({ key: `local:${loc.id}`, m: loc, variant: 'session', selected: false, showLabel: true });
    }
    for (const per of persistedResults) {
      list.push({
        key: `persisted:${per.id}`,
        m: per,
        variant: 'persisted',
        selected: per.id === editingMeasurementId,
        showLabel: true,
      });
    }
    return list;
  }, [mode, quickPreview, pendingResult, relatedResults, localResults, persistedResults, editingMeasurementId]);

  const textFor = React.useCallback(
    (e: Entry) => {
      // Persisted values keep the unit they were saved with; session ones follow the display unit.
      const m = e.variant === 'persisted' ? e.m : convertSmartMeasurementUnit(e.m, displayUnit);
      const value = formatSmartMeasurementDisplay(m);
      // Skip the name when it just repeats the value (e.g. bounding boxes).
      const name = e.m.label && e.variant !== 'related' && e.m.label !== value ? `${e.m.label}: ` : '';
      return `${name}${value}`;
    },
    [displayUnit]
  );

  const rootRef = React.useRef<HTMLDivElement>(null);
  const selectionPathRef = React.useRef<SVGPathElement>(null);
  const selectionRingRef = React.useRef<SVGPathElement>(null);
  const elementsRef = React.useRef(new Map<string, EntryElements>());
  const entriesRef = React.useRef(entries);
  entriesRef.current = entries;
  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;
  // Geometry and label components register their elements under the entry key.
  const register = React.useCallback<Register>((key, patch) => {
    const map = elementsRef.current;
    const next = { ...(map.get(key) ?? EMPTY_ELEMENTS), ...patch };
    if (Object.values(next).every((v) => v === null)) map.delete(key);
    else map.set(key, next);
  }, []);

  React.useEffect(() => {
    let frame = 0;
    const occlusion = new Map<string, { at: number; hidden: boolean }>();

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const root = rootRef.current;
      const handle = getViewerCamera();
      if (!root || !handle) return;
      const camera = handle.camera;
      const W = root.clientWidth;
      const H = root.clientHeight;
      if (W <= 0 || H <= 0) return;
      camera.updateMatrixWorld();

      const project = (p: Vec3Tuple): (P2 & { behind: boolean }) => {
        _v.set(p[0], p[1], p[2]).project(camera);
        return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H, behind: _v.z > 1 || _v.z < -1 };
      };
      const onScreen = (p: P2) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
      const center3 = handle.getModelCenter();
      const centerS = center3 ? project([center3.x, center3.y, center3.z]) : { x: W / 2, y: H / 2, behind: false };
      const now = performance.now();
      const modelRoot = handle.getModelRoot();

      // Batch layout reads (label sizes) before any writes.
      const sizes = new Map<string, { w: number; h: number }>();
      for (const e of entriesRef.current) {
        const label = elementsRef.current.get(e.key)?.label;
        if (label) {
          label.style.display = 'flex';
          sizes.set(e.key, { w: label.offsetWidth, h: label.offsetHeight });
        }
      }

      const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const e of entriesRef.current) {
        const els = elementsRef.current.get(e.key);
        if (!els?.group) continue;
        const m = e.m;
        let stroke = '';
        let thin = '';
        let fill = '';
        let leader = '';
        let leaderFill = '';
        let labelAt: P2 | null = null; // label center
        let labelNormal: P2 = { x: 0, y: -1 }; // side the label sits on
        const anchors: P2[] = [];
        let hide = false;

        let segment: [Vec3Tuple, Vec3Tuple] | null =
          m.lineStart && m.lineEnd ? [m.lineStart, m.lineEnd] : null;
        let ringCenter: Vec3Tuple | null = null;
        if ((m.kind === 'diameter' || m.kind === 'radius') && m.radius && m.radius > 0.05) {
          // Draw holes / cylinders on the rim facing the camera (eDrawings style)
          // rather than mid-depth inside the hole, and across the rim along the
          // camera's horizontal so the line never collapses on screen.
          // Display only: the stored measurement is unchanged.
          const axis = new THREE.Vector3(...(m.axis ?? [0, 0, 1])).normalize();
          const center = new THREE.Vector3(...m.anchor);
          const halfLen = (m.references[0]?.kind === 'cylinder' ? m.references[0].length ?? 0 : 0) / 2;
          const camPos = camera.getWorldPosition(new THREE.Vector3());
          const rimA = center.clone().addScaledVector(axis, halfLen);
          const rimB = center.clone().addScaledVector(axis, -halfLen);
          const rim = rimA.distanceTo(camPos) <= rimB.distanceTo(camPos) ? rimA : rimB;
          const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
          const radial = right.addScaledVector(axis, -right.dot(axis));
          if (radial.lengthSq() < 1e-6) radial.setFromMatrixColumn(camera.matrixWorld, 1).addScaledVector(axis, -radial.dot(axis));
          radial.normalize().multiplyScalar(m.radius);
          const t = (v: THREE.Vector3): Vec3Tuple => [v.x, v.y, v.z];
          ringCenter = t(rim);
          segment =
            m.kind === 'diameter'
              ? [t(rim.clone().sub(radial)), t(rim.clone().add(radial))]
              : [t(rim), t(rim.clone().add(radial))];
        }
        const hasSegment = Boolean(segment);

        // Hide when any measured point is behind the camera, or all are occluded by the model.
        const keyPoints: Vec3Tuple[] =
          m.kind === 'angle' && m.lineStart && m.angleVertex && m.lineEnd
            ? [m.lineStart, m.angleVertex, m.lineEnd]
            : segment
              ? segment
              : [m.anchor];
        const occlusionPoints = ringCenter ? [ringCenter] : keyPoints;
        const projected = keyPoints.map(project);
        if (projected.some((p) => p.behind)) hide = true;
        if (!hide && m.kind !== 'bbox') {
          const cached = occlusion.get(e.key);
          if (!cached || now - cached.at > OCCLUSION_INTERVAL_MS) {
            const hidden = occlusionPoints.every((p) => isOccluded(p, camera, modelRoot));
            occlusion.set(e.key, { at: now, hidden });
            hide = hidden;
          } else {
            hide = cached.hidden;
          }
        }

        if (!hide && m.kind === 'bbox' && m.bboxMin && m.bboxMax) {
          for (const [a, b] of bboxEdges(m.bboxMin, m.bboxMax)) {
            const pa = project(a);
            const pb = project(b);
            if (!pa.behind && !pb.behind) thin += moveLine(pa, pb);
          }
          const c = project(m.anchor);
          fill += dotPath(c);
          anchors.push(c);
          labelAt = c;
        } else if (!hide && m.kind === 'angle' && m.lineStart && m.angleVertex && m.lineEnd) {
          const [ps, pv, pe] = projected;
          stroke += moveLine(pv, ps) + moveLine(pv, pe);
          const a1 = Math.atan2(ps.y - pv.y, ps.x - pv.x);
          const a2 = Math.atan2(pe.y - pv.y, pe.x - pv.x);
          let sweep = a2 - a1;
          while (sweep > Math.PI) sweep -= 2 * Math.PI;
          while (sweep < -Math.PI) sweep += 2 * Math.PI;
          const r = Math.max(12, Math.min(28, len(sub(ps, pv)) * 0.6, len(sub(pe, pv)) * 0.6));
          const arcStart = add(pv, { x: Math.cos(a1) * r, y: Math.sin(a1) * r });
          const arcEnd = add(pv, { x: Math.cos(a1 + sweep) * r, y: Math.sin(a1 + sweep) * r });
          thin += `M${f(arcStart.x)} ${f(arcStart.y)}A${f(r)} ${f(r)} 0 0 ${sweep > 0 ? 1 : 0} ${f(arcEnd.x)} ${f(arcEnd.y)}`;
          for (const p of projected) fill += dotPath(p);
          anchors.push(pv, ps, pe);
          const mid = a1 + sweep / 2;
          labelNormal = { x: Math.cos(mid), y: Math.sin(mid) };
          labelAt = add(pv, mul(labelNormal, r));
        } else if (!hide && hasSegment) {
          const [p1, p2] = projected;
          const d = sub(p2, p1);
          const L = len(d);
          anchors.push(p1, p2);
          fill += dotPath(p1) + dotPath(p2);
          if (L < 1) {
            labelAt = p1;
          } else {
            const u = mul(d, 1 / L);
            let n: P2 = { x: -u.y, y: u.x };
            const across = m.kind === 'diameter' || m.kind === 'radius';
            // Linear dimensions sit on the side away from the part's screen centre.
            const mid = mul(add(p1, p2), 0.5);
            if ((mid.x - centerS.x) * n.x + (mid.y - centerS.y) * n.y < 0) n = mul(n, -1);
            if (across && n.y > 0) n = mul(n, -1); // diameter label above the line
            const offset = across ? 0 : OFFSET_PX;
            const q1 = add(p1, mul(n, offset));
            const q2 = add(p2, mul(n, offset));
            stroke += moveLine(q1, q2);
            if (!across) {
              thin += moveLine(add(p1, mul(n, EXT_GAP_PX)), add(q1, mul(n, EXT_BEYOND_PX)));
              thin += moveLine(add(p2, mul(n, EXT_GAP_PX)), add(q2, mul(n, EXT_BEYOND_PX)));
            }
            if (L >= 2 * ARROW_LEN + 6) {
              // Tips on the extension lines / circle rim, pointing outward (ISO/ASME).
              // (a radius only has the arrow at the rim end)
              fill += (m.kind === 'radius' ? '' : arrowPath(q1, mul(u, -1))) + arrowPath(q2, u);
            } else {
              // Too short: arrows outside, pointing inward.
              stroke += moveLine(sub(q1, mul(u, ARROW_LEN + 6)), q1) + moveLine(q2, add(q2, mul(u, ARROW_LEN + 6)));
              fill += arrowPath(q1, u) + arrowPath(q2, mul(u, -1));
            }
            if (m.kind === 'center-to-center') {
              // Center marks at both circle centres.
              for (const c of [p1, p2]) thin += moveLine(add(c, mul(u, -5)), add(c, mul(u, 5))) + moveLine(add(c, mul(n, -5)), add(c, mul(n, 5)));
            }
            if (across && m.radius && m.radius > 0.05) {
              const ring = ringPoints(ringCenter ?? m.anchor, m.axis ?? [0, 0, 1], m.radius).map(project);
              if (!ring.some((p) => p.behind)) thin += ring.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join('');
            }
            labelNormal = n;
            labelAt = mul(add(q1, q2), 0.5);
          }
        } else if (!hide) {
          const c = projected[0];
          fill += dotPath(c);
          anchors.push(c);
          labelAt = c;
        }

        els.group.setAttribute('display', hide ? 'none' : 'inline');
        els.stroke?.setAttribute('d', stroke);
        els.thin?.setAttribute('d', thin);
        els.fill?.setAttribute('d', fill);

        const label = els.label;
        if (label) {
          const size = sizes.get(e.key);
          if (hide || !labelAt || !size) {
            label.style.display = 'none';
          } else {
            // Push the label off the line by its own half-extent along the normal + gap.
            const extent = Math.abs(labelNormal.x) * (size.w / 2) + Math.abs(labelNormal.y) * (size.h / 2);
            const want = add(labelAt, mul(labelNormal, LABEL_GAP + extent + (anchors.length === 1 ? DOT_R + 2 : 0)));
            const clampToView = (pt: P2): P2 => ({
              x: Math.min(Math.max(pt.x, size.w / 2 + EDGE_MARGIN), W - size.w / 2 - EDGE_MARGIN),
              y: Math.min(Math.max(pt.y, size.h / 2 + EDGE_MARGIN), H - size.h / 2 - EDGE_MARGIN),
            });
            let clamped = clampToView(want);
            // Do not stack on labels of other dimensions: step outward along this label's normal.
            const overlaps = (c: P2) =>
              placed.some(
                (rect) =>
                  Math.abs(rect.x - c.x) < (rect.w + size.w) / 2 + 2 &&
                  Math.abs(rect.y - c.y) < (rect.h + size.h) / 2 + 2
              );
            for (let i = 0; i < 6 && overlaps(clamped); i++) {
              clamped = clampToView(add(clamped, mul(labelNormal, size.h + 3)));
            }
            placed.push({ x: clamped.x, y: clamped.y, w: size.w, h: size.h });
            label.style.transform = `translate(${f(clamped.x - size.w / 2)}px, ${f(clamped.y - size.h / 2)}px)`;
            if (Math.hypot(clamped.x - want.x, clamped.y - want.y) > 1) {
              // Off-screen label: dashed leader from the label to the nearest on-screen anchor.
              const visible = anchors.filter(onScreen);
              const target = visible.length
                ? visible.reduce((best, a) => (len(sub(a, clamped)) < len(sub(best, clamped)) ? a : best))
                : null;
              if (target) {
                const dir = sub(target, clamped);
                const dl = len(dir);
                if (dl > 12) {
                  const u = mul(dir, 1 / dl);
                  const start = add(clamped, { x: u.x * (size.w / 2 + 2), y: u.y * (size.h / 2 + 2) });
                  leader += moveLine(start, sub(target, mul(u, DOT_R + 1)));
                  leaderFill += arrowPath(sub(target, mul(u, DOT_R + 1)), u);
                }
              } else {
                // Nothing on screen: a short arrow at the label pointing toward the measurement.
                const dir = sub(want, clamped);
                const dl = len(dir) || 1;
                const u = mul(dir, 1 / dl);
                const tip = add(clamped, { x: u.x * (size.w / 2 + 16), y: u.y * (size.h / 2 + 16) });
                leader += moveLine(add(clamped, { x: u.x * (size.w / 2 + 2), y: u.y * (size.h / 2 + 2) }), tip);
                leaderFill += arrowPath(tip, u);
              }
            }
          }
        }
        els.leader?.setAttribute('d', leader);
        els.leaderFill?.setAttribute('d', leaderFill);
      }

      // Selected references (measure tool in progress): 4 px dot + 1 px ring.
      let selDots = '';
      let selRings = '';
      for (const ref of selectionRef.current) {
        const p = project(ref.position);
        if (p.behind) continue;
        selDots += dotPath(p);
        selRings += dotPath(p, 5);
      }
      selectionPathRef.current?.setAttribute('d', selDots);
      selectionRingRef.current?.setAttribute('d', selRings);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="dimension-overlay">
      <svg className="absolute inset-0 h-full w-full overflow-visible" style={{ shapeRendering: 'geometricPrecision' }}>
        {entries.map((e) => (
          <DimensionGeometry key={e.key} entry={e} register={register} />
        ))}
        <g style={{ color: 'var(--dimension-session)' }}>
          <path ref={selectionPathRef} fill="currentColor" />
          <path ref={selectionRingRef} fill="none" stroke="currentColor" strokeWidth={1} />
        </g>
      </svg>
      {entries
        .filter((e) => e.showLabel)
        .map((e) => (
          <DimensionLabel key={e.key} entry={e} register={register} canEdit={canEdit} text={textFor(e)} />
        ))}
    </div>
  );
}
