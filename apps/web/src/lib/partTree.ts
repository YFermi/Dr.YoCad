import type { PartMetricsSummary, PartNode, Vec3Tuple } from '@cadline/shared';

/** Leaf part instances under `node` (a part counts as 1). */
export function countLeafParts(node: PartNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((sum, child) => sum + countLeafParts(child), 0);
}

/** Leaf part instances in the whole tree (0 for an empty tree). */
export function countTreeParts(nodes: PartNode[]): number {
  return nodes.reduce((sum, node) => sum + countLeafParts(node), 0);
}

export function findPartNode(nodes: PartNode[], id: string): PartNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findPartNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Ids of the leaf parts under `node` (itself if it is a part). */
export function collectLeafPartIds(node: PartNode): string[] {
  if (node.children.length === 0) return [node.id];
  return node.children.flatMap(collectLeafPartIds);
}

/**
 * One summary for an assembly node from its leaf parts' summaries: union
 * bounding box, summed area / volume / triangles, volume-weighted centroid
 * (area-weighted if volumes are 0), and all their feature ids.
 */
export function aggregatePartSummaries(
  partId: string,
  partName: string,
  leaves: PartMetricsSummary[]
): PartMetricsSummary {
  const min: Vec3Tuple = [Infinity, Infinity, Infinity];
  const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
  const weighted: Vec3Tuple = [0, 0, 0];
  const totalVolume = leaves.reduce((sum, p) => sum + Math.abs(p.volume), 0);
  const weightOf = (p: PartMetricsSummary) => (totalVolume > 0 ? Math.abs(p.volume) : p.surfaceArea);
  let area = 0;
  let volume = 0;
  let triangles = 0;
  let totalWeight = 0;
  for (const p of leaves) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.bboxMin[i]);
      max[i] = Math.max(max[i], p.bboxMax[i]);
      weighted[i] += p.centroid[i] * weightOf(p);
    }
    area += p.surfaceArea;
    volume += p.volume;
    triangles += p.triangleCount;
    totalWeight += weightOf(p);
  }
  const centroid: Vec3Tuple =
    totalWeight > 0
      ? [weighted[0] / totalWeight, weighted[1] / totalWeight, weighted[2] / totalWeight]
      : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return {
    partId,
    partName,
    bboxMin: min,
    bboxMax: max,
    bboxDims: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    surfaceArea: area,
    volume,
    centroid,
    triangleCount: triangles,
    featureIds: leaves.flatMap((p) => p.featureIds),
  };
}
