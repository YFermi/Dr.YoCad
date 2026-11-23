import * as React from 'react';
import { Circle, Group, Layer, Rect, Text } from 'react-konva';
import { useCursorStore } from '@/stores/cursorStore';

interface RemoteCursors2DLayerProps {
  sheet: 'dxf' | 'pdf';
  scale: number;
  flipY?: boolean;
  pageYOffsets?: Map<number, number>;
}

/**
 * Dedicated non-interactive Konva layer rendering remote collaborator cursors
 * as a colored circle + name tag at fixed screen-space pixel sizes.
 */
export function RemoteCursors2DLayer({
  sheet,
  scale,
  flipY = false,
  pageYOffsets,
}: RemoteCursors2DLayerProps) {
  const cursors = useCursorStore((s) => s.cursors);
  const invScale = 1 / Math.max(scale, 0.0001);

  const visibleCursors = React.useMemo(
    () =>
      Object.values(cursors).filter(
        (c) => c.z === undefined && (!c.sheet || c.sheet === sheet)
      ),
    [cursors, sheet]
  );

  if (visibleCursors.length === 0) {
    return null;
  }

  return (
    <Layer listening={false}>
      {visibleCursors.map((cursor) => {
        const pageOffset =
          sheet === 'pdf' && pageYOffsets
            ? (pageYOffsets.get(cursor.page ?? 1) ?? 0)
            : 0;
        const sx = cursor.x;
        const sy = flipY ? -cursor.y : cursor.y + pageOffset;

        const firstName = cursor.name.split(' ')[0] || cursor.name;
        const fontSize = 10 * invScale;
        const padX = 5 * invScale;
        const padY = 2.5 * invScale;
        const tagW = Math.max(firstName.length * fontSize * 0.62 + padX * 2, 34 * invScale);
        const tagH = fontSize + padY * 2;

        return (
          <Group key={cursor.userId} x={sx} y={sy} listening={false}>
            {/* Outer cursor ring */}
            <Circle
              radius={6 * invScale}
              fill={cursor.color}
              stroke="#ffffff"
              strokeWidth={1.6 * invScale}
              shadowColor="#000000"
              shadowBlur={4}
              shadowOpacity={0.5}
              perfectDrawEnabled={false}
            />
            {/* Name tag pill beside cursor */}
            <Rect
              x={8 * invScale}
              y={6 * invScale}
              width={tagW}
              height={tagH}
              cornerRadius={3 * invScale}
              fill={cursor.color}
              shadowColor="#000000"
              shadowBlur={4}
              shadowOpacity={0.45}
              perfectDrawEnabled={false}
            />
            <Text
              x={8 * invScale + padX}
              y={6 * invScale + padY}
              text={firstName}
              fontSize={fontSize}
              fontFamily="Inter, system-ui, sans-serif"
              fontStyle="600"
              fill="#ffffff"
              perfectDrawEnabled={false}
            />
          </Group>
        );
      })}
    </Layer>
  );
}
