import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, FolderKanban } from 'lucide-react';
import type { ResolvedShareLink } from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { FileViewerPage } from '@/pages/FileViewer';
import { Button } from '@/components/ui/button';

export function ShareViewPage() {
  const { token } = useParams<{ token: string }>();

  const shareQuery = useQuery({
    queryKey: ['share', token],
    queryFn: () =>
      apiFetch<ResolvedShareLink>(`/share/${token}`, {
        skipAuth: true,
      }),
    enabled: Boolean(token),
    retry: false,
  });

  if (shareQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Resolving share link...
      </div>
    );
  }

  if (shareQuery.error || !shareQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center space-y-3">
          <AlertCircle className="mx-auto h-8 w-8 text-red-400" />
          <h1 className="text-base font-semibold text-foreground">
            Share link unavailable
          </h1>
          <p className="text-sm text-muted-foreground">
            {shareQuery.error instanceof Error
              ? shareQuery.error.message
              : 'This link may have expired or been revoked.'}
          </p>
          <div className="pt-2">
            <Link to="/login">
              <Button size="sm">Sign in to Cadline</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { shareLink, file, project } = shareQuery.data;

  if (file) {
    return (
      <FileViewerPage
        sharedFile={file}
        sharedPermission={shareLink.permission}
        shareToken={token}
      />
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-lg w-full rounded-lg border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 text-primary">
            <FolderKanban className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">
              {project?.name ?? 'Shared Project'}
            </h1>
            <p className="font-mono text-xs text-muted-foreground">
              Permission: {shareLink.permission}
              {shareLink.expiresAt
                ? ` · Expires ${new Date(shareLink.expiresAt).toLocaleDateString()}`
                : ' · No expiry'}
            </p>
          </div>
        </div>
        {project?.description && (
          <p className="text-sm text-muted-foreground">{project.description}</p>
        )}
        <div className="pt-2">
          <Link to="/login">
            <Button size="sm">Sign in to open workspace</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
