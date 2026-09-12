import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ClerkProvider,
  SignIn,
  SignUp,
  useClerk,
  useAuth,
} from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  AlertCircle, ArrowRight, BarChart3, Bell, Check, CheckCircle2, ClipboardCheck,
  Database, FileCheck2, FileText, Filter, FolderUp, History, Loader2, LockKeyhole,
  Menu, MoreHorizontal, RefreshCw, Search, Settings2, ShieldCheck, Sparkles,
  UploadCloud, X, XCircle, Zap,
} from 'lucide-react';
import {
  getGetCurrentUserQueryKey, getGetDashboardQueryKey, getGetRunQueryKey,
  getGetRunSummaryQueryKey, getGetSettingsQueryKey, getListActionsQueryKey,
  getListAuditEventsQueryKey, getListRunExceptionsQueryKey, getListRunsQueryKey,
  useApproveAction, useCreateRun, useGenerateRunSummary, useGetCurrentUser,
  useGetDashboard, useGetRun, useGetRunSummary, useGetSettings, useListActions,
  useListAuditEvents, useListRunExceptions, useListRuns, useProcessRun,
  useRejectAction, useRequestAction, useRequestUploadUrl, useUpdateSettings,
} from '@workspace/api-client-react';
import type {
  ActionRequest, AuditEvent, CurrentUser, EvidenceSummary,
  Run, ValidationException,
} from '@workspace/api-client-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation, useParams } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in the environment.');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#d9f06c',
    colorForeground: '#f6f1e5',
    colorMutedForeground: '#9facbe',
    colorDanger: '#f08b82',
    colorBackground: '#1e2d43',
    colorInput: '#162338',
    colorInputForeground: '#f6f1e5',
    colorNeutral: '#43536a',
    fontFamily: 'Space Grotesk, sans-serif',
    borderRadius: '0.65rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#1e2d43] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#f6f1e5]',
    headerSubtitle: 'text-[#9facbe]',
    socialButtonsBlockButtonText: 'text-[#d8dfeb]',
    formFieldLabel: 'text-[#d8dfeb]',
    footerActionLink: 'text-[#d9f06c]',
    footerActionText: 'text-[#9facbe]',
    dividerText: 'text-[#9facbe]',
    identityPreviewEditButton: 'text-[#d9f06c]',
    formFieldSuccessText: 'text-[#d9f06c]',
    alertText: 'text-[#f6f1e5]',
    logoBox: 'h-9',
    logoImage: 'max-h-9',
    socialButtonsBlockButton: 'border-[#43536a] bg-[#162338] hover:bg-[#26364d]',
    formButtonPrimary: 'bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]',
    formFieldInput: 'border-[#43536a] bg-[#162338] text-[#f6f1e5]',
    footerAction: 'text-[#9facbe]',
    dividerLine: 'bg-[#43536a]',
    alert: 'border-[#43536a] bg-[#26364d]',
    otpCodeFieldInput: 'border-[#43536a] bg-[#162338] text-[#f6f1e5]',
    formFieldRow: 'text-[#d8dfeb]',
    main: 'bg-transparent',
  },
};

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: BarChart3 },
  { href: '/runs', label: 'Import runs', icon: Database },
  { href: '/actions/queue', label: 'Action queue', icon: ClipboardCheck },
  { href: '/audit', label: 'Audit trail', icon: History },
  { href: '/settings', label: 'Organisation', icon: Settings2 },
];

function formatDate(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
}
function formatDateTime(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function initials(name?: string) {
  return (name || 'OP').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}
function statusLabel(value?: string) {
  return (value || 'unknown').replaceAll('_', ' ');
}

function StatusPill({ value, tone }: { value?: string; tone?: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const derived = tone || (value === 'succeeded' || value === 'approved' || value === 'ready' || value === 'completed' ? 'success' : value === 'failed' || value === 'critical' || value === 'rejected' ? 'danger' : value === 'queued' || value === 'running' || value === 'requested' || value === 'medium' || value === 'high' ? 'warning' : 'neutral');
  const colors = { success: 'bg-[#e8f0cc] text-[#52651a] border-[#cbdc9c]', warning: 'bg-[#f8edcf] text-[#8a5d17] border-[#ead9a8]', danger: 'bg-[#f7dedb] text-[#963f39] border-[#e7bdb9]', neutral: 'bg-secondary text-secondary-foreground border-secondary-border' };
  return <span data-testid={`status-${value || 'unknown'}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize tracking-wide ${colors[derived]}`}><span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />{statusLabel(value)}</span>;
}

function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="space-y-3" data-testid="loading-state">{Array.from({ length: count }).map((_, i) => <div key={i} className="skeleton h-14 rounded-lg" />)}</div>;
}
function ErrorState({ message = 'We could not load this view.', retry }: { message?: string; retry?: () => void }) {
  return <div className="rounded-xl border border-[#e7bdb9] bg-[#fdf0ee] p-7 text-center" data-testid="error-state"><AlertCircle className="mx-auto mb-3 h-7 w-7 text-destructive" /><p className="font-semibold text-[#7c3934]">{message}</p><p className="mt-1 text-sm text-[#9d5c55]">Try again, or return in a moment.</p>{retry && <Button data-testid="button-retry" onClick={retry} variant="outline" className="mt-4 border-[#d9aaa4]">Retry</Button>}</div>;
}
function EmptyState({ icon: Icon = FileCheck2, title, detail, action }: { icon?: typeof FileCheck2; title: string; detail: string; action?: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border bg-card/60 px-6 py-14 text-center" data-testid="empty-state"><div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground"><Icon className="h-6 w-6" /></div><h3 className="font-semibold">{title}</h3><p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{detail}</p>{action && <div className="mt-5">{action}</div>}</div>;
}

function Logo({ light = false }: { light?: boolean }) {
  return <Link href="/" data-testid="link-logo" className="group flex items-center gap-2.5"><span className={`relative flex h-8 w-8 items-center justify-center rounded-lg ${light ? 'bg-[#d9f06c] text-[#162338]' : 'bg-primary text-primary-foreground'}`}><span className="absolute h-3.5 w-3.5 rounded-sm border-2 border-current" /><span className="absolute h-1.5 w-1.5 rounded-full bg-current" /></span><span className={`text-[13px] font-bold tracking-[.08em] ${light ? 'text-[#f6f1e5]' : ''}`}>PROOF<span className={light ? 'text-[#d9f06c]' : 'text-accent'}>/OPS</span></span></Link>;
}

function Shell({ children, user }: { children: ReactNode; user?: CurrentUser }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  return <div className="noise min-h-[100dvh] bg-background">
    <aside className={`fixed inset-y-0 left-0 z-30 flex w-[248px] flex-col bg-sidebar px-4 py-5 text-sidebar-foreground transition-transform md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="mb-9 flex items-center justify-between px-2"><Logo light /><button data-testid="button-close-menu" className="text-sidebar-foreground/70 md:hidden" onClick={() => setMobileOpen(false)}><X className="h-5 w-5" /></button></div>
      <div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-sidebar-foreground/45">Workspace</div>
      <nav className="space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`link-nav-${label.toLowerCase().replace(' ', '-')}`} onClick={() => setMobileOpen(false)} className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${location === href || (href === '/runs' && location.startsWith('/runs/')) ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground'}`}><Icon className="h-4 w-4 opacity-75" /><span>{label}</span>{href === '/actions/queue' && <span className="ml-auto rounded bg-[#d9f06c] px-1.5 py-0.5 text-[10px] font-bold text-[#26340f]">3</span>}</Link>)}
      </nav>
      <div className="mt-8 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-sidebar-foreground/45">Current scope</div>
      <div className="mt-3 rounded-xl border border-sidebar-border bg-sidebar-accent/60 p-3"><div className="flex items-center gap-2 text-xs font-medium"><span className="h-2 w-2 rounded-full bg-[#d9f06c]" />{user?.organisation.name || 'Northstar Operations'}</div><p className="mt-2 pl-4 text-[11px] text-sidebar-foreground/50 mono">{user?.organisation.code || 'NORTHSTAR-OPS'}</p></div>
      <div className="mt-auto border-t border-sidebar-border pt-4"><div className="flex items-center gap-3 px-2"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold">{initials(user?.name)}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{user?.name || 'Operations analyst'}</p><p className="truncate text-[11px] capitalize text-sidebar-foreground/50">{user?.role || 'analyst'}</p></div><button data-testid="button-account-menu" className="text-sidebar-foreground/50 hover:text-sidebar-foreground"><MoreHorizontal className="h-4 w-4" /></button></div></div>
    </aside>
    {mobileOpen && <button aria-label="Close navigation" data-testid="button-overlay-menu" className="fixed inset-0 z-20 bg-[#162338]/40 md:hidden" onClick={() => setMobileOpen(false)} />}
    <div className="md:pl-[248px]">
      <header className="sticky top-0 z-10 flex h-[70px] items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur md:px-9"><div className="flex items-center gap-3"><button data-testid="button-open-menu" className="rounded-lg p-2 hover:bg-secondary md:hidden" onClick={() => setMobileOpen(true)}><Menu className="h-5 w-5" /></button><div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"><span className="mono text-[11px] text-foreground/60">OPS /</span><span className="capitalize">{location.replace('/', '').replaceAll('/', ' / ') || 'overview'}</span></div></div><div className="flex items-center gap-2"><button data-testid="button-search" className="hidden h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground sm:flex"><Search className="h-3.5 w-3.5" />Search <span className="mono ml-4 text-[10px]">⌘K</span></button><button data-testid="button-notifications" className="relative rounded-lg p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground"><Bell className="h-4 w-4" /><span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent" /></button></div></header>
      <main className="mx-auto max-w-[1440px] px-5 py-7 md:px-9 md:py-9">{children}</main>
    </div>
  </div>;
}

function PageIntro({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) {
  return <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end animate-rise"><div><p className="mono mb-2 text-[10px] font-semibold uppercase tracking-[.2em] text-muted-foreground">{eyebrow}</p><h1 className="text-3xl font-bold tracking-[-.035em] md:text-[38px]">{title}</h1>{detail && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{detail}</p>}</div>{action}</div>;
}

function Metric({ label, value, sub, accent }: { label: string; value: string | number; sub: string; accent?: boolean }) {
  return <div className={`rounded-xl border p-5 ${accent ? 'border-[#c9d99a] bg-[#f1f6dc]' : 'border-border bg-card'}`}><div className="flex items-start justify-between"><p className="text-xs font-medium text-muted-foreground">{label}</p>{accent && <Zap className="h-4 w-4 text-[#718e1f]" />}</div><p data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`} className="mt-4 text-3xl font-bold tracking-[-.04em]">{value}</p><p className="mt-1 text-xs text-muted-foreground">{sub}</p></div>;
}

function RunRow({ run }: { run: Run }) {
  return <Link href={`/runs/${run.id}/exceptions`} data-testid={`row-run-${run.id}`} className="group grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border/70 px-5 py-4 transition-colors hover:bg-secondary/45 sm:grid-cols-[minmax(0,1.6fr)_110px_95px_105px]"><div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><FileText className="h-4 w-4" /></span><div className="min-w-0"><p className="truncate text-sm font-semibold group-hover:text-[#627d18]">{run.fileName}</p><p className="mono mt-1 text-[10px] text-muted-foreground">{run.id.slice(0, 12)} · {formatDate(run.createdAt)}</p></div></div><div className="hidden text-xs text-muted-foreground sm:block">{run.recordCount.toLocaleString()} rows</div><div className="hidden sm:block"><StatusPill value={run.status} /></div><div className="text-right"><p className="text-xs font-semibold">{run.exceptionCount} <span className="font-normal text-muted-foreground">issues</span></p><p className="mt-1 text-[10px] text-muted-foreground sm:hidden"><StatusPill value={run.status} /></p></div></Link>;
}

function DashboardPage() {
  const dashboard = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } }).data;
  if (dashboard.isLoading) return <PageFrame><LoadingRows count={5} /></PageFrame>;
  if (dashboard.isError) return <PageFrame><ErrorState retry={() => dashboard.refetch()} /></PageFrame>;
  const data = dashboard.data;
  const canImport = user?.role === 'analyst' || user?.role === 'administrator';
  if (!data) return <PageFrame><EmptyState title="No operational data yet" detail="Create your first import run to start building an evidence trail." action={canImport ? <Link href="/runs/new" data-testid="link-empty-new-run"><Button>Start an import <ArrowRight /></Button></Link> : undefined} /></PageFrame>;
  return <PageFrame><PageIntro eyebrow={`Good morning, ${user?.name?.split(' ')[0] || 'analyst'}`} title="Operations overview" detail="A clear read on what needs attention across your evidence workspace." action={canImport ? <Link href="/runs/new" data-testid="link-dashboard-new-run"><Button className="h-11 bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]">New import <FolderUp /></Button></Link> : undefined} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 animate-rise-1"><Metric label="Open exceptions" value={data.openExceptions} sub="Across active runs" accent /><Metric label="Runs this month" value={data.runsThisMonth} sub="Imports received" /><Metric label="Pending actions" value={data.pendingActions} sub="Awaiting decision" /><Metric label="Success rate" value={`${data.successRate.toFixed(1)}%`} sub="Validated without issues" /></div><div className="mt-7 grid gap-6 xl:grid-cols-[1.5fr_1fr]"><section className="overflow-hidden rounded-xl border border-border bg-card animate-rise-2"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-semibold">Recent import runs</h2><p className="mt-1 text-xs text-muted-foreground">Latest evidence entering the workspace</p></div><Link href="/runs" data-testid="link-dashboard-runs" className="text-xs font-semibold text-[#627d18] hover:underline">View all</Link></div>{data.recentRuns.length ? <div>{data.recentRuns.slice(0, 5).map((run) => <RunRow key={run.id} run={run} />)}</div> : <div className="p-8"><EmptyState icon={Database} title="No runs recorded" detail="Upload an operational file to see it here." /></div>}</section><section className="evidence-grid overflow-hidden rounded-xl border border-border bg-[#eaf0d0] p-6 animate-rise-3"><div className="flex items-center justify-between"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-accent"><ShieldCheck className="h-5 w-5" /></span><span className="mono text-[10px] uppercase tracking-[.18em] text-[#5d6a35]">Control health</span></div><h2 className="mt-14 max-w-xs text-2xl font-bold leading-tight tracking-[-.03em] text-[#26340f]">Every decision leaves a trace.</h2><p className="mt-3 max-w-xs text-sm leading-relaxed text-[#5d6a35]">Your evidence chain is protected by role controls, retention rules, and a complete audit trail.</p><Link href="/audit" data-testid="link-dashboard-audit" className="mt-8 inline-flex items-center gap-2 text-xs font-semibold text-[#52651a] hover:gap-3 transition-all">Inspect audit trail <ArrowRight className="h-4 w-4" /></Link></section></div></PageFrame>;
}

function PageFrame({ children }: { children: ReactNode }) { return <>{children}</>; }

function RunsPage() {
  const [status, setStatus] = useState<string>('all');
  const params = status === 'all' ? { limit: 100 } : { status: status as never, limit: 100 };
  const runs = useListRuns(params, { query: { queryKey: getListRunsQueryKey(params) } });
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } }).data;
  const canImport = user?.role === 'analyst' || user?.role === 'administrator';
  return <PageFrame><PageIntro eyebrow="Evidence intake" title="Import runs" detail="Track every file from receipt through validation and evidence generation." action={canImport ? <Link href="/runs/new" data-testid="link-runs-new"><Button className="h-11 bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]"><FolderUp /> New import</Button></Link> : undefined} /><div className="mb-5 flex flex-wrap items-center gap-2"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Filter className="h-3.5 w-3.5" />Filter</div>{['all', 'queued', 'running', 'succeeded', 'partial', 'failed'].map((item) => <button key={item} data-testid={`button-filter-${item}`} onClick={() => setStatus(item)} className={`rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${status === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:bg-secondary'}`}>{item}</button>)}</div><section className="overflow-hidden rounded-xl border border-border bg-card">{runs.isLoading ? <div className="p-5"><LoadingRows /></div> : runs.isError ? <div className="p-5"><ErrorState retry={() => runs.refetch()} /></div> : !runs.data?.length ? <div className="p-5"><EmptyState icon={Database} title="No matching runs" detail="Try another status filter or create a new import." action={canImport ? <Link href="/runs/new" data-testid="link-runs-empty-new"><Button>New import</Button></Link> : undefined} /></div> : <><div className="hidden grid-cols-[minmax(0,1.6fr)_110px_95px_105px] gap-4 border-b border-border bg-secondary/45 px-5 py-3 text-[10px] font-semibold uppercase tracking-[.15em] text-muted-foreground sm:grid"><span>Source file</span><span>Records</span><span>Status</span><span className="text-right">Exceptions</span></div>{runs.data.map((run) => <RunRow key={run.id} run={run} />)}</>}</section></PageFrame>;
}

function NewRunPage() {
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const uploadUrl = useRequestUploadUrl();
  const createRun = useCreateRun();
  const processRun = useProcessRun();
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } }).data;
  if (user?.role === 'auditor') {
    return <PageFrame><EmptyState icon={LockKeyhole} title="Read-only access" detail="Auditors can inspect imports and evidence, but cannot upload or rerun data." action={<Link href="/runs"><Button variant="outline">View import runs</Button></Link>} /></PageFrame>;
  }
  const handleFile = (selected?: File) => {
    if (!selected) return;
    const validType =
      ['text/csv', 'application/json', 'application/vnd.api+json'].includes(selected.type) ||
      /\.(csv|json)$/i.test(selected.name);
    if (!validType) {
      setError('Choose a CSV or JSON file.');
      return;
    }
    if (selected.size > 250 * 1024 * 1024) {
      setError('Files must be 250 MB or smaller.');
      return;
    }
    setError('');
    setFile(selected);
  };
  const submit = () => {
    if (!file) {
      setError('Select a file before continuing.');
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    uploadUrl.mutate(
      {
        data: {
          name: file.name,
          size: file.size,
          contentType: file.type || 'application/octet-stream',
        },
      },
      {
        onSuccess: async (upload) => {
          try {
            const response = await fetch(upload.uploadURL, {
              method: 'PUT',
              headers: { 'Content-Type': file.type || 'application/octet-stream' },
              body: file,
            });
            if (!response.ok) throw new Error('Upload failed');
            createRun.mutate(
              {
                data: {
                  fileName: file.name,
                  fileType: file.type || 'application/octet-stream',
                  fileSize: file.size,
                  objectPath: upload.objectPath,
                  idempotencyKey: `${file.name}-${file.size}-${file.lastModified}`,
                },
              },
              {
                onSuccess: (run) => {
                  queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
                  if (run.status === 'queued' || run.status === 'failed') {
                    processRun.mutate(
                      { runId: run.id },
                      {
                        onSettled: () => {
                          queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(run.id) });
                          queryClient.invalidateQueries({ queryKey: getListRunExceptionsQueryKey(run.id) });
                          queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
                        },
                      },
                    );
                  }
                  setLocation(`/runs/${run.id}/exceptions`);
                },
                onError: () => {
                  submitting.current = false;
                  setError('The run could not be created. Please try again.');
                },
              },
            );
          } catch {
            submitting.current = false;
            setError('The file upload did not complete. Please try again.');
          }
        },
        onError: () => {
          submitting.current = false;
          setError('We could not prepare the secure upload. Please try again.');
        },
      },
    );
  };
  const pending = uploadUrl.isPending || createRun.isPending;
  return <PageFrame><PageIntro eyebrow="Evidence intake / new" title="Start an import" detail="Upload one operational file. We will validate it, isolate exceptions, and prepare a defensible summary." action={<Link href="/runs" data-testid="link-new-run-cancel"><Button variant="outline">Cancel</Button></Link>} /><div className="mx-auto max-w-3xl"><div className={`rounded-2xl border-2 border-dashed p-8 text-center transition-colors md:p-16 ${dragging ? 'border-[#718e1f] bg-[#f1f6dc]' : 'border-border bg-card'}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files?.[0]); }} data-testid="dropzone-upload"><input id="file-upload" data-testid="input-file-upload" type="file" className="sr-only" accept=".csv,.json,application/json,text/csv" onChange={(e) => handleFile(e.target.files?.[0])} /><label htmlFor="file-upload" className="cursor-pointer"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#eaf0d0] text-[#627d18]"><UploadCloud className="h-7 w-7" /></span><h2 className="mt-5 text-xl font-semibold">{file ? file.name : 'Drop your file here'}</h2><p className="mt-2 text-sm text-muted-foreground">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · ready for secure upload` : 'or click to browse · CSV or JSON up to 250 MB'}</p></label>{file && <button data-testid="button-remove-file" onClick={() => setFile(null)} className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-destructive hover:underline"><X className="h-3.5 w-3.5" />Remove selection</button>}</div>{error && <p data-testid="text-upload-error" className="mt-3 flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</p>}<div className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-card p-4"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-[#627d18]" /><div><p className="text-sm font-semibold">Private by default</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Files are sent directly to encrypted object storage. Access is limited to your organisation and every processing step is recorded.</p></div></div><Button data-testid="button-create-run" disabled={!file || pending || submitting.current} onClick={submit} className="mt-6 h-11 w-full bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]">{pending || submitting.current ? <><Loader2 className="animate-spin" />Preparing secure run…</> : <>Create queued run <ArrowRight /></>}</Button></div></PageFrame>;
}

function RunHeader({ run, active }: { run?: Run; active: 'exceptions' | 'summary' }) {
  if (!run) return <div className="skeleton mb-7 h-24 rounded-xl" />;
  return <div className="mb-7 animate-rise"><div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><Link href="/runs" data-testid="link-breadcrumb-runs" className="hover:text-foreground">Import runs</Link><span>/</span><span className="mono">{run.id.slice(0, 12)}</span></div><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 className="truncate text-2xl font-bold tracking-[-.03em] md:text-3xl">{run.fileName}</h1><StatusPill value={run.status} /></div><p className="mono mt-2 text-[11px] text-muted-foreground">{run.recordCount.toLocaleString()} records · imported {formatDateTime(run.createdAt)} · {run.retryCount} retries</p></div><div className="flex gap-2"><Link href={`/runs/${run.id}/exceptions`} data-testid="link-run-exceptions" className={`rounded-lg px-3 py-2 text-xs font-semibold ${active === 'exceptions' ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground'}`}>Exceptions {run.exceptionCount > 0 && <span className="ml-1 rounded bg-[#d9f06c] px-1.5 py-0.5 text-[10px] text-[#26340f]">{run.exceptionCount}</span>}</Link><Link href={`/runs/${run.id}/summary`} data-testid="link-run-summary" className={`rounded-lg px-3 py-2 text-xs font-semibold ${active === 'summary' ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground'}`}>Evidence summary</Link></div></div></div>;
}

function ExceptionsPage() {
  const { runId = '' } = useParams<{ runId: string }>();
  const run = useGetRun(runId, { query: { queryKey: getGetRunQueryKey(runId), enabled: !!runId } });
  const exceptions = useListRunExceptions(runId, { query: { queryKey: getListRunExceptionsQueryKey(runId), enabled: !!runId } });
  const [severity, setSeverity] = useState('all');
  const filtered = useMemo(() => (exceptions.data || []).filter((item) => severity === 'all' || item.severity === severity), [exceptions.data, severity]);
  return <PageFrame><RunHeader run={run.data} active="exceptions" />{exceptions.isLoading || run.isLoading ? <LoadingRows /> : exceptions.isError || run.isError ? <ErrorState retry={() => { void exceptions.refetch(); void run.refetch(); }} /> : <><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Validation exceptions <span className="ml-1 text-muted-foreground">({exceptions.data?.length || 0})</span></h2><p className="mt-1 text-xs text-muted-foreground">Review the rows that need an analyst decision before evidence can be trusted.</p></div><div className="flex gap-1.5">{['all', 'critical', 'high', 'medium', 'low'].map((item) => <button key={item} data-testid={`button-exception-filter-${item}`} onClick={() => setSeverity(item)} className={`rounded-full border px-2.5 py-1 text-[11px] capitalize ${severity === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`}>{item}</button>)}</div></div>{!filtered.length ? <EmptyState icon={CheckCircle2} title="No exceptions in this view" detail="This run is clean for the selected severity." /> : <section className="overflow-hidden rounded-xl border border-border bg-card"><div className="hidden grid-cols-[70px_110px_100px_1fr_100px_100px] gap-3 border-b border-border bg-secondary/45 px-4 py-3 text-[10px] font-semibold uppercase tracking-[.14em] text-muted-foreground md:grid"><span>Row</span><span>Field</span><span>Code</span><span>Message</span><span>Severity</span><span>Status</span></div>{filtered.map((item) => <ExceptionRow key={item.id} item={item} />)}</section>}<div className="mt-7 grid gap-6 xl:grid-cols-2"><RowsPanel title="Accepted rows" rows={run.data?.acceptedRows ?? []} accepted /><RowsPanel title="Rejected rows" rows={run.data?.rejectedRows ?? []} /></div><AttemptsPanel attempts={run.data?.attempts ?? []} /></>}</PageFrame>;
}
function ExceptionRow({ item }: { item: ValidationException }) {
  return <div data-testid={`row-exception-${item.id}`} className="grid gap-3 border-b border-border/70 px-4 py-4 last:border-0 md:grid-cols-[70px_110px_100px_1fr_100px_100px] md:items-center"><div className="flex justify-between md:block"><span className="text-xs text-muted-foreground md:hidden">Row</span><span className="mono text-xs font-semibold">#{item.rowNumber}</span></div><div className="flex justify-between md:block"><span className="text-xs text-muted-foreground md:hidden">Field</span><span className="mono text-xs">{item.field}</span></div><div className="flex justify-between md:block"><span className="text-xs text-muted-foreground md:hidden">Code</span><span className="mono text-[11px] text-muted-foreground">{item.code}</span></div><div><p className="text-sm">{item.message}</p>{item.value && <p className="mono mt-1 truncate text-[11px] text-destructive">Received: {item.value}</p>}</div><div><StatusPill value={item.severity} /></div><div><StatusPill value={item.status} /></div></div>;
}
function RowsPanel({ title, rows, accepted }: { title: string; rows: Array<{ id: string; rowNumber: number; data: Record<string, unknown> }>; accepted?: boolean }) {
  return <section className="overflow-hidden rounded-xl border border-border bg-card" data-testid={`panel-${accepted ? 'accepted' : 'rejected'}-rows`}><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-semibold">{title}</h2><p className="mt-1 text-xs text-muted-foreground">{rows.length} row{rows.length === 1 ? '' : 's'} in this run</p></div><StatusPill value={accepted ? 'accepted' : 'rejected'} /></div>{!rows.length ? <div className="p-5"><EmptyState title={`No ${accepted ? 'accepted' : 'rejected'} rows`} detail={accepted ? 'Rows passing validation will appear here.' : 'Rows with validation exceptions will appear here.'} /></div> : <div className="divide-y divide-border/70">{rows.slice(0, 20).map((row) => <div key={row.id} className="flex items-start gap-4 px-5 py-3"><span className="mono text-xs text-muted-foreground">#{row.rowNumber}</span><p className="truncate text-xs text-foreground/75">{Object.entries(row.data).map(([key, value]) => `${key}: ${String(value ?? '')}`).join(' · ')}</p></div>)}</div>}</section>;
}
function AttemptsPanel({ attempts }: { attempts: Array<{ id: string; actor: string; startedAt: string; durationMs?: number; outcome: string; reason?: string | null }> }) {
  return <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card" data-testid="panel-run-attempts"><div className="border-b border-border px-5 py-4"><h2 className="font-semibold">Run attempts</h2><p className="mt-1 text-xs text-muted-foreground">Every validation attempt, actor, duration, and outcome.</p></div>{!attempts.length ? <div className="p-5"><EmptyState icon={History} title="No completed attempts yet" detail="The attempt record will appear after processing starts." /></div> : <div className="divide-y divide-border/70">{attempts.map((attempt) => <div key={attempt.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><div><p className="text-sm font-semibold">{attempt.actor}</p><p className="mt-1 text-xs text-muted-foreground">{formatDateTime(attempt.startedAt)} · {attempt.durationMs == null ? 'Duration unavailable' : `${attempt.durationMs} ms`}</p>{attempt.reason && <p className="mt-1 text-xs text-destructive">{attempt.reason}</p>}</div><StatusPill value={attempt.outcome} /></div>)}</div>}</section>;
}

function SourceRows({ rows }: { rows: number[] }) {
  return <p className="mono mt-3 text-[10px] uppercase tracking-[.12em] text-muted-foreground" data-testid="summary-source-rows">Source rows: {rows.map((row) => `#${row}`).join(', ')}</p>;
}

function SummaryPage() {
  const { runId = '' } = useParams<{ runId: string }>();
  const run = useGetRun(runId, { query: { queryKey: getGetRunQueryKey(runId), enabled: !!runId } });
  const summary = useGetRunSummary(runId, { query: { queryKey: getGetRunSummaryQueryKey(runId), enabled: !!runId } });
  const generate = useGenerateRunSummary();
  const requestAction = useRequestAction();
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } }).data;
  const [requested, setRequested] = useState(false);
  const [actionType, setActionType] = useState<'request_correction' | 'notify_owner' | 'create_review_task'>('request_correction');
  const [headline, setHeadline] = useState('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState('');
  const current = summary.data as EvidenceSummary | undefined;
  const canMutate = user?.role === 'analyst' || user?.role === 'administrator';
  const summaryStatus = run.data?.summaryStatus;
  const retryLabels: Record<string, { title: string; detail: string }> = {
    timeout: { title: 'Summary request timed out', detail: 'The model did not respond within the evidence window. No summary was stored.' },
    rate_limited: { title: 'Summary request was rate limited', detail: 'The model provider asked us to wait. No summary was stored.' },
    malformed_output: { title: 'Summary output failed validation', detail: 'The model returned data that did not match the required evidence shape. No summary was stored.' },
  };
  const retryState = summaryStatus && retryLabels[summaryStatus] ? retryLabels[summaryStatus] : undefined;
  const generateSummary = () => {
    setError('');
    generate.mutate(
      { runId, data: { forceRegenerate: Boolean(current) } },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getGetRunSummaryQueryKey(runId), data);
          void run.refetch();
        },
        onError: () => {
          setError('Summary generation did not complete. The retry state is shown above.');
          void run.refetch();
        },
      },
    );
  };
  const submitAction = () => {
    if (!headline.trim() || !rationale.trim()) {
      setError('Add a title and rationale before requesting an action.');
      return;
    }
    requestAction.mutate({ data: { runId, actionType, title: headline, rationale } }, {
      onSuccess: () => {
        setRequested(true);
        queryClient.invalidateQueries({ queryKey: getListActionsQueryKey() });
      },
      onError: () => setError('The action request could not be submitted.'),
    });
  };
  return <PageFrame>
    <RunHeader run={run.data} active="summary" />
    {summary.isLoading || run.isLoading ? <LoadingRows count={5} /> : summary.isError && !current ? (
      retryState ? <section className="rounded-xl border border-[#ead9a8] bg-[#fff9e9] p-7" data-testid={`summary-retry-${summaryStatus}`}>
        <div className="flex items-start gap-3"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#8a5d17]" /><div><StatusPill value={summaryStatus} tone="warning" /><h2 className="mt-4 text-lg font-semibold text-[#6d4b16]">{retryState.title}</h2><p className="mt-2 text-sm text-[#8a6b35]">{retryState.detail}</p>{canMutate && <Button data-testid="button-retry-summary" disabled={generate.isPending} onClick={generateSummary} className="mt-5 bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]">{generate.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Retry summary</Button>}</div></div>
      </section> : <div><EmptyState icon={Sparkles} title="Summary not generated" detail="Generate a structured read of this run once validation has completed." action={canMutate ? <Button data-testid="button-generate-summary" disabled={generate.isPending} onClick={generateSummary}>{generate.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate evidence summary</Button> : undefined} /></div>
    ) : current ? <div className="grid gap-6 xl:grid-cols-[1.4fr_.8fr]">
      <div className="space-y-6">
        <section className="rounded-xl border border-border bg-card p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">Generated evidence / {formatDate(current.generatedAt)}</p><h2 data-testid="text-summary-headline" className="mt-4 max-w-2xl text-2xl font-bold leading-tight tracking-[-.03em]">{current.headline}</h2><SourceRows rows={current.headlineSourceRows} /></div><StatusPill value={current.riskLevel} /></div>
          <p className="mt-6 max-w-3xl text-[15px] leading-7 text-foreground/75">{current.overview}</p><SourceRows rows={current.overviewSourceRows} />
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-[11px] text-muted-foreground"><span>Model <span className="mono ml-1">{current.model}</span> · Prompt <span className="mono ml-1">{current.promptVersion}</span></span>{canMutate && <Button data-testid="button-regenerate-summary" variant="outline" size="sm" disabled={generate.isPending} onClick={generateSummary}>{generate.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Regenerate</Button>}</div>
        </section>
        <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-6 py-4"><h2 className="font-semibold">Findings</h2><p className="mt-1 text-xs text-muted-foreground">Specific, reviewable observations from the source file.</p></div><div>{current.findings.map((finding, index) => <div key={`${finding.title}-${index}`} className="flex gap-4 border-b border-border/70 p-6 last:border-0"><span className="mono flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-[11px] font-semibold text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{finding.title}</h3><StatusPill value={finding.severity} /></div><p className="mt-2 text-sm leading-6 text-muted-foreground">{finding.detail}</p><SourceRows rows={finding.sourceRowNumbers} /></div></div>)}</div></section>
      </div>
      {canMutate ? <section className="rounded-xl border border-border bg-card p-6"><div className="mb-6 flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#eaf0d0] text-[#627d18]"><Zap className="h-4 w-4" /></span><div><h2 className="font-semibold">Request follow-up</h2><p className="mt-1 text-xs text-muted-foreground">Turn this evidence into a controlled action.</p></div></div>{requested ? <div className="rounded-xl border border-[#cbdc9c] bg-[#f1f6dc] p-5"><CheckCircle2 className="h-6 w-6 text-[#627d18]" /><p className="mt-3 font-semibold text-[#52651a]">Action sent to the queue</p><p className="mt-1 text-sm text-[#6d7d3d]">An administrator will review the request before it runs.</p><Link href="/actions/queue" data-testid="link-summary-action-queue" className="mt-4 inline-flex text-xs font-semibold text-[#52651a] hover:underline">Open action queue <ArrowRight className="ml-1 h-4 w-4" /></Link></div> : <div className="space-y-4"><label className="block"><span className="mb-1.5 block text-xs font-semibold">Action type</span><select data-testid="select-action-type" value={actionType} onChange={(e) => setActionType(e.target.value as typeof actionType)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="request_correction">Request source correction</option><option value="notify_owner">Notify data owner</option><option value="create_review_task">Create review task</option></select></label><label className="block"><span className="mb-1.5 block text-xs font-semibold">Title</span><Input data-testid="input-action-title" value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="e.g. Correct missing owner codes" /></label><label className="block"><span className="mb-1.5 block text-xs font-semibold">Rationale</span><Textarea data-testid="textarea-action-rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="What should happen, and why does the evidence support it?" rows={5} /></label>{error && <p data-testid="text-summary-error" className="text-xs text-destructive">{error}</p>}<Button data-testid="button-request-action" disabled={requestAction.isPending} onClick={submitAction} className="w-full bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]">{requestAction.isPending ? <Loader2 className="animate-spin" /> : <ClipboardCheck />} Request approval</Button></div>}</section> : <section className="rounded-xl border border-border bg-card p-6"><LockKeyhole className="h-5 w-5 text-muted-foreground" /><h2 className="mt-4 font-semibold">Auditor read-only access</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">You can inspect the complete evidence summary and citations. Action requests and regeneration controls are unavailable.</p></section>}
    </div> : <EmptyState icon={Sparkles} title="Summary unavailable" detail="Generate a summary once the run has completed processing." action={canMutate ? <Button onClick={generateSummary}>Generate summary</Button> : undefined} />}
  </PageFrame>;
}

function ActionQueuePage() {
  const actions = useListActions(undefined, { query: { queryKey: getListActionsQueryKey() } });
  const approve = useApproveAction();
  const reject = useRejectAction();
  const [busyId, setBusyId] = useState('');
  const [decision, setDecision] = useState<{ actionId: string; value: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submitDecision = () => {
    if (!decision || !reason.trim()) {
      setError('A reason is required for every decision.');
      return;
    }
    setBusyId(decision.actionId);
    setError('');
    const options = {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListActionsQueryKey() });
        setBusyId('');
        setDecision(null);
        setReason('');
      },
      onError: () => {
        setBusyId('');
        setError('The decision could not be recorded.');
      },
    };
    if (decision.value === 'approve') approve.mutate({ actionId: decision.actionId, data: { reason: reason.trim() } }, options);
    else reject.mutate({ actionId: decision.actionId, data: { reason: reason.trim() } }, options);
  };
  return <PageFrame><PageIntro eyebrow="Governance" title="Action queue" detail="Review proposed follow-up actions before they affect an operational system." /><div className="mb-5 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#f8edcf] text-xs text-[#8a5d17]">{actions.data?.filter((item) => item.status === 'requested').length || 0}</span>Awaiting decision</div><span className="text-xs text-muted-foreground">Independent administrator approval · all decisions are audited</span></div>{actions.isLoading ? <LoadingRows /> : actions.isError ? <ErrorState retry={() => actions.refetch()} /> : !actions.data?.length ? <EmptyState icon={ClipboardCheck} title="Queue is clear" detail="No follow-up actions are waiting for approval." /> : <div className="space-y-3">{actions.data.map((action) => <section key={action.id} data-testid={`card-action-${action.id}`} className="rounded-xl border border-border bg-card p-5 transition-shadow hover:shadow-md"><div className="flex flex-col justify-between gap-4 md:flex-row"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><StatusPill value={action.status} /><span className="mono text-[10px] text-muted-foreground">{action.actionType}</span></div><h2 className="mt-3 text-lg font-semibold">{action.title}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{action.rationale}</p><p className="mt-4 text-[11px] text-muted-foreground">Requested by {action.requestedBy} · {formatDateTime(action.requestedAt)} · Run <Link href={`/runs/${action.runId}/summary`} data-testid={`link-action-run-${action.id}`} className="mono text-[#627d18] hover:underline">{action.runId.slice(0, 12)}</Link></p>{action.decisionNote && <p className="mt-3 text-xs text-muted-foreground">Decision reason: {action.decisionNote}</p>}</div>{action.canDecide && <div className="flex shrink-0 items-start gap-2"><Button data-testid={`button-reject-action-${action.id}`} variant="outline" disabled={busyId === action.id} onClick={() => { setDecision({ actionId: action.id, value: 'reject' }); setReason(''); setError(''); }} className="border-[#dfb4ae] text-[#963f39]"><XCircle /> Reject</Button><Button data-testid={`button-approve-action-${action.id}`} disabled={busyId === action.id} onClick={() => { setDecision({ actionId: action.id, value: 'approve' }); setReason(''); setError(''); }} className="bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]"><Check /> Approve</Button></div>}</div>{decision?.actionId === action.id && <div className="mt-5 border-t border-border pt-5"><label className="block"><span className="mb-1.5 block text-xs font-semibold">{decision.value === 'approve' ? 'Approval' : 'Rejection'} reason</span><Textarea data-testid={`textarea-${decision.value}-reason-${action.id}`} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} placeholder="Record the evidence and reasoning behind this decision." /></label>{error && <p className="mt-2 text-xs text-destructive">{error}</p>}<div className="mt-3 flex gap-2"><Button data-testid={`button-confirm-${decision.value}-${action.id}`} disabled={busyId === action.id || !reason.trim()} onClick={submitDecision}>{busyId === action.id ? <Loader2 className="animate-spin" /> : <Check />} Confirm {decision.value === 'approve' ? 'approval' : 'rejection'}</Button><Button variant="outline" onClick={() => { setDecision(null); setReason(''); setError(''); }}>Cancel</Button></div></div>}</section>)}</div>}</PageFrame>;
}

function AuditPage() {
  const audit = useListAuditEvents({ limit: 100 }, { query: { queryKey: getListAuditEventsQueryKey({ limit: 100 }) } });
  return <PageFrame><PageIntro eyebrow="Governance / read-only" title="Audit trail" detail="Append-only records for sign-in, uploads, reruns, summaries, decisions, and inbound events." action={<div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground"><LockKeyhole className="h-3.5 w-3.5" /> Read-only view</div>} />{audit.isLoading ? <LoadingRows count={6} /> : audit.isError ? <ErrorState retry={() => audit.refetch()} /> : !audit.data?.length ? <EmptyState icon={History} title="No events yet" detail="Activity will appear here as your team imports files and makes decisions." /> : <section className="overflow-hidden rounded-xl border border-border bg-card"><div className="hidden grid-cols-[1fr_150px_180px_150px] gap-4 border-b border-border bg-secondary/45 px-5 py-3 text-[10px] font-semibold uppercase tracking-[.15em] text-muted-foreground md:grid"><span>Verb</span><span>Actor</span><span>Subject</span><span>Timestamp</span></div>{audit.data.map((event) => <AuditRow key={event.id} event={event} />)}</section>}</PageFrame>;
}
function AuditRow({ event }: { event: AuditEvent }) { return <div data-testid={`row-audit-${event.id}`} className="grid gap-2 border-b border-border/70 px-5 py-4 last:border-0 md:grid-cols-[1fr_150px_180px_150px] md:items-center"><div className="flex items-start gap-3"><span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary"><History className="h-3.5 w-3.5 text-muted-foreground" /></span><div><p className="text-sm font-medium capitalize">{statusLabel(event.action)}</p></div></div><div className="pl-10 text-xs text-muted-foreground md:pl-0">{event.actor}<p className="mt-1 text-[10px] capitalize">{event.role}</p></div><div className="pl-10 text-xs text-muted-foreground md:pl-0"><span className="capitalize">{event.entityType}</span><p className="mono mt-1 text-[10px]">{event.entityId.slice(0, 18)}</p></div><div className="pl-10 text-xs text-muted-foreground md:pl-0">{formatDateTime(event.createdAt)}</div></div>; }

function SettingsPage() {
  const settings = useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } }).data;
  const update = useUpdateSettings();
  const [name, setName] = useState('');
  const [retention, setRetention] = useState('');
  const [approval, setApproval] = useState(true);
  const [saved, setSaved] = useState(false);
  const [initialized, setInitialized] = useState(false);
  if (settings.data && !initialized) { setName(settings.data.name); setRetention(String(settings.data.retentionDays)); setApproval(settings.data.requireApproval); setInitialized(true); }
  const save = () => update.mutate({ data: { name, retentionDays: Number(retention), requireApproval: approval } }, { onSuccess: (data) => { queryClient.setQueryData(getGetSettingsQueryKey(), data); setSaved(true); setTimeout(() => setSaved(false), 2200); } });
  if (user && user.role !== 'administrator') {
    return <PageFrame><PageIntro eyebrow="Organisation / read-only" title="Settings" detail="Inspect the organisation controls that govern evidence and approvals." action={<div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground"><LockKeyhole className="h-3.5 w-3.5" /> Read-only view</div>} />{settings.isLoading ? <LoadingRows count={3} /> : settings.isError ? <ErrorState retry={() => settings.refetch()} /> : <div className="grid max-w-3xl gap-4 sm:grid-cols-2"><section className="rounded-xl border border-border bg-card p-6"><p className="text-xs font-semibold text-muted-foreground">Organisation</p><p className="mt-2 text-lg font-semibold">{settings.data?.name}</p><p className="mono mt-2 text-xs text-muted-foreground">{settings.data?.code}</p></section><section className="rounded-xl border border-border bg-card p-6"><p className="text-xs font-semibold text-muted-foreground">Governance controls</p><dl className="mt-4 space-y-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Retention</dt><dd className="font-semibold">{settings.data?.retentionDays} days</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Approval required</dt><dd className="font-semibold">{settings.data?.requireApproval ? 'Yes' : 'No'}</dd></div></dl></section></div>}</PageFrame>;
  }
  return <PageFrame><PageIntro eyebrow="Organisation / administration" title="Settings" detail="Control how evidence is retained and how follow-up work is approved." />{settings.isLoading ? <LoadingRows count={3} /> : settings.isError ? <ErrorState retry={() => settings.refetch()} /> : <div className="grid max-w-4xl gap-6 lg:grid-cols-[1.2fr_.8fr]"><section className="rounded-xl border border-border bg-card p-6"><div className="mb-7 border-b border-border pb-5"><h2 className="font-semibold">Organisation profile</h2><p className="mt-1 text-xs text-muted-foreground">These identifiers appear in the audit trail and import context.</p></div><div className="space-y-5"><label className="block"><span className="mb-1.5 block text-xs font-semibold">Organisation name</span><Input data-testid="input-organisation-name" value={name} onChange={(e) => setName(e.target.value)} /></label><div><span className="mb-1.5 block text-xs font-semibold">Organisation code</span><div data-testid="text-organisation-code" className="flex h-9 items-center rounded-md border border-border bg-secondary/60 px-3 mono text-xs text-muted-foreground">{settings.data?.code}</div><p className="mt-1.5 text-[11px] text-muted-foreground">Code is assigned at setup and cannot be changed.</p></div><label className="block"><span className="mb-1.5 block text-xs font-semibold">Evidence retention</span><div className="flex items-center gap-2"><Input data-testid="input-retention-days" type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} /><span className="text-xs text-muted-foreground">days</span></div></label><div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-secondary/35 p-4"><div><p className="text-sm font-semibold">Require approval for actions</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Analysts can request follow-up work, but administrators must approve it before execution.</p></div><button data-testid="button-toggle-approval" onClick={() => setApproval(!approval)} className={`relative mt-0.5 h-6 w-11 rounded-full transition-colors ${approval ? 'bg-[#718e1f]' : 'bg-muted-foreground/30'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-card transition-transform ${approval ? 'left-6' : 'left-1'}`} /></button></div></div><div className="mt-8 flex items-center gap-3"><Button data-testid="button-save-settings" disabled={update.isPending} onClick={save} className="bg-[#d9f06c] text-[#26340f] hover:bg-[#c9e05d]">{update.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save changes</Button>{saved && <span data-testid="text-settings-saved" className="text-xs font-medium text-[#627d18]">Changes saved</span>}</div></section><section className="rounded-xl border border-border bg-[#eaf0d0] p-6"><ShieldCheck className="h-5 w-5 text-[#627d18]" /><h2 className="mt-5 text-lg font-semibold text-[#26340f]">Controls that hold up</h2><p className="mt-2 text-sm leading-6 text-[#5d6a35]">Retention and approval settings apply across this organisation. Changes are written to the audit trail with your identity and timestamp.</p><div className="mt-8 space-y-3 border-t border-[#cbdc9c] pt-5"><div className="flex items-center justify-between text-xs"><span className="text-[#5d6a35]">Approval workflow</span><span className="font-semibold text-[#52651a]">{approval ? 'Enforced' : 'Optional'}</span></div><div className="flex items-center justify-between text-xs"><span className="text-[#5d6a35]">Retention window</span><span className="font-semibold text-[#52651a]">{retention || '—'} days</span></div></div></section></div>}</PageFrame>;
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#162338] px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#162338] px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}

function LandingPage() {
  return <div className="noise min-h-[100dvh] overflow-hidden bg-background"><header className="mx-auto flex max-w-[1240px] items-center justify-between px-5 py-6 md:px-8"><Logo /><div className="flex items-center gap-3"><Link href="/sign-in" data-testid="link-landing-sign-in" className="hidden px-3 py-2 text-sm font-semibold sm:inline-flex">Sign in</Link><Link href="/sign-up" data-testid="link-landing-sign-up" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">Get started <ArrowRight className="h-4 w-4" /></Link></div></header><main><section className="evidence-grid relative mx-auto max-w-[1240px] px-5 pb-20 pt-16 md:px-8 md:pb-28 md:pt-24"><div className="max-w-4xl animate-rise"><p className="mono flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.22em] text-[#627d18]"><span className="h-2 w-2 rounded-full bg-accent" /> Operations evidence console</p><h1 className="mt-6 max-w-4xl text-5xl font-bold leading-[.96] tracking-[-.065em] text-primary md:text-[80px]">Turn operational noise into <span className="text-[#627d18]">proof.</span></h1><p className="mt-8 max-w-xl text-lg leading-8 text-muted-foreground">Proof/Ops gives analysts, administrators, and auditors one deliberate place to validate files, review exceptions, and control what happens next.</p><div className="mt-9 flex flex-wrap gap-3"><Link href="/sign-up" data-testid="link-hero-start" className="inline-flex h-12 items-center gap-2 rounded-lg bg-[#d9f06c] px-5 text-sm font-bold text-[#26340f] shadow-sm">Bring in your first run <ArrowRight className="h-4 w-4" /></Link><Link href="/sign-in" data-testid="link-hero-sign-in" className="inline-flex h-12 items-center rounded-lg border border-border bg-card px-5 text-sm font-semibold">I already have access</Link></div></div><div className="mt-16 grid max-w-4xl gap-3 sm:grid-cols-3 animate-rise-2"><div className="rounded-xl border border-border bg-card/80 p-4 backdrop-blur"><p className="mono text-[10px] text-muted-foreground">01 / INGEST</p><p className="mt-7 text-sm font-semibold">Secure file intake</p><p className="mt-2 text-xs leading-5 text-muted-foreground">Direct-to-storage uploads with a traceable run from the first byte.</p></div><div className="rounded-xl border border-border bg-card/80 p-4 backdrop-blur"><p className="mono text-[10px] text-muted-foreground">02 / VERIFY</p><p className="mt-7 text-sm font-semibold">Exception clarity</p><p className="mt-2 text-xs leading-5 text-muted-foreground">Surface the rows that matter, with context an analyst can act on.</p></div><div className="rounded-xl border border-border bg-card/80 p-4 backdrop-blur"><p className="mono text-[10px] text-muted-foreground">03 / CONTROL</p><p className="mt-7 text-sm font-semibold">Governed follow-up</p><p className="mt-2 text-xs leading-5 text-muted-foreground">Approval gates and an immutable trail keep action accountable.</p></div></div></section><section className="mx-auto grid max-w-[1240px] gap-8 px-5 py-20 md:grid-cols-[.8fr_1.2fr] md:px-8 md:py-28"><div><p className="mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">The operating model</p><h2 className="mt-5 text-3xl font-bold leading-tight tracking-[-.04em] md:text-5xl">Clarity at the exact moment it matters.</h2></div><div className="grid gap-4 sm:grid-cols-2"><div className="rounded-xl border border-border bg-card p-6"><FileCheck2 className="h-5 w-5 text-[#627d18]" /><h3 className="mt-10 font-semibold">Evidence, not just output</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Generated summaries stay tied to the source run, its findings, and the model that produced them.</p></div><div className="rounded-xl border border-border bg-primary p-6 text-primary-foreground"><ShieldCheck className="h-5 w-5 text-accent" /><h3 className="mt-10 font-semibold">Controls that feel human</h3><p className="mt-2 text-sm leading-6 text-primary-foreground/65">A fast interface for the work, with the guardrails your organisation needs underneath.</p></div><div className="rounded-xl border border-border bg-[#eaf0d0] p-6 sm:col-span-2"><p className="mono text-[10px] uppercase tracking-[.18em] text-[#627d18]">Made for the handoff</p><p className="mt-5 max-w-xl text-2xl font-semibold leading-tight tracking-[-.03em] text-[#26340f]">Analyst to administrator to auditor — one chain, no blind spots.</p></div></div></section><section className="border-y border-border bg-secondary/35"><div className="mx-auto flex max-w-[1240px] flex-col justify-between gap-6 px-5 py-16 md:flex-row md:items-center md:px-8"><div><p className="mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">Ready when you are</p><h2 className="mt-3 text-3xl font-bold tracking-[-.04em]">Start with the file in front of you.</h2></div><Link href="/sign-up" data-testid="link-landing-bottom-cta" className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground">Enter the console <ArrowRight className="h-4 w-4" /></Link></div></section></main><footer className="mx-auto flex max-w-[1240px] items-center justify-between px-5 py-7 text-xs text-muted-foreground md:px-8"><Logo /><span>Built for accountable operations.</span></footer></div>;
}

function ProtectedRoutes() {
  const user = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  if (user.isLoading) return <div className="min-h-[100dvh] bg-background p-6"><div className="mx-auto max-w-5xl"><div className="skeleton h-10 w-40 rounded-lg" /><div className="mt-16 grid gap-4 md:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-28 rounded-xl" />)}</div></div></div>;
  return <Shell user={user.data}>{<Switch><Route path="/dashboard" component={DashboardPage} /><Route path="/runs/new" component={NewRunPage} /><Route path="/runs/:runId/exceptions" component={ExceptionsPage} /><Route path="/runs/:runId/summary" component={SummaryPage} /><Route path="/runs" component={RunsPage} /><Route path="/actions/queue" component={ActionQueuePage} /><Route path="/audit" component={AuditPage} /><Route path="/settings" component={SettingsPage} /><Route><Redirect to="/dashboard" /></Route></Switch>}</Shell>;
}

function Router() {
  const [location] = useLocation();
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) {
    return <div className="min-h-[100dvh] bg-background" />;
  }
  if (location === '/' || location === '') {
    return isSignedIn ? <Redirect to="/dashboard" /> : <LandingPage />;
  }
  if (location.startsWith('/sign-in')) return <SignInPage />;
  if (location.startsWith('/sign-up')) return <SignUpPage />;
  if (!isSignedIn) return <Redirect to="/" />;
  return <ProtectedRoutes />;
}

function stripBase(path: string) {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        previousUserId.current !== undefined &&
        previousUserId.current !== userId
      ) {
        queryClient.clear();
      }
      previousUserId.current = userId;
    });
    return unsubscribe;
  }, [addListener]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: 'Welcome back',
            subtitle: 'Sign in to access your evidence workspace',
          },
        },
        signUp: {
          start: {
            title: 'Create your workspace access',
            subtitle: 'Join the accountable operations workflow',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkQueryClientCacheInvalidator />
      <Router />
    </ClerkProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ErrorBoundary resetKey={window.location.pathname}>
            <ClerkProviderWithRoutes />
          </ErrorBoundary>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;