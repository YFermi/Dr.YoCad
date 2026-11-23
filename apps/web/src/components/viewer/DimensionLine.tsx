import * as React from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { SmartMeasurement, Vec3Tuple } from '@cadline/shared';

interface DimensionLineProps {
  measurement: SmartMeasurement;
  variant: 'preview' | 'pending' | 'related' | 'persisted';
  markerRadius: number;
}

const VARIANT_COLORS: Record<DimensionLineProps['variant'], { line: string; accent: string }> = {
  preview: { line: '#38bdf8', accent: '#7dd3fc' },
  pending: { line: '#0ea5e9', accent: '#38bdf8' },
  related: { line: '#a78bfa', accent: '#c4b5fd' },
  persisted: { line: '#fbbf24', accent: '#f59e0b' },
};

function buildArrowQuaternion(from: Vec3Tuple, to: Vec3Tuple): THREE.Quaternion {
  const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (dir.lengthSq() < 1e-10) {
    return new THREE.Quaternion();
  }
  dir.normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}

function buildCircleRingPoints(
  center: Vec3Tuple,
  axis: Vec3Tuple,
  radius: number,
  segments = 48
): Vec3Tuple[] {
  const n = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
  const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(ref, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();

  const pts: Vec3Tuple[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const c = Math.cos(theta) * radius;
    const s = Math.sin(theta) * radius;
    pts.push([
      center[0] + u.x * c + v.x * s,
      center[1] + u.y * c + v.y * s,
      center[2] + u.z * c + v.z * s,
    ]);
  }
  return pts;
}

function buildBboxEdges(min: Vec3Tuple, max: Vec3Tuple): Array<[Vec3Tuple, Vec3Tuple]> {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    [[x0, y0, z0], [x1, y0, z0]],
    [[x1, y0, z0], [x1, y1, z0]],
    [[x1, y1, z0], [x0, y1, z0]],
    [[x0, y1, z0], [x0, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1]],
    [[x1, y0, z1], [x1, y1, z1]],
    [[x1, y1, z1], [x0, y1, z1]],
    [[x0, y1, z1], [x0, y0, z1]],
    [[x0, y0, z0], [x0, y0, z1]],
    [[x1, y0, z0], [x1, y0, z1]],
    [[x1, y1, z0], [x1, y1, z1]],
    [[x0, y1, z0], [x0, y1, z1]],
  ];
}

/**
 * Pure 3D dimension-line renderer (anchor spheres, arrows, circle rings,
 * angle rays, bounding box wireframes). Floating DOM labels are projected
 * separately via MeasureOverlay's React-19-safe DOM overlay.
 */
export function DimensionLine({ measurement, variant, markerRadius }: DimensionLineProps) {
  const palette = VARIANT_COLORS[variant];
  const isDashed = variant === 'preview' || variant === 'related';
  const lineWidth = variant === 'persisted' ? 2.5 : variant === 'pending' ? 3 : 2;
  const coneRadius = markerRadius * 0.72;
  const coneHeight = markerRadius * 2.2;

  const circleRing = React.useMemo(() => {
    if (
      (measurement.kind === 'diameter' || measurement.kind === 'radius') &&
      measurement.radius &&
      measurement.radius > 0.05
    ) {
      return buildCircleRingPoints(
        measurement.anchor,
        measurement.axis ?? [0, 0, 1],
        measurement.radius
      );
    }
    return null;
  }, [measurement.kind, measurement.anchor, measurement.axis, measurement.radius]);

  const bboxEdges = React.useMemo(() => {
    if (measurement.kind === 'bbox' && measurement.bboxMin && measurement.bboxMax) {
      return buildBboxEdges(measurement.bboxMin, measurement.bboxMax);
    }
    return null;
  }, [measurement.kind, measurement.bboxMin, measurement.bboxMax]);

  // Bounding box wireframe rendering
  if (bboxEdges) {
    return (
      <group>
        {bboxEdges.map((seg, idx) => (
          <Line
            key={idx}
            points={seg}
            color={palette.line}
            lineWidth={1.8}
            dashed
            dashSize={markerRadius * 2.5}
            gapSize={markerRadius * 1.5}
          />
        ))}
        <mesh position={measurement.anchor} raycast={() => undefined}>
          <sphereGeometry args={[markerRadius * 0.85, 14, 14]} />
          <meshBasicMaterial color={palette.accent} depthTest={false} />
        </mesh>
      </group>
    );
  }

  // Angle rendering (3-point or 2-plane vertex rays)
  if (
    measurement.kind === 'angle' &&
    measurement.lineStart &&
    measurement.angleVertex &&
    measurement.lineEnd
  ) {
    return (
      <group>
        <Line
          points={[measurement.lineStart, measurement.angleVertex, measurement.lineEnd]}
          color={palette.line}
          lineWidth={lineWidth}
          dashed={isDashed}
          dashSize={markerRadius * 2}
          gapSize={markerRadius}
        />
        {[measurement.lineStart, measurement.angleVertex, measurement.lineEnd].map((pt, idx) => (
          <mesh key={idx} position={pt} raycast={() => undefined}>
            <sphereGeometry args={[markerRadius * 0.8, 14, 14]} />
            <meshBasicMaterial color={palette.accent} depthTest={false} />
          </mesh>
        ))}
      </group>
    );
  }

  // Linear / Diameter / Center-to-Center / Min-Wall rendering
  const hasSegment = Boolean(measurement.lineStart && measurement.lineEnd);
  const start = measurement.lineStart;
  const end = measurement.lineEnd;
  const segLen =
    start && end
      ? Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2])
      : 0;
  const showArrows = hasSegment && segLen > coneHeight * 2.4;

  return (
    <group>
      {circleRing && (
        <Line
          points={circleRing}
          color={variant === 'persisted' ? '#fbbf24' : '#22c55e'}
          lineWidth={2.5}
        />
      )}

      {hasSegment && start && end && (
        <>
          <Line
            points={[start, end]}
            color={palette.line}
            lineWidth={lineWidth}
            dashed={isDashed}
            dashSize={markerRadius * 2}
            gapSize={markerRadius}
          />

          <mesh position={start} raycast={() => undefined}>
            <sphereGeometry args={[markerRadius * 0.65, 12, 12]} />
            <meshBasicMaterial color={palette.accent} depthTest={false} />
          </mesh>
          <mesh position={end} raycast={() => undefined}>
            <sphereGeometry args={[markerRadius * 0.65, 12, 12]} />
            <meshBasicMaterial color={palette.accent} depthTest={false} />
          </mesh>

          {showArrows && (
            <>
              <mesh
                position={start}
                quaternion={buildArrowQuaternion(end, start)}
                raycast={() => undefined}
              >
                <coneGeometry args={[coneRadius, coneHeight, 10]} />
                <meshBasicMaterial color={palette.line} depthTest={false} />
              </mesh>
              <mesh
                position={end}
                quaternion={buildArrowQuaternion(start, end)}
                raycast={() => undefined}
              >
                <coneGeometry args={[coneRadius, coneHeight, 10]} />
                <meshBasicMaterial color={palette.line} depthTest={false} />
              </mesh>
            </>
          )}
        </>
      )}

      {!hasSegment && (
        <mesh position={measurement.anchor} raycast={() => undefined}>
          <sphereGeometry args={[markerRadius * 0.85, 14, 14]} />
          <meshBasicMaterial color={palette.accent} depthTest={false} />
        </mesh>
      )}
    </group>
  );
}
