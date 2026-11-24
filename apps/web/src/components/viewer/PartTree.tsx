import * as React from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Focus,
  Layers,
  RotateCcw,
  Ruler,
} from 'lucide-react';
import type { PartNode } from '@cadline/shared';
import { useViewerStore } from '@/stores/viewerStore';
import { useMeasureStore } from '@/stores/measureStore';
import { cn } from '@/lib/utils';
import { countLeafParts } from '@/lib/partTree';

interface PartTreeProps {
  fallbackName?: string;
}

interface ContextMenuState {
  node: PartNode;
  x: number;
  y: number;
}

function PartTreeRow({
  node,
  depth,
  onContextMenu,
}: {
  node: PartNode;
  depth: number;
  onContextMenu: (e: React.MouseEvent, node: PartNode) => void;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const hiddenPartIds = useViewerStore((s) => s.hiddenPartIds);
  const isolatedPartId = useViewerStore((s) => s.isolatedPartId);
  const selectedPartId = useViewerStore((s) => s.selectedPartId);
  const togglePartVisibility = useViewerStore((s) => s.togglePartVisibility);
  const isolatePart = useViewerStore((s) => s.isolatePart);
  const selectPart = useViewerStore((s) => s.selectPart);
  const inspectPart = useMeasureStore((s) => s.inspectPart);
  const inspectedPartId = useMeasureStore((s) => s.inspectedPartId);

  const hasChildren = node.children.length > 0;
  const isHidden = hiddenPartIds.has(node.id);
  const isIsolated = isolatedPartId === node.id;
  const isSelected = selectedPartId === node.id;
  const isInspected = inspectedPartId === node.id;

  return (
    <div>
      <div
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={cn(
          'group flex items-center justify-between gap-1 rounded px-2 py-1 text-xs transition-colors',
          isSelected || isInspected
            ? 'bg-primary/15 text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent cursor-pointer"
              aria-label={expanded ? 'Collapse assembly' : 'Expand assembly'}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          ) : (
            <span className="h-4 w-4 shrink-0" />
          )}

          <button
            type="button"
            onClick={() => selectPart(isSelected ? null : node.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer',
              isHidden && 'opacity-50 line-through'
            )}
            title={`${node.name} (right-click to measure)`}
          >
            {hasChildren ? (
              <Layers className="h-3.5 w-3.5 shrink-0 text-primary/80" />
            ) : (
              <Box className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{node.name}</span>
            {hasChildren && (
              <span
                className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] tabular-nums text-muted-foreground"
                title={`${countLeafParts(node)} parts in this assembly`}
              >
                {countLeafParts(node)}
              </span>
            )}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-80 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => inspectPart(node.id)}
            title="Measure this part"
            aria-label={`Measure ${node.name}`}
            className={cn(
              'rounded p-1 transition-colors cursor-pointer',
              isInspected
                ? 'bg-sky-500/20 text-sky-300'
                : 'text-muted-foreground hover:bg-accent hover:text-sky-300'
            )}
          >
            <Ruler className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => isolatePart(node.id)}
            title={isIsolated ? 'Exit isolate' : 'Isolate part'}
            aria-label={isIsolated ? `Exit isolate ${node.name}` : `Isolate ${node.name}`}
            className={cn(
              'rounded p-1 transition-colors cursor-pointer',
              isIsolated
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Focus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => togglePartVisibility(node.id)}
            title={isHidden ? 'Show part' : 'Hide part'}
            aria-label={isHidden ? `Show ${node.name}` : `Hide ${node.name}`}
            className={cn(
              'rounded p-1 transition-colors cursor-pointer',
              isHidden
                ? 'text-amber-400 hover:bg-accent'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {isHidden ? (
              <EyeOff className="h-3 w-3" />
            ) : (
              <Eye className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <PartTreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function PartTree({ fallbackName }: PartTreeProps) {
  const partTree = useViewerStore((s) => s.partTree);
  const hiddenPartIds = useViewerStore((s) => s.hiddenPartIds);
  const isolatedPartId = useViewerStore((s) => s.isolatedPartId);
  const showAllParts = useViewerStore((s) => s.showAllParts);
  const isolatePart = useViewerStore((s) => s.isolatePart);
  const togglePartVisibility = useViewerStore((s) => s.togglePartVisibility);
  const requestZoomToPart = useViewerStore((s) => s.requestZoomToPart);
  const inspectPart = useMeasureStore((s) => s.inspectPart);

  const [menu, setMenu] = React.useState<ContextMenuState | null>(null);

  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  const handleContextMenu = React.useCallback((e: React.MouseEvent, node: PartNode) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  const hasVisibilityOverrides =
    hiddenPartIds.size > 0 || isolatedPartId !== null;

  const nodes: PartNode[] =
    partTree.length > 0
      ? partTree
      : fallbackName
        ? [{ id: 'root-part', name: fallbackName, children: [] }]
        : [];

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Model Tree
        </span>
        {hasVisibilityOverrides && (
          <button
            type="button"
            onClick={showAllParts}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/15 transition-colors cursor-pointer"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Show all
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-0.5">
        {nodes.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No assembly parts available.
          </p>
        ) : (
          nodes.map((node) => (
            <PartTreeRow
              key={node.id}
              node={node}
              depth={0}
              onContextMenu={handleContextMenu}
            />
          ))
        )}
      </div>

      {/* Right-click context menu */}
      {menu && (
        <div
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          className="fixed z-50 w-44 rounded-md border border-border bg-[#121721] p-1 text-xs shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="truncate border-b border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
            {menu.node.name}
          </div>
          <button
            type="button"
            onClick={() => {
              inspectPart(menu.node.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sky-300 hover:bg-accent cursor-pointer"
          >
            <Ruler className="h-3.5 w-3.5" />
            Measure this part
          </button>
          <button
            type="button"
            onClick={() => {
              requestZoomToPart(menu.node.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground hover:bg-accent cursor-pointer"
          >
            <Focus className="h-3.5 w-3.5" />
            Zoom to part
          </button>
          <button
            type="button"
            onClick={() => {
              isolatePart(menu.node.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground hover:bg-accent cursor-pointer"
          >
            <Layers className="h-3.5 w-3.5" />
            {isolatedPartId === menu.node.id ? 'Exit isolate' : 'Isolate part'}
          </button>
          <button
            type="button"
            onClick={() => {
              togglePartVisibility(menu.node.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground hover:bg-accent cursor-pointer"
          >
            {hiddenPartIds.has(menu.node.id) ? (
              <>
                <Eye className="h-3.5 w-3.5" />
                Show part
              </>
            ) : (
              <>
                <EyeOff className="h-3.5 w-3.5" />
                Hide part
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
