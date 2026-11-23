import * as React from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { SharePermission, type ShareLink } from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileId?: string;
  projectId?: string;
  resourceName: string;
}

const PERMISSIONS: Array<{ value: SharePermission; label: string }> = [
  { value: SharePermission.VIEW, label: 'View only' },
  { value: SharePermission.COMMENT, label: 'Comment' },
  { value: SharePermission.MEASURE, label: 'Measure' },
  { value: SharePermission.EDIT, label: 'Edit' },
  { value: SharePermission.ADMIN, label: 'Admin' },
];

export function ShareDialog({
  open,
  onOpenChange,
  fileId,
  projectId,
  resourceName,
}: ShareDialogProps) {
  const [permission, setPermission] = React.useState<SharePermission>(
    SharePermission.VIEW
  );
  const [expiresInHours, setExpiresInHours] = React.useState<string>('168');
  const [createdLink, setCreatedLink] = React.useState<ShareLink | null>(null);
  const [isCreating, setIsCreating] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setCreatedLink(null);
      setCopied(false);
    }
  }, [open]);

  const shareUrl = createdLink
    ? `${window.location.origin}/share/${createdLink.token}`
    : '';

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsCreating(true);
    try {
      const hours = Number(expiresInHours);
      const link = await apiFetch<ShareLink>('/share', {
        method: 'POST',
        body: JSON.stringify({
          ...(fileId ? { fileId } : {}),
          ...(projectId ? { projectId } : {}),
          permission,
          ...(Number.isFinite(hours) && hours > 0 ? { expiresInHours: hours } : {}),
        }),
      });
      setCreatedLink(link);
      toast({
        title: 'Share link created',
        description: `Permission: ${link.permission}`,
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'Could not create share link',
        description: err instanceof Error ? err.message : 'Unexpected error',
        variant: 'error',
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Copy manually from the input field', variant: 'default' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle>Share design review link</DialogTitle>
          <DialogDescription>
            Generate a permission-scoped link for{' '}
            <span className="text-foreground font-medium">{resourceName}</span>.
          </DialogDescription>
        </DialogHeader>

        {!createdLink ? (
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="share-permission"
                className="text-xs font-medium text-muted-foreground"
              >
                Access level
              </label>
              <select
                id="share-permission"
                value={permission}
                onChange={(e) => setPermission(e.target.value as SharePermission)}
                className="flex h-9 w-full rounded-md border border-input bg-[#0d121b] px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {PERMISSIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label} ({p.value})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="share-expiry"
                className="text-xs font-medium text-muted-foreground"
              >
                Expires in (hours, leave blank for no expiry)
              </label>
              <Input
                id="share-expiry"
                type="number"
                min={1}
                max={8760}
                value={expiresInHours}
                onChange={(e) => setExpiresInHours(e.target.value)}
                placeholder="168"
              />
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating}>
                <Link2 className="h-4 w-4" />
                {isCreating ? 'Creating...' : 'Create Link'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Share URL
              </label>
              <div className="flex items-center gap-2">
                <Input value={shareUrl} readOnly className="font-mono text-xs" />
                <Button variant="secondary" size="sm" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground font-mono">
                Permission: {createdLink.permission}
                {createdLink.expiresAt
                  ? ` · Expires ${new Date(createdLink.expiresAt).toLocaleString()}`
                  : ' · No expiration'}
              </p>
            </div>

            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
