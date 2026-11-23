import * as React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  isAnnotationAnchor3D,
  normalizeAnnotationAnchor,
  type Annotation,
} from '@cadline/shared';
import { useViewerStore } from '@/stores/viewerStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { cn } from '@/lib/utils';

export function isAnnotationResolved(annotation: Annotation): boolean {
  const total = annotation.commentCount ?? 0;
  const resolved = annotation.resolvedCommentCount ?? 0;
  return total > 0 && resolved >= total;
}

interface AnnotationsLayerProps {
  versionId?: string;
  markerRadius: number;
  pinElementsRef: React.RefObject<Map<string, HTMLButtonElement>>;
  draftPinRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Renders 3D surface anchor markers inside <Canvas> and projects every pin's
 * world coordinate into 2D viewport pixels inside useFrame (React-19-safe;
 * avoids drei <Html> nested createRoot/unmount races).
 */
export function AnnotationsLayer({
  versionId,
  markerRadius,
  pinElementsRef,
  draftPinRef,
}: AnnotationsLayerProps) {
  const { camera, size } = useThree();
  const annotations = useViewerStore((s) => s.annotations);
  const selectedAnnotationId = useViewerStore((s) => s.selectedAnnotationId);
  const annotationDraft = useViewerStore((s) => s.annotationDraft);
  const projectedVecRef = React.useRef(new THREE.Vector3());

  const visibleAnnotations = React.useMemo(() => {
    const list = annotations ?? [];
    if (!versionId) return list;
    return list.filter((a) => a.versionId === versionId);
  }, [annotations, versionId]);

  useFrame(() => {
    const vec = projectedVecRef.current;
    const pinMap = pinElementsRef.current;

    if (pinMap) {
      for (const ann of visibleAnnotations) {
        const el = pinMap.get(ann.id);
        if (!el) continue;

        const anchor = ann.payload?.anchor
          ? normalizeAnnotationAnchor(ann.payload.anchor)
          : null;
        if (!isAnnotationAnchor3D(anchor)) {
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
          continue;
        }
        const pos = anchor.position;

        vec.set(pos[0], pos[1], pos[2]).project(camera);
        if (vec.z > 1 || vec.z < -1) {
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
          continue;
        }

        const x = (vec.x * 0.5 + 0.5) * size.width;
        const y = (-vec.y * 0.5 + 0.5) * size.height;
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
        el.style.opacity = '1';
        el.style.pointerEvents = 'auto';
      }
    }

    const draftEl = draftPinRef.current;
    if (draftEl && annotationDraft) {
      const pos = annotationDraft.anchor.position;
      vec.set(pos[0], pos[1], pos[2]).project(camera);
      if (vec.z > 1 || vec.z < -1) {
        draftEl.style.opacity = '0';
      } else {
        const x = (vec.x * 0.5 + 0.5) * size.width;
        const y = (-vec.y * 0.5 + 0.5) * size.height;
        draftEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
        draftEl.style.opacity = '1';
      }
    }
  });

  const anchorRadius = Math.max(markerRadius * 0.85, 0.45);

  return (
    <group>
      {visibleAnnotations.map((ann) => {
        const anchor = ann.payload?.anchor
          ? normalizeAnnotationAnchor(ann.payload.anchor)
          : null;
        if (!isAnnotationAnchor3D(anchor)) return null;
        const pos = anchor.position;
        const resolved = isAnnotationResolved(ann);
        const selected = ann.id === selectedAnnotationId;
        const color = resolved ? '#10b981' : '#0b5fff';

        return (
          <mesh key={ann.id} position={[pos[0], pos[1], pos[2]]} raycast={() => undefined}>
            <sphereGeometry args={[selected ? anchorRadius * 1.3 : anchorRadius, 14, 14]} />
            <meshBasicMaterial color={color} />
          </mesh>
        );
      })}

      {annotationDraft && (
        <mesh
          position={[
            annotationDraft.anchor.position[0],
            annotationDraft.anchor.position[1],
            annotationDraft.anchor.position[2],
          ]}
          raycast={() => undefined}
        >
          <sphereGeometry args={[anchorRadius * 1.35, 16, 16]} />
          <meshBasicMaterial color="#f59e0b" />
        </mesh>
      )}
    </group>
  );
}

interface AnnotationsPinOverlayProps {
  versionId?: string;
  pinElementsRef: React.RefObject<Map<string, HTMLButtonElement>>;
  draftPinRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Interactive 2D DOM pin layer synced with 3D anchors via AnnotationsLayer.
 */
export function AnnotationsPinOverlay({
  versionId,
  pinElementsRef,
  draftPinRef,
}: AnnotationsPinOverlayProps) {
  const annotations = useViewerStore((s) => s.annotations);
  const selectedAnnotationId = useViewerStore((s) => s.selectedAnnotationId);
  const annotationDraft = useViewerStore((s) => s.annotationDraft);
  const selectAnnotation = useViewerStore((s) => s.selectAnnotation);
  const recentAnnotationIds = usePresenceStore((s) => s.recentAnnotationIds);

  const visibleAnnotations = React.useMemo(() => {
    const list = annotations ?? [];
    if (!versionId) return list;
    return list.filter((a) => a.versionId === versionId);
  }, [annotations, versionId]);

  if (visibleAnnotations.length === 0 && !annotationDraft) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {visibleAnnotations.map((ann, idx) => {
        const resolved = isAnnotationResolved(ann);
        const selected = ann.id === selectedAnnotationId;
        const isPulsing = Boolean(recentAnnotationIds[ann.id]);

        return (
          <button
            key={ann.id}
            type="button"
            ref={(node) => {
              if (node) {
                pinElementsRef.current.set(ann.id, node);
              } else {
                pinElementsRef.current.delete(ann.id);
              }
            }}
            onClick={(event) => {
              event.stopPropagation();
              selectAnnotation(ann.id);
            }}
            title={ann.label || `Annotation #${idx + 1}`}
            aria-label={`Annotation #${idx + 1}: ${ann.label || 'Untitled'}`}
            className={cn(
              'absolute left-0 top-0 flex items-center justify-center rounded-full border-2 font-mono font-semibold tabular-nums text-white opacity-0 shadow-lg transition-[width,height,box-shadow] duration-150 cursor-pointer select-none',
              resolved
                ? 'border-emerald-200 bg-emerald-600 hover:bg-emerald-500'
                : 'border-sky-200 bg-[#0b5fff] hover:bg-blue-500',
              selected
                ? 'h-8 w-8 text-xs ring-4 ring-sky-400/50 z-20'
                : 'h-6 w-6 text-[11px] z-10',
              isPulsing && 'ring-4 ring-sky-300/80 animate-pulse'
            )}
          >
            {isPulsing && (
              <span className="pointer-events-none absolute inset-0 rounded-full bg-sky-400/60 animate-ping" />
            )}
            <span className="relative z-10">{idx + 1}</span>
          </button>
        );
      })}

      {annotationDraft && (
        <div
          ref={draftPinRef}
          className="pointer-events-none absolute left-0 top-0 z-20 flex flex-col items-center opacity-0"
        >
          <div className="mb-1.5 whitespace-nowrap rounded border border-amber-400/70 bg-[#121721] px-2 py-0.5 font-mono text-[10px] font-medium text-amber-300 shadow-lg">
            Click to label
          </div>
          <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-amber-200 bg-amber-500 font-mono text-xs font-bold text-slate-950 shadow-lg ring-4 ring-amber-400/40">
            +
          </div>
        </div>
      )}
    </div>
  );
}
