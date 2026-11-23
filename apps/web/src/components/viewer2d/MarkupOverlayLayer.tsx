import * as React from 'react';
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Layer,
  Line,
  Rect,
  Text,
} from 'react-konva';
import {
  MeasurementType,
  isAnnotationAnchor2D,
  isMeasurementPoints2D,
  normalizeAnnotationAnchor,
  type Annotation,
  type AnnotationShape2D,
  type Measurement,
  type Point2D,
} from '@cadline/shared';
import type { ShapeDraft } from '@/stores/viewer2dStore';
import {
  computeAngle2DDeg,
  computeDistance2D,
  computePolygonArea2D,
  type SnapResult,
} from '@/components/viewer2d/snapping';
import { isAnnotationResolved } from '@/components/viewer/AnnotationsLayer';
import { usePresenceStore } from '@/stores/presenceStore';

interface MarkupOverlayLayerProps {
  annotations: Annotation[];
  measurements: Measurement[];
  draftShape: ShapeDraft | null;
  snapIndicator: SnapResult | null;
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string) => void;
  scale: number;
  flipY?: boolean;
  pageYOffsets?: Map<number, number>;
  units: string;
}

function toStagePoint(
  pt: Point2D,
  flipY: boolean,
  pageOffsetY: number
): Point2D {
  return {
    x: pt.x,
    y: flipY ? -pt.y : pt.y + pageOffsetY,
  };
}

/**
 * Generates scalloped polyline points forming a CAD-style revision cloud
 * around the rectangle defined by two opposite corners in stage coordinates.
 */
function buildRevisionCloudPoints(
  p1: Point2D,
  p2: Point2D,
  scallopLength: number
): number[] {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const width = Math.max(maxX - minX, 0.001);
  const height = Math.max(maxY - minY, 0.001);

  const perimeter = 2 * (width + height);
  const safeScallop = Math.max(
    Math.min(scallopLength, Math.min(width, height) * 0.45),
    perimeter / 64
  );

  const corners: Point2D[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];

  const coords: number[] = [];
  const samplesPerArc = 6;

  for (let edge = 0; edge < 4; edge += 1) {
    const start = corners[edge];
    const end = corners[(edge + 1) % 4];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    const count = Math.max(2, Math.round(len / safeScallop));
    const ux = dx / len;
    const uy = dy / len;
    // Outward normal for clockwise rectangle (minX,minY -> maxX,minY -> maxX,maxY -> minX,maxY)
    const nx = uy;
    const ny = -ux;
    const segLen = len / count;
    const bulgeRadius = segLen * 0.42;

    for (let i = 0; i < count; i += 1) {
      const sx = start.x + ux * (i * segLen);
      const sy = start.y + uy * (i * segLen);
      const ex = start.x + ux * ((i + 1) * segLen);
      const ey = start.y + uy * ((i + 1) * segLen);
      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;

      for (let s = 0; s < samplesPerArc; s += 1) {
        const t = s / samplesPerArc;
        const theta = Math.PI * (1 - t); // pi -> 0
        const along = (t - 0.5) * segLen;
        const out = Math.sin(theta) * bulgeRadius;
        coords.push(mx + ux * along + nx * out, my + uy * along + ny * out);
      }
    }
  }

  return coords;
}

function renderShape2D(
  shape: AnnotationShape2D,
  invScale: number,
  flipY: boolean,
  pageOffsetY: number,
  isSelected: boolean,
  onSelect: () => void,
  key: string
): React.ReactNode {
  const baseColor = shape.color ?? '#0b5fff';
  const strokeWidth = (shape.strokeWidth ?? 2) * invScale * (isSelected ? 1.65 : 1);
  const pts = (shape.points ?? []).map((p) => toStagePoint(p, flipY, pageOffsetY));

  const commonProps = {
    onClick: onSelect,
    onTap: onSelect,
    hitStrokeWidth: Math.max(12 * invScale, strokeWidth * 2),
    shadowColor: isSelected ? '#38bdf8' : undefined,
    shadowBlur: isSelected ? 12 : 0,
    shadowOpacity: isSelected ? 0.9 : 0,
  };

  switch (shape.shapeType) {
    case 'arrow': {
      if (pts.length < 2) return null;
      const p1 = pts[0];
      const p2 = pts[1];
      return (
        <Arrow
          key={key}
          {...commonProps}
          points={[p1.x, p1.y, p2.x, p2.y]}
          stroke={baseColor}
          fill={baseColor}
          strokeWidth={strokeWidth}
          pointerLength={11 * invScale}
          pointerWidth={9 * invScale}
          lineCap="round"
          lineJoin="round"
        />
      );
    }

    case 'rect': {
      if (pts.length < 2) return null;
      const x = Math.min(pts[0].x, pts[1].x);
      const y = Math.min(pts[0].y, pts[1].y);
      const width = Math.abs(pts[1].x - pts[0].x);
      const height = Math.abs(pts[1].y - pts[0].y);
      return (
        <Rect
          key={key}
          {...commonProps}
          x={x}
          y={y}
          width={Math.max(width, 0.5 * invScale)}
          height={Math.max(height, 0.5 * invScale)}
          stroke={baseColor}
          strokeWidth={strokeWidth}
          fill={isSelected ? 'rgba(56, 189, 248, 0.14)' : 'rgba(11, 95, 255, 0.08)'}
        />
      );
    }

    case 'ellipse': {
      if (pts.length < 2) return null;
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const rx = Math.max(Math.abs(pts[1].x - pts[0].x) / 2, 0.5 * invScale);
      const ry = Math.max(Math.abs(pts[1].y - pts[0].y) / 2, 0.5 * invScale);
      return (
        <Ellipse
          key={key}
          {...commonProps}
          x={cx}
          y={cy}
          radiusX={rx}
          radiusY={ry}
          stroke={baseColor}
          strokeWidth={strokeWidth}
          fill={isSelected ? 'rgba(56, 189, 248, 0.14)' : 'rgba(11, 95, 255, 0.08)'}
        />
      );
    }

    case 'cloud': {
      if (pts.length < 2) return null;
      const cloudCoords = buildRevisionCloudPoints(pts[0], pts[1], 18 * invScale);
      return (
        <Line
          key={key}
          {...commonProps}
          points={cloudCoords}
          closed
          stroke={baseColor}
          strokeWidth={strokeWidth}
          fill={isSelected ? 'rgba(244, 63, 94, 0.14)' : 'rgba(244, 63, 94, 0.06)'}
          lineJoin="round"
        />
      );
    }

    case 'freehand': {
      if (pts.length < 2) return null;
      const flat: number[] = [];
      for (const p of pts) {
        flat.push(p.x, p.y);
      }
      return (
        <Line
          key={key}
          {...commonProps}
          points={flat}
          stroke={baseColor}
          strokeWidth={strokeWidth}
          tension={0.35}
          lineCap="round"
          lineJoin="round"
        />
      );
    }

    case 'text': {
      const origin = pts[0] ?? toStagePoint({ x: shape.x ?? 0, y: shape.y ?? 0 }, flipY, pageOffsetY);
      const textValue = shape.text || 'Note';
      const fontSize = (shape.fontSize ?? 13) * invScale;
      const padX = 7 * invScale;
      const padY = 4 * invScale;
      const approxWidth = Math.max(textValue.length * fontSize * 0.62 + padX * 2, 40 * invScale);
      const approxHeight = fontSize * 1.35 + padY * 2;
      return (
        <Group
          key={key}
          x={origin.x}
          y={origin.y}
          onClick={onSelect}
          onTap={onSelect}
        >
          <Rect
            x={0}
            y={-approxHeight / 2}
            width={approxWidth}
            height={approxHeight}
            cornerRadius={4 * invScale}
            fill="rgba(18, 23, 33, 0.92)"
            stroke={isSelected ? '#38bdf8' : baseColor}
            strokeWidth={(isSelected ? 2 : 1.2) * invScale}
            shadowColor={isSelected ? '#38bdf8' : '#000000'}
            shadowBlur={isSelected ? 10 : 4}
          />
          <Text
            x={padX}
            y={-approxHeight / 2 + padY}
            text={textValue}
            fontSize={fontSize}
            fontFamily="Inter, system-ui, sans-serif"
            fontStyle="600"
            fill="#f8fafc"
          />
        </Group>
      );
    }

    default:
      return null;
  }
}

export function MarkupOverlayLayer({
  annotations,
  measurements,
  draftShape,
  snapIndicator,
  selectedAnnotationId,
  onSelectAnnotation,
  scale,
  flipY = false,
  pageYOffsets,
  units,
}: MarkupOverlayLayerProps) {
  const recentAnnotationIds = usePresenceStore((s) => s.recentAnnotationIds);
  const safeScale = Math.max(scale, 0.0001);
  const invScale = 1 / safeScale;

  const getPageOffset = (page?: number): number => {
    if (!pageYOffsets) return 0;
    return pageYOffsets.get(page ?? 1) ?? 0;
  };

  return (
    <Layer>
      {/* Persisted 2D Measurements */}
      {measurements.map((m) => {
        if (!isMeasurementPoints2D(m.points)) return null;
        const pageOffset = getPageOffset(m.points.page);
        const pts = m.points.points2d.map((p) => toStagePoint(p, flipY, pageOffset));
        if (pts.length < 2) return null;

        const amber = '#f59e0b';
        const strokeWidth = 1.6 * invScale;
        const fontSize = 11 * invScale;

        if (m.type === MeasurementType.AREA && pts.length >= 3) {
          const flat: number[] = [];
          let cx = 0;
          let cy = 0;
          for (const p of pts) {
            flat.push(p.x, p.y);
            cx += p.x;
            cy += p.y;
          }
          cx /= pts.length;
          cy /= pts.length;
          const label = `${m.value.toFixed(2)} ${m.unit}`;
          const pillW = (label.length * 6.8 + 14) * invScale;
          const pillH = 20 * invScale;

          return (
            <Group key={m.id} listening={false}>
              <Line
                points={flat}
                closed
                stroke={amber}
                strokeWidth={strokeWidth}
                dash={[6 * invScale, 4 * invScale]}
                fill="rgba(245, 158, 11, 0.14)"
              />
              {pts.map((p, idx) => (
                <Circle
                  key={`${m.id}-v-${idx}`}
                  x={p.x}
                  y={p.y}
                  radius={3.5 * invScale}
                  fill={amber}
                  stroke="#0d1117"
                  strokeWidth={1 * invScale}
                />
              ))}
              <Rect
                x={cx - pillW / 2}
                y={cy - pillH / 2}
                width={pillW}
                height={pillH}
                cornerRadius={4 * invScale}
                fill="rgba(18, 23, 33, 0.92)"
                stroke={amber}
                strokeWidth={1 * invScale}
              />
              <Text
                x={cx - pillW / 2}
                y={cy - fontSize * 0.55}
                width={pillW}
                align="center"
                text={label}
                fontSize={fontSize}
                fontFamily="JetBrains Mono, monospace"
                fontStyle="bold"
                fill="#fcd34d"
              />
            </Group>
          );
        }

        if (m.type === MeasurementType.ANGLE && pts.length >= 3) {
          const [p1, vertex, p3] = pts;
          const label = `${m.value.toFixed(1)}${m.unit}`;
          const pillW = (label.length * 7 + 14) * invScale;
          const pillH = 20 * invScale;
          const bisectorX = (p1.x + p3.x) / 2;
          const bisectorY = (p1.y + p3.y) / 2;
          const lx = vertex.x + (bisectorX - vertex.x) * 0.38;
          const ly = vertex.y + (bisectorY - vertex.y) * 0.38;

          return (
            <Group key={m.id} listening={false}>
              <Line
                points={[p1.x, p1.y, vertex.x, vertex.y, p3.x, p3.y]}
                stroke={amber}
                strokeWidth={strokeWidth}
                dash={[5 * invScale, 3 * invScale]}
              />
              {[p1, vertex, p3].map((p, idx) => (
                <Circle
                  key={`${m.id}-a-${idx}`}
                  x={p.x}
                  y={p.y}
                  radius={3.5 * invScale}
                  fill={amber}
                  stroke="#0d1117"
                  strokeWidth={1 * invScale}
                />
              ))}
              <Rect
                x={lx - pillW / 2}
                y={ly - pillH / 2}
                width={pillW}
                height={pillH}
                cornerRadius={4 * invScale}
                fill="rgba(18, 23, 33, 0.92)"
                stroke={amber}
                strokeWidth={1 * invScale}
              />
              <Text
                x={lx - pillW / 2}
                y={ly - fontSize * 0.55}
                width={pillW}
                align="center"
                text={label}
                fontSize={fontSize}
                fontFamily="JetBrains Mono, monospace"
                fontStyle="bold"
                fill="#fcd34d"
              />
            </Group>
          );
        }

        // DISTANCE (default)
        const [p1, p2] = pts;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const label = `${m.value.toFixed(2)} ${m.unit}`;
        const pillW = (label.length * 6.8 + 14) * invScale;
        const pillH = 20 * invScale;

        return (
          <Group key={m.id} listening={false}>
            <Line
              points={[p1.x, p1.y, p2.x, p2.y]}
              stroke={amber}
              strokeWidth={strokeWidth}
            />
            <Circle
              x={p1.x}
              y={p1.y}
              radius={3.5 * invScale}
              fill={amber}
              stroke="#0d1117"
              strokeWidth={1 * invScale}
            />
            <Circle
              x={p2.x}
              y={p2.y}
              radius={3.5 * invScale}
              fill={amber}
              stroke="#0d1117"
              strokeWidth={1 * invScale}
            />
            <Rect
              x={mx - pillW / 2}
              y={my - pillH / 2 - 12 * invScale}
              width={pillW}
              height={pillH}
              cornerRadius={4 * invScale}
              fill="rgba(18, 23, 33, 0.92)"
              stroke={amber}
              strokeWidth={1 * invScale}
            />
            <Text
              x={mx - pillW / 2}
              y={my - fontSize * 0.55 - 12 * invScale}
              width={pillW}
              align="center"
              text={label}
              fontSize={fontSize}
              fontFamily="JetBrains Mono, monospace"
              fontStyle="bold"
              fill="#fcd34d"
            />
          </Group>
        );
      })}

      {/* Persisted 2D Annotations (markups + pins) */}
      {annotations.map((ann, idx) => {
        const anchor = normalizeAnnotationAnchor(ann.payload?.anchor);
        if (!isAnnotationAnchor2D(anchor)) return null;

        const pageOffset = getPageOffset(anchor.page);
        const isSelected = selectedAnnotationId === ann.id;
        const isPulsing = Boolean(recentAnnotationIds[ann.id]);
        const resolved = isAnnotationResolved(ann);
        const shape = ann.payload?.shape;
        const pinPos = toStagePoint({ x: anchor.x, y: anchor.y }, flipY, pageOffset);

        const handleSelect = () => onSelectAnnotation(ann.id);

        return (
          <Group key={ann.id}>
            {shape && shape.shapeType !== 'pin'
              ? renderShape2D(
                  shape,
                  invScale,
                  flipY,
                  pageOffset,
                  isSelected || isPulsing,
                  handleSelect,
                  `${ann.id}-shape`
                )
              : null}

            {/* Numbered pin badge for PIN annotations, or compact anchor badge for selected/new shapes */}
            {(!shape || shape.shapeType === 'pin' || isSelected || isPulsing) && (
              <Group
                x={pinPos.x}
                y={pinPos.y}
                onClick={handleSelect}
                onTap={handleSelect}
              >
                {(isSelected || isPulsing) && (
                  <Circle
                    radius={(isPulsing ? 20 : 16) * invScale}
                    stroke="#38bdf8"
                    strokeWidth={2 * invScale}
                    fill={
                      isPulsing
                        ? 'rgba(56, 189, 248, 0.32)'
                        : 'rgba(56, 189, 248, 0.2)'
                    }
                  />
                )}
                <Circle
                  radius={11 * invScale}
                  fill={resolved ? '#059669' : '#0b5fff'}
                  stroke={isSelected ? '#ffffff' : '#0d1117'}
                  strokeWidth={(isSelected ? 2.2 : 1.5) * invScale}
                  shadowColor="#000000"
                  shadowBlur={6}
                  shadowOpacity={0.6}
                />
                <Text
                  x={-11 * invScale}
                  y={-5.5 * invScale}
                  width={22 * invScale}
                  align="center"
                  text={String(idx + 1)}
                  fontSize={10.5 * invScale}
                  fontFamily="JetBrains Mono, monospace"
                  fontStyle="bold"
                  fill="#ffffff"
                  listening={false}
                />
              </Group>
            )}
          </Group>
        );
      })}

      {/* Live Draft Shape / Measurement Preview */}
      {draftShape && (() => {
        const pageOffset = getPageOffset(draftShape.page);
        const rawPoints = draftShape.currentPoint
          ? [...draftShape.points, draftShape.currentPoint]
          : draftShape.points;
        const stagePts = rawPoints.map((p) => toStagePoint(p, flipY, pageOffset));
        if (stagePts.length === 0) return null;

        const strokeW = 1.8 * invScale;
        const fontSize = 11 * invScale;

        if (draftShape.tool === 'distance' && stagePts.length >= 2) {
          const p1 = stagePts[0];
          const p2 = stagePts[1];
          const dist = computeDistance2D(rawPoints[0], rawPoints[1]);
          const label = `${dist.toFixed(2)} ${units}`;
          const pillW = (label.length * 6.8 + 14) * invScale;
          const pillH = 20 * invScale;
          const mx = (p1.x + p2.x) / 2;
          const my = (p1.y + p2.y) / 2;

          return (
            <Group listening={false}>
              <Line
                points={[p1.x, p1.y, p2.x, p2.y]}
                stroke="#fbbf24"
                strokeWidth={strokeW}
                dash={[6 * invScale, 4 * invScale]}
              />
              <Circle x={p1.x} y={p1.y} radius={4 * invScale} fill="#fbbf24" />
              <Circle x={p2.x} y={p2.y} radius={4 * invScale} fill="#fbbf24" />
              <Rect
                x={mx - pillW / 2}
                y={my - pillH / 2 - 14 * invScale}
                width={pillW}
                height={pillH}
                cornerRadius={4 * invScale}
                fill="rgba(18, 23, 33, 0.94)"
                stroke="#fbbf24"
                strokeWidth={1 * invScale}
              />
              <Text
                x={mx - pillW / 2}
                y={my - fontSize * 0.55 - 14 * invScale}
                width={pillW}
                align="center"
                text={label}
                fontSize={fontSize}
                fontFamily="JetBrains Mono, monospace"
                fontStyle="bold"
                fill="#fef08a"
              />
            </Group>
          );
        }

        if (draftShape.tool === 'angle' && stagePts.length >= 2) {
          const flat: number[] = [];
          for (const p of stagePts) flat.push(p.x, p.y);
          const angleDeg =
            rawPoints.length >= 3
              ? computeAngle2DDeg(rawPoints[0], rawPoints[1], rawPoints[2])
              : null;

          return (
            <Group listening={false}>
              <Line
                points={flat}
                stroke="#fbbf24"
                strokeWidth={strokeW}
                dash={[5 * invScale, 3 * invScale]}
              />
              {stagePts.map((p, i) => (
                <Circle key={i} x={p.x} y={p.y} radius={4 * invScale} fill="#fbbf24" />
              ))}
              {angleDeg !== null && stagePts[1] && (
                <Group x={stagePts[1].x + 10 * invScale} y={stagePts[1].y - 20 * invScale}>
                  <Rect
                    width={54 * invScale}
                    height={20 * invScale}
                    cornerRadius={4 * invScale}
                    fill="rgba(18, 23, 33, 0.94)"
                    stroke="#fbbf24"
                    strokeWidth={1 * invScale}
                  />
                  <Text
                    y={4 * invScale}
                    width={54 * invScale}
                    align="center"
                    text={`${angleDeg.toFixed(1)}°`}
                    fontSize={fontSize}
                    fontFamily="JetBrains Mono, monospace"
                    fontStyle="bold"
                    fill="#fef08a"
                  />
                </Group>
              )}
            </Group>
          );
        }

        if (draftShape.tool === 'area') {
          const flat: number[] = [];
          for (const p of stagePts) flat.push(p.x, p.y);
          const areaVal = rawPoints.length >= 3 ? computePolygonArea2D(rawPoints) : 0;
          const last = stagePts[stagePts.length - 1];

          return (
            <Group listening={false}>
              <Line
                points={flat}
                closed={stagePts.length >= 3}
                stroke="#fbbf24"
                strokeWidth={strokeW}
                dash={[6 * invScale, 4 * invScale]}
                fill={stagePts.length >= 3 ? 'rgba(251, 191, 36, 0.14)' : undefined}
              />
              {stagePts.map((p, i) => (
                <Circle
                  key={i}
                  x={p.x}
                  y={p.y}
                  radius={(i === 0 ? 5 : 3.5) * invScale}
                  fill={i === 0 ? '#10b981' : '#fbbf24'}
                />
              ))}
              {rawPoints.length >= 3 && last && (
                <Group x={last.x + 10 * invScale} y={last.y - 22 * invScale}>
                  <Rect
                    width={92 * invScale}
                    height={20 * invScale}
                    cornerRadius={4 * invScale}
                    fill="rgba(18, 23, 33, 0.94)"
                    stroke="#fbbf24"
                    strokeWidth={1 * invScale}
                  />
                  <Text
                    y={4 * invScale}
                    width={92 * invScale}
                    align="center"
                    text={`${areaVal.toFixed(1)} ${units}²`}
                    fontSize={fontSize}
                    fontFamily="JetBrains Mono, monospace"
                    fontStyle="bold"
                    fill="#fef08a"
                  />
                </Group>
              )}
            </Group>
          );
        }

        if (
          draftShape.tool === 'arrow' ||
          draftShape.tool === 'rect' ||
          draftShape.tool === 'ellipse' ||
          draftShape.tool === 'cloud' ||
          draftShape.tool === 'freehand'
        ) {
          const previewShape: AnnotationShape2D = {
            shapeType: draftShape.tool,
            color: draftShape.color,
            strokeWidth: 2,
            points: rawPoints,
          };
          return (
            <Group listening={false} opacity={0.9}>
              {renderShape2D(
                previewShape,
                invScale,
                flipY,
                pageOffset,
                false,
                () => undefined,
                'draft-preview'
              )}
            </Group>
          );
        }

        return null;
      })()}

      {/* Snap Indicator Reticle */}
      {snapIndicator && snapIndicator.snapped && (() => {
        const sp = toStagePoint(
          { x: snapIndicator.x, y: snapIndicator.y },
          flipY,
          0
        );
        const r = 6 * invScale;
        const sw = 1.6 * invScale;
        const labelMap: Record<Exclude<SnapResult['snapped'], null>, string> = {
          endpoint: 'END',
          midpoint: 'MID',
          intersection: 'INT',
          grid: 'GRID',
        };
        const colorMap: Record<Exclude<SnapResult['snapped'], null>, string> = {
          endpoint: '#10b981',
          midpoint: '#38bdf8',
          intersection: '#f59e0b',
          grid: '#818cf8',
        };
        const color = colorMap[snapIndicator.snapped];
        const tag = labelMap[snapIndicator.snapped];

        return (
          <Group x={sp.x} y={sp.y} listening={false}>
            {snapIndicator.snapped === 'endpoint' && (
              <Rect
                x={-r}
                y={-r}
                width={r * 2}
                height={r * 2}
                stroke={color}
                strokeWidth={sw}
              />
            )}
            {snapIndicator.snapped === 'midpoint' && (
              <Line
                points={[0, -r * 1.2, r * 1.1, r, -r * 1.1, r]}
                closed
                stroke={color}
                strokeWidth={sw}
              />
            )}
            {snapIndicator.snapped === 'intersection' && (
              <>
                <Line points={[-r, -r, r, r]} stroke={color} strokeWidth={sw} />
                <Line points={[-r, r, r, -r]} stroke={color} strokeWidth={sw} />
              </>
            )}
            {snapIndicator.snapped === 'grid' && (
              <>
                <Line points={[-r, 0, r, 0]} stroke={color} strokeWidth={sw} />
                <Line points={[0, -r, 0, r]} stroke={color} strokeWidth={sw} />
              </>
            )}
            <Text
              x={r + 4 * invScale}
              y={-r - 2 * invScale}
              text={tag}
              fontSize={9 * invScale}
              fontFamily="JetBrains Mono, monospace"
              fontStyle="bold"
              fill={color}
            />
          </Group>
        );
      })()}
    </Layer>
  );
}
