import * as React from 'react';
import {
  Arc,
  Circle,
  Group,
  Layer,
  Line,
  Stage,
  Text,
} from 'react-konva';
import type Konva from 'konva';
import {
  isAnnotationAnchor2D,
  normalizeAnnotationAnchor,
  type Annotation,
  type DxfBounds,
  type DxfEntity,
  type DxfLayerManifestItem,
  type DxfPolylineVertex,
  type DxfSceneGraph,
  type Measurement,
  type Point2D,
} from '@cadline/shared';
import {
  useViewer2DStore,
  type ShapeDraft,
} from '@/stores/viewer2dStore';
import {
  buildSnapGeometryIndex,
  findSnapCandidate,
  type SnapResult,
} from '@/components/viewer2d/snapping';
import { MarkupOverlayLayer } from '@/components/viewer2d/MarkupOverlayLayer';
import { RemoteCursors2DLayer } from '@/components/viewer2d/RemoteCursors2DLayer';
import { usePresenceStore } from '@/stores/presenceStore';
import { useCursorStore } from '@/stores/cursorStore';
import {
  emitRealtimeCursorMove,
  emitRealtimeViewportSync,
} from '@/hooks/useRealtimeSync';

interface DxfStageProps {
  scene: DxfSceneGraph;
  layers: DxfLayerManifestItem[];
  bounds: DxfBounds;
  fileName?: string;
  annotations: Annotation[];
  measurements: Measurement[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  onRequestPinOrText: (input: {
    tool: 'pin' | 'text';
    point: Point2D;
    screenPos: Point2D;
  }) => void;
}

const MAX_INSERT_DEPTH = 5;
const CULL_THRESHOLD = 300;
const MIN_ZOOM_FACTOR = 0.1;
const MAX_ZOOM_FACTOR = 20;

interface WorldBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function getEntityApproxBounds(entity: DxfEntity): WorldBBox | null {
  switch (entity.type) {
    case 'LINE':
      return {
        minX: Math.min(entity.start.x, entity.end.x),
        minY: Math.min(entity.start.y, entity.end.y),
        maxX: Math.max(entity.start.x, entity.end.x),
        maxY: Math.max(entity.start.y, entity.end.y),
      };
    case 'CIRCLE':
    case 'ARC':
      return {
        minX: entity.center.x - entity.radius,
        minY: entity.center.y - entity.radius,
        maxX: entity.center.x + entity.radius,
        maxY: entity.center.y + entity.radius,
      };
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      if (entity.vertices.length === 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const v of entity.vertices) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
      }
      return { minX, minY, maxX, maxY };
    }
    case 'TEXT':
    case 'MTEXT': {
      const h = Math.max(entity.height || 3, 1);
      const w = Math.max(entity.text.length * h * 0.7, h * 2);
      return {
        minX: entity.position.x - w,
        minY: entity.position.y - h * 2,
        maxX: entity.position.x + w * 2,
        maxY: entity.position.y + h * 2,
      };
    }
    default:
      // Always render INSERT and DIMENSION unless explicitly outside huge bounds
      return null;
  }
}

function intersectsViewport(box: WorldBBox | null, view: WorldBBox): boolean {
  if (!box) return true;
  return !(
    box.maxX < view.minX ||
    box.minX > view.maxX ||
    box.maxY < view.minY ||
    box.minY > view.maxY
  );
}

/**
 * Samples DXF polyline vertices including optional DXF bulge segments into flat Konva coords (Y-flipped).
 */
function buildPolylineStagePoints(
  vertices: DxfPolylineVertex[],
  closed: boolean
): number[] {
  const coords: number[] = [];
  if (vertices.length === 0) return coords;

  const segCount = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segCount; i += 1) {
    const p1 = vertices[i];
    const p2 = vertices[(i + 1) % vertices.length];
    coords.push(p1.x, -p1.y);

    const bulge = p1.bulge ?? 0;
    if (Math.abs(bulge) > 1e-4) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const chord = Math.hypot(dx, dy);
      if (chord > 1e-5) {
        const theta = 4 * Math.atan(bulge);
        const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
        const halfChord = chord / 2;
        const apothem = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord));
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const sign = bulge > 0 ? 1 : -1;
        const dirSign = Math.abs(theta) > Math.PI ? -sign : sign;
        const nx = (-dy / chord) * dirSign;
        const ny = (dx / chord) * dirSign;
        const cx = mx + nx * apothem;
        const cy = my + ny * apothem;
        const startAng = Math.atan2(p1.y - cy, p1.x - cx);
        const steps = 10;
        for (let s = 1; s < steps; s += 1) {
          const ang = startAng + (theta * s) / steps;
          coords.push(cx + Math.cos(ang) * radius, -(cy + Math.sin(ang) * radius));
        }
      }
    }
  }

  if (!closed) {
    const last = vertices[vertices.length - 1];
    coords.push(last.x, -last.y);
  }
  return coords;
}

function getLineDash(lineType: string | undefined, invScale: number): number[] | undefined {
  if (!lineType) return undefined;
  const upper = lineType.toUpperCase();
  if (upper.includes('CENTER')) {
    return [12 * invScale, 4 * invScale, 3 * invScale, 4 * invScale];
  }
  if (upper.includes('DASH') || upper.includes('HIDDEN')) {
    return [6 * invScale, 4 * invScale];
  }
  return undefined;
}

function renderDxfEntity(
  entity: DxfEntity,
  key: string,
  layerColor: string,
  blocks: Record<string, DxfEntity[]>,
  invScale: number,
  depth: number,
  visitedBlocks: Set<string>
): React.ReactNode {
  const stroke = entity.color || layerColor || '#e2e8f0';
  const strokeWidth = Math.max(1.25 * invScale, 0.05);
  const dash = getLineDash(entity.lineType, invScale);

  switch (entity.type) {
    case 'LINE':
      return (
        <Line
          key={key}
          points={[entity.start.x, -entity.start.y, entity.end.x, -entity.end.y]}
          stroke={stroke}
          strokeWidth={strokeWidth}
          dash={dash}
          listening={false}
          perfectDrawEnabled={false}
        />
      );

    case 'CIRCLE':
      return (
        <Circle
          key={key}
          x={entity.center.x}
          y={-entity.center.y}
          radius={entity.radius}
          stroke={stroke}
          strokeWidth={strokeWidth}
          dash={dash}
          listening={false}
          perfectDrawEnabled={false}
        />
      );

    case 'ARC': {
      let sweep = entity.endAngle - entity.startAngle;
      if (sweep <= 0) sweep += 360;
      return (
        <Arc
          key={key}
          x={entity.center.x}
          y={-entity.center.y}
          innerRadius={entity.radius}
          outerRadius={entity.radius}
          angle={sweep}
          rotation={-entity.endAngle}
          stroke={stroke}
          strokeWidth={strokeWidth}
          dash={dash}
          listening={false}
          perfectDrawEnabled={false}
        />
      );
    }

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const pts = buildPolylineStagePoints(entity.vertices, entity.closed);
      if (pts.length < 4) return null;
      return (
        <Line
          key={key}
          points={pts}
          closed={entity.closed}
          stroke={stroke}
          strokeWidth={strokeWidth}
          dash={dash}
          listening={false}
          perfectDrawEnabled={false}
        />
      );
    }

    case 'TEXT':
    case 'MTEXT': {
      const fontSize = Math.max(entity.height || 3.5, 1.5);
      return (
        <Text
          key={key}
          x={entity.position.x}
          y={-entity.position.y - fontSize}
          text={entity.text}
          fontSize={fontSize}
          fontFamily="JetBrains Mono, monospace"
          fill={stroke}
          rotation={-(entity.rotation ?? 0)}
          listening={false}
          perfectDrawEnabled={false}
        />
      );
    }

    case 'INSERT': {
      if (depth >= MAX_INSERT_DEPTH || visitedBlocks.has(entity.blockName)) {
        return null;
      }
      const children = blocks[entity.blockName];
      if (!children || children.length === 0) return null;

      const nextVisited = new Set(visitedBlocks);
      nextVisited.add(entity.blockName);

      return (
        <Group
          key={key}
          x={entity.position.x}
          y={-entity.position.y}
          scaleX={entity.scaleX ?? 1}
          scaleY={entity.scaleY ?? 1}
          rotation={-(entity.rotation ?? 0)}
          listening={false}
        >
          {children.map((child, idx) =>
            renderDxfEntity(
              child,
              `${key}-blk-${idx}`,
              stroke,
              blocks,
              invScale / Math.max(Math.abs(entity.scaleX ?? 1), 0.1),
              depth + 1,
              nextVisited
            )
          )}
        </Group>
      );
    }

    case 'DIMENSION': {
      if (entity.resolvedEntities && entity.resolvedEntities.length > 0 && depth < MAX_INSERT_DEPTH) {
        return (
          <Group key={key} listening={false}>
            {entity.resolvedEntities.map((child, idx) =>
              renderDxfEntity(
                child,
                `${key}-dim-${idx}`,
                stroke,
                blocks,
                invScale,
                depth + 1,
                visitedBlocks
              )
            )}
          </Group>
        );
      }

      const start = entity.start;
      const end = entity.end;
      const labelPos =
        entity.middleOfText ??
        (start && end
          ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
          : entity.anchorPoint);
      const labelText =
        entity.text ||
        (start && end ? Math.hypot(end.x - start.x, end.y - start.y).toFixed(1) : '');

      return (
        <Group key={key} listening={false}>
          {start && end && (
            <Line
              points={[start.x, -start.y, end.x, -end.y]}
              stroke={stroke}
              strokeWidth={strokeWidth * 0.9}
              listening={false}
            />
          )}
          {labelPos && labelText && (
            <Text
              x={labelPos.x}
              y={-labelPos.y - 3.5}
              text={labelText}
              fontSize={3.2}
              fontFamily="JetBrains Mono, monospace"
              fill={stroke}
              listening={false}
            />
          )}
        </Group>
      );
    }

    default:
      return null;
  }
}

export function DxfStage({
  scene,
  layers,
  bounds,
  fileName,
  annotations,
  measurements,
  selectedAnnotationId,
  onSelectAnnotation,
  onRequestPinOrText,
}: DxfStageProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<Konva.Stage | null>(null);
  const [size, setSize] = React.useState<{ width: number; height: number }>({
    width: 800,
    height: 600,
  });

  const [scale, setScale] = React.useState(1);
  const [position, setPosition] = React.useState<Point2D>({ x: 0, y: 0 });
  const fitScaleRef = React.useRef(1);
  const initializedRef = React.useRef(false);

  const [spacePressed, setSpacePressed] = React.useState(false);
  const isPanningRef = React.useRef(false);
  const panStartRef = React.useRef<{ pointer: Point2D; pos: Point2D } | null>(null);
  const isDrawingRef = React.useRef(false);
  const lastTouchDistRef = React.useRef<number | null>(null);
  const lastTouchCenterRef = React.useRef<Point2D | null>(null);
  const animFrameRef = React.useRef<number | null>(null);

  const [snapIndicator, setSnapIndicator] = React.useState<SnapResult | null>(null);
  const [cursorModelPos, setCursorModelPos] = React.useState<Point2D | null>(null);

  const tool = useViewer2DStore((s) => s.tool);
  const snap = useViewer2DStore((s) => s.snap);
  const gridStep = useViewer2DStore((s) => s.gridStep);
  const draftShape = useViewer2DStore((s) => s.draftShape);
  const hiddenLayers = useViewer2DStore((s) => s.hiddenLayers);
  const soloLayer = useViewer2DStore((s) => s.soloLayer);
  const beginShape = useViewer2DStore((s) => s.beginShape);
  const updateShape = useViewer2DStore((s) => s.updateShape);
  const commitShape = useViewer2DStore((s) => s.commitShape);
  const cancelShape = useViewer2DStore((s) => s.cancelShape);
  const setViewportTransform = useViewer2DStore((s) => s.setViewportTransform);
  const registerStageHandlers = useViewer2DStore((s) => s.registerStageHandlers);
  const activeFollowUserId = usePresenceStore((s) => s.activeUserId);
  const remoteViewportPose = useCursorStore((s) => s.remoteViewportPose);
  const scaleRef = React.useRef(scale);
  const positionRef = React.useRef(position);
  scaleRef.current = scale;
  positionRef.current = position;

  // Broadcast 2D viewport pan/zoom at <= 15 Hz when not following
  React.useEffect(() => {
    if (!initializedRef.current || activeFollowUserId !== null) return;
    emitRealtimeViewportSync({
      scale,
      offsetX: position.x,
      offsetY: position.y,
    });
  }, [activeFollowUserId, position.x, position.y, scale]);

  // Smoothly lerp (0.15 per frame) to followed user's 2D viewport
  React.useEffect(() => {
    if (activeFollowUserId === null || !remoteViewportPose) return;
    let rafId = 0;
    const targetScale = remoteViewportPose.scale;
    const targetX = remoteViewportPose.offsetX;
    const targetY = remoteViewportPose.offsetY;

    const step = () => {
      if (usePresenceStore.getState().activeUserId === null) return;
      const curScale = scaleRef.current;
      const curPos = positionRef.current;
      const nextScale = curScale + (targetScale - curScale) * 0.15;
      const nextX = curPos.x + (targetX - curPos.x) * 0.15;
      const nextY = curPos.y + (targetY - curPos.y) * 0.15;

      scaleRef.current = nextScale;
      positionRef.current = { x: nextX, y: nextY };
      setScale(nextScale);
      setPosition({ x: nextX, y: nextY });
      setViewportTransform(nextScale, nextX, nextY);

      const done =
        Math.abs(targetScale - nextScale) < 0.0005 &&
        Math.abs(targetX - nextX) < 0.25 &&
        Math.abs(targetY - nextY) < 0.25;
      if (!done) {
        rafId = requestAnimationFrame(step);
      }
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [activeFollowUserId, remoteViewportPose, setViewportTransform]);

  // Measure container via ResizeObserver
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard shortcuts: Space to pan, Escape to cancel draft, Enter to commit area
  React.useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setSpacePressed(true);
      } else if (e.key === 'Escape') {
        cancelShape();
      } else if (e.key === 'Enter') {
        const current = useViewer2DStore.getState().draftShape;
        if (current && current.tool === 'area' && current.points.length >= 3) {
          void commitShape();
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [cancelShape, commitShape]);

  // Fit drawing bounds cleanly inside the Konva stage
  const fitToView = React.useCallback(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const drawW = Math.max(bounds.maxX - bounds.minX, 1);
    const drawH = Math.max(bounds.maxY - bounds.minY, 1);
    const pad = 48;
    const availW = Math.max(size.width - pad * 2, 100);
    const availH = Math.max(size.height - pad * 2, 100);
    const nextScale = Math.min(availW / drawW, availH / drawH);
    fitScaleRef.current = nextScale;

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    // DXF is Y-flipped in stage: model (centerX, centerY) -> stage (centerX, -centerY)
    const nextX = size.width / 2 - centerX * nextScale;
    const nextY = size.height / 2 - -centerY * nextScale;

    setScale(nextScale);
    setPosition({ x: nextX, y: nextY });
    setViewportTransform(nextScale, nextX, nextY);
  }, [bounds, size.height, size.width, setViewportTransform]);

  React.useEffect(() => {
    if (!initializedRef.current && size.width > 0 && size.height > 0) {
      initializedRef.current = true;
      fitToView();
    }
  }, [fitToView, size.height, size.width]);

  // Smooth pan/zoom animation helper
  const animateToView = React.useCallback(
    (targetScale: number, targetPos: Point2D) => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
      const startScale = scale;
      const startPos = { ...position };
      const startTime = performance.now();
      const duration = 260;

      const step = (now: number) => {
        const t = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const curScale = startScale + (targetScale - startScale) * eased;
        const curX = startPos.x + (targetPos.x - startPos.x) * eased;
        const curY = startPos.y + (targetPos.y - startPos.y) * eased;
        setScale(curScale);
        setPosition({ x: curX, y: curY });
        setViewportTransform(curScale, curX, curY);
        if (t < 1) {
          animFrameRef.current = requestAnimationFrame(step);
        } else {
          animFrameRef.current = null;
        }
      };

      animFrameRef.current = requestAnimationFrame(step);
    },
    [position, scale, setViewportTransform]
  );

  React.useEffect(() => {
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  // Register imperative toolbar & CommentsPanel bridges
  React.useEffect(() => {
    const zoomStep = (factor: number) => {
      const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
      const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
      const nextScale = Math.max(minScale, Math.min(maxScale, scale * factor));
      const cx = size.width / 2;
      const cy = size.height / 2;
      const stageX = (cx - position.x) / scale;
      const stageY = (cy - position.y) / scale;
      const nextPos = {
        x: cx - stageX * nextScale,
        y: cy - stageY * nextScale,
      };
      setScale(nextScale);
      setPosition(nextPos);
      setViewportTransform(nextScale, nextPos.x, nextPos.y);
    };

    const screenshot = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const dataUrl = stage.toDataURL({ pixelRatio: 2, mimeType: 'image/png' });
      const link = document.createElement('a');
      link.download = `${(fileName ?? 'drawing').replace(/\.[^.]+$/, '')}-2d.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    const focusAnnotation = (annotationId: string) => {
      const match = annotations.find((a) => a.id === annotationId);
      if (!match) return;
      const anchor = normalizeAnnotationAnchor(match.payload?.anchor);
      if (!isAnnotationAnchor2D(anchor)) return;

      const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
      const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
      const preferredScale = Math.max(
        scale,
        Math.min(maxScale, Math.max(minScale, fitScaleRef.current * 2.2))
      );
      const targetPos = {
        x: size.width / 2 - anchor.x * preferredScale,
        y: size.height / 2 - -anchor.y * preferredScale,
      };
      animateToView(preferredScale, targetPos);
    };

    registerStageHandlers({
      fit: fitToView,
      zoomStep,
      screenshot,
      focusAnnotation,
    });
  }, [
    animateToView,
    annotations,
    fileName,
    fitToView,
    position.x,
    position.y,
    registerStageHandlers,
    scale,
    setViewportTransform,
    size.height,
    size.width,
  ]);

  // Visible layer set
  const visibleLayers = React.useMemo(() => {
    const set = new Set<string>();
    for (const l of layers) {
      const visible =
        soloLayer !== null ? soloLayer === l.name : !hiddenLayers.has(l.name);
      if (visible) set.add(l.name);
    }
    return set;
  }, [hiddenLayers, layers, soloLayer]);

  // Group entities by DXF layer name so each DXF layer maps to a Konva <Layer>
  const entitiesByLayer = React.useMemo(() => {
    const map = new Map<string, DxfEntity[]>();
    for (const l of layers) {
      map.set(l.name, []);
    }
    for (const ent of scene.entities) {
      const list = map.get(ent.layer);
      if (list) {
        list.push(ent);
      } else {
        map.set(ent.layer, [ent]);
      }
    }
    return map;
  }, [layers, scene.entities]);

  // Precomputed snap index for visible DXF layers
  const snapIndex = React.useMemo(
    () => buildSnapGeometryIndex(scene.entities, scene.blocks, visibleLayers),
    [scene.blocks, scene.entities, visibleLayers]
  );

  // World viewport bounding box for entity culling when drawing is large
  const viewportWorldBounds = React.useMemo<WorldBBox>(() => {
    const safeScale = Math.max(scale, 0.0001);
    const minStageX = (0 - position.x) / safeScale;
    const maxStageX = (size.width - position.x) / safeScale;
    const minStageY = (0 - position.y) / safeScale;
    const maxStageY = (size.height - position.y) / safeScale;
    const padX = (maxStageX - minStageX) * 0.15;
    const padY = (maxStageY - minStageY) * 0.15;
    return {
      minX: minStageX - padX,
      maxX: maxStageX + padX,
      minY: -maxStageY - padY,
      maxY: -minStageY + padY,
    };
  }, [position.x, position.y, scale, size.height, size.width]);

  const shouldCull = scene.entities.length > CULL_THRESHOLD;

  // Convert stage pointer position -> DXF model coordinate (with optional snap)
  const getModelPoint = React.useCallback(
    (pointer: Point2D, applySnap: boolean): { point: Point2D; snapRes: SnapResult | null } => {
      const safeScale = Math.max(scale, 0.0001);
      const raw: Point2D = {
        x: (pointer.x - position.x) / safeScale,
        y: -((pointer.y - position.y) / safeScale),
      };
      if (!applySnap) {
        return { point: raw, snapRes: null };
      }
      const res = findSnapCandidate(raw, snapIndex, safeScale, snap, gridStep);
      return {
        point: { x: res.x, y: res.y },
        snapRes: res,
      };
    },
    [gridStep, position.x, position.y, scale, snap, snapIndex]
  );

  const isSnapTool =
    tool !== 'pan' && tool !== 'select' && tool !== 'freehand';

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const zoomBy = 1.12;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
    const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
    const nextScale = Math.max(
      minScale,
      Math.min(maxScale, direction > 0 ? scale * zoomBy : scale / zoomBy)
    );

    const mousePointTo = {
      x: (pointer.x - position.x) / scale,
      y: (pointer.y - position.y) / scale,
    };
    const nextPos = {
      x: pointer.x - mousePointTo.x * nextScale,
      y: pointer.y - mousePointTo.y * nextScale,
    };

    setScale(nextScale);
    setPosition(nextPos);
    setViewportTransform(nextScale, nextPos.x, nextPos.y);
  };

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const isMiddleClick = e.evt.button === 1;
    if (tool === 'pan' || spacePressed || isMiddleClick) {
      e.evt.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = { pointer, pos: { ...position } };
      return;
    }

    if (e.evt.button !== 0) return;

    if (tool === 'select') {
      if (e.target === stage) {
        onSelectAnnotation(null);
      }
      return;
    }

    const { point, snapRes } = getModelPoint(pointer, isSnapTool);
    setSnapIndicator(snapRes);

    // Click-to-place popover tools
    if (tool === 'pin' || tool === 'text') {
      onRequestPinOrText({
        tool,
        point,
        screenPos: { x: pointer.x, y: pointer.y },
      });
      return;
    }

    // Multi-click measurement tools
    if (tool === 'distance') {
      if (!draftShape || draftShape.tool !== 'distance') {
        beginShape({
          tool: 'distance',
          sheet: 'dxf',
          points: [point],
          currentPoint: point,
          color: '#f59e0b',
        });
      } else {
        updateShape({
          ...draftShape,
          points: [draftShape.points[0], point],
          currentPoint: undefined,
        });
        void commitShape();
      }
      return;
    }

    if (tool === 'angle') {
      if (!draftShape || draftShape.tool !== 'angle') {
        beginShape({
          tool: 'angle',
          sheet: 'dxf',
          points: [point],
          currentPoint: point,
          color: '#f59e0b',
        });
      } else if (draftShape.points.length === 1) {
        updateShape({
          ...draftShape,
          points: [draftShape.points[0], point],
          currentPoint: point,
        });
      } else {
        updateShape({
          ...draftShape,
          points: [draftShape.points[0], draftShape.points[1], point],
          currentPoint: undefined,
        });
        void commitShape();
      }
      return;
    }

    if (tool === 'area') {
      if (!draftShape || draftShape.tool !== 'area') {
        beginShape({
          tool: 'area',
          sheet: 'dxf',
          points: [point],
          currentPoint: point,
          color: '#f59e0b',
        });
      } else {
        // Closing click near start vertex if >= 3 points
        const first = draftShape.points[0];
        const distPx = Math.hypot(point.x - first.x, point.y - first.y) * scale;
        if (draftShape.points.length >= 3 && distPx <= 12) {
          updateShape({ ...draftShape, currentPoint: undefined });
          void commitShape();
        } else {
          updateShape({
            ...draftShape,
            points: [...draftShape.points, point],
            currentPoint: point,
          });
        }
      }
      return;
    }

    // Drag-to-draw markup tools
    isDrawingRef.current = true;
    const colorByTool: Record<'arrow' | 'rect' | 'ellipse' | 'cloud' | 'freehand', string> = {
      arrow: '#38bdf8',
      rect: '#0b5fff',
      ellipse: '#a855f7',
      cloud: '#f43f5e',
      freehand: '#22c55e',
    };

    const nextDraft: ShapeDraft = {
      tool,
      sheet: 'dxf',
      points: [point],
      currentPoint: point,
      color: colorByTool[tool],
    };
    beginShape(nextDraft);
  };

  const handleMouseMove = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    if (isPanningRef.current && panStartRef.current) {
      const dx = pointer.x - panStartRef.current.pointer.x;
      const dy = pointer.y - panStartRef.current.pointer.y;
      const nextPos = {
        x: panStartRef.current.pos.x + dx,
        y: panStartRef.current.pos.y + dy,
      };
      setPosition(nextPos);
      setViewportTransform(scale, nextPos.x, nextPos.y);
      return;
    }

    const { point, snapRes } = getModelPoint(pointer, isSnapTool);
    setCursorModelPos(point);
    setSnapIndicator(isSnapTool ? snapRes : null);
    emitRealtimeCursorMove({ x: point.x, y: point.y, sheet: 'dxf' });

    const activeDraft = useViewer2DStore.getState().draftShape;
    if (!activeDraft) return;

    if (
      activeDraft.tool === 'distance' ||
      activeDraft.tool === 'angle' ||
      activeDraft.tool === 'area'
    ) {
      updateShape({ ...activeDraft, currentPoint: point });
      return;
    }

    if (!isDrawingRef.current) return;

    if (activeDraft.tool === 'freehand') {
      const prev = activeDraft.points[activeDraft.points.length - 1];
      if (!prev || Math.hypot(point.x - prev.x, point.y - prev.y) * scale >= 3) {
        updateShape({
          ...activeDraft,
          points: [...activeDraft.points, point],
          currentPoint: undefined,
        });
      }
    } else {
      updateShape({ ...activeDraft, currentPoint: point });
    }
  };

  const handleMouseUp = () => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
      return;
    }

    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    const activeDraft = useViewer2DStore.getState().draftShape;
    if (!activeDraft) return;

    if (activeDraft.tool === 'freehand') {
      if (activeDraft.points.length >= 2) {
        void commitShape();
      } else {
        cancelShape();
      }
      return;
    }

    const endPt = activeDraft.currentPoint;
    const startPt = activeDraft.points[0];
    if (
      startPt &&
      endPt &&
      Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) * scale >= 4
    ) {
      updateShape({
        ...activeDraft,
        points: [startPt, endPt],
        currentPoint: undefined,
      });
      void commitShape();
    } else {
      cancelShape();
    }
  };

  const handleDblClick = () => {
    const activeDraft = useViewer2DStore.getState().draftShape;
    if (activeDraft && activeDraft.tool === 'area' && activeDraft.points.length >= 3) {
      updateShape({ ...activeDraft, currentPoint: undefined });
      void commitShape();
    }
  };

  // Two-finger pan & pinch zoom for trackpads/touchscreens
  const handleTouchMove = (e: Konva.KonvaEventObject<TouchEvent>) => {
    const touches = e.evt.touches;
    if (touches.length !== 2) return;
    e.evt.preventDefault();

    const t1 = touches[0];
    const t2 = touches[1];
    const center = {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

    if (lastTouchDistRef.current !== null && lastTouchCenterRef.current !== null) {
      const rect = containerRef.current?.getBoundingClientRect();
      const relCenter = {
        x: center.x - (rect?.left ?? 0),
        y: center.y - (rect?.top ?? 0),
      };
      const factor = dist / Math.max(lastTouchDistRef.current, 1);
      const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
      const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
      const nextScale = Math.max(minScale, Math.min(maxScale, scale * factor));
      const dx = center.x - lastTouchCenterRef.current.x;
      const dy = center.y - lastTouchCenterRef.current.y;

      const worldPt = {
        x: (relCenter.x - position.x) / scale,
        y: (relCenter.y - position.y) / scale,
      };
      const nextPos = {
        x: relCenter.x - worldPt.x * nextScale + dx,
        y: relCenter.y - worldPt.y * nextScale + dy,
      };
      setScale(nextScale);
      setPosition(nextPos);
      setViewportTransform(nextScale, nextPos.x, nextPos.y);
    }

    lastTouchDistRef.current = dist;
    lastTouchCenterRef.current = center;
  };

  const handleTouchEnd = () => {
    lastTouchDistRef.current = null;
    lastTouchCenterRef.current = null;
  };

  // Optional background snap grid lines
  const gridLines = React.useMemo(() => {
    if (!snap.grid) return null;
    const step = Math.max(gridStep, 0.25);
    const spanX = viewportWorldBounds.maxX - viewportWorldBounds.minX;
    const spanY = viewportWorldBounds.maxY - viewportWorldBounds.minY;
    // Prevent dense grid draw calls when zoomed far out
    if (spanX / step > 140 || spanY / step > 140) return null;

    const lines: Array<[number, number, number, number]> = [];
    const startX = Math.floor(viewportWorldBounds.minX / step) * step;
    const endX = Math.ceil(viewportWorldBounds.maxX / step) * step;
    const startY = Math.floor(viewportWorldBounds.minY / step) * step;
    const endY = Math.ceil(viewportWorldBounds.maxY / step) * step;

    for (let x = startX; x <= endX; x += step) {
      lines.push([x, -startY, x, -endY]);
    }
    for (let y = startY; y <= endY; y += step) {
      lines.push([startX, -y, endX, -y]);
    }
    return lines;
  }, [gridStep, snap.grid, viewportWorldBounds]);

  const invScale = 1 / Math.max(scale, 0.0001);
  const cursorClass =
    tool === 'pan' || spacePressed
      ? 'cursor-grab active:cursor-grabbing'
      : tool === 'select'
        ? 'cursor-default'
        : 'cursor-crosshair';

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-[#0d1117] select-none ${cursorClass}`}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        scaleX={scale}
        scaleY={scale}
        x={position.x}
        y={position.y}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          isPanningRef.current = false;
          setSnapIndicator(null);
        }}
        onDblClick={handleDblClick}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Optional Snap Grid Layer */}
        {gridLines && (
          <Layer listening={false}>
            {gridLines.map((pts, idx) => (
              <Line
                key={idx}
                points={pts}
                stroke="rgba(148, 163, 184, 0.12)"
                strokeWidth={0.75 * invScale}
                listening={false}
                perfectDrawEnabled={false}
              />
            ))}
          </Layer>
        )}

        {/* One Konva <Layer> per DXF layer */}
        {layers.map((layer) => {
          const isVisible = visibleLayers.has(layer.name);
          const layerEntities = entitiesByLayer.get(layer.name) ?? [];
          if (!isVisible) {
            return <Layer key={layer.name} visible={false} listening={false} />;
          }

          return (
            <Layer key={layer.name} visible listening={false}>
              {layerEntities.map((entity, idx) => {
                if (shouldCull) {
                  const box = getEntityApproxBounds(entity);
                  if (!intersectsViewport(box, viewportWorldBounds)) {
                    return null;
                  }
                }
                return renderDxfEntity(
                  entity,
                  `${layer.name}-${entity.handle ?? idx}`,
                  layer.color,
                  scene.blocks,
                  invScale,
                  0,
                  new Set<string>()
                );
              })}
            </Layer>
          );
        })}

        {/* Shared 2D Markup, Measurements & Snap Reticle Overlay */}
        <MarkupOverlayLayer
          annotations={annotations}
          measurements={measurements}
          draftShape={draftShape}
          snapIndicator={snapIndicator}
          selectedAnnotationId={selectedAnnotationId}
          onSelectAnnotation={(id) => onSelectAnnotation(id)}
          scale={scale}
          flipY
          units={bounds.units || scene.units || 'mm'}
        />

        {/* Remote Collaborator Cursors */}
        <RemoteCursors2DLayer sheet="dxf" scale={scale} flipY />
      </Stage>

      {/* Subtle CAD coordinate readout (top-left) */}
      <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-3 rounded-md border border-border/80 bg-[#121721]/90 px-2.5 py-1 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur-xs">
        <span className="text-foreground/90">DXF</span>
        {cursorModelPos && (
          <span>
            X: {cursorModelPos.x.toFixed(2)} · Y: {cursorModelPos.y.toFixed(2)}{' '}
            {bounds.units || scene.units || 'mm'}
          </span>
        )}
        {draftShape?.tool === 'area' && (
          <span className="text-amber-300">
            Click points · double-click or Enter to close
          </span>
        )}
      </div>
    </div>
  );
}
