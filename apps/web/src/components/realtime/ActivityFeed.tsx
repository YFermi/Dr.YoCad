import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import {
  ActivityAction,
  computeAvatarColor,
  type ActivityLogWithAuthor,
} from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { formatRelativeTime, getInitials } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

function describeActivityAction(item: ActivityLogWithAuthor): string {
  const fileSuffix = item.fileName ? ` on ${item.fileName}` : '';
  const meta = item.metadata ?? {};

  switch (item.action) {
    case ActivityAction.ANNOTATION_CREATED:
      return `placed a ${String(meta.type ?? 'pin').toLowerCase()} annotation${fileSuffix}`;
    case ActivityAction.COMMENT_CREATED:
      return `posted a review comment${fileSuffix}`;
    case ActivityAction.MEASUREMENT_CREATED:
      return `saved a ${String(meta.type ?? '').toLowerCase()} measurement${fileSuffix}`;
    case ActivityAction.FILE_UPLOAD_INITIATED:
    case ActivityAction.FILE_UPLOAD_COMPLETED:
      return `uploaded ${item.fileName ?? 'a design file'}`;
    case ActivityAction.FILE_DELETED:
      return `deleted ${item.fileName ?? 'a design file'}`;
    case ActivityAction.SHARE_LINK_CREATED:
      return `created a share link${fileSuffix}`;
    case ActivityAction.PROJECT_CREATED:
      return 'created this project';
    case ActivityAction.PROJECT_UPDATED:
      return 'updated project details';
    case ActivityAction.USER_REGISTERED:
      return 'joined the workspace';
    default:
      return `${String(item.action).toLowerCase().replace(/_/g, ' ')}${fileSuffix}`;
  }
}

interface ActivityFeedProps {
  projectId: string;
  compact?: boolean;
}

export function ActivityFeed({ projectId, compact = false }: ActivityFeedProps) {
  const activityQuery = useQuery({
    queryKey: ['project-activity', projectId],
    queryFn: () =>
      apiFetch<ActivityLogWithAuthor[]>(`/projects/${projectId}/activity`),
    enabled: Boolean(projectId),
    refetchInterval: 30000,
  });

  const items = activityQuery.data ?? [];

  return (
    <div
      className={
        compact
          ? 'flex h-full min-h-0 flex-col'
          : 'rounded-lg border border-border bg-card overflow-hidden'
      }
    >
      {!compact && (
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Recent Activity
            </h2>
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            Last {items.length}
          </span>
        </div>
      )}

      <div className={compact ? 'min-h-0 flex-1 overflow-y-auto p-3 space-y-2.5' : 'divide-y divide-border'}>
        {activityQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner size="sm" />
            <span>Loading activity…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            No project activity recorded yet.
          </div>
        ) : (
          items.map((entry) => {
            const actorName = entry.author?.name ?? 'Team member';
            const color = computeAvatarColor(entry.userId ?? entry.id);

            return (
              <div
                key={entry.id}
                className={
                  compact
                    ? 'flex items-start gap-2.5 rounded-md border border-border/70 bg-background/50 p-2 text-xs'
                    : 'flex items-start gap-3 px-4 py-2.5 text-xs hover:bg-accent/30 transition-colors'
                }
              >
                <span
                  style={{ backgroundColor: color }}
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold text-white"
                >
                  {getInitials(actorName, entry.author?.email)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="leading-snug text-foreground/90">
                    <span className="font-medium text-foreground">{actorName}</span>{' '}
                    <span className="text-muted-foreground">
                      {describeActivityAction(entry)}
                    </span>
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {formatRelativeTime(entry.createdAt)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
