import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileBox,
  Folder,
  Share2,
  Trash2,
  ExternalLink,
  ArrowLeft,
} from 'lucide-react';
import type { DesignFile, Project } from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { AppShell } from '@/components/layout/AppShell';
import { UploadDropzone } from '@/components/UploadDropzone';
import { ShareDialog } from '@/components/ShareDialog';
import { ActivityFeed } from '@/components/realtime/ActivityFeed';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [shareTarget, setShareTarget] = React.useState<{
    fileId?: string;
    projectId?: string;
    name: string;
  } | null>(null);

  const projectQuery = useQuery({
    queryKey: ['project', id],
    queryFn: () => apiFetch<Project>(`/projects/${id}`),
    enabled: Boolean(id),
  });

  const filesQuery = useQuery({
    queryKey: ['project-files', id],
    queryFn: () => apiFetch<{ items: DesignFile[] }>(`/files?projectId=${id}`),
    enabled: Boolean(id),
  });

  const deleteFileMutation = useMutation({
    mutationFn: (fileId: string) =>
      apiFetch<{ id: string; deleted: boolean }>(`/files/${fileId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-files', id] });
      void queryClient.invalidateQueries({ queryKey: ['project-activity', id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast({ title: 'File deleted', variant: 'default' });
    },
    onError: (err) => {
      toast({
        title: 'Could not delete file',
        description: err instanceof Error ? err.message : 'Unexpected error',
        variant: 'error',
      });
    },
  });

  const project = projectQuery.data;
  const files = filesQuery.data?.items ?? [];

  return (
    <AppShell
      breadcrumbs={[
        { label: 'Projects', to: '/projects' },
        { label: project?.name ?? 'Loading...' },
      ]}
      actions={
        project ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setShareTarget({ projectId: project.id, name: project.name })
            }
          >
            <Share2 className="h-4 w-4" />
            Share Project
          </Button>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-[1440px] flex flex-col lg:flex-row min-h-[calc(100vh-3.5rem)]">
        {/* Left sidebar: Folder / file tree placeholder */}
        <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-border bg-card/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-muted-foreground">
              Folder Tree
            </span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {files.length}
            </span>
          </div>

          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2 rounded-md bg-accent/60 px-2.5 py-1.5 text-foreground font-medium">
              <Folder className="h-4 w-4 text-primary shrink-0" />
              <span className="truncate">Root Directory</span>
            </div>

            <div className="pl-4 space-y-0.5 pt-1">
              {files.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => navigate(`/files/${file.id}`)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
                >
                  <FileBox className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{file.name}</span>
                </button>
              ))}
              {files.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No files uploaded yet.
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
            Nested folder CRUD and drag-and-drop organization plug in during Session 2.
          </div>
        </aside>

        {/* Main project content */}
        <section className="flex-1 min-w-0 p-6 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => navigate('/projects')}
                className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to projects
              </button>
              <h1 className="text-xl font-semibold tracking-tight text-foreground truncate">
                {project?.name ?? 'Loading project...'}
              </h1>
              {project?.description && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {project.description}
                </p>
              )}
            </div>
          </div>

          {id && (
            <UploadDropzone
              projectId={id}
              onUploadComplete={() => {
                void queryClient.invalidateQueries({ queryKey: ['project-files', id] });
                void queryClient.invalidateQueries({ queryKey: ['project-activity', id] });
                void queryClient.invalidateQueries({ queryKey: ['projects'] });
              }}
            />
          )}

          {/* Files Table */}
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Project Files</h2>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {files.length} {files.length === 1 ? 'record' : 'records'}
              </span>
            </div>

            {filesQuery.isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading files...</div>
            ) : files.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                Upload a file above to run the chunked multipart upload pipeline.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">File</th>
                      <th className="px-4 py-2.5 font-medium">Format</th>
                      <th className="px-4 py-2.5 font-medium text-right">Size</th>
                      <th className="px-4 py-2.5 font-medium">Version</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">Updated</th>
                      <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {files.map((file) => (
                      <tr
                        key={file.id}
                        className="hover:bg-accent/40 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => navigate(`/files/${file.id}`)}
                            className="inline-flex items-center gap-2 font-medium text-foreground hover:text-primary transition-colors cursor-pointer"
                          >
                            <FileBox className="h-4 w-4 shrink-0 text-primary" />
                            <span className="truncate max-w-[280px]">{file.name}</span>
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground uppercase">
                          .{file.extension}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground tabular-nums">
                          {formatBytes(file.sizeBytes)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-foreground tabular-nums">
                          v{file.currentVersion}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          <span
                            className={
                              file.status === 'READY'
                                ? 'text-emerald-400'
                                : file.status === 'FAILED'
                                  ? 'text-red-400'
                                  : 'text-amber-400'
                            }
                          >
                            {file.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground tabular-nums">
                          {formatDateTime(file.updatedAt)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/files/${file.id}`)}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              View
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setShareTarget({ fileId: file.id, name: file.name })
                              }
                            >
                              <Share2 className="h-3.5 w-3.5" />
                              Share
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${file.name}`}
                              onClick={() => deleteFileMutation.mutate(file.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-400" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {id && <ActivityFeed projectId={id} />}
        </section>
      </div>

      {shareTarget && (
        <ShareDialog
          open={Boolean(shareTarget)}
          onOpenChange={(open) => {
            if (!open) setShareTarget(null);
          }}
          fileId={shareTarget.fileId}
          projectId={shareTarget.projectId}
          resourceName={shareTarget.name}
        />
      )}
    </AppShell>
  );
}
