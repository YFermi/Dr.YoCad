import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, FolderKanban } from 'lucide-react';
import { useAuthStore } from '@/lib/auth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export interface AppShellProps {
  breadcrumbs?: BreadcrumbItem[];
  actions?: React.ReactNode;
  fullBleed?: boolean;
  children: React.ReactNode;
}

export function AppShell({
  breadcrumbs = [],
  actions,
  fullBleed = false,
  children,
}: AppShellProps) {
  const navigate = useNavigate();
  const { user, organization, logout } = useAuthStore();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-30 h-14 border-b border-border bg-card/95 backdrop-blur-sm">
        <div
          className={
            fullBleed
              ? 'flex h-full w-full items-center justify-between gap-6 px-4'
              : 'mx-auto flex h-full max-w-[1440px] items-center justify-between gap-8 px-6'
          }
        >
          <div className="flex min-w-0 items-center gap-4">
            <Link
              to="/projects"
              className="font-display text-base font-bold tracking-tight text-foreground whitespace-nowrap shrink-0"
            >
              Cadline
            </Link>

            {breadcrumbs.length > 0 && (
              <nav
                aria-label="Breadcrumb"
                className="hidden sm:flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
              >
                {breadcrumbs.map((crumb, idx) => (
                  <React.Fragment key={`${crumb.label}-${idx}`}>
                    <span aria-hidden="true" className="text-border">
                      /
                    </span>
                    {crumb.to ? (
                      <Link
                        to={crumb.to}
                        className="truncate max-w-[200px] hover:text-foreground transition-colors whitespace-nowrap"
                      >
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className="truncate max-w-[260px] text-foreground font-medium whitespace-nowrap">
                        {crumb.label}
                      </span>
                    )}
                  </React.Fragment>
                ))}
              </nav>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {actions}
            {user && (
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors whitespace-nowrap shrink-0">
                  <span className="max-w-[140px] truncate">{user.name}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <div className="px-2.5 py-2">
                    <p className="text-sm font-medium text-foreground truncate">
                      {user.name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {user.email}
                    </p>
                    {organization && (
                      <p className="mt-1 text-xs text-muted-foreground font-mono truncate">
                        {organization.name} · {user.role}
                      </p>
                    )}
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigate('/projects')}>
                    <FolderKanban className="h-4 w-4 text-muted-foreground" />
                    Projects
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={handleLogout}>
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}

export default AppShell;
