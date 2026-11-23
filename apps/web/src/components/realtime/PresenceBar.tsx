import * as React from 'react';
import { Eye, X } from 'lucide-react';
import { computeAvatarColor, type PresenceUser } from '@cadline/shared';
import { useAuthStore } from '@/lib/auth';
import { usePresenceStore } from '@/stores/presenceStore';
import { startFollowingUser, stopFollowingUser } from '@/hooks/useRealtimeSync';
import { cn, getInitials } from '@/lib/utils';

const MAX_VISIBLE_AVATARS = 5;

function getUserColor(user: PresenceUser): string {
  return user.avatarColor || computeAvatarColor(user.userId);
}

/**
 * Top-bar presence avatar stack showing active users in the file room.
 * Clicking an avatar opens a popover to follow that user's view.
 */
export function PresenceBar() {
  const currentUser = useAuthStore((s) => s.user);
  const users = usePresenceStore((s) => s.users);
  const activeUserId = usePresenceStore((s) => s.activeUserId);

  const [openUserId, setOpenUserId] = React.useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpenUserId(null);
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  if (users.length === 0) {
    return null;
  }

  const visible = users.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = users.slice(MAX_VISIBLE_AVATARS);

  const renderFollowAction = (person: PresenceUser) => {
    const isSelf = currentUser?.id === person.userId;
    const isFollowing = activeUserId === person.userId;

    if (isSelf) {
      return (
        <span className="font-mono text-[10px] text-muted-foreground">You</span>
      );
    }

    if (isFollowing) {
      return (
        <button
          type="button"
          onClick={() => {
            stopFollowingUser();
            setOpenUserId(null);
            setOverflowOpen(false);
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
          Stop following
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => {
          startFollowingUser(person.userId);
          setOpenUserId(null);
          setOverflowOpen(false);
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
      >
        <Eye className="h-3.5 w-3.5" />
        Follow {person.name.split(' ')[0]}&apos;s view
      </button>
    );
  };

  return (
    <div ref={containerRef} className="relative flex items-center">
      <div className="flex items-center -space-x-1.5">
        {visible.map((person) => {
          const color = getUserColor(person);
          const isSelf = currentUser?.id === person.userId;
          const isFollowing = activeUserId === person.userId;
          const isOpen = openUserId === person.userId;

          return (
            <div key={person.userId} className="relative">
              <button
                type="button"
                onClick={() => {
                  setOverflowOpen(false);
                  setOpenUserId((prev) =>
                    prev === person.userId ? null : person.userId
                  );
                }}
                style={{ backgroundColor: color }}
                title={`${person.name}${isSelf ? ' (You)' : ''}`}
                aria-label={`Collaborator ${person.name}`}
                className={cn(
                  'relative flex h-7 w-7 items-center justify-center rounded-full border-2 border-card font-mono text-[10px] font-semibold text-white shadow-xs transition-transform hover:z-10 hover:scale-105 cursor-pointer select-none',
                  isFollowing && 'ring-2 ring-white ring-offset-1 ring-offset-card z-10'
                )}
              >
                {getInitials(person.name)}
              </button>

              {isOpen && (
                <div className="absolute right-0 top-9 z-40 w-56 rounded-lg border border-border bg-popover p-3 shadow-2xl">
                  <div className="mb-2.5 flex items-center gap-2.5">
                    <span
                      style={{ backgroundColor: color }}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold text-white"
                    >
                      {getInitials(person.name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-foreground">
                        {person.name}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span
                          style={{ backgroundColor: color }}
                          className="inline-block h-2 w-2 rounded-full"
                        />
                        <span>Cursor color</span>
                      </div>
                    </div>
                  </div>
                  {renderFollowAction(person)}
                </div>
              )}
            </div>
          );
        })}

        {overflow.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setOpenUserId(null);
                setOverflowOpen((prev) => !prev);
              }}
              aria-label={`${overflow.length} more active collaborators`}
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-card bg-secondary font-mono text-[10px] font-semibold text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              +{overflow.length}
            </button>

            {overflowOpen && (
              <div className="absolute right-0 top-9 z-40 w-60 rounded-lg border border-border bg-popover p-2 shadow-2xl space-y-1.5">
                <p className="px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  In this file ({users.length})
                </p>
                <div className="max-h-56 overflow-y-auto space-y-1">
                  {overflow.map((person) => {
                    const color = getUserColor(person);
                    const isSelf = currentUser?.id === person.userId;
                    const isFollowing = activeUserId === person.userId;
                    return (
                      <div
                        key={person.userId}
                        className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            style={{ backgroundColor: color }}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-semibold text-white"
                          >
                            {getInitials(person.name)}
                          </span>
                          <span className="truncate text-xs text-foreground">
                            {person.name}
                          </span>
                        </div>
                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => {
                              if (isFollowing) {
                                stopFollowingUser();
                              } else {
                                startFollowingUser(person.userId);
                              }
                              setOverflowOpen(false);
                            }}
                            className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground hover:border-primary hover:text-primary cursor-pointer"
                          >
                            {isFollowing ? 'Stop' : 'Follow'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Floating banner displayed over the viewport while following another user's view.
 */
export function FollowingBanner() {
  const users = usePresenceStore((s) => s.users);
  const activeUserId = usePresenceStore((s) => s.activeUserId);

  if (!activeUserId) return null;

  const leader = users.find((u) => u.userId === activeUserId);
  const leaderName = leader?.name ?? 'Collaborator';
  const color = leader ? getUserColor(leader) : computeAvatarColor(activeUserId);

  return (
    <div
      style={{ borderColor: color }}
      className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2.5 rounded-md border bg-[#121721]/95 px-3 py-1.5 text-xs text-foreground shadow-xl backdrop-blur-xs"
    >
      <span
        style={{ backgroundColor: color }}
        className="h-2 w-2 shrink-0 rounded-full"
      />
      <span className="font-medium">
        Following <span className="text-white">{leaderName}</span>&apos;s view
      </span>
      <button
        type="button"
        onClick={() => stopFollowingUser()}
        className="ml-1 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent transition-colors cursor-pointer"
      >
        Stop
      </button>
    </div>
  );
}
