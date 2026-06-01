'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getOrders, updateOrder, deleteOrder, createOrder,
  getInventory, upsertInventory, getProducts, forwardToShipping,
  getStaff, distributeOrders, transferOrders, bulkDeleteOrders, getBulkAwb,
  DistributionAllocation,
  getBostaFollowUps, saveFollowUpAction,
  Order, User, InventoryItem, Product, ShippingResult, StaffMember,
  BostaFollowUps, BostaFollowUpOrder,
} from '@/lib/api';
import OrdersTable from '@/components/OrdersTable';

const STATUS_OPTIONS = ['جديد', 'تم التأكيد', 'تم الرفض', 'مؤجل', 'لا يرد', 'معلق حتي الدفع', 'تم الشحن'];

/* The 27 Egyptian governorates — used by the manual-order governorate dropdown. */
const EGYPT_GOVERNORATES = [
  'القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الشرقية', 'الدقهلية', 'البحيرة',
  'الغربية', 'المنوفية', 'كفر الشيخ', 'دمياط', 'بورسعيد', 'الإسماعيلية', 'السويس',
  'الفيوم', 'بني سويف', 'المنيا', 'أسيوط', 'سوهاج', 'قنا', 'الأقصر', 'أسوان',
  'البحر الأحمر', 'الوادي الجديد', 'مطروح', 'شمال سيناء', 'جنوب سيناء',
];

const getShortName = (name?: string) => {
  if (!name) return '';
  return name.trim().split(/\s+/).slice(0, 3).join(' ');
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

  const [user,          setUser]          = useState<User | null>(null);
  const [orders,        setOrders]        = useState<Order[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
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

  const [shippingModal,   setShippingModal]   = useState(false);
  const [shippingLoading, setShippingLoading] = useState(false);
  const [shippingResult,  setShippingResult]  = useState<ShippingResult | null>(null);
  const [allowOpenAll,    setAllowOpenAll]    = useState(false);
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
  const [followUpsTab,     setFollowUpsTab]     = useState<'action_required' | 'returning'>('action_required');
  const [followUpsSearch,  setFollowUpsSearch]  = useState('');
  /* Per-row editable draft for notes / return-shipping fee, keyed by trackingNumber */
  const [followUpEdits,    setFollowUpEdits]    = useState<Record<string, { return_note: string; return_shipping_fee: string }>>({});
  const [followUpSaving,   setFollowUpSaving]   = useState<Record<string, boolean>>({});

  /* ── Staff / routing state ───────────────────────────────────── */
  const [staff,         setStaff]         = useState<StaffMember[]>([]);
  const [distributing,  setDistributing]  = useState(false);
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

  /* ── Auth guard ──────────────────────────────────────────────── */
  useEffect(() => {
    const token    = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (!token || !userData) { router.push('/'); return; }
    setUser(JSON.parse(userData));
  }, [router]);

  /* ── Fetch orders (initial load + manual refresh button) ────── */
  // Shows the loading spinner — intentional only for explicit user actions.
  // Do NOT call this from the background polling interval; use silentRefresh.
  const fetchOrders = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const res = await getOrders();
      setOrders(res.data);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/');
      } else {
        setError('فشل في تحميل الطلبات. تحقق من الاتصال بالخادم.');
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  /* ── Silent background refresh (no spinner, no scroll reset) ── */
  // Surgically patches order state in-place so OrdersTable stays mounted,
  // scroll position is preserved, and no active filter/modal is disturbed.
  const silentRefresh = useCallback(async () => {
    try {
      const res = await getOrders();
      setOrders(res.data);             // functional-update not needed; full replace is fine
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/');
      }
      // All other errors are swallowed — never flash UI errors during a background poll
    }
  }, [router]);

  // Initial load — shows spinner once on mount
  useEffect(() => { fetchOrders(); }, [fetchOrders]);

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
    try {
      const res = await updateOrder(id, data);
      setOrders((prev) => prev.map((o) => (o.id === id ? res.data : o)));
      showToast('تم الحفظ بنجاح', 'success');
      // Refresh both stock sources so filter-pill badges update immediately
      fetchInventory();
      fetchProducts();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل في الحفظ';
      showToast(msg, 'error');
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
      // Default to whichever bucket has items
      setFollowUpsTab(
        res.data.counts.action_required === 0 && res.data.counts.returning > 0
          ? 'returning'
          : 'action_required'
      );
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
          returning: patch(prev.returning),
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

  /* Open the distribution modal — seed an equal split as a sensible default. */
  const openDistModal = () => {
    setDistMode('equal');
    const n = activeAgentsForDist.length;
    const seed: Record<number, string> = {};
    if (n > 0) {
      const base = Math.floor(100 / n);
      let rem = 100 - base * n;
      activeAgentsForDist.forEach((a) => {
        seed[a.id] = String(base + (rem-- > 0 ? 1 : 0));
      });
    }
    setDistPercents(seed);
    setShowDistModal(true);
  };

  /* ── Manual order creation ───────────────────────────────────── */
  const openAddModal = () => {
    setAddForm({ ...EMPTY_ADD_FORM });
    setShowAddModal(true);
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
  const uniqueAgents = Array.from(
    new Set(roleScoped.map((o) => o.AssignedTo).filter(Boolean))
  ) as string[];

  const uniqueProducts = Array.from(
    new Set(roleScoped.map((o) => getShortName(o.ProductName)).filter(Boolean))
  ) as string[];

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

  // Badge count — scoped to current agent + product selection
  const reconfirmCount = productFiltered.filter(needsReconfirmation).length;

  // 3b. Status + date — final display set
  const RECONFIRM_FILTER = 'مؤجلات تستحق التأكيد';

  const filtered = (() => {
    if (activeFilter === RECONFIRM_FILTER) {
      // Special path: ignore date range; sort closest postponed date first
      return [...productFiltered.filter(needsReconfirmation)].sort(
        (a, b) => new Date(a.PostponedDate!).getTime() - new Date(b.PostponedDate!).getTime()
      );
    }
    // Build on the date-scoped set so the table matches the date-aware counts.
    return dateScoped.filter(
      (o) => activeFilter === 'الكل' || normStatus(o.Status) === normStatus(activeFilter)
    );
  })();

  // 4. Search — final layer; composable on top of every other filter
  //    Matches FullName OR Phone, case-insensitive, trims whitespace.
  const searchNeedle = searchTerm.trim().toLowerCase();
  const displayOrders: Order[] = searchNeedle
    ? filtered.filter(
        (o) =>
          o.FullName.toLowerCase().includes(searchNeedle) ||
          o.Phone.toLowerCase().includes(searchNeedle)
      )
    : filtered;

  /* ── Stats (product scope so tabs affect cards) ──────────────── */
  const stats = {
    total:     dateScoped.length,
    new:       dateScoped.filter((o) => normStatus(o.Status) === 'جديد').length,
    confirmed: dateScoped.filter((o) => normStatus(o.Status) === 'تم التأكيد').length,
    rejected:  dateScoped.filter((o) => normStatus(o.Status) === 'تم الرفض').length,
    postponed: dateScoped.filter((o) => normStatus(o.Status) === 'مؤجل').length,
    noAnswer:  dateScoped.filter((o) => normStatus(o.Status) === 'لا يرد').length,
    shipped:   dateScoped.filter((o) => normStatus(o.Status) === 'تم الشحن').length,
  };
  const pct = (n: number) =>
    stats.total ? Math.round((n / stats.total) * 100) : 0;

  // Count of confirmed orders not yet forwarded to Bosta (derived from live data)
  const pendingShipCount = roleScoped.filter(
    (o) => o.Status === 'تم التأكيد' && !o.BostaTrackingCode
  ).length;

  // Effective batch size to ship: the requested quota clamped to [1, pending].
  // A blank/invalid input falls back to shipping the entire pending queue.
  const effectiveShipCount = (() => {
    const parsed = parseInt(shipLimit, 10);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, pendingShipCount)
      : pendingShipCount;
  })();

  /* ── Copy phones (جديد orders only) ─────────────────────────── */
  const handleCopyPhones = async () => {
    const phones = displayOrders
      .filter((o) => o.Status === 'جديد')
      .map((o) => o.Phone)
      .filter(Boolean)
      .join('\n');

    if (!phones) {
      showToast('لا توجد أرقام جديدة لنسخها', 'error');
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
      // Ship the requested batch quota (clamped to the pending queue).
      const res = await forwardToShipping(allowOpenAll, effectiveShipCount);
      setShippingResult(res.data);
      // Refresh orders silently so statuses update without scroll disruption
      const fresh = await import('@/lib/api').then((m) => m.getOrders());
      setOrders(fresh.data);
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
  const getStock = (shortName: string): number | null => {
    if (!products.length) return null; // still loading — show no badge
    const norm  = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    const needle = norm(shortName);
    const found = products.find((p) => {
      const full  = norm(p.name);
      const short = norm(getShortName(p.name));
      return (
        full  === needle ||
        short === needle ||
        full.startsWith(needle) ||
        needle.startsWith(short)
      );
    });
    return found !== undefined ? found.stock_quantity : null;
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
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">سيستم تأكيد الطلبات</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {isAdmin
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
                    ({agent === 'كل الفريق'
                      ? roleScoped.length
                      : roleScoped.filter((o) => o.AssignedTo === agent).length})
                  </span>
                </button>
              ))}

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
                  <label className="flex items-center gap-2.5 mb-5 cursor-pointer select-none group">
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

              {/* Tabs */}
              {followUps && !followUpsLoading && !followUpsError && (
                <div className="flex items-center gap-2 px-6 pt-4 shrink-0">
                  <button
                    onClick={() => setFollowUpsTab('action_required')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all
                      ${followUpsTab === 'action_required'
                        ? 'bg-amber-500 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'}`}
                  >
                    في انتظار متابعتك
                    <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold
                      ${followUpsTab === 'action_required' ? 'bg-white text-amber-600' : 'bg-amber-500 text-white'}`}>
                      {followUps.counts.action_required}
                    </span>
                  </button>
                  <button
                    onClick={() => setFollowUpsTab('returning')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all
                      ${followUpsTab === 'returning'
                        ? 'bg-rose-500 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'}`}
                  >
                    مرتجعاتك العائدة
                    <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold
                      ${followUpsTab === 'returning' ? 'bg-white text-rose-600' : 'bg-rose-500 text-white'}`}>
                      {followUps.counts.returning}
                    </span>
                  </button>
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
                  const allRows: BostaFollowUpOrder[] =
                    followUpsTab === 'returning'
                      ? followUps?.returning ?? []
                      : followUps?.action_required ?? [];

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
                                {['رقم التتبع', 'العميل', 'الهاتف', 'المدينة', 'ملاحظات', 'مصاريف شحن المرتجع', 'آخر تحديث'].map((h) => (
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
                const price = productPriceMap[p];
                const stock = getStock(p);
                const isActive = activeProduct === p;
                return (
                  <button
                    key={p}
                    onClick={() => setActiveProduct(p)}
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
        <div className="grid grid-cols-3 md:grid-cols-7 gap-3">
          <StatCard label="الإجمالي"   value={stats.total}
            valueColor="text-slate-800 dark:text-white"
            active={activeFilter === 'الكل'}
            onClick={() => setActiveFilter('الكل')} />
          <StatCard label="جديد"       value={stats.new}
            valueColor="text-blue-600 dark:text-blue-400"
            active={activeFilter === 'جديد'}
            onClick={() => setActiveFilter('جديد')} />
          <StatCard label="تم التأكيد" value={stats.confirmed}
            valueColor="text-emerald-600 dark:text-emerald-400"
            pct={pct(stats.confirmed)} pctLabel="نسبة التأكيد"
            active={activeFilter === 'تم التأكيد'}
            onClick={() => setActiveFilter('تم التأكيد')} />
          <StatCard label="تم الرفض"   value={stats.rejected}
            valueColor="text-red-500 dark:text-red-400"
            pct={pct(stats.rejected)} pctLabel="نسبة الرفض"
            active={activeFilter === 'تم الرفض'}
            onClick={() => setActiveFilter('تم الرفض')} />
          <StatCard label="مؤجل"       value={stats.postponed}
            valueColor="text-amber-600 dark:text-amber-400"
            active={activeFilter === 'مؤجل'}
            onClick={() => setActiveFilter('مؤجل')} />
          <StatCard label="لا يرد"     value={stats.noAnswer}
            valueColor="text-slate-500 dark:text-slate-400"
            pct={pct(stats.noAnswer)} pctLabel="نسبة عدم الرد"
            active={activeFilter === 'لا يرد'}
            onClick={() => setActiveFilter('لا يرد')} />
          <StatCard label="تم الشحن"  value={stats.shipped}
            valueColor="text-teal-600 dark:text-teal-400"
            active={activeFilter === 'تم الشحن'}
            onClick={() => setActiveFilter('تم الشحن')} />
        </div>

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
                  ({dateScoped.filter((o) => normStatus(o.Status) === normStatus(f)).length})
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

            {/* ── Bosta follow-ups button — admin only ────────────── */}
            {isAdmin && (
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
        {loading ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl
            border border-slate-200 dark:border-slate-800 text-center py-24 shadow-sm">
            <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600
              rounded-full animate-spin mb-3" />
            <p className="text-slate-400 dark:text-slate-500 text-sm">جارٍ تحميل الطلبات...</p>
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
  label, value, valueColor, pct, pctLabel, onClick, active,
}: {
  label:       string;
  value:       number;
  valueColor?: string;        // semantic text color for the number only
  pct?:        number;
  pctLabel?:   string;
  onClick?:    () => void;
  active?:     boolean;
}) {
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
      {/* Main number */}
      <div className={`text-3xl font-bold tracking-tight leading-none
        ${valueColor ?? 'text-slate-800 dark:text-white'}`}>
        {value}
      </div>

      {/* Percentage row */}
      {pct !== undefined && (
        <div className="flex items-baseline gap-1.5 mt-1.5">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-400">{pct}%</span>
          {pctLabel && (
            <span className="text-xs text-slate-400 dark:text-slate-500 leading-tight">{pctLabel}</span>
          )}
        </div>
      )}

      {/* Label */}
      <div className="text-sm font-medium text-slate-500 dark:text-slate-400 mt-2 leading-snug">{label}</div>
    </div>
  );
}
