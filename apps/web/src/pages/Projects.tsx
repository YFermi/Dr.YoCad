import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Clock, FileBox, FolderKanban, Plus } from 'lucide-react';
import type { PaginatedResult, Project } from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiFetch<PaginatedResult<Project>>('/projects?page=1&pageSize=50'),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; description?: string }) =>
      apiFetch<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project created', created.name);
      setName('');
      setDescription('');
      setDialogOpen(false);
    },
    onError: (err) => {
      toast.error(
        'Failed to create project',
        err instanceof Error ? err.message : 'Unexpected error'
      );
    },
  });

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    });
  };

  const items = projectsQuery.data?.items ?? [];

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-foreground">
            Engineering Projects
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Organize CAD assemblies, revision history, and review links.
          </p>
        </div>

        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </div>

      {projectsQuery.isLoading ? (
        <div className="flex items-center justify-center py-20 gap-3 text-xs text-muted-foreground">
          <Spinner />
          <span>Loading projects...</span>
        </div>
      ) : projectsQuery.error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-300">
          {projectsQuery.error instanceof Error
            ? projectsQuery.error.message
            : 'Unable to load projects'}
        </div>
      ) : items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-14 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <FolderKanban className="h-5 w-5" />
            </div>
            <h2 className="text-sm font-semibold text-foreground">
              No projects yet
            </h2>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Create your first project to upload STEP, STL, or GLB files and inspect them in 3D.
            </p>
            <Button className="mt-4" size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New Project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((project) => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              className="group block focus:outline-none"
            >
              <Card className="h-full transition-colors hover:border-primary/60 group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                      <FolderKanban className="h-4 w-4" />
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </div>
                  <CardTitle className="pt-2 text-sm group-hover:text-primary transition-colors">
                    {project.name}
                  </CardTitle>
                  <CardDescription className="line-clamp-2 min-h-[32px]">
                    {project.description || 'No description provided.'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between border-t border-border/60 pt-3 font-mono text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5 tabular-nums">
                    <FileBox className="h-3.5 w-3.5 text-slate-400" />
                    {project._count?.files ?? 0} file
                    {(project._count?.files ?? 0) === 1 ? '' : 's'}
                  </span>
                  <span className="flex items-center gap-1 tabular-nums">
                    <Clock className="h-3 w-3 text-slate-400" />
                    {formatDateTime(project.updatedAt)}
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent onClose={() => setDialogOpen(false)}>
          <DialogHeader>
            <DialogTitle>Create engineering project</DialogTitle>
            <DialogDescription>
              Group related assemblies, drawings, and versions in one workspace.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Actuator Assembly Rev D"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-desc">Description</Label>
              <Input
                id="project-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional scope or release notes"
              />
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating...' : 'Create Project'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
