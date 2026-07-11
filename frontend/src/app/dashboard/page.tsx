'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  getOrders, getOrderStats, updateOrder, deleteOrder, createOrder,
  getInventory, upsertInventory, getProducts, forwardToShipping,
  getStaff, distributeOrders, autoDistributeOrders, saveDistributionConfig, transferOrders, bulkDeleteOrders, getBulkAwb,
  DistributionAllocation,
  getBostaFollowUps, saveFollowUpAction,
  bulkImportOrders, BulkImportResult,
  Order, User, InventoryItem, Product, ShippingResult, StaffMember,
  BostaFollowUps, BostaFollowUpOrder, OrderStats,
} from '@/lib/api';
import OrdersTable from '@/components/OrdersTable';
/* NOTE: `xlsx` (SheetJS) is intentionally NOT imported at module level — it is
   a ~446 KB chunk that was shipping with the page's first load and stalling
   low-end mobile devices on parse/compile. It is dynamically imported inside
   handleCsvFile, so the cost is only paid when someone actually uploads a
   bulk-import file. Do not "clean this up" into a static import.            */

/* Status pills = OPERATIONAL QUEUES (exact current state, one per team action).
   'جاري الإعادة' (in transit back to us) and 'تم الإرجاع' (physically received /
   restocked) are courier-set states — surfaced here so returned parcels have a
   dedicated queue instead of hiding under 'الكل'. */
const STATUS_OPTIONS = ['جديد', 'تم التأكيد', 'تم الرفض', 'مؤجل', 'لا يرد', 'معلق حتي الدفع', 'تم الشحن', 'جاري الإعادة', 'تم الإرجاع'];

/* Every status that means the order successfully PASSED confirmation — used for
   a cumulative confirmation rate so the % doesn't collapse as orders move on to
   shipped/delivered. Mirrors the backend analytics `status_confirmed` set. */
const PASSED_CONFIRMATION = ['تم التأكيد', 'تم الشحن', 'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع'];

/* Every status that means the order was DISPATCHED — the next funnel stage down.
   The "تم الشحن" card counts this set so it reflects total shipped over the date
   range instead of draining to zero as parcels get delivered or returned. */
const PASSED_SHIPPING = ['تم الشحن', 'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع'];

/* Returns-audit queue — deep-linked from staff analytics via
   /dashboard?filter=returns_audit&agent=<email>. Combines BOTH courier return
   states so the admin sees every failed delivery for one agent in a single
   view (pull tracking numbers → audit the confirmation call recordings). */
const RETURNS_AUDIT_FILTER = 'مرتجعات (تدقيق)';
const RETURNS_AUDIT_STATUSES = ['جاري الإعادة', 'تم الإرجاع'];

/* NOTE (reporting vs operations): the card NUMBERS stay cumulative/funnel, but
   card CLICKS are an operational gesture — they filter the table to the exact
   snapshot status (e.g. orders sitting in 'تم التأكيد' awaiting dispatch). The
   card ↔ table difference is reconciled by the snapshot sub-label on the card
   itself, not by widening the table filter. */

/* Virtual status-tab value for "postponed orders due for re-confirmation within
   3 days". Hoisted to module scope because both the server-query builder and
   the filter chain need it. Maps to `reconfirm=true` on the API (not a real
   "Status" value). */
const RECONFIRM_FILTER = 'مؤجلات تستحق التأكيد';

/* All-zero placeholder backing `stats` until the first /stats response lands
   (the card grid shows skeletons instead of these zeros). Stat cards and pill
   counts are STRICTLY server-hydrated — never derived from loaded rows.     */
const EMPTY_STATS: OrderStats = {
  total: 0, new: 0, confirmed: 0, rejected: 0, postponed: 0, noAnswer: 0,
  shipped: 0, confirmedCumulative: 0, shippedCumulative: 0, reconfirm: 0,
  byStatus: {}, byAgent: {}, agentTotal: 0,
};

/* The 27 Egyptian governorates — used by the manual-order governorate dropdown. */
const EGYPT_GOVERNORATES = [
  'القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الشرقية', 'الدقهلية', 'البحيرة',
  'الغربية', 'المنوفية', 'كفر الشيخ', 'دمياط', 'بورسعيد', 'الإسماعيلية', 'السويس',
  'الفيوم', 'بني سويف', 'المنيا', 'أسيوط', 'سوهاج', 'قنا', 'الأقصر', 'أسوان',
  'البحر الأحمر', 'الوادي الجديد', 'مطروح', 'شمال سيناء', 'جنوب سيناء',
];

const getShortName = (name?: string) => {
  if (!name) return '';
  // Drop brackets/punctuation (→ space) BEFORE taking the first 3 words, so a raw
  // unlinked name like "[جهاز ليزر IPL]" collapses to the SAME short name as the
  // clean inventory-linked "جهاز ليزر IPL". This keeps the product pill list
  // deduped strictly by short name (price-agnostic) while staying short & clean,
  // and keeps the filter, count, stock badge and inventory modal all in sync.
  return name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
};

/* Normalise an order status for comparison — guards against hidden whitespace
   and Unicode-normalisation differences between the DB value and the UI literals
   (e.g. a stray RTL mark or NFC/NFD mismatch). Used by BOTH the status filter
   and the pill/stat counts so they can never diverge. */
const normStatus = (s?: string | null) => (s ?? '').normalize('NFC').trim();

interface Toast { message: string; type: 'success' | 'error' }

const todayStr = () => new Date().toLocaleDateString('en-CA');

function escapeCsv(val: string | null | undefined) {
  return `"${String(val ?? '').replace(/"/g, '""')}"`;
}

/* Defensive renderer for Bosta values that may arrive as nested objects
   ({_id,name,sector,nameAr} for cities/zones, {value,code} for states).
   Coercing to a string here prevents the "Objects are not valid as a React
   child" crash even if the backend ever sends a raw object through.          */
function bostaStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.nameAr ?? o.name ?? o.value ?? o.label ?? o.code ?? '');
  }
  return '';
}

export default function DashboardPage() {
  const router = useRouter();
  /* LOST-ORDER VIEW: this same component serves two routes — /dashboard (live
     confirmation queue) and /dashboard/lost-orders (the isolated lost batch).
     `lostMode` is derived from the path and drives which set getOrders fetches,
     the page title, and the default of the bulk-upload radio. */
  const pathname = usePathname();
  const lostMode = pathname?.startsWith('/dashboard/lost-orders') ?? false;

  const [user,          setUser]          = useState<User | null>(null);
  const [orders,        setOrders]        = useState<Order[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  /* ── Virtualized infinite scroll (keyset append + react-virtuoso) ──
     Rows load PAGE_SIZE at a time and APPEND as the user nears the list
     bottom. The state array may grow large (that's accepted), but the DOM
     stays tiny: TableVirtuoso in OrdersTable mounts only the visible rows and
     unmounts everything off-screen — that (not the array size) is what
     prevented-the-iOS-OOM. Two guards keep the fetch chain sane:
       • loadMoreOrders no-ops while a page is in flight AND dedupes by cursor,
         so a burst of endReached events can't double-fetch a page;
       • the fetchSeq ref discards any append/refresh that resolves after the
         filters changed (a cursor is only valid for the filter set that
         produced it — filter changes always replace and restart the chain). */
  const PAGE_SIZE = 100;
  const [nextCursor,  setNextCursor]  = useState<string | null>(null);
  const [hasMore,     setHasMore]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const lastRequestedCursorRef = useRef<string | null>(null);
  /* Fast stat-card numbers from GET /api/orders/stats — computed server-side
     over the WHOLE tenant scope so the cards are correct and paint immediately,
     without waiting for any order rows to arrive. */
  const [serverStats, setServerStats] = useState<OrderStats | null>(null);
  const [activeAgent,   setActiveAgent]   = useState('كل الفريق');
  const [activeProduct, setActiveProduct] = useState('كل المنتجات');
  const [activeFilter,  setActiveFilter]  = useState('الكل');
  const [startDate,     setStartDate]     = useState('');
  const [endDate,       setEndDate]       = useState('');
  const [searchTerm,    setSearchTerm]    = useState('');
  const [toast,         setToast]         = useState<Toast | null>(null);
  const [invModal,  setInvModal]  = useState(false);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [invDraft,  setInvDraft]  = useState<Record<string, string>>({});
  const [invSaving, setInvSaving] = useState<string | null>(null);
  const [products,  setProducts]  = useState<Product[]>([]);
  // Mandatory out-of-stock alert for employees. `oosModal` holds the product
  // name currently shown in the blocking modal (null = hidden); `oosAck` tracks
  // products the employee already acknowledged this session so the alert fires
  // once per product, not on every click.
  const [oosModal,  setOosModal]  = useState<string | null>(null);
  const [oosAck,    setOosAck]    = useState<Set<string>>(new Set());

  const [shippingModal,   setShippingModal]   = useState(false);
  const [shippingLoading, setShippingLoading] = useState(false);
  const [shippingResult,  setShippingResult]  = useState<ShippingResult | null>(null);
  const [allowOpenAll,    setAllowOpenAll]    = useState(false);
  const [payWithPoints,   setPayWithPoints]   = useState(false);
  /* Batch quota: how many confirmed orders to ship this run (string for the
     controlled <input>). Defaults to the full pending count when the modal opens. */
  const [shipLimit,       setShipLimit]       = useState('');

  /* ── Bulk AWB state ─────────────────────────────────────────── */
  const [awbLoading, setAwbLoading] = useState(false);

  /* ── Bosta follow-ups state ─────────────────────────────────── */
  const [followUpsModal,   setFollowUpsModal]   = useState(false);
  const [followUpsLoading, setFollowUpsLoading] = useState(false);
  const [followUps,        setFollowUps]        = useState<BostaFollowUps | null>(null);
  const [followUpsError,   setFollowUpsError]   = useState('');
  const [followUpsSearch,  setFollowUpsSearch]  = useState('');
  /* Per-row editable draft for notes / return-shipping fee, keyed by trackingNumber */
  const [followUpEdits,    setFollowUpEdits]    = useState<Record<string, { return_note: string; return_shipping_fee: string }>>({});
  const [followUpSaving,   setFollowUpSaving]   = useState<Record<string, boolean>>({});

  /* ── Staff / routing state ───────────────────────────────────── */
  const [staff,         setStaff]         = useState<StaffMember[]>([]);
  const [distributing,  setDistributing]  = useState(false);
  const [savingDist,    setSavingDist]    = useState(false);
  /* Distribution modal */
  const [showDistModal, setShowDistModal] = useState(false);
  const [distMode,      setDistMode]      = useState<'equal' | 'custom'>('equal');
  const [distPercents,  setDistPercents]  = useState<Record<number, string>>({});
  /* Manual add-order modal */
  const EMPTY_ADD_FORM = { FullName: '', Phone: '', City: '', Address: '', productId: '', ProductName: '', sku: '', ProductPrice: '', quantity: '1' };
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm,      setAddForm]      = useState({ ...EMPTY_ADD_FORM });
  const [addSaving,    setAddSaving]    = useState(false);
  const [selectedIds,   setSelectedIds]   = useState<number[]>([]);   // bulk checkbox selection
  const [showXferModal, setShowXferModal] = useState(false);
  const [xferTargetId,  setXferTargetId]  = useState<number | ''>('');
  const [xferSaving,    setXferSaving]    = useState(false);
  const [bulkDeleting,  setBulkDeleting]  = useState(false);
  /* ── CSV bulk import ─────────────────────────────────────────── */
  const [showCsvModal,  setShowCsvModal]  = useState(false);
  const [csvParsed,     setCsvParsed]     = useState<Partial<Order>[]>([]);
  const [csvFileName,   setCsvFileName]   = useState('');
  const [csvUploading,  setCsvUploading]  = useState(false);
  /* Bulk-upload target: false = طلبات فعلية (live), true = طلبات مفقودة (lost). */
  const [csvIsLost,     setCsvIsLost]     = useState(false);
  /* Lost-order manual distribution (dedicated page only). */
  const [assigningLost, setAssigningLost] = useState(false);

  /* ── Auth guard ──────────────────────────────────────────────── */
  useEffect(() => {
    const token    = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (!token || !userData) { router.push('/'); return; }
    setUser(JSON.parse(userData));
  }, [router]);

  /* ── Server-side filter query ────────────────────────────────── */
  // Search is debounced so we don't hit the API on every keystroke; the RAW
  // searchTerm still drives the client-side refinement below, so the table
  // narrows instantly from loaded rows while the server round-trip fills in
  // historical matches.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 400);
    return () => clearTimeout(t);
  }, [searchTerm]);

  /* Single source of truth for what the server should filter. Changing ANY of
     these re-runs the page-1 fetch effect below → the loaded array is REPLACED
     and the cursor reset (a keyset cursor is only valid for the filter set that
     produced it). The UI's "all" sentinel values map to `undefined` = no param. */
  const serverFilters = useMemo(() => ({
    lost:      lostMode,
    search:    debouncedSearch || undefined,
    /* Virtual tabs → server params: the returns-audit queue spans BOTH courier
       return statuses (comma list → btrim(Status) = ANY on the server); the
       reconfirm tab maps to its own flag, not a Status value. */
    status:    activeFilter === RETURNS_AUDIT_FILTER ? RETURNS_AUDIT_STATUSES.join(',')
             : activeFilter !== 'الكل' && activeFilter !== RECONFIRM_FILTER ? activeFilter
             : undefined,
    reconfirm: activeFilter === RECONFIRM_FILTER ? true : undefined,
    agent:     activeAgent !== 'كل الفريق' ? activeAgent : undefined,
    product:   activeProduct !== 'كل المنتجات' ? activeProduct : undefined,
    dateFrom:  startDate || undefined,
    dateTo:    endDate || undefined,
  }), [lostMode, debouncedSearch, activeFilter, activeAgent, activeProduct, startDate, endDate]);

  /* Monotonic fetch sequence — any page-1 fetch invalidates every response
     still in flight (an older filter's slow response must never clobber a
     newer filter's rows, and a stale load-more must never append to them). */
  const fetchSeq = useRef(0);

  /* ── Fetch page 1 and REPLACE state (initial / filter change / refresh) ── */
  // spinner (silent !== true) → full-page skeleton (initial mount + explicit
  // refresh button, which binds onClick={fetchOrders} so the first arg may be
  // a MouseEvent — hence the strict `silent === true` check). Filter/search
  // refetches pass silent=true: the skeleton unmounts the search bar and would
  // steal keyboard focus mid-typing.
  //
  // CLEANUP SAFETY: `loading` is cleared by WHICHEVER fetch finishes as the
  // latest (seq === fetchSeq.current), regardless of which fetch set it — a
  // superseded initial fetch must never strand the skeleton on screen.
  const fetchOrders = useCallback(async (silent?: unknown) => {
    const isSilent = silent === true;
    const seq = ++fetchSeq.current;
    lastRequestedCursorRef.current = null;   // new chain — allow the first append
    try {
      if (!isSilent) setLoading(true);
      setError('');
      const res = await getOrders({ ...serverFilters, limit: PAGE_SIZE });
      if (seq !== fetchSeq.current) return;   // superseded by a newer fetch
      setOrders(res.data.orders);             // REPLACE — restart the scroll chain
      setNextCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
    } catch (err: unknown) {
      if (seq !== fetchSeq.current) return;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/');
      } else if (!isSilent) {
        setError('فشل في تحميل الطلبات. تحقق من الاتصال بالخادم.');
      }
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [router, serverFilters]);

  /* Merge a freshly-fetched FIRST page into existing state without discarding
     rows appended by loadMoreOrders(): rows the server just returned replace
     their loaded counterparts (new + edited orders), everything older stays. */
  const mergeFirstPage = (prev: Order[], fresh: Order[]): Order[] => {
    const freshIds = new Set(fresh.map((o) => o.id));
    return [...fresh, ...prev.filter((o) => !freshIds.has(o.id))];
  };

  /* ── Silent background refresh (no skeleton, no scroll reset) ── */
  // Re-fetches page 1 of the current filter set every 30 s and merges it in
  // place, preserving scroll position and appended pages. Captures the seq
  // WITHOUT incrementing — a poll must never supersede a user fetch.
  const silentRefresh = useCallback(async () => {
    const seq = fetchSeq.current;
    try {
      const res = await getOrders({ ...serverFilters, limit: PAGE_SIZE });
      if (seq !== fetchSeq.current) return;   // filters changed mid-flight → stale
      setOrders((prev) => mergeFirstPage(prev, res.data.orders));
      // Only adopt the fresh cursor when nothing beyond page 1 is loaded —
      // otherwise this would rewind the append chain's progress.
      setNextCursor((prev) => (prev === null ? res.data.nextCursor : prev));
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/');
      }
      // All other errors are swallowed — never flash UI errors during a background poll
    }
  }, [router, serverFilters]);

  /* ── Append next page (virtuoso endReached) ──────────────────── */
  // The DOM stays bounded no matter how much this appends — TableVirtuoso
  // renders only the visible window. Cursor dedupe makes endReached bursts
  // idempotent: the same page can never be requested twice.
  const loadMoreOrders = useCallback(async () => {
    if (!hasMore || loadingMore || !nextCursor) return;
    if (lastRequestedCursorRef.current === nextCursor) return;   // burst dedupe
    lastRequestedCursorRef.current = nextCursor;
    const seq = fetchSeq.current;
    setLoadingMore(true);
    try {
      const res = await getOrders({ ...serverFilters, limit: PAGE_SIZE, cursor: nextCursor });
      if (seq !== fetchSeq.current) return;   // filters changed mid-flight → don't append
      setOrders((prev) => [...prev, ...res.data.orders]);
      setNextCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
    } catch {
      // Allow a retry on the next endReached — scrolling again re-requests.
      lastRequestedCursorRef.current = null;
    } finally {
      setLoadingMore(false);
    }
  }, [serverFilters, hasMore, loadingMore, nextCursor]);

  /* ── Stat cards: fetch server-side aggregate immediately, independent of
     the (paginated) order rows. Scoped by agent/product/date (matching the old
     client-side dateScoped semantics) but never by status/search.          */
  const fetchStats = useCallback(async () => {
    try {
      const res = await getOrderStats({
        lost:     lostMode,
        agent:    serverFilters.agent,
        product:  serverFilters.product,
        dateFrom: serverFilters.dateFrom,
        dateTo:   serverFilters.dateTo,
      });
      setServerStats(res.data);
    } catch {
      // Falls back to the client-computed `stats` below — no user-facing error needed.
    }
  }, [lostMode, serverFilters]);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => {
    const id = setInterval(fetchStats, 30_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  // Initial load (skeleton) + every filter/search change (silent replace).
  // fetchOrders' identity changes ONLY when serverFilters does, so this effect
  // fires exactly once per filter change. No state it writes feeds back into
  // fetchOrders' identity → it cannot loop.
  const didInitialLoad = useRef(false);
  useEffect(() => {
    fetchOrders(didInitialLoad.current);   // false → skeleton on the very first run only
    didInitialLoad.current = true;
  }, [fetchOrders]);

  /* Deep-link support — the staff-analytics returns drill-down lands here as
     /dashboard?filter=returns_audit&agent=<email>. Read once on mount via
     window.location (no useSearchParams → no Suspense boundary needed). */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('filter') === 'returns_audit') setActiveFilter(RETURNS_AUDIT_FILTER);
    const agentParam = params.get('agent');
    if (agentParam) setActiveAgent(agentParam);
  }, []);

  // Background polling every 30 s — silent, no spinner, no scroll disruption
  useEffect(() => {
    const id = setInterval(() => {
      silentRefresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [silentRefresh]);

  /* ── Toast ───────────────────────────────────────────────────── */
  const showToast = (message: string, type: Toast['type']) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  /* ── Products (new inventory table — stock in filter pills) ─── */
  const fetchProducts = useCallback(async () => {
    try {
      const res = await getProducts();
      setProducts(res.data);
    } catch {
      // Silently swallow — 403 for non-admins is expected
    }
  }, []);

  useEffect(() => {
    // All roles fetch products — agents need them for the manual-order modal
    // (backend strips COGS for non-admins).
    if (user) fetchProducts();
  }, [user, fetchProducts]);

  // Background products poll — keeps stock badges in filter pills fresh.
  useEffect(() => {
    const id = setInterval(fetchProducts, 30_000);
    return () => clearInterval(id);
  }, [fetchProducts]);

  /* ── Inventory (legacy simple table — powers the Inventory modal) */
  const fetchInventory = useCallback(async () => {
    try {
      const res = await getInventory();
      setInventory(res.data);
      setInvDraft(() => {
        const draft: Record<string, string> = {};
        res.data.forEach((item) => { draft[item.ProductName] = String(item.StockQuantity); });
        return draft;
      });
    } catch {
      // silently swallow — 403 for non-admins is expected
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') fetchInventory();
  }, [user, fetchInventory]);

  // Background inventory poll — runs every 30 s alongside the orders poll.
  // fetchInventory already silently swallows 403 for non-admins, so no gate needed.
  useEffect(() => {
    const id = setInterval(fetchInventory, 30_000);
    return () => clearInterval(id);
  }, [fetchInventory]);

  /* ── Staff list (admin only — powers the transfer modal) ──────── */
  const fetchStaff = useCallback(async () => {
    try {
      const res = await getStaff();
      setStaff(res.data);
    } catch {
      // Silently swallow — 403 for non-admins is expected
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') fetchStaff();
  }, [user, fetchStaff]);

  const handleSaveStock = async (shortName: string) => {
    const qty = parseInt(invDraft[shortName] ?? '0', 10);
    if (isNaN(qty) || qty < 0) return;
    setInvSaving(shortName);
    try {
      const res = await upsertInventory(shortName, qty);
      setInventory((prev) => {
        const idx = prev.findIndex((i) => i.ProductName === shortName);
        return idx >= 0
          ? prev.map((i) => (i.ProductName === shortName ? res.data : i))
          : [...prev, res.data];
      });
      showToast('تم حفظ المخزون', 'success');
    } catch {
      showToast('فشل في حفظ المخزون', 'error');
    } finally {
      setInvSaving(null);
    }
  };

  /* ── Update / Delete ─────────────────────────────────────────── */
  const handleUpdate = async (id: number, data: Partial<Order>) => {
    /* STRICT optimistic update — mutate the row in local state SYNCHRONOUSLY,
       before any await, so the UI changes the instant the user picks a status
       (no transparent/loading row). The API runs in the background; we only
       touch state again if it FAILS (rollback). */
    let prevOrder: Order | null = null;
    setOrders((prev) => prev.map((o) => {
      if (o.id !== id) return o;
      prevOrder = o;                 // snapshot for rollback
      return { ...o, ...data };      // instant merge
    }));

    try {
      await updateOrder(id, data);
      // Success: non-blocking toast + background stock-badge refresh (deferred,
      // never awaited; OrdersTable is memoised against products so it won't
      // re-render the table).
      setTimeout(() => showToast('تم الحفظ بنجاح', 'success'), 0);
      setTimeout(() => fetchProducts(), 0);
    } catch (err: unknown) {
      // Rollback to the pre-edit row only on failure.
      if (prevOrder) {
        const snapshot = prevOrder;
        setOrders((prev) => prev.map((o) => (o.id === id ? snapshot : o)));
      }
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل في الحفظ — تم التراجع';
      setTimeout(() => showToast(msg, 'error'), 0);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteOrder(id);
      setOrders((prev) => prev.filter((o) => o.id !== id));
      showToast('تم حذف الطلب بنجاح', 'success');
    } catch {
      showToast('فشل في حذف الطلب', 'error');
    }
  };

  /* ── Distribute orders (equal or custom %) ──────────────────── */
  const handleConfirmDistribute = async () => {
    setDistributing(true);
    try {
      let res;
      if (distMode === 'custom') {
        const allocations: DistributionAllocation[] = activeAgentsForDist.map((a) => ({
          agentId:    a.id,
          percentage: Number(distPercents[a.id] ?? 0) || 0,
        }));
        res = await distributeOrders('custom', allocations);
      } else {
        res = await distributeOrders('equal');
      }
      const { distributed } = res.data;
      if (distributed === 0) {
        showToast('لا توجد طلبات غير موزعة حالياً', 'error');
      } else {
        showToast(`تم توزيع ${distributed} طلب بنجاح! 🎉`, 'success');
        await fetchOrders();
      }
      setShowDistModal(false);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل التوزيع';
      showToast(msg, 'error');
    } finally {
      setDistributing(false);
    }
  };

  /* ── Save custom percentages for AUTO-distribution (EasyOrder webhook) ──
     Persists the weights so new incoming orders are auto-assigned by them. */
  const handleSaveDistribution = async () => {
    setSavingDist(true);
    try {
      const allocations: DistributionAllocation[] = activeAgentsForDist.map((a) => ({
        agentId:    a.id,
        percentage: Number(distPercents[a.id] ?? 0) || 0,
      }));
      await saveDistributionConfig(allocations);
      showToast('تم حفظ نسب التوزيع التلقائي ✓', 'success');
      await fetchStaff();   // refresh saved percentages
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل حفظ النسب';
      showToast(msg, 'error');
    } finally {
      setSavingDist(false);
    }
  };

  /* ── Bulk AWB handler ───────────────────────────────────────── */
  const handleBulkAwb = async () => {
    if (selectedIds.length === 0) {
      showToast('اختر طلبات أولاً لطباعة البوالص', 'error');
      return;
    }
    setAwbLoading(true);
    try {
      const res = await getBulkAwb(selectedIds);
      const contentType = (res.headers['content-type'] as string) || '';

      if (contentType.includes('application/pdf')) {
        /* Stream PDF blob → trigger browser download */
        const url = URL.createObjectURL(res.data);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = `bosta-awb-${Date.now()}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('تم تحميل البوالص بنجاح ✅', 'success');
      } else {
        /* JSON blob containing a URL from Bosta */
        const text = await (res.data as Blob).text();
        const json = JSON.parse(text) as { url?: string; download_url?: string; pdfUrl?: string };
        const pdfUrl = json.url || json.download_url || json.pdfUrl;
        if (pdfUrl) {
          window.open(pdfUrl, '_blank', 'noopener,noreferrer');
          showToast('تم فتح رابط البوالص في تبويب جديد ✅', 'success');
        } else {
          showToast('لم يتم إرجاع رابط PDF من Bosta', 'error');
        }
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل طباعة البوالص — تحقق من الإعدادات';
      showToast(msg, 'error');
    } finally {
      setAwbLoading(false);
    }
  };

  /* ── Bosta follow-ups handler ───────────────────────────────── */
  const openFollowUps = async () => {
    setFollowUpsModal(true);
    setFollowUpsLoading(true);
    setFollowUpsError('');
    try {
      const res = await getBostaFollowUps();
      setFollowUps(res.data);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'تعذّر جلب المتابعات من شركة الشحن — تحقق من التوكن في الإعدادات';
      setFollowUpsError(msg);
      setFollowUps(null);
    } finally {
      setFollowUpsLoading(false);
    }
  };

  /* Initialise the editable draft for a row the first time it renders */
  const getFollowUpDraft = (r: BostaFollowUpOrder) => {
    const key = bostaStr(r.trackingNumber);
    return (
      followUpEdits[key] ?? {
        return_note: r.return_note ?? '',
        return_shipping_fee:
          r.return_shipping_fee != null && r.return_shipping_fee !== 0
            ? String(r.return_shipping_fee)
            : '',
      }
    );
  };

  const updateFollowUpDraft = (
    trackingNumber: string,
    field: 'return_note' | 'return_shipping_fee',
    value: string,
    base: BostaFollowUpOrder,
  ) => {
    setFollowUpEdits((prev) => {
      const current =
        prev[trackingNumber] ?? {
          return_note: base.return_note ?? '',
          return_shipping_fee:
            base.return_shipping_fee != null && base.return_shipping_fee !== 0
              ? String(base.return_shipping_fee)
              : '',
        };
      return { ...prev, [trackingNumber]: { ...current, [field]: value } };
    });
  };

  /* Persist a row's notes + return-shipping fee (auto-save on blur) */
  const saveFollowUpRow = async (r: BostaFollowUpOrder) => {
    const trackingNumber = bostaStr(r.trackingNumber);
    if (!trackingNumber) return;
    const draft = followUpEdits[trackingNumber];
    if (!draft) return; // nothing edited

    const note = draft.return_note ?? '';
    const fee = Math.max(0, parseFloat(draft.return_shipping_fee) || 0);

    // Skip the round-trip if nothing actually changed
    const origNote = r.return_note ?? '';
    const origFee = r.return_shipping_fee ?? 0;
    if (note === origNote && fee === origFee) return;

    if (!r.order_id) {
      showToast('لا يوجد طلب محلي مرتبط برقم التتبع هذا', 'error');
      return;
    }

    setFollowUpSaving((prev) => ({ ...prev, [trackingNumber]: true }));
    try {
      const res = await saveFollowUpAction(trackingNumber, {
        return_note: note,
        return_shipping_fee: fee,
      });
      // Reflect the persisted values back into the live data set
      setFollowUps((prev) => {
        if (!prev) return prev;
        const patch = (list: BostaFollowUpOrder[]) =>
          list.map((o) =>
            bostaStr(o.trackingNumber) === trackingNumber
              ? { ...o, return_note: res.data.return_note, return_shipping_fee: res.data.return_shipping_fee }
              : o,
          );
        return {
          ...prev,
          action_required: patch(prev.action_required),
        };
      });
      showToast('تم حفظ بيانات المرتجع', 'success');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'تعذّر حفظ البيانات';
      showToast(msg, 'error');
    } finally {
      setFollowUpSaving((prev) => {
        const next = { ...prev };
        delete next[trackingNumber];
        return next;
      });
    }
  };

  /* Copy the (filtered) phone numbers, stripping the +2 / 002 country prefix */
  const handleCopyFollowUpNumbers = async (rows: BostaFollowUpOrder[]) => {
    const phones = rows
      .map((r) => bostaStr(r.phone).trim())
      .filter(Boolean)
      .map((p) => p.replace(/^\+?2(?=0)/, '').replace(/^00?2(?=0)/, ''))
      .join('\n');

    if (!phones) {
      showToast('لا توجد أرقام لنسخها', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(phones);
      showToast('تم نسخ الأرقام بنجاح', 'success');
    } catch {
      showToast('فشل في نسخ الأرقام', 'error');
    }
  };

  /* ── Bulk selection helpers ─────────────────────────────────── */
  const toggleSelection = (id: number) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const toggleSelectAll = (visibleIds: number[]) => {
    const allSelected = visibleIds.every((id) => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds((prev) => prev.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelectedIds((prev) => [...new Set([...prev, ...visibleIds])]);
    }
  };

  /* ── Bulk transfer (selected orders → target agent) ──────────── */
  const handleTransferOrders = async () => {
    if (!selectedIds.length || xferTargetId === '') return;
    setXferSaving(true);
    try {
      const res = await transferOrders(selectedIds, xferTargetId as number);
      const { transferred, targetEmail } = res.data;
      setOrders((prev) =>
        prev.map((o) =>
          selectedIds.includes(o.id) ? { ...o, AssignedTo: targetEmail } : o
        )
      );
      showToast(
        `تم نقل ${transferred} طلب بنجاح إلى ${targetEmail.split('@')[0]}`,
        'success'
      );
      setShowXferModal(false);
      setSelectedIds([]);
      setXferTargetId('');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل نقل الطلبات';
      showToast(msg, 'error');
    } finally {
      setXferSaving(false);
    }
  };

  /* ── Bulk delete (selected orders) ───────────────────────────── */
  const handleBulkDelete = async () => {
    if (!selectedIds.length || bulkDeleting) return;
    if (!window.confirm('هل أنت متأكد من حذف الطلبات المحددة نهائياً؟')) return;

    setBulkDeleting(true);
    try {
      const res = await bulkDeleteOrders(selectedIds);
      const idSet = new Set(selectedIds);
      setOrders((prev) => prev.filter((o) => !idSet.has(o.id)));
      showToast(`تم حذف ${res.data.deleted} طلب بنجاح`, 'success');
      setSelectedIds([]);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل حذف الطلبات';
      showToast(msg, 'error');
    } finally {
      setBulkDeleting(false);
    }
  };

  /* ── Present agents (for transfer modal dropdown) ───────────── */
  const presentAgents = staff.filter(
    (m) => m.role === 'agent' && m.is_active && !m.is_absent
  );

  /* ── Distribution: active agents + live percentage sum ───────── */
  const activeAgentsForDist = staff.filter((m) => m.role === 'agent' && m.is_active);
  const distSum = activeAgentsForDist.reduce(
    (s, a) => s + (Number(distPercents[a.id] ?? 0) || 0), 0
  );

  /* Open the distribution modal. If saved auto-distribution percentages exist,
     seed from them (so the admin sees/edits the persisted split); otherwise seed
     an equal split as a sensible default. */
  const openDistModal = () => {
    const hasSaved = activeAgentsForDist.some((a) => Number(a.distribution_percentage ?? 0) > 0);
    const seed: Record<number, string> = {};
    if (hasSaved) {
      activeAgentsForDist.forEach((a) => {
        seed[a.id] = String(Number(a.distribution_percentage ?? 0) || 0);
      });
      setDistMode('custom');
    } else {
      setDistMode('equal');
      const n = activeAgentsForDist.length;
      if (n > 0) {
        const base = Math.floor(100 / n);
        let rem = 100 - base * n;
        activeAgentsForDist.forEach((a) => {
          seed[a.id] = String(base + (rem-- > 0 ? 1 : 0));
        });
      }
    }
    setDistPercents(seed);
    setShowDistModal(true);
  };

  /* ── Manual order creation ───────────────────────────────────── */
  const openAddModal = () => {
    setAddForm({ ...EMPTY_ADD_FORM });
    setShowAddModal(true);
  };

  /* ── CSV / Excel bulk import helpers ─────────────────────────────
     Reads .csv, .xlsx and .xls natively via the `xlsx` library so that
     Excel files (the most common real-world upload) parse correctly
     instead of being mangled by a text-only CSV reader. The first sheet
     is converted to JSON objects keyed by header; flexible Arabic/English
     header aliases are then matched against each row. */
  const handleCsvFile = (file: File) => {
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // Deferred: the xlsx bundle loads on first upload, never on page load.
        const XLSX = await import('xlsx');
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const firstSheet = wb.Sheets[wb.SheetNames[0]];
        if (!firstSheet) { showToast('الملف فارغ أو لا يحتوي على بيانات', 'error'); return; }

        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: '' });
        if (!rows.length) { showToast('الملف فارغ أو لا يحتوي على بيانات', 'error'); return; }

        const parsed: Partial<Order>[] = [];
        for (const raw of rows) {
          // Normalise header keys (lowercase + trim + strip wrapping quotes)
          // and stringify values once, so alias lookups are cheap & robust.
          const row: Record<string, string> = {};
          for (const k of Object.keys(raw)) {
            const v = raw[k];
            row[k.trim().toLowerCase().replace(/^"|"$/g, '')] = v == null ? '' : String(v).trim();
          }

          // Map flexible header aliases → our Order field names
          const pick = (aliases: string[]) => {
            for (const a of aliases) { if (row[a]) return row[a]; }
            return '';
          };

          // Normalise phone: strip non-digits, and recover the leading 0 that
          // Excel drops when it stores a mobile as a number (10 digits starting
          // with '1' → prepend '0' → valid 11-digit Egyptian mobile '010…').
          let phone = pick(['phone', 'telephone', 'mobile', 'رقم الهاتف', 'الهاتف']).replace(/\D/g, '');
          if (phone.length === 10 && phone.startsWith('1')) phone = '0' + phone;
          if (!phone) continue;   // phone is the dedup key — skip rows without one

          parsed.push({
            FullName:     pick(['name', 'full name', 'fullname', 'full_name', 'customer name', 'customer_name', 'الاسم', 'اسم العميل', 'الاسم بالكامل', 'الاسم الكامل']),
            Phone:        phone,
            City:         pick(['city', 'government', 'governorate', 'state', 'province', 'المدينة', 'المحافظة', 'محافظة']),
            Address:      pick(['address', 'street', 'العنوان', 'العنوان التفصيلي', 'الشارع', 'تفاصيل العنوان', 'عنوان']),
            ProductName:  pick(['product', 'products', 'product_name', 'productname', 'item', 'المنتج', 'اسم المنتج', 'المنتجات']),
            ProductPrice: pick(['productprice', 'price', 'السعر', 'الاجمالي', 'الإجمالي']),
            Note:         pick(['note', 'notes', 'ملاحظة', 'ملاحظات']) || null,
          });
        }

        setCsvParsed(parsed);
      } catch {
        showToast('تعذّر قراءة الملف — تأكد أنه ملف Excel أو CSV صالح', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleCsvImport = async () => {
    if (!csvParsed.length) return;
    setCsvUploading(true);
    try {
      const res = await bulkImportOrders(csvParsed, csvIsLost);
      const { importedCount, skippedCount } = res.data;
      showToast(
        `تمت الإضافة! تم استيراد ${importedCount} ${csvIsLost ? 'طلب مفقود' : 'طلب'}، وتجاهل ${skippedCount} طلب مكرر`,
        'success',
      );
      setShowCsvModal(false);
      setCsvParsed([]);
      setCsvFileName('');
      fetchOrders();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل استيراد الملف';
      showToast(msg, 'error');
    } finally {
      setCsvUploading(false);
    }
  };

  /* Manually distribute the isolated lost orders to agents (dedicated page only).
     Calls auto-distribute scoped to lost=true so live orders are never touched. */
  const handleAssignLostOrders = async () => {
    if (assigningLost) return;
    setAssigningLost(true);
    try {
      const res = await autoDistributeOrders(true);
      const { distributed, agentsCount } = res.data;
      showToast(
        distributed > 0
          ? `تم توزيع ${distributed} طلب مفقود على ${agentsCount} موظف`
          : 'لا توجد طلبات مفقودة بحالة «جديد» للتوزيع',
        distributed > 0 ? 'success' : 'error',
      );
      if (distributed > 0) fetchOrders();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل توزيع الطلبات المفقودة';
      showToast(msg, 'error');
    } finally {
      setAssigningLost(false);
    }
  };

  const handleCreateOrder = async () => {
    if (!addForm.FullName.trim() || !addForm.Phone.trim()) {
      showToast('الاسم ورقم الهاتف مطلوبان', 'error');
      return;
    }
    setAddSaving(true);
    try {
      const res = await createOrder({
        FullName:     addForm.FullName.trim(),
        Phone:        addForm.Phone.trim(),
        City:         addForm.City.trim(),
        Address:      addForm.Address.trim(),
        ProductName:  addForm.ProductName.trim() || undefined,
        sku:          addForm.sku.trim() || undefined,
        ProductPrice: addForm.ProductPrice.trim() || undefined,
        quantity:     Math.max(1, parseInt(addForm.quantity, 10) || 1),
      });
      setOrders((prev) => [res.data, ...prev]);   // show instantly at the top
      showToast('تم إضافة الطلب بنجاح', 'success');
      setShowAddModal(false);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل في إضافة الطلب';
      showToast(msg, 'error');
    } finally {
      setAddSaving(false);
    }
  };

  /* ── Role-based privacy fence ────────────────────────────────── */
  // This is the ONLY place that enforces visibility.
  // Agents see exclusively their own assigned orders; admins see everything.
  // Every derived list and filter below must start from `roleScoped`,
  // not from the raw `orders` array.
  const roleScoped: Order[] =
    user?.role !== 'admin' && user?.email
      ? orders.filter((o) => o.AssignedTo === user.email)
      : orders;

  /* ── Derived lists ───────────────────────────────────────────── */
  // With SERVER-side filtering, `orders` only contains rows matching the active
  // filters — deriving the pill lists from it would collapse them to the
  // current selection (select agent A → every other agent's pill vanishes).
  // Agents: the staff roster (already fetched for admins — the only role that
  // sees the team pills) is the complete, stable source; order-derived is the
  // fallback for the pre-fetch window / non-admins (their own orders only).
  const orderDerivedAgents = Array.from(
    new Set(roleScoped.map((o) => o.AssignedTo).filter(Boolean))
  ) as string[];
  const staffAgents = staff.filter((m) => m.role === 'agent').map((m) => m.email);
  const uniqueAgents = staffAgents.length ? staffAgents : orderDerivedAgents;

  // Products: accumulate every short name seen this session (a Set ref survives
  // filtered refetches), so selecting one product doesn't hide the others.
  // Idempotent adds during render are safe; the ref resets on remount
  // (navigating between live/lost pages).
  const productsSeenRef = useRef<Set<string>>(new Set());
  roleScoped.forEach((o) => {
    const short = getShortName(o.ProductName);
    if (short) productsSeenRef.current.add(short);
  });
  const uniqueProducts = Array.from(productsSeenRef.current);

  // First known price per short product name — used in product filter tab badges
  const productPriceMap: Record<string, string> = {};
  roleScoped.forEach((o) => {
    if (o.ProductName && o.ProductPrice) {
      const short = getShortName(o.ProductName);
      if (!productPriceMap[short]) productPriceMap[short] = o.ProductPrice;
    }
  });

  /* ── Filter chain: agent → product → status → date ──────────── */
  // 1. Agent scope — admin-only UI toggle; for agents roleScoped is already
  //    their strict slice so this just handles admin's team-switcher.
  const agentFiltered =
    activeAgent === 'كل الفريق'
      ? roleScoped
      : roleScoped.filter((o) => o.AssignedTo === activeAgent);

  // 2. Product scope
  const productFiltered =
    activeProduct === 'كل المنتجات'
      ? agentFiltered
      : agentFiltered.filter((o) => getShortName(o.ProductName) === activeProduct);

  // 2.5 Date scope — applied BEFORE status/search so every stat, pill count, and
  //     the table all reflect the selected day range. Timezone-safe (local day).
  const isInDateRange = (o: Order): boolean => {
    if (!startDate && !endDate) return true;
    const day = new Date(o.createdAt);
    if (Number.isNaN(day.getTime())) return false;     // unparseable → excluded when filtering
    const orderDay = day.toLocaleDateString('en-CA');  // 'YYYY-MM-DD' in local time
    if (startDate && orderDay < startDate) return false;
    if (endDate   && orderDay > endDate)   return false;
    return true;
  };
  const dateScoped = productFiltered.filter(isInDateRange);

  // 3a. Helper — true when a postponed order needs re-confirmation within 3 days
  const needsReconfirmation = (o: Order): boolean => {
    if (o.Status !== 'مؤجل' || !o.PostponedDate) return false;
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const postponed = new Date(o.PostponedDate);
    postponed.setHours(0, 0, 0, 0);
    const diffDays = Math.floor(
      (postponed.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24)
    );
    return diffDays >= 0 && diffDays <= 3;
  };

  // Badge count — scoped to current agent + product selection. Server value is
  // exact over the whole history; loaded-rows count is the fallback until the
  // first /stats response lands.
  const reconfirmCount = serverStats?.reconfirm ?? 0;   // strictly server-hydrated

  // 3b. Status + date — final display set
  const filtered = (() => {
    if (activeFilter === RECONFIRM_FILTER) {
      // Special path: ignore date range; sort closest postponed date first
      return [...productFiltered.filter(needsReconfirmation)].sort(
        (a, b) => new Date(a.PostponedDate!).getTime() - new Date(b.PostponedDate!).getTime()
      );
    }
    if (activeFilter === RETURNS_AUDIT_FILTER) {
      // Audit queue: both courier return states in one view.
      return dateScoped.filter((o) => RETURNS_AUDIT_STATUSES.includes(normStatus(o.Status)));
    }
    // Build on the date-scoped set so the table matches the date-aware counts.
    return dateScoped.filter(
      (o) => activeFilter === 'الكل' || normStatus(o.Status) === normStatus(activeFilter)
    );
  })();

  // 4. Search — final layer; composable on top of every other filter.
  //    MUST accept everything the server's ?search= matches (name, phone,
  //    order id, Bosta tracking code) — the server now returns those rows and
  //    a narrower client predicate would silently hide them from the table.
  const searchNeedle = searchTerm.trim().toLowerCase();
  const displayOrders: Order[] = searchNeedle
    ? filtered.filter(
        (o) =>
          o.FullName.toLowerCase().includes(searchNeedle) ||
          o.Phone.toLowerCase().includes(searchNeedle) ||
          String(o.id) === searchNeedle ||
          (o.BostaTrackingCode ?? '').toLowerCase().includes(searchNeedle)
      )
    : filtered;

  /* ── Stats — STRICTLY server-hydrated (GET /api/orders/stats) ─── */
  // Never derived from the loaded rows: with paginated fetching the in-memory
  // array is a window, not the dataset, and counting it produced the infamous
  // "الإجمالي = 50" bug. Until the first /stats response the cards render as
  // skeletons (see the grid below) — EMPTY_STATS only backs the few places
  // (e.g. the distribution modal count) that read `stats` before then.
  // Semantics preserved from the funnel rework: confirmed/shipped are snapshot
  // queue sizes; confirmedCumulative/shippedCumulative are "ever reached this
  // stage" — all computed in SQL over the whole tenant history, scoped by
  // agent/product/date exactly like the old dateScoped chain.
  const stats: OrderStats = serverStats ?? EMPTY_STATS;
  const pct = (n: number) =>
    stats.total ? Math.round((n / stats.total) * 100) : 0;

  // "Send What You See": the confirmed orders within the CURRENTLY filtered/
  // searched table view (same order as displayed). The shipping badge and the
  // batch we dispatch are both derived from this — so they always match
  // exactly what the user is looking at (incl. product filter). We intentionally
  // do NOT exclude orders that carry a BostaTrackingCode, so a manually-reverted
  // order can be re-selected and re-sent to generate a fresh waybill.
  const confirmedDisplayOrders = displayOrders.filter(
    (o) => normStatus(o.Status) === 'تم التأكيد'
  );
  const pendingShipCount = confirmedDisplayOrders.length;

  // Effective batch size to ship: the requested quota clamped to [1, pending].
  // A blank/invalid input falls back to shipping the entire visible queue.
  const effectiveShipCount = (() => {
    const parsed = parseInt(shipLimit, 10);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, pendingShipCount)
      : pendingShipCount;
  })();

  /* ── Copy phones (all currently displayed/filtered orders) ──── */
  const handleCopyPhones = async () => {
    const phones = displayOrders
      .map((o) => o.Phone)
      .filter(Boolean)
      .join('\n');

    if (!phones) {
      showToast('لا توجد أرقام لنسخها', 'error');
      return;
    }

    try {
      await navigator.clipboard.writeText(phones);
      showToast('تم نسخ الأرقام بنجاح', 'success');
    } catch {
      showToast('فشل في نسخ الأرقام', 'error');
    }
  };

  /* ── Export CSV ──────────────────────────────────────────────── */
  const handleExportCsv = () => {
    const headers = ['الاسم الكامل', 'الهاتف', 'المدينة', 'العنوان', 'المنتج', 'السعر', 'حالة الاستلام', 'الحالة', 'الملاحظة', 'الموظف المسؤول'];
    const rows = filtered.map((o) => [
      escapeCsv(o.FullName),
      escapeCsv(o.Phone),
      escapeCsv(o.City),
      escapeCsv(o.Address),
      escapeCsv(o.ProductName),
      escapeCsv(o.ProductPrice),
      escapeCsv(o.DeliveryRate),
      escapeCsv(o.Status),
      escapeCsv(o.Note),
      escapeCsv(o.AssignedTo),
    ].join(','));

    // UTF-8 BOM so Arabic renders correctly in Excel
    const csv  = '﻿' + [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `orders_${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Bosta shipping forward ──────────────────────────────────── */
  const handleForwardShipping = async () => {
    setShippingLoading(true);
    setShippingResult(null);
    try {
      // COD Note (Bosta deposit mapping):
      // For orders where hasDeposit=true, the Bosta shipment COD must equal:
      //   remainingCOD = (ProductPrice + shippingFee) - depositAmount
      // The server reads hasDeposit & depositAmount from the DB per order when
      // building the Bosta payload — no extra data needs to be sent from here.
      //
      // TODO (Wallet): After a successful forward, credit the business_wallet:
      //   UPDATE business_wallet SET balance += SUM(depositAmount)
      //   for all orders in this batch where hasDeposit = true.
      //   This records already-collected cash into the wallet ledger before shipment.
      // Slice the first N confirmed orders from the CURRENT filtered view and
      // ship exactly those ids ("Send What You See"). N is the clamped quota.
      const idsToShip = confirmedDisplayOrders
        .slice(0, effectiveShipCount)
        .map((o) => o.id);
      const res = await forwardToShipping(allowOpenAll, idsToShip, payWithPoints);
      setShippingResult(res.data);
      // Refresh the current page silently so statuses update without scroll disruption
      await silentRefresh();
      fetchStats();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل في إرسال الطلبات للشحن';
      setShippingResult({ message: msg, success: [], failed: [] });
    } finally {
      setShippingLoading(false);
    }
  };

  const isAdmin = user?.role === 'admin';

  // Returns real stock_quantity from the /api/products table ONLY.
  // Returns null while products are loading so stale numbers from the
  // legacy inventory table never appear in the filter-pill badges.
  // Matching order (most → least strict):
  //   1. exact full-name  2. short-name (first 3 words)  3. prefix containment
  // All comparisons are case-insensitive and whitespace-normalised.
  // Resolve a filter pill's short name to its master catalog product (/api/products).
  const findCatalogProduct = (shortName: string): Product | undefined => {
    if (!products.length) return undefined; // still loading
    const norm  = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    const needle = norm(shortName);
    return products.find((p) => {
      const full  = norm(p.name);
      const short = norm(getShortName(p.name));
      return (
        full  === needle ||
        short === needle ||
        full.startsWith(needle) ||
        needle.startsWith(short)
      );
    });
  };

  const getStock = (shortName: string): number | null => {
    const found = findCatalogProduct(shortName);
    // Admins receive the exact count; for employees the backend strips it, so
    // this is `undefined` → null (the numeric badge is admin-gated anyway).
    return found?.stock_quantity ?? null;
  };

  // Role-agnostic out-of-stock check. Admins get the exact `stock_quantity`;
  // employees receive the derived `stock_status`. Returns false when the product
  // can't be resolved (still loading / not linked to the catalog), so we never
  // block on missing data.
  const isOutOfStock = (shortName: string): boolean => {
    const found = findCatalogProduct(shortName);
    if (!found) return false;
    if (typeof found.stock_quantity === 'number') return found.stock_quantity === 0;
    return found.stock_status === 'OUT_OF_STOCK';
  };

  // Resolve a product to the employee-facing 3-tier stock state. Admins carry the
  // exact `stock_quantity`, so we derive the same tiers from it for consistency;
  // employees carry the pre-computed `stock_status` (+ `low_stock_count` in the
  // 1–5 band). Returns null when the product isn't resolvable yet.
  type EmployeeStock =
    | { tier: 'IN_STOCK' }
    | { tier: 'LOW_STOCK'; count: number }
    | { tier: 'OUT_OF_STOCK' };
  const getEmployeeStockStatus = (shortName: string): EmployeeStock | null => {
    const found = findCatalogProduct(shortName);
    if (!found) return null;
    if (typeof found.stock_quantity === 'number') {
      if (found.stock_quantity === 0) return { tier: 'OUT_OF_STOCK' };
      if (found.stock_quantity <= 5)  return { tier: 'LOW_STOCK', count: found.stock_quantity };
      return { tier: 'IN_STOCK' };
    }
    switch (found.stock_status) {
      case 'OUT_OF_STOCK': return { tier: 'OUT_OF_STOCK' };
      case 'LOW_STOCK':    return { tier: 'LOW_STOCK', count: found.low_stock_count ?? 0 };
      case 'IN_STOCK':     return { tier: 'IN_STOCK' };
      default:             return null;
    }
  };

  // Selecting a product filter pill. For employees, picking an out-of-stock
  // product raises the mandatory red alert (once per product per session) so
  // they stop confirming orders on a depleted SKU.
  const handleSelectProduct = (p: string) => {
    setActiveProduct(p);
    if (!isAdmin && p !== 'كل المنتجات' && isOutOfStock(p) && !oosAck.has(p)) {
      setOosModal(p);
    }
  };

  // The single acknowledgement action — the only way to dismiss the alert.
  const acknowledgeOutOfStock = () => {
    if (oosModal) setOosAck((prev) => new Set(prev).add(oosModal));
    setOosModal(null);
  };

  // Official master selling price from the catalog — stable, unlike order
  // ProductPrice which includes dynamic shipping. null when not linked to a product.
  const getCatalogPrice = (shortName: string): string | null => {
    const found = findCatalogProduct(shortName);
    if (!found) return null;
    const sp = parseFloat(String(found.selling_price));
    return Number.isFinite(sp) ? String(sp) : null;
  };

  /* ── Render ──────────────────────────────────────────────────── */
  return (
    <div dir="rtl" className="min-h-full">

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg
            text-white text-sm font-medium
            ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}
        >
          {toast.message}
        </div>
      )}

      <div className="max-w-screen-2xl mx-auto px-6 pt-8 pb-6 space-y-5">

        {/* ── Page title row ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">
              {lostMode ? 'تأكيد الطلبات المفقودة' : 'سيستم تأكيد الطلبات'}
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {lostMode
                ? 'طلبات مفقودة/تاريخية — معزولة عن طابور التأكيد المباشر'
                : isAdmin
                  ? 'عرض جميع الطلبات وإدارة الفريق'
                  : `طلباتك — ${user?.email ?? ''}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openAddModal}
              title="إضافة طلب يدوي"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl
                bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800
                text-white text-sm font-semibold shadow-sm shadow-indigo-500/20
                transition-all duration-150 active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              إضافة طلب
            </button>

            {isAdmin && (
              <button
                onClick={() => { setCsvParsed([]); setCsvFileName(''); setCsvIsLost(lostMode); setShowCsvModal(true); }}
                title="رفع ملفات Excel أو CSV"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl
                  bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800
                  text-white text-sm font-semibold shadow-sm shadow-emerald-500/20
                  transition-all duration-150 active:scale-95"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                إضافة طلبات مجمعة (Excel)
              </button>
            )}

            {/* Lost-orders only: manually hand the isolated batch to agents when
                ready — scoped to lost=true so the live auto-queue is never touched. */}
            {lostMode && isAdmin && (
              <button
                onClick={handleAssignLostOrders}
                disabled={assigningLost}
                title="توزيع الطلبات المفقودة على الموظفين"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl
                  bg-amber-600 hover:bg-amber-700 active:bg-amber-800 disabled:opacity-50
                  text-white text-sm font-semibold shadow-sm shadow-amber-500/20
                  transition-all duration-150 active:scale-95"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {assigningLost ? 'جارٍ التوزيع…' : 'توزيع الطلبات المفقودة'}
              </button>
            )}

            <button
              onClick={fetchOrders}
              title="تحديث الطلبات"
              className="flex items-center gap-2 px-3 py-2 rounded-xl
                text-slate-500 dark:text-slate-400
                hover:text-indigo-600 dark:hover:text-indigo-400
                hover:bg-white dark:hover:bg-slate-800
                hover:shadow-sm border border-transparent
                hover:border-slate-200 dark:hover:border-slate-700
                transition-all text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              تحديث
            </button>
          </div>
        </div>

        {/* ── Team filter — admin only ──────────────────────────────── */}
        {isAdmin && uniqueAgents.length > 0 && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl
            border border-slate-200 dark:border-slate-800 px-4 py-3.5 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 dark:text-slate-500
              uppercase tracking-wider mb-2.5">
              فلتر فريق العمل
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {['كل الفريق', ...uniqueAgents].map((agent) => (
                <button
                  key={agent}
                  onClick={() => setActiveAgent(agent)}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-150
                    ${activeAgent === agent
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
                >
                  {agent === 'كل الفريق' ? 'كل الفريق' : agent.split('@')[0]}
                  <span className={`mr-1.5 text-xs
                    ${activeAgent === agent ? 'text-indigo-200' : 'text-slate-400 dark:text-slate-500'}`}>
                    ({/* Exact whole-queue counts from /stats (byAgent ignores
                        the active pill, so siblings keep their numbers).
                        STRICTLY server-hydrated: '…' until the first response,
                        never a count of the loaded rows. */
                      serverStats === null ? '…'
                        : agent === 'كل الفريق'
                          ? serverStats.agentTotal
                          : (serverStats.byAgent[agent] ?? 0)})
                  </span>
                </button>
              ))}

            </div>
          </div>
        )}

        {/* ── CSV Bulk Import Modal ─────────────────────────────────── */}
        {showCsvModal && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setShowCsvModal(false)}
          >
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md p-6" dir="rtl">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">رفع ملفات (Excel / CSV)</h2>
                <button onClick={() => setShowCsvModal(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Expected headers hint */}
              <div className="mb-4 p-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">الأعمدة المتوقعة في الملف:</p>
                <p dir="ltr" className="font-mono">name, phone, city, address, product_name, price, notes</p>
                <p className="mt-1">• رقم الهاتف إلزامي — الصفوف بدونه تُتجاهل تلقائياً.</p>
                <p>• أي هاتف موجود مسبقاً في النظام يُتجاهل (لا تكرار).</p>
              </div>

              {/* Batch type — REQUIRED. Live orders enter the confirmation queue;
                  lost orders are isolated on the dedicated "الطلبات المفقودة" page. */}
              <div className="mb-4">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">نوع الطلبات في الملف:</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { val: false, label: 'طلبات فعلية', hint: 'تدخل طابور التأكيد', active: 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' },
                    { val: true,  label: 'طلبات مفقودة', hint: 'معزولة عن العمليات', active: 'border-amber-500 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' },
                  ].map((opt) => {
                    const selected = csvIsLost === opt.val;
                    return (
                      <button
                        key={String(opt.val)}
                        type="button"
                        onClick={() => setCsvIsLost(opt.val)}
                        className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-xl border-2 text-right transition
                          ${selected ? opt.active : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="flex items-center gap-1.5 text-sm font-semibold">
                          <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center
                            ${selected ? 'border-current' : 'border-slate-300 dark:border-slate-600'}`}>
                            {selected && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
                          </span>
                          {opt.label}
                        </span>
                        <span className="text-[11px] opacity-80 pr-5">{opt.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* File picker */}
              <label className="flex flex-col items-center justify-center gap-2 w-full h-32
                border-2 border-dashed border-slate-300 dark:border-slate-600
                rounded-xl cursor-pointer hover:border-emerald-400 transition
                bg-slate-50 dark:bg-slate-800/50 mb-4">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {csvFileName || 'اضغط لاختيار ملف Excel أو CSV'}
                </span>
                <input
                  type="file"
                  accept=".csv, .xlsx, .xls, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleCsvFile(file);
                  }}
                />
              </label>

              {/* Parse result preview */}
              {csvParsed.length > 0 && (
                <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-emerald-50 dark:bg-emerald-900/30
                  border border-emerald-200 dark:border-emerald-700 rounded-xl text-sm text-emerald-700 dark:text-emerald-300">
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  تم قراءة <span className="font-bold mx-1">{csvParsed.length}</span> طلب من الملف — جاهز للرفع
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={handleCsvImport}
                  disabled={csvParsed.length === 0 || csvUploading}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50
                    text-white py-2.5 rounded-xl text-sm font-semibold transition"
                >
                  {csvUploading ? 'جارٍ الرفع...' : `استيراد ${csvParsed.length > 0 ? `(${csvParsed.length})` : ''}`}
                </button>
                <button
                  onClick={() => setShowCsvModal(false)}
                  className="flex-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200
                    dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300
                    py-2.5 rounded-xl text-sm font-semibold transition"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Manual Add-Order Modal ────────────────────────────────── */}
        {showAddModal && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && !addSaving && setShowAddModal(false)}
          >
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl
              border border-slate-200 dark:border-slate-700/60 w-full max-w-md flex flex-col max-h-[90vh]" dir="rtl">

              {/* Header */}
              <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white leading-tight">إضافة طلب يدوي</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    طلب خارجي (واتساب / فيسبوك) — يبدأ بحالة «جديد»
                  </p>
                </div>
                <button onClick={() => setShowAddModal(false)} disabled={addSaving}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
                    hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-40" aria-label="إغلاق">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Body */}
              <div className="px-6 py-4 space-y-3.5 overflow-y-auto">
                {/* Plain text fields (name + phone) */}
                {([
                  { key: 'FullName', label: 'اسم العميل *', dir: 'rtl', ph: 'الاسم الكامل' },
                  { key: 'Phone',    label: 'رقم الهاتف *', dir: 'ltr', ph: '01XXXXXXXXX' },
                ] as { key: keyof typeof addForm; label: string; dir: string; ph: string }[]).map((f) => (
                  <div key={f.key}>
                    <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">{f.label}</label>
                    <input
                      type="text"
                      value={addForm[f.key]}
                      onChange={(e) => setAddForm((p) => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.ph}
                      dir={f.dir}
                      className="w-full px-3 py-2 rounded-xl text-sm outline-none
                        bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                        text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                        focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                    />
                  </div>
                ))}

                {/* Governorate dropdown */}
                <div>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">المحافظة</label>
                  <select
                    value={addForm.City}
                    onChange={(e) => setAddForm((p) => ({ ...p, City: e.target.value }))}
                    className="w-full px-3 py-2 rounded-xl text-sm outline-none cursor-pointer
                      bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                      text-slate-900 dark:text-slate-100
                      focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                  >
                    <option value="">— اختر المحافظة —</option>
                    {EGYPT_GOVERNORATES.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>

                {/* Detailed address */}
                <div>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">العنوان التفصيلي</label>
                  <input
                    type="text"
                    value={addForm.Address}
                    onChange={(e) => setAddForm((p) => ({ ...p, Address: e.target.value }))}
                    placeholder="الشارع، المبنى، علامة مميزة"
                    dir="rtl"
                    className="w-full px-3 py-2 rounded-xl text-sm outline-none
                      bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                      text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                      focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                  />
                </div>

                {/* Product dropdown — selecting one fills ProductName + sku and
                    auto-fills the price (still editable below). */}
                <div>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">المنتج (اختياري)</label>
                  <select
                    value={addForm.productId}
                    onChange={(e) => {
                      const prod = products.find((p) => p.id === e.target.value);
                      setAddForm((p) => ({
                        ...p,
                        productId:    e.target.value,
                        ProductName:  prod ? prod.name : '',
                        sku:          prod ? (prod.sku ?? '') : '',
                        // auto-fill the price from the product (editable afterwards)
                        ProductPrice: prod ? String(prod.selling_price ?? '') : p.ProductPrice,
                      }));
                    }}
                    className="w-full px-3 py-2 rounded-xl text-sm outline-none cursor-pointer
                      bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                      text-slate-900 dark:text-slate-100
                      focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                  >
                    <option value="">— اختر منتجاً —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.sku ? ` (${p.sku})` : ''}
                      </option>
                    ))}
                  </select>
                  {products.length === 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      لا توجد منتجات مُسجّلة بعد — أضِف منتجات من صفحة المخزون.
                    </p>
                  )}
                </div>

                {/* Quantity + Total / COD */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">الكمية</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={addForm.quantity}
                      onChange={(e) => setAddForm((p) => ({ ...p, quantity: e.target.value }))}
                      placeholder="1"
                      dir="ltr"
                      className="w-full px-3 py-2 rounded-xl text-sm outline-none
                        bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                        text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                        focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">الإجمالي / المبلغ (COD)</label>
                    <input
                      type="number"
                      min="0"
                      value={addForm.ProductPrice}
                      onChange={(e) => setAddForm((p) => ({ ...p, ProductPrice: e.target.value }))}
                      placeholder="0"
                      dir="ltr"
                      className="w-full px-3 py-2 rounded-xl text-sm outline-none
                        bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                        text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                        focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                    />
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="px-6 pb-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex gap-3">
                <button
                  onClick={handleCreateOrder}
                  disabled={addSaving || !addForm.FullName.trim() || !addForm.Phone.trim()}
                  className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl
                    text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white
                    shadow-md shadow-indigo-600/20 disabled:opacity-50 disabled:cursor-not-allowed
                    transition-all duration-150 active:scale-[0.98]"
                >
                  {addSaving ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      جارٍ الإضافة…
                    </>
                  ) : 'إضافة الطلب'}
                </button>
                <button onClick={() => setShowAddModal(false)} disabled={addSaving}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold
                    bg-slate-100 hover:bg-slate-200 text-slate-700
                    dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                    disabled:opacity-50 transition">
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Distribution Modal (equal / custom %) ─────────────────── */}
        {showDistModal && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && !distributing && setShowDistModal(false)}
          >
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl
              border border-slate-200 dark:border-slate-700/60 w-full max-w-md flex flex-col max-h-[90vh]" dir="rtl">

              {/* Header */}
              <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white leading-tight">توزيع الطلبات</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    توزيع الطلبات الجديدة (<span className="font-semibold">{stats.new}</span>) على الموظفين
                  </p>
                </div>
                <button onClick={() => setShowDistModal(false)} disabled={distributing}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
                    hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-40" aria-label="إغلاق">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Mode tabs */}
              <div className="px-6 pt-4">
                <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                  {([
                    { v: 'equal',  label: 'توزيع بالتساوي' },
                    { v: 'custom', label: 'توزيع مخصص (%)' },
                  ] as { v: 'equal' | 'custom'; label: string }[]).map((t) => (
                    <button key={t.v} onClick={() => setDistMode(t.v)}
                      className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all duration-150
                        ${distMode === t.v
                          ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Body */}
              <div className="px-6 py-4 flex-1 overflow-y-auto">
                {activeAgentsForDist.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-amber-700 dark:text-amber-400
                    bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-xl">
                    لا يوجد موظفون نشطون للتوزيع عليهم
                  </div>
                ) : distMode === 'equal' ? (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                      سيتم توزيع الطلبات بالتساوي على الموظفين الحاضرين ({presentAgents.length}).
                    </p>
                    {presentAgents.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 px-3 py-2 rounded-xl
                        bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 text-sm">
                        <span className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900/60
                          text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-xs font-bold shrink-0">
                          {(a.name?.trim()?.[0] || a.email[0]).toUpperCase()}
                        </span>
                        <span className="text-slate-700 dark:text-slate-300 truncate">
                          {a.name?.trim() || a.email.split('@')[0]}
                        </span>
                      </div>
                    ))}
                    {presentAgents.length === 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">لا يوجد موظفون حاضرون حالياً.</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeAgentsForDist.map((a) => (
                      <div key={a.id} className="flex items-center gap-2.5 px-3 py-2 rounded-xl
                        bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60">
                        <span className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900/60
                          text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-xs font-bold shrink-0">
                          {(a.name?.trim()?.[0] || a.email[0]).toUpperCase()}
                        </span>
                        <span className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-300 truncate">
                          {a.name?.trim() || a.email.split('@')[0]}
                        </span>
                        <div className="relative shrink-0">
                          <input
                            type="number" min={0} max={100}
                            value={distPercents[a.id] ?? ''}
                            onChange={(e) => setDistPercents((p) => ({ ...p, [a.id]: e.target.value }))}
                            className="w-20 px-2 py-1.5 pl-6 text-sm text-center rounded-lg outline-none
                              bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600
                              text-slate-800 dark:text-slate-100
                              focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                          />
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
                        </div>
                      </div>
                    ))}

                    {/* Live sum validation */}
                    <div className={`flex items-center justify-between px-3 py-2 rounded-xl text-sm font-semibold mt-2
                      ${distSum === 100
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/50'
                        : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800/50'}`}>
                      <span>إجمالي النسب</span>
                      <span>{distSum}% {distSum === 100 ? '✓' : `(يجب أن يساوي 100%)`}</span>
                    </div>

                    {/* Save for auto-distribution (EasyOrder webhook) */}
                    <div className="mt-3 rounded-xl border border-indigo-100 dark:border-indigo-900/40
                      bg-indigo-50/50 dark:bg-indigo-950/20 px-3 py-3">
                      <p className="text-xs text-indigo-700/90 dark:text-indigo-300/80 leading-relaxed mb-2">
                        احفظ هذه النسب ليتم توزيع الطلبات الواردة من إيزي أوردر تلقائياً عليها (Weighted Round-Robin).
                      </p>
                      <button
                        onClick={handleSaveDistribution}
                        disabled={savingDist || activeAgentsForDist.length === 0}
                        className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-lg
                          text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white
                          disabled:opacity-50 disabled:cursor-not-allowed transition active:scale-[0.98]"
                      >
                        {savingDist ? 'جارٍ الحفظ…' : '💾 حفظ نسب التوزيع التلقائي'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 pb-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex gap-3">
                <button
                  onClick={handleConfirmDistribute}
                  disabled={
                    distributing ||
                    activeAgentsForDist.length === 0 ||
                    (distMode === 'custom' && distSum !== 100) ||
                    (distMode === 'equal' && presentAgents.length === 0)
                  }
                  className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl
                    text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white
                    shadow-md shadow-emerald-600/20 disabled:opacity-50 disabled:cursor-not-allowed
                    transition-all duration-150 active:scale-[0.98]"
                >
                  {distributing ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      جارٍ التوزيع…
                    </>
                  ) : 'تأكيد التوزيع'}
                </button>
                <button onClick={() => setShowDistModal(false)} disabled={distributing}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold
                    bg-slate-100 hover:bg-slate-200 text-slate-700
                    dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                    disabled:opacity-50 transition">
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Transfer Selected Modal ──────────────────────────────── */}
        {showXferModal && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && !xferSaving && setShowXferModal(false)}
          >
            <div
              className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl
                border border-slate-200 dark:border-slate-700/60
                w-full max-w-md flex flex-col"
              dir="rtl"
            >
              {/* ── Modal header ───────────────────────────────────── */}
              <div className="flex items-center justify-between px-6 pt-6 pb-4
                border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/40
                    flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-emerald-700 dark:text-emerald-400"
                      fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-white leading-tight">
                      نقل الطلبات المحددة
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      سيتم نقل{' '}
                      <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                        {selectedIds.length}
                      </span>
                      {' '}طلب محدد إلى الموظف المختار
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowXferModal(false)}
                  disabled={xferSaving}
                  className="p-1.5 rounded-lg
                    text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
                    hover:bg-slate-100 dark:hover:bg-slate-800
                    transition-all duration-150 disabled:opacity-40"
                  aria-label="إغلاق"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* ── Agent list ─────────────────────────────────────── */}
              <div className="px-6 py-4 flex-1">
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase
                  tracking-wide mb-3">
                  اختر الموظف المستهدف
                  <span className="normal-case font-normal text-slate-400 dark:text-slate-600 mr-1.5">
                    — {presentAgents.length} حاضر
                  </span>
                </p>

                {presentAgents.length === 0 ? (
                  <div className="flex items-center gap-2.5 px-4 py-3.5 rounded-xl
                    bg-amber-50 dark:bg-amber-900/20
                    border border-amber-200 dark:border-amber-700/50
                    text-amber-800 dark:text-amber-400 text-sm">
                    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    لا يوجد موظفون حاضرون حالياً — تحقق من سجل الحضور
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[260px] overflow-y-auto -mr-1 pr-1">
                    {presentAgents.map((agent) => {
                      const isSelected = xferTargetId === agent.id;
                      const initial = (agent.name?.trim()?.[0] || agent.email[0]).toUpperCase();
                      const displayLabel = agent.name?.trim() || agent.email.split('@')[0];
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => setXferTargetId(agent.id)}
                          className={`
                            w-full flex items-center gap-3 px-4 py-3 rounded-xl
                            border-2 text-right transition-all duration-150
                            ${isSelected
                              ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/50 dark:border-emerald-500'
                              : 'border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800'}
                          `}
                        >
                          {/* Avatar */}
                          <div className={`
                            w-9 h-9 rounded-full flex items-center justify-center
                            shrink-0 text-sm font-bold select-none
                            ${isSelected
                              ? 'bg-emerald-600 text-white'
                              : 'bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300'}
                          `}>
                            {initial}
                          </div>

                          {/* Name + email */}
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm font-semibold truncate leading-tight
                              ${isSelected
                                ? 'text-emerald-800 dark:text-emerald-300'
                                : 'text-slate-900 dark:text-slate-100'}`}>
                              {displayLabel}
                            </p>
                            <p className="text-xs text-slate-600 dark:text-slate-400 truncate mt-0.5">
                              {agent.email}
                            </p>
                          </div>

                          {/* Selection indicator */}
                          <div className={`
                            w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0
                            transition-all duration-150
                            ${isSelected
                              ? 'border-emerald-500 bg-emerald-500'
                              : 'border-slate-300 dark:border-slate-600'}
                          `}>
                            {isSelected && (
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Footer buttons ─────────────────────────────────── */}
              <div className="px-6 pb-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex gap-3">
                <button
                  onClick={handleTransferOrders}
                  disabled={xferTargetId === '' || xferSaving || presentAgents.length === 0}
                  className="flex-1 inline-flex items-center justify-center gap-2
                    py-2.5 px-4 rounded-xl text-sm font-semibold
                    bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white
                    shadow-md shadow-emerald-600/20
                    disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none
                    transition-all duration-150 active:scale-[0.98]"
                >
                  {xferSaving ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10"
                          stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor"
                          d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      جارٍ النقل…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                      تأكيد نقل {selectedIds.length} طلب
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowXferModal(false)}
                  disabled={xferSaving}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold
                    bg-slate-100 hover:bg-slate-200 active:bg-slate-300
                    text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                    transition-all duration-150 disabled:opacity-50"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Inventory Modal ──────────────────────────────────────── */}
        {invModal && (
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setInvModal(false)}
          >
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" dir="rtl">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-800">إدارة المخزون</h2>
                <button onClick={() => setInvModal(false)}
                  className="text-gray-400 hover:text-gray-600 transition">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {uniqueProducts.length === 0 ? (
                <p className="text-center text-gray-400 py-8 text-sm">لا توجد منتجات في النظام حتى الآن</p>
              ) : (
                <div className="space-y-3 max-h-[60vh] overflow-y-auto pl-1">
                  {uniqueProducts.map((p) => {
                    const stock = getStock(p);
                    return (
                      <div key={p}
                        className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-gray-300 transition">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-800 truncate">{p}</p>
                          <p className={`text-xs mt-0.5 font-medium
                            ${stock === null
                              ? 'text-gray-400'
                              : stock === 0
                                ? 'text-red-500'
                                : stock <= 5
                                  ? 'text-amber-500'
                                  : 'text-emerald-500'}`}>
                            {stock === null
                              ? 'غير محدد'
                              : stock === 0
                                ? 'نفد من المخزن'
                                : `${stock} في المخزن`}
                          </p>
                        </div>
                        <input
                          type="number"
                          min="0"
                          value={invDraft[p] ?? ''}
                          onChange={(e) => setInvDraft((d) => ({ ...d, [p]: e.target.value }))}
                          placeholder="0"
                          className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm
                            text-center outline-none focus:ring-2 focus:ring-emerald-400"
                        />
                        <button
                          onClick={() => handleSaveStock(p)}
                          disabled={invSaving === p}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white
                            rounded-lg text-xs font-semibold transition disabled:opacity-50 whitespace-nowrap"
                        >
                          {invSaving === p ? '...' : 'حفظ'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Mandatory Out-of-Stock Alert (employees only) ─────────────
            Blocking modal: no backdrop-click / escape / close button. The ONLY
            way out is the single acknowledgement button. */}
        {oosModal && !isAdmin && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60]
              flex items-center justify-center p-4"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="oos-title"
          >
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl
              w-full max-w-sm p-7 text-center border-2 border-red-500/60" dir="rtl">
              {/* Red alert icon */}
              <div className="inline-flex items-center justify-center w-16 h-16
                rounded-full bg-red-100 dark:bg-red-900/40 mb-4">
                <svg className="w-9 h-9 text-red-600 dark:text-red-400"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4
                       a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
                </svg>
              </div>

              <h2 id="oos-title" className="text-xl font-extrabold text-red-600 dark:text-red-400 mb-1.5">
                الكمية خلصت حاليا
              </h2>
              <p className="text-sm font-semibold text-slate-600 dark:text-slate-300 mb-6">
                {oosModal}
              </p>

              <button
                onClick={acknowledgeOutOfStock}
                autoFocus
                className="w-full py-3 rounded-xl text-sm font-bold text-white
                  bg-red-600 hover:bg-red-700 active:bg-red-800
                  shadow-lg shadow-red-500/30 transition-all duration-150"
              >
                تمام هوقف تاكيدات عليه
              </button>
            </div>
          </div>
        )}

        {/* ── Bosta Shipping Modal ─────────────────────────────────── */}
        {shippingModal && (
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && !shippingLoading && setShippingModal(false)}
          >
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" dir="rtl">

              {/* ── Pre-send confirmation ── */}
              {!shippingResult && (
                <>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 bg-teal-100 rounded-xl flex items-center justify-center shrink-0">
                      <svg className="w-5 h-5 text-teal-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-gray-800">إرسال الطلبات للشحن</h2>
                      <p className="text-xs text-gray-400">عبر شركة بوسطة (Bosta)</p>
                    </div>
                  </div>

                  {pendingShipCount === 0 ? (
                    <div className="bg-gray-50 rounded-xl px-4 py-6 text-center text-gray-500 text-sm mb-5">
                      لا توجد طلبات مؤكدة جديدة بانتظار الشحن
                    </div>
                  ) : (
                    <>
                      <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-4 mb-4">
                        <p className="text-sm text-teal-800">
                          يوجد{' '}
                          <span className="font-bold text-teal-900 text-base">{pendingShipCount}</span>
                          {' '}طلب مؤكد بانتظار الشحن.
                        </p>
                        <p className="text-xs text-teal-600 mt-1">
                          الطلبات التي تم إرسالها مسبقاً لن تُكرَّر. ستُرسَل الطلبات الأقدم أولاً.
                        </p>
                      </div>

                      {/* Batch quota — how many orders to send this run */}
                      <label className="block mb-5">
                        <span className="block text-sm font-semibold text-gray-700 mb-1.5">
                          كم عدد الطلبات التي تريد إرسالها لشركة الشحن؟
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={pendingShipCount}
                          step={1}
                          value={shipLimit}
                          onChange={(e) => setShipLimit(e.target.value)}
                          disabled={shippingLoading}
                          className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm
                            text-gray-800 tabular-nums focus:outline-none focus:ring-2
                            focus:ring-teal-500/40 focus:border-teal-400 transition disabled:opacity-50"
                          placeholder={String(pendingShipCount)}
                        />
                        <span className="block text-xs text-gray-400 mt-1">
                          بحد أقصى {pendingShipCount} طلب — لإرسال دفعة حسب باقة الشحن.
                        </span>
                      </label>
                    </>
                  )}

                  {/* Allow-open checkbox */}
                  <label className="flex items-center gap-2.5 mb-3 cursor-pointer select-none group">
                    <input
                      type="checkbox"
                      checked={allowOpenAll}
                      onChange={(e) => setAllowOpenAll(e.target.checked)}
                      className="w-4 h-4 accent-teal-600 rounded cursor-pointer"
                    />
                    <span className="text-sm text-gray-600 group-hover:text-gray-800 transition">
                      السماح بفتح الشحنة لجميع الطلبات
                    </span>
                  </label>

                  {/* Pay-with-Bosta-points checkbox */}
                  <label className="flex items-center gap-2.5 mb-5 cursor-pointer select-none group">
                    <input
                      type="checkbox"
                      checked={payWithPoints}
                      onChange={(e) => setPayWithPoints(e.target.checked)}
                      className="w-4 h-4 accent-teal-600 rounded cursor-pointer"
                    />
                    <span className="text-sm text-gray-600 group-hover:text-gray-800 transition">
                      الدفع باستخدام نقاط بوسطة
                    </span>
                  </label>

                  <div className="flex gap-3">
                    <button
                      onClick={handleForwardShipping}
                      disabled={shippingLoading || pendingShipCount === 0}
                      className="flex-1 flex items-center justify-center gap-2
                        bg-teal-600 hover:bg-teal-700 text-white py-2.5 rounded-xl
                        text-sm font-semibold transition disabled:opacity-50"
                    >
                      {shippingLoading ? (
                        <>
                          <span className="w-4 h-4 border-2 border-white/40 border-t-white
                            rounded-full animate-spin" />
                          جارٍ الإرسال...
                        </>
                      ) : (
                        `إرسال ${effectiveShipCount} طلب للشحن`
                      )}
                    </button>
                    <button
                      onClick={() => setShippingModal(false)}
                      disabled={shippingLoading}
                      className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-2.5 rounded-xl
                        text-sm font-semibold transition disabled:opacity-50"
                    >
                      إلغاء
                    </button>
                  </div>
                </>
              )}

              {/* ── Post-send results ── */}
              {shippingResult && (
                <>
                  <h2 className="text-lg font-bold text-gray-800 mb-4">نتائج الشحن</h2>

                  {/* Summary chips */}
                  <div className="flex gap-3 mb-5">
                    <div className="flex-1 bg-green-50 border border-green-200 rounded-xl p-3 text-center">
                      <div className="text-2xl font-bold text-green-700">{shippingResult.success.length}</div>
                      <div className="text-xs text-green-600 mt-0.5">تم الإرسال</div>
                    </div>
                    <div className="flex-1 bg-red-50 border border-red-200 rounded-xl p-3 text-center">
                      <div className="text-2xl font-bold text-red-700">{shippingResult.failed.length}</div>
                      <div className="text-xs text-red-600 mt-0.5">فشل الإرسال</div>
                    </div>
                  </div>

                  {/* Batch cap: more orders were pending than shipped this run. */}
                  {!!shippingResult.remaining && shippingResult.remaining > 0 && (
                    <div className="mb-5 flex items-center justify-between gap-3 p-3 rounded-xl
                      bg-amber-50 border border-amber-200 text-sm">
                      <span className="text-amber-800">
                        متبقٍ <span className="font-bold">{shippingResult.remaining}</span> طلب لم يُرسل بعد (تم تقسيم الدفعة للحفاظ على استقرار الشحن).
                      </span>
                      <button
                        onClick={handleForwardShipping}
                        disabled={shippingLoading}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold text-white
                          bg-amber-600 hover:bg-amber-700 disabled:opacity-60 transition">
                        {shippingLoading ? 'جارٍ الإرسال…' : 'إرسال الدفعة التالية'}
                      </button>
                    </div>
                  )}

                  <div className="space-y-3 max-h-[40vh] overflow-y-auto pl-1">
                    {/* Successes */}
                    {shippingResult.success.map((row) => (
                      <div key={row.orderId}
                        className="flex items-center justify-between gap-3 p-3 bg-green-50
                          border border-green-100 rounded-xl text-sm">
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-800 truncate">{row.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5" dir="ltr">{row.phone}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-xs text-green-600 font-medium">كود التتبع</p>
                          <p className="text-xs font-bold text-green-800 font-mono" dir="ltr">
                            {row.trackingCode}
                          </p>
                        </div>
                      </div>
                    ))}

                    {/* Failures */}
                    {shippingResult.failed.map((row) => (
                      <div key={row.orderId}
                        className="flex items-center justify-between gap-3 p-3 bg-red-50
                          border border-red-100 rounded-xl text-sm">
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-800 truncate">{row.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5" dir="ltr">{row.phone}</p>
                        </div>
                        <div className="shrink-0 text-right max-w-[150px]">
                          <p className="text-xs text-red-500 truncate" title={row.error}>{row.error}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => setShippingModal(false)}
                    className="w-full mt-5 bg-gray-100 hover:bg-gray-200 text-gray-700 py-2.5
                      rounded-xl text-sm font-semibold transition"
                  >
                    إغلاق
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Bosta Follow-ups Modal ───────────────────────────────── */}
        {followUpsModal && (
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setFollowUpsModal(false)}
          >
            <div
              className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh]
                flex flex-col border border-slate-200 dark:border-slate-700"
              dir="rtl"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-amber-600 dark:text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">متابعات شركة الشحن (Bosta)</h2>
                    <p className="text-xs text-slate-400 dark:text-slate-500">شحنات تحتاج إجراء · مرتجعات عائدة</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={openFollowUps}
                    disabled={followUpsLoading}
                    title="تحديث"
                    className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:text-slate-300 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                  >
                    <svg className={`w-5 h-5 ${followUpsLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setFollowUpsModal(false)}
                    className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:text-slate-300 dark:hover:bg-slate-800 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Header chip — action-needed only. Returned parcels now live on
                  the dedicated "إدارة تحصيل المرتجعات" page. */}
              {followUps && !followUpsLoading && !followUpsError && (
                <div className="flex items-center gap-2 px-6 pt-4 shrink-0">
                  <span className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-amber-500 text-white shadow-sm">
                    في انتظار متابعتك
                    <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold bg-white text-amber-600">
                      {followUps.counts.action_required}
                    </span>
                  </span>
                </div>
              )}

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-6">
                {followUpsLoading ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <div className="inline-block w-6 h-6 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin" />
                    <p className="text-sm text-slate-400">جارٍ الجلب من شركة الشحن…</p>
                  </div>
                ) : followUpsError ? (
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50
                    text-red-700 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
                    {followUpsError}
                  </div>
                ) : (() => {
                  const allRows: BostaFollowUpOrder[] = followUps?.action_required ?? [];

                  const q = followUpsSearch.trim().toLowerCase();
                  const rows = q
                    ? allRows.filter((r) => {
                        const name = bostaStr(r.customer).toLowerCase();
                        const phone = bostaStr(r.phone).toLowerCase();
                        return name.includes(q) || phone.includes(q);
                      })
                    : allRows;

                  return (
                    <div className="space-y-4">
                      {/* Search + Copy toolbar */}
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative flex-1 min-w-[200px]">
                          <svg className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                          </svg>
                          <input
                            type="text"
                            value={followUpsSearch}
                            onChange={(e) => setFollowUpsSearch(e.target.value)}
                            placeholder="بحث بالاسم أو رقم الهاتف…"
                            className="w-full pr-9 pl-3 py-2 rounded-xl text-sm bg-slate-50 dark:bg-slate-800
                              border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200
                              outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                          />
                        </div>
                        <button
                          onClick={() => handleCopyFollowUpNumbers(rows)}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium
                            bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition whitespace-nowrap"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          نسخ الأرقام ({rows.length})
                        </button>
                      </div>

                      {rows.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 gap-3">
                          <svg className="w-10 h-10 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                          </svg>
                          <p className="text-sm text-slate-400">
                            {q ? 'لا توجد نتائج مطابقة للبحث' : 'لا توجد شحنات في هذه القائمة 🎉'}
                          </p>
                        </div>
                      ) : (
                        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
                                {['رقم التتبع', 'العميل', 'الهاتف', 'المدينة', 'المنتج', 'ملاحظات', 'مصاريف شحن المرتجع', 'آخر تحديث'].map((h) => (
                                  <th key={h} className="text-right text-[11px] font-semibold text-slate-500 dark:text-slate-400 px-4 py-2.5 whitespace-nowrap">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                              {rows.map((r) => {
                                const key = bostaStr(r.trackingNumber);
                                const draft = getFollowUpDraft(r);
                                const saving = !!followUpSaving[key];
                                const linked = !!r.order_id;
                                return (
                                  <tr key={key} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-colors">
                                    <td className="px-4 py-2.5 font-mono text-xs text-indigo-600 dark:text-indigo-400 whitespace-nowrap" dir="ltr">{key || '—'}</td>
                                    <td className="px-4 py-2.5 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">{bostaStr(r.customer) || '—'}</td>
                                    <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap" dir="ltr">{bostaStr(r.phone) || '—'}</td>
                                    <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{bostaStr(r.city) || '—'}</td>
                                    {/* Product(s) — comma-separated when the parcel covers multiple items */}
                                    <td className="px-4 py-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 max-w-[14rem]">
                                      <span className="line-clamp-2" title={bostaStr(r.product)}>
                                        {bostaStr(r.product) || '—'}
                                      </span>
                                    </td>
                                    {/* Notes */}
                                    <td className="px-4 py-2.5">
                                      <input
                                        type="text"
                                        defaultValue={draft.return_note}
                                        disabled={!linked || saving}
                                        title={linked ? '' : 'لا يوجد طلب محلي مرتبط'}
                                        placeholder={linked ? 'أضف ملاحظة…' : 'غير مرتبط'}
                                        onChange={(e) => updateFollowUpDraft(key, 'return_note', e.target.value, r)}
                                        onBlur={() => saveFollowUpRow(r)}
                                        className="w-40 px-2 py-1 rounded-lg text-xs bg-slate-50 dark:bg-slate-800
                                          border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200
                                          outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition
                                          disabled:opacity-50 disabled:cursor-not-allowed"
                                      />
                                    </td>
                                    {/* Return shipping fee */}
                                    <td className="px-4 py-2.5">
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="number"
                                          min={0}
                                          step="0.01"
                                          defaultValue={draft.return_shipping_fee}
                                          disabled={!linked || saving}
                                          title={linked ? '' : 'لا يوجد طلب محلي مرتبط'}
                                          placeholder="0"
                                          dir="ltr"
                                          onChange={(e) => updateFollowUpDraft(key, 'return_shipping_fee', e.target.value, r)}
                                          onBlur={() => saveFollowUpRow(r)}
                                          className="w-24 px-2 py-1 rounded-lg text-xs tabular-nums bg-slate-50 dark:bg-slate-800
                                            border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200
                                            outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition
                                            disabled:opacity-50 disabled:cursor-not-allowed"
                                        />
                                        {saving && (
                                          <span className="inline-block w-3.5 h-3.5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
                                        )}
                                      </div>
                                    </td>
                                    <td className="px-4 py-2.5 text-xs text-slate-400 dark:text-slate-500 whitespace-nowrap">
                                      {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' }) : '—'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ── Product filter tabs ───────────────────────────────────── */}
        {uniqueProducts.length > 0 && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl
            border border-slate-200 dark:border-slate-800 px-4 py-3.5 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 dark:text-slate-500
              uppercase tracking-wider mb-2.5">
              فلتر المنتجات
            </p>
            <div className="flex flex-wrap gap-2 items-start">

              {/* "كل المنتجات" — pill, no price line */}
              <button
                onClick={() => setActiveProduct('كل المنتجات')}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition self-center
                  ${activeProduct === 'كل المنتجات'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
              >
                كل المنتجات
              </button>

              {/* Individual product cards — two-line layout with price */}
              {uniqueProducts.map((p) => {
                const count = agentFiltered.filter((o) => getShortName(o.ProductName) === p).length;
                // Prefer the official master catalog price (stable); fall back to the
                // order-derived price only when the product isn't linked to inventory.
                const price = getCatalogPrice(p) ?? productPriceMap[p];
                const stock = getStock(p);
                const empStock = getEmployeeStockStatus(p);
                const isActive = activeProduct === p;
                return (
                  <button
                    key={p}
                    onClick={() => handleSelectProduct(p)}
                    className={`px-3 py-2 rounded-xl text-sm font-medium transition text-right
                      ${isActive
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
                  >
                    {/* Row 1: name + order count + stock badge */}
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <span>{p}</span>
                      <span className={`text-xs
                        ${isActive ? 'text-indigo-200' : 'text-slate-400 dark:text-slate-500'}`}>
                        ({count})
                      </span>
                      {/* Admins see the exact count. Employees see a persistent
                          3-tier status label — never the raw number, except the
                          exact remaining count inside the LOW_STOCK (1–5) band. */}
                      {isAdmin && stock !== null && (
                        <span className={`text-xs font-bold
                          ${stock === 0
                            ? 'text-red-500'
                            : stock <= 5
                              ? 'text-amber-500'
                              : isActive ? 'text-emerald-300' : 'text-emerald-600'}`}>
                          [{stock}]
                        </span>
                      )}
                      {!isAdmin && empStock?.tier === 'IN_STOCK' && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md
                          text-[10px] font-bold bg-emerald-100 text-emerald-700
                          dark:bg-emerald-900/40 dark:text-emerald-300">
                          <span className="w-1 h-1 rounded-full bg-emerald-500" />
                          متوفر في المخزن
                        </span>
                      )}
                      {!isAdmin && empStock?.tier === 'LOW_STOCK' && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md
                          text-[10px] font-bold bg-amber-100 text-amber-700
                          dark:bg-amber-900/40 dark:text-amber-300">
                          <span className="w-1 h-1 rounded-full bg-amber-500" />
                          متبقي {empStock.count} قطع فقط
                        </span>
                      )}
                      {!isAdmin && empStock?.tier === 'OUT_OF_STOCK' && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md
                          text-[10px] font-bold bg-red-100 text-red-700
                          dark:bg-red-900/40 dark:text-red-300">
                          <span className="w-1 h-1 rounded-full bg-red-500" />
                          نفذت الكمية
                        </span>
                      )}
                    </div>
                    {/* Row 2: price — only shown if known */}
                    {price && (
                      <div className={`text-xs mt-0.5 font-normal
                        ${isActive ? 'text-indigo-200' : 'text-slate-400 dark:text-slate-500'}`}>
                        {price} ج.م
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Stats cards ───────────────────────────────────────────── */}
        {/* Skeleton until the FIRST /stats response — the cards never block on
            (or wait for) the table fetch; both load independently in the
            background while the page shell paints immediately. */}
        {serverStats === null ? (
          <div className="grid grid-cols-3 md:grid-cols-7 gap-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm animate-pulse">
                <div className="h-3 w-14 rounded bg-slate-200 dark:bg-slate-700 mb-3" />
                <div className="h-6 w-10 rounded bg-slate-200 dark:bg-slate-700" />
              </div>
            ))}
          </div>
        ) : (
        <div className="grid grid-cols-3 md:grid-cols-7 gap-3">
          <StatCard label="الإجمالي"   value={stats.total}
            valueColor="text-slate-800 dark:text-white"
            active={activeFilter === 'الكل'}
            onClick={() => setActiveFilter('الكل')} />
          <StatCard label="جديد"       value={stats.new}
            valueColor="text-blue-600 dark:text-blue-400"
            active={activeFilter === 'جديد'}
            onClick={() => setActiveFilter('جديد')} />
          <StatCard label="تم التأكيد" value={stats.confirmedCumulative}
            valueColor="text-emerald-600 dark:text-emerald-400"
            pct={pct(stats.confirmedCumulative)} pctLabel="نسبة التأكيد" pctPrimary
            sub={`بانتظار الشحن: ${stats.confirmed}`}
            active={activeFilter === 'تم التأكيد'}
            onClick={() => setActiveFilter('تم التأكيد')} />
          <StatCard label="تم الرفض"   value={stats.rejected}
            valueColor="text-red-500 dark:text-red-400"
            pct={pct(stats.rejected)} pctLabel="نسبة الرفض" pctPrimary
            active={activeFilter === 'تم الرفض'}
            onClick={() => setActiveFilter('تم الرفض')} />
          <StatCard label="مؤجل"       value={stats.postponed}
            valueColor="text-amber-600 dark:text-amber-400"
            active={activeFilter === 'مؤجل'}
            onClick={() => setActiveFilter('مؤجل')} />
          <StatCard label="لا يرد"     value={stats.noAnswer}
            valueColor="text-slate-500 dark:text-slate-400"
            pct={pct(stats.noAnswer)} pctLabel="نسبة عدم الرد" pctPrimary
            active={activeFilter === 'لا يرد'}
            onClick={() => setActiveFilter('لا يرد')} />
          <StatCard label="تم الشحن"  value={stats.shippedCumulative}
            valueColor="text-teal-600 dark:text-teal-400"
            pct={stats.confirmedCumulative
              ? Math.round((stats.shippedCumulative / stats.confirmedCumulative) * 100)
              : 0}
            pctLabel="نسبة الشحن" pctPrimary
            sub={`قيد الشحن الآن: ${stats.shipped}`}
            active={activeFilter === 'تم الشحن'}
            onClick={() => setActiveFilter('تم الشحن')} />
        </div>
        )}

        {/* ── Date range filter ─────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3
          bg-white dark:bg-slate-900 rounded-2xl
          border border-slate-200 dark:border-slate-800 px-4 py-3.5 shadow-sm">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap">
            فلتر الأيام:
          </span>
          <div className="flex flex-wrap items-center gap-3 flex-1">
            <label className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span>من</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} dir="ltr"
                className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2
                  text-sm outline-none bg-white dark:bg-slate-800
                  text-slate-700 dark:text-slate-300
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition" />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span>إلى</span>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} dir="ltr"
                className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2
                  text-sm outline-none bg-white dark:bg-slate-800
                  text-slate-700 dark:text-slate-300
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition" />
            </label>
            <button
              onClick={() => { const t = todayStr(); setStartDate(t); setEndDate(t); }}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition shadow-sm whitespace-nowrap"
            >
              اليوم
            </button>
            {(startDate || endDate) && (
              <button onClick={() => { setStartDate(''); setEndDate(''); }}
                className="text-xs text-red-500 hover:text-red-700 underline transition">
                مسح الفلتر
              </button>
            )}
          </div>
          {(startDate || endDate) && (
            <span className="text-xs text-indigo-600 font-medium whitespace-nowrap">{displayOrders.length} نتيجة</span>
          )}
        </div>

        {/* ── Status filter tabs ────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          {['الكل', ...STATUS_OPTIONS].map((f) => (
            <button key={f} onClick={() => setActiveFilter(f)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-150
                ${activeFilter === f
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700'}`}
            >
              {f}
              {f !== 'الكل' && (
                <span className={`mr-1.5 text-xs ${activeFilter === f ? 'text-indigo-200' : 'text-gray-400'}`}>
                  ({/* Exact per-status counts from /stats (agent/product/date-scoped,
                      never status-scoped — so every tab keeps its number while
                      one is selected). STRICTLY server-hydrated: '…' until the
                      first response, never a count of the loaded rows. */
                    serverStats === null ? '…' : (serverStats.byStatus[normStatus(f)] ?? 0)})
                </span>
              )}
            </button>
          ))}

          {/* ── Re-confirmation urgent tab ───────────────────────────── */}
          <button
            onClick={() => setActiveFilter(RECONFIRM_FILTER)}
            className={`relative flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold transition-all duration-150
              ${activeFilter === RECONFIRM_FILTER
                ? 'bg-amber-500 text-white shadow-sm'
                : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700/50 dark:hover:bg-amber-900/50'}`}
          >
            {/* Bell icon */}
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            مؤجلات تستحق التأكيد
            {/* Badge counter */}
            <span
              className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full
                text-xs font-bold leading-none
                ${reconfirmCount === 0
                  ? 'bg-amber-200 text-amber-600'
                  : activeFilter === RECONFIRM_FILTER
                    ? 'bg-white text-amber-600'
                    : 'bg-amber-500 text-white animate-pulse'}`}
            >
              {reconfirmCount}
            </span>
          </button>

          {/* ── Returns-audit tab — appears only when the staff-analytics
                drill-down (or a manual deep link) activated it ───────────── */}
          {activeFilter === RETURNS_AUDIT_FILTER && (
            <button
              onClick={() => setActiveFilter('الكل')}
              title="اضغط لإلغاء فلتر التدقيق"
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold
                bg-red-600 text-white shadow-sm hover:bg-red-700 transition-all duration-150"
            >
              🔍 {RETURNS_AUDIT_FILTER}
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold leading-none bg-white text-red-600">
                {/* Sum of both courier return statuses — server-hydrated. */}
                {serverStats === null ? '…'
                  : RETURNS_AUDIT_STATUSES.reduce((n, s) => n + (serverStats.byStatus[s] ?? 0), 0)}
              </span>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>

        {/* ── Search bar ───────────────────────────────────────────── */}
        {!loading && (
          <div className="relative">
            {/* Magnifying-glass — visual start (right in RTL) */}
            <div className="absolute inset-y-0 right-0 flex items-center pr-3.5 pointer-events-none">
              <svg className="w-4 h-4 text-slate-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
              </svg>
            </div>

            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="بحث باسم العميل أو رقم الهاتف..."
              dir="rtl"
              className="w-full pr-10 pl-10 py-2.5
                bg-white dark:bg-slate-900
                border border-slate-300 dark:border-slate-700 rounded-xl
                text-slate-800 dark:text-slate-200
                text-sm outline-none
                focus:ring-2 focus:ring-indigo-400 focus:border-transparent
                placeholder-slate-400 dark:placeholder-slate-600
                shadow-sm transition"
            />

            {/* Clear button — visual end (left in RTL), only shown while typing */}
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                aria-label="مسح البحث"
                className="absolute inset-y-0 left-0 flex items-center pl-3.5
                  text-slate-400 dark:text-slate-500
                  hover:text-slate-700 dark:hover:text-slate-300 transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                    d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* ── Error ────────────────────────────────────────────────── */}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50
            text-red-700 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* ── Toolbar ──────────────────────────────────────────────── */}
        {!loading && (
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={handleCopyPhones}
              className="flex items-center gap-2 px-4 py-2
                bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700
                hover:bg-slate-50 dark:hover:bg-slate-800
                text-slate-700 dark:text-slate-300
                rounded-xl text-sm font-medium transition shadow-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              نسخ الأرقام
            </button>

            {isAdmin && (
              <button onClick={handleExportCsv}
                className="flex items-center gap-2 px-4 py-2
                  bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700
                  hover:bg-slate-50 dark:hover:bg-slate-800
                  text-slate-700 dark:text-slate-300
                  rounded-xl text-sm font-medium transition shadow-sm">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                تصدير الطلبات (CSV)
              </button>
            )}

            {isAdmin && (
              <button onClick={() => { fetchInventory(); setInvModal(true); }}
                className="flex items-center gap-2 px-4 py-2
                  bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700
                  hover:bg-slate-50 dark:hover:bg-slate-800
                  text-slate-700 dark:text-slate-300
                  rounded-xl text-sm font-medium transition shadow-sm">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                إدارة المخزون
              </button>
            )}

            {/* ── Bosta shipping button — primary CTA, admin only ──── */}
            {isAdmin && (
              <button
                onClick={() => { setShippingResult(null); setAllowOpenAll(false); setShipLimit(String(pendingShipCount)); setShippingModal(true); }}
                className="relative flex items-center gap-2 px-4 py-2
                  bg-indigo-600 hover:bg-indigo-700 text-white
                  rounded-xl text-sm font-medium transition shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
                </svg>
                إرسال للشحن (Bosta)
                {pendingShipCount > 0 && (
                  <span className="absolute -top-1.5 -left-1.5 inline-flex items-center justify-center
                    w-5 h-5 text-xs font-bold bg-white text-indigo-700 rounded-full shadow-sm">
                    {pendingShipCount}
                  </span>
                )}
              </button>
            )}

            {/* ── Bosta follow-ups button — admin OR shipping-followups permission ── */}
            {(isAdmin || user?.permissions?.includes('shipping_followups')) && (
              <button
                onClick={openFollowUps}
                title="متابعة الشحنات التي تحتاج إجراء أو المرتجعات العائدة من شركة الشحن"
                className="flex items-center gap-2 px-4 py-2
                  bg-amber-500 hover:bg-amber-600 active:bg-amber-700
                  text-white rounded-xl text-sm font-medium
                  shadow-sm shadow-amber-500/25 transition-all duration-150"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                متابعات شركة الشحن
              </button>
            )}

            {/* ── Bulk AWB print button — admin only, visible when rows selected ── */}
            {isAdmin && selectedIds.length > 0 && (
              <button
                onClick={handleBulkAwb}
                disabled={awbLoading}
                title="طباعة بوالص الشحن لجميع الطلبات المحددة"
                className="relative flex items-center gap-2 px-4 py-2
                  bg-orange-500 hover:bg-orange-600 active:bg-orange-700
                  text-white rounded-xl text-sm font-medium
                  shadow-sm shadow-orange-500/25
                  transition-all duration-150
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {awbLoading ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    جارٍ التحميل…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    طباعة البوالص ({selectedIds.length})
                  </>
                )}
              </button>
            )}

            {/* ── Distribute button — admin only (opens distribution modal) ── */}
            {isAdmin && (
              <button
                onClick={openDistModal}
                disabled={distributing}
                title="توزيع الطلبات الجديدة على الموظفين (بالتساوي أو بنسب مخصصة)"
                className="relative flex items-center gap-2 px-4 py-2
                  bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800
                  dark:bg-emerald-700 dark:hover:bg-emerald-600
                  text-white rounded-xl text-sm font-medium
                  shadow-sm shadow-emerald-500/20
                  transition-all duration-150
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h7" />
                </svg>
                توزيع الطلبات
              </button>
            )}

            {/* ── Transfer selected button — appears when rows are checked ── */}
            {isAdmin && selectedIds.length > 0 && (
              <button
                onClick={() => { setXferTargetId(''); setShowXferModal(true); }}
                className="inline-flex items-center gap-2 px-4 py-2
                  bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800
                  text-white rounded-xl text-sm font-semibold
                  shadow-md shadow-emerald-500/20
                  transition-all duration-150 active:scale-95"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                نقل {selectedIds.length} طلب محدد
              </button>
            )}

            {/* ── Bulk delete selected button — danger themed ── */}
            {isAdmin && selectedIds.length > 0 && (
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="inline-flex items-center gap-2 px-4 py-2
                  bg-red-600 hover:bg-red-700 active:bg-red-800
                  text-white rounded-xl text-sm font-semibold
                  shadow-md shadow-red-500/20
                  transition-all duration-150 active:scale-95
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkDeleting ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                )}
                حذف {selectedIds.length} طلب
              </button>
            )}

            <span className="text-xs text-slate-400 dark:text-slate-500 mr-auto">{displayOrders.length} طلب معروض</span>
          </div>
        )}

        {/* ── Table ────────────────────────────────────────────────── */}
        {/* Skeleton rows (not a spinner): the layout paints at its final shape
            immediately, rows fill in when the (independent) fetch resolves. */}
        {loading ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl
            border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="px-4 py-3.5 bg-gray-50 dark:bg-slate-800/50 border-b border-gray-200 dark:border-slate-700 flex gap-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-3 w-20 rounded bg-slate-200 dark:bg-slate-700 animate-pulse" />
              ))}
            </div>
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="px-4 py-4 flex items-center gap-6 animate-pulse">
                  <div className="h-3 w-6  rounded bg-slate-200 dark:bg-slate-700" />
                  <div className="h-3 w-28 rounded bg-slate-200 dark:bg-slate-700" />
                  <div className="h-3 w-24 rounded bg-slate-200 dark:bg-slate-700" />
                  <div className="h-6 w-20 rounded-lg bg-slate-200 dark:bg-slate-700" />
                  <div className="h-3 w-32 rounded bg-slate-200 dark:bg-slate-700 hidden md:block" />
                  <div className="h-6 w-24 rounded-lg bg-slate-200 dark:bg-slate-700 hidden md:block" />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <OrdersTable
            orders={displayOrders}
            role={user?.role === 'admin' ? 'admin' : 'agent'}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            selectedIds={selectedIds}
            onToggleSelect={isAdmin ? toggleSelection : undefined}
            onSelectAll={isAdmin ? toggleSelectAll : undefined}
            agents={uniqueAgents}
            showProduct={activeProduct === 'كل المنتجات'}
            onToast={(m, t) => showToast(m, t ?? 'success')}
            onEndReached={loadMoreOrders}
            hasMore={hasMore}
            loadingMore={loadingMore}
            emptyMessage={
              searchTerm.trim()
                ? `لا توجد نتائج مطابقة لـ "${searchTerm.trim()}"`
                : 'لا توجد طلبات لعرضها'
            }
          />
        )}
      </div>
    </div>
  );
}

/* ── StatCard ─────────────────────────────────────────────────── */
function StatCard({
  label, value, valueColor, pct, pctLabel, pctPrimary, sub, onClick, active,
}: {
  label:       string;
  value:       number;
  valueColor?: string;        // semantic text color for the number only
  pct?:        number;
  pctLabel?:   string;
  pctPrimary?: boolean;       // when true: % is the big number, count is secondary
  sub?:        string;        // snapshot queue size — reconciles the cumulative
                              // headline with what clicking the card shows
  onClick?:    () => void;
  active?:     boolean;
}) {
  /* When a percentage is the headline metric (e.g. Confirmation Rate), show it
     big and demote the absolute count to secondary text — so a card whose count
     naturally drains to 0 during the day still reflects real performance. */
  const primaryIsPct = pctPrimary && pct !== undefined;

  return (
    <div
      onClick={onClick}
      className={`
        bg-white dark:bg-slate-900
        border rounded-xl p-5 shadow-sm select-none
        transition-all duration-150
        ${onClick
          ? 'cursor-pointer hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-800'
          : ''}
        ${active
          ? 'border-indigo-400 dark:border-indigo-600 ring-2 ring-indigo-500/20 shadow-md'
          : 'border-slate-200 dark:border-slate-800'}
      `}
    >
      {primaryIsPct ? (
        <>
          {/* Primary: the percentage */}
          <div className={`text-3xl font-bold tracking-tight leading-none
            ${valueColor ?? 'text-slate-800 dark:text-white'}`}>
            {pct}%
          </div>
          {/* Secondary: the absolute count */}
          <div className="flex items-baseline gap-1.5 mt-1.5">
            <span className="text-sm font-semibold text-slate-600 dark:text-slate-400">{value}</span>
            <span className="text-xs text-slate-400 dark:text-slate-500 leading-tight">طلب</span>
          </div>
        </>
      ) : (
        <>
          {/* Primary: the absolute count */}
          <div className={`text-3xl font-bold tracking-tight leading-none
            ${valueColor ?? 'text-slate-800 dark:text-white'}`}>
            {value}
          </div>
          {/* Secondary: the percentage (if any) */}
          {pct !== undefined && (
            <div className="flex items-baseline gap-1.5 mt-1.5">
              <span className="text-sm font-semibold text-slate-600 dark:text-slate-400">{pct}%</span>
              {pctLabel && (
                <span className="text-xs text-slate-400 dark:text-slate-500 leading-tight">{pctLabel}</span>
              )}
            </div>
          )}
        </>
      )}

      {/* Label */}
      <div className="text-sm font-medium text-slate-500 dark:text-slate-400 mt-2 leading-snug">{label}</div>

      {/* Snapshot sub-label — the operational queue size behind the funnel number */}
      {sub && (
        <div className="text-xs font-semibold text-indigo-500 dark:text-indigo-400 mt-1 leading-snug">{sub}</div>
      )}
    </div>
  );
}
