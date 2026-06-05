'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  ANALYTICS INTEGRATION GUIDE — COGS & GROSS MARGIN
 * ════════════════════════════════════════════════════════════════════
 *
 *  The `cost_price` column in the `products` table is the single source
 *  of truth for Cost of Goods Sold (COGS) calculations.
 *
 *  TO REPLACE THE MOCK DATA IN analytics/page.tsx:
 *
 *  1. Call `getProducts()` alongside `getOrders()` in the analytics page.
 *
 *  2. Build a lookup map keyed by product name (first 3 words, same as
 *     getShortName() used throughout the codebase):
 *       const costMap: Record<string, number> = {};
 *       products.forEach(p => { costMap[p.name] = parseFloat(String(p.cost_price)); });
 *
 *  3. For every delivered order in a period, compute that order's COGS:
 *       const unitCost = costMap[getShortName(order.ProductName)] ?? 0;
 *       const orderCOGS = unitCost * (order.Quantity ?? 1);
 *
 *  4. Aggregate by day to build DAILY_DATA dynamically:
 *       grossMargin (per day) = Σ(selling_price × qty delivered) − Σ(orderCOGS)
 *       netProfit   (per day) = grossMargin − adsSpend
 *
 *  5. The CPP / MAX CPP / True CPA KPI cards already use these values —
 *     no structural changes needed in analytics, just swap mock arrays
 *     for the derived objects above.
 *
 *  This makes every Analytics metric automatically reflect real inventory
 *  costs whenever a product's cost_price is updated here.
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  getProducts, createProduct, updateProduct, deleteProduct, postPurchase,
  Product, ProductPayload, PurchaseResult,
} from '@/lib/api';

/* ── Number helpers ─────────────────────────────────────────────────────── */
const parseN = (v: string | number | null | undefined): number =>
  parseFloat(String(v ?? 0)) || 0;

const fmtPrice = (v: string | number | null | undefined): string => {
  const n = parseN(v);
  return n % 1 === 0
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/* ── Local types ─────────────────────────────────────────────────────────── */
interface Toast { message: string; type: 'success' | 'error' }

type FormState = {
  name: string; sku: string;
  cost_price: string; selling_price: string;
  stock_quantity: string; image_url: string;
  aliases: string;   // comma-separated in the UI; parsed to string[] on save
};
const EMPTY_FORM: FormState = {
  name: '', sku: '', cost_price: '', selling_price: '', stock_quantity: '', image_url: '', aliases: '',
};

type PurchaseFormState = {
  productId:    string;
  quantity:     string;
  unitCost:     string;
  purchaseDate: string;
};
const todayISO = () => new Date().toISOString().split('T')[0];
const EMPTY_PURCHASE_FORM: PurchaseFormState = {
  productId: '', quantity: '', unitCost: '', purchaseDate: todayISO(),
};

/* ── Sub-components ──────────────────────────────────────────────────────── */

function StockBadge({ qty }: { qty: number }) {
  if (qty === 0) return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold
      bg-red-100 text-red-700 border border-red-200
      dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400" />
      نفد
    </span>
  );
  if (qty <= 10) return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold
      bg-amber-100 text-amber-700 border border-amber-200
      dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800/50">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
      قارب على الانتهاء
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold
      bg-emerald-100 text-emerald-700 border border-emerald-200
      dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/50">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
      متوفر
    </span>
  );
}

const AVATAR_COLORS = [
  'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/50 dark:text-indigo-300',
  'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-300',
  'bg-rose-100 text-rose-600 dark:bg-rose-900/50 dark:text-rose-300',
  'bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-300',
  'bg-violet-100 text-violet-600 dark:bg-violet-900/50 dark:text-violet-300',
  'bg-teal-100 text-teal-600 dark:bg-teal-900/50 dark:text-teal-300',
];

function ProductAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  const [imgError, setImgError] = useState(false);
  const colorCls = AVATAR_COLORS[(name.codePointAt(0) ?? 0) % AVATAR_COLORS.length];

  if (imageUrl && !imgError) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl} alt={name}
        onError={() => setImgError(true)}
        className="w-10 h-10 rounded-xl object-cover border border-slate-200 dark:border-slate-700"
      />
    );
  }
  return (
    <div className={`w-10 h-10 rounded-xl flex items-center justify-center
      font-bold text-base shrink-0 ${colorCls}`}>
      {[...name][0]?.toUpperCase() ?? '?'}
    </div>
  );
}

function StatCard({
  label, value, sub, accent,
}: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
      dark:border-slate-800 px-5 py-4 shadow-sm">
      <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-1">
        {label}
      </p>
      <p className={`text-2xl font-bold tracking-tight ${accent}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/* ── Modal wrapper ───────────────────────────────────────────────────────── */
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50
        flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl
        w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" dir="rtl">
        {children}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 *  MAIN PAGE
 * ══════════════════════════════════════════════════════════════════════════ */
export default function InventoryPage() {
  const router = useRouter();

  const [products,      setProducts]      = useState<Product[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState('');
  const [showModal,     setShowModal]     = useState(false);
  const [editTarget,    setEditTarget]    = useState<Product | null>(null);
  const [form,          setForm]          = useState<FormState>(EMPTY_FORM);
  const [saving,        setSaving]        = useState(false);
  const [formError,     setFormError]     = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<Product | null>(null);
  const [deleting,      setDeleting]      = useState(false);
  const [toast,         setToast]         = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Role gate — used to show/hide cost-price column + supply button ─── */
  const [isAdmin, setIsAdmin] = useState(false);

  /* ── Purchase (supply) modal state ──────────────────────────────────── */
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [purchaseForm,      setPurchaseForm]      = useState<PurchaseFormState>(EMPTY_PURCHASE_FORM);
  const [purchaseSaving,    setPurchaseSaving]    = useState(false);
  const [purchaseError,     setPurchaseError]     = useState('');
  const [purchaseResult,    setPurchaseResult]    = useState<PurchaseResult | null>(null);

  /* ── Auth guard — admin only ──────────────────────────────────────────── */
  useEffect(() => {
    const token    = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (!token || !userData) { router.push('/'); return; }
    try {
      const u = JSON.parse(userData);
      if (u.role !== 'admin') {
        router.push('/dashboard');
      } else {
        setIsAdmin(true);
      }
    } catch { router.push('/'); }
  }, [router]);

  /* ── Fetch ────────────────────────────────────────────────────────────── */
  const fetchProducts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getProducts();
      setProducts(res.data);
    } catch {
      showToast('فشل تحميل المنتجات — تحقق من الاتصال', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  /* ── Toast ────────────────────────────────────────────────────────────── */
  const showToast = (message: string, type: Toast['type']) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  /* ── Modal helpers ────────────────────────────────────────────────────── */
  const openAdd = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowModal(true);
  };

  const openEdit = (p: Product) => {
    setEditTarget(p);
    setForm({
      name:           p.name,
      sku:            p.sku,
      cost_price:     String(parseN(p.cost_price)),
      selling_price:  String(parseN(p.selling_price)),
      stock_quantity: String(p.stock_quantity),
      image_url:      p.image_url ?? '',
      aliases:        Array.isArray(p.aliases) ? p.aliases.join(', ') : '',
    });
    setFormError('');
    setShowModal(true);
  };

  const closeModal = () => { setShowModal(false); setEditTarget(null); };

  /* ── Purchase modal helpers ───────────────────────────────────────────── */
  const openPurchase = () => {
    setPurchaseForm({ ...EMPTY_PURCHASE_FORM, purchaseDate: todayISO() });
    setPurchaseError('');
    setPurchaseResult(null);
    setShowPurchaseModal(true);
  };
  const closePurchaseModal = () => {
    setShowPurchaseModal(false);
    setPurchaseResult(null);
  };

  const handlePurchaseSave = async () => {
    setPurchaseError('');
    if (!purchaseForm.productId)           { setPurchaseError('يرجى اختيار المنتج');                   return; }
    const qty  = parseInt(purchaseForm.quantity)     || 0;
    const cost = parseFloat(purchaseForm.unitCost)   || 0;
    if (qty <= 0)                          { setPurchaseError('الكمية يجب أن تكون أكبر من صفر');        return; }
    if (cost < 0 || purchaseForm.unitCost === '') { setPurchaseError('يرجى إدخال سعر تكلفة الوحدة');   return; }

    setPurchaseSaving(true);
    try {
      const res = await postPurchase({
        productId:    purchaseForm.productId,
        quantity:     qty,
        unitCost:     cost,
        purchaseDate: purchaseForm.purchaseDate || undefined,
      });
      setPurchaseResult(res.data);
      // Refresh the product row in local state
      setProducts((prev) => prev.map((p) => (p.id === res.data.product.id ? res.data.product : p)));
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'فشل تسجيل الشحنة';
      setPurchaseError(msg);
    } finally {
      setPurchaseSaving(false);
    }
  };;

  /* ── Save (create or update) ──────────────────────────────────────────── */
  const handleSave = async () => {
    setFormError('');
    if (!form.name.trim())  { setFormError('اسم المنتج مطلوب');   return; }
    if (!form.sku.trim())   { setFormError('SKU مطلوب');           return; }

    const payload: ProductPayload = {
      name:           form.name.trim(),
      sku:            form.sku.trim().toUpperCase(),
      cost_price:     parseN(form.cost_price),
      selling_price:  parseN(form.selling_price),
      stock_quantity: Math.max(0, Math.round(parseN(form.stock_quantity))),
      image_url:      form.image_url.trim() || null,
      // Parse the comma-separated aliases textbox → trimmed, de-duped array.
      aliases:        [...new Set(
        form.aliases.split(',').map((a) => a.trim()).filter(Boolean)
      )],
    };

    setSaving(true);
    try {
      if (editTarget) {
        const res = await updateProduct(editTarget.id, payload);
        setProducts((prev) => prev.map((p) => (p.id === editTarget.id ? res.data : p)));
        showToast('تم تحديث المنتج بنجاح ✓', 'success');
      } else {
        const res = await createProduct(payload);
        setProducts((prev) => [res.data, ...prev]);
        showToast('تمت إضافة المنتج بنجاح ✓', 'success');
      }
      closeModal();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'فشل في الحفظ — تحقق من البيانات';
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  /* ── Delete ───────────────────────────────────────────────────────────── */
  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await deleteProduct(deleteConfirm.id);
      setProducts((prev) => prev.filter((p) => p.id !== deleteConfirm.id));
      showToast('تم حذف المنتج', 'success');
      setDeleteConfirm(null);
    } catch {
      showToast('فشل في حذف المنتج', 'error');
    } finally {
      setDeleting(false);
    }
  };

  /* ── Derived data ─────────────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
    );
  }, [products, search]);

  const stats = useMemo(() => {
    const totalProducts  = products.length;
    const stockValue     = products.reduce((s, p) => s + parseN(p.selling_price) * p.stock_quantity, 0);
    const totalCOGS      = products.reduce((s, p) => s + parseN(p.cost_price)    * p.stock_quantity, 0);
    const lowStockCount  = products.filter((p) => p.stock_quantity > 0 && p.stock_quantity <= 10).length;
    const outOfStock     = products.filter((p) => p.stock_quantity === 0).length;
    return { totalProducts, stockValue, totalCOGS, lowStockCount, outOfStock };
  }, [products]);

  /* ── Live margin preview inside the product add/edit modal ─────────── */
  const modalCost      = parseN(form.cost_price);
  const modalPrice     = parseN(form.selling_price);
  const modalMargin    = modalPrice - modalCost;
  const modalMarginPct = modalPrice > 0 ? ((modalMargin / modalPrice) * 100).toFixed(1) : '0';

  /* ── Live WAC preview inside the purchase modal ─────────────────────── */
  const purchaseSelectedProduct = products.find((p) => p.id === purchaseForm.productId);
  const purchaseQty    = Math.max(0, parseInt(purchaseForm.quantity)   || 0);
  const purchaseCost   = Math.max(0, parseFloat(purchaseForm.unitCost) || 0);
  const currentStock   = purchaseSelectedProduct?.stock_quantity ?? 0;
  const currentWAC     = purchaseSelectedProduct ? parseN(purchaseSelectedProduct.cost_price) : 0;
  const newStock       = currentStock + purchaseQty;
  const previewWAC     = (purchaseQty > 0 && purchaseCost > 0)
    ? (newStock > 0
        ? ((currentStock * currentWAC) + (purchaseQty * purchaseCost)) / newStock
        : purchaseCost)
    : currentWAC;

  /* ── Render ───────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-full" dir="rtl">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3
          rounded-xl shadow-lg text-white text-sm font-medium transition-all
          ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}

      <div className="max-w-screen-2xl mx-auto px-6 pt-8 pb-10 space-y-6">

        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">
              إدارة المخزون
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              منتجاتك · أسعار التكلفة · مستويات المخزون
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Supply batch button — admin only */}
            {isAdmin && (
              <button
                onClick={openPurchase}
                className="inline-flex items-center gap-2 px-5 py-2.5
                  bg-emerald-600 hover:bg-emerald-700 text-white
                  rounded-xl text-sm font-semibold shadow-sm
                  shadow-emerald-500/30 transition-all duration-150"
              >
                {/* Truck / box icon */}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                إدخال شحنة
              </button>
            )}
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-5 py-2.5
                bg-indigo-600 hover:bg-indigo-700 text-white
                rounded-xl text-sm font-semibold shadow-sm
                shadow-indigo-500/30 transition-all duration-150"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              إضافة منتج
            </button>
          </div>
        </div>

        {/* ── Stats row ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="إجمالي المنتجات"
            value={String(stats.totalProducts)}
            accent="text-slate-800 dark:text-white"
          />
          <StatCard
            label="قيمة المخزون"
            value={`${fmtPrice(stats.stockValue)} ج.م`}
            sub="بسعر البيع"
            accent="text-emerald-600 dark:text-emerald-400"
          />
          <StatCard
            label="إجمالي التكلفة (COGS)"
            value={`${fmtPrice(stats.totalCOGS)} ج.م`}
            sub="بسعر التكلفة"
            accent="text-indigo-600 dark:text-indigo-400"
          />
          <StatCard
            label="منتجات تحتاج تجديد"
            value={String(stats.lowStockCount + stats.outOfStock)}
            sub={`${stats.outOfStock} نفد • ${stats.lowStockCount} قارب`}
            accent={stats.outOfStock > 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}
          />
        </div>

        {/* ── Search bar ──────────────────────────────────────────────── */}
        <div className="relative">
          <div className="absolute inset-y-0 right-0 flex items-center pr-3.5 pointer-events-none">
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
            </svg>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث باسم المنتج أو SKU..."
            className="w-full pr-10 pl-4 py-2.5 rounded-xl text-sm
              bg-white dark:bg-slate-900
              border border-slate-300 dark:border-slate-700
              text-slate-800 dark:text-slate-200
              placeholder-slate-400 dark:placeholder-slate-600
              outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent
              shadow-sm transition"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute inset-y-0 left-0 flex items-center pl-3.5
                text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                  d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* ── Table ───────────────────────────────────────────────────── */}
        {loading ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
            dark:border-slate-800 text-center py-24 shadow-sm">
            <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600
              rounded-full animate-spin mb-3" />
            <p className="text-slate-400 dark:text-slate-500 text-sm">جارٍ تحميل المنتجات...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
            dark:border-slate-800 text-center py-24 shadow-sm px-6">
            {search ? (
              <>
                <div className="inline-flex items-center justify-center w-14 h-14
                  rounded-full bg-slate-100 dark:bg-slate-800 mb-4">
                  <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
                  </svg>
                </div>
                <p className="text-slate-700 dark:text-slate-300 font-semibold text-sm">
                  لا توجد نتائج لـ &ldquo;{search}&rdquo;
                </p>
              </>
            ) : (
              <>
                <div className="inline-flex items-center justify-center w-16 h-16
                  rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 mb-4">
                  <svg className="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
                <p className="text-slate-700 dark:text-slate-300 font-semibold">المخزون فارغ حتى الآن</p>
                <p className="text-slate-400 dark:text-slate-500 text-sm mt-1 mb-5">
                  أضف أول منتج لبدء تتبع مخزونك وتكاليفك
                </p>
                <button
                  onClick={openAdd}
                  className="inline-flex items-center gap-2 px-5 py-2.5
                    bg-indigo-600 hover:bg-indigo-700 text-white
                    rounded-xl text-sm font-semibold transition"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                  </svg>
                  إضافة أول منتج
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
            dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b
                  border-slate-200 dark:border-slate-700
                  text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <Th>#</Th>
                    <Th>المنتج</Th>
                    <Th>SKU</Th>
                    {isAdmin && <Th>سعر التكلفة</Th>}
                    {isAdmin && <Th>إجمالي التكلفة</Th>}
                    <Th>سعر البيع</Th>
                    <Th>هامش الربح</Th>
                    <Th>المخزون</Th>
                    <Th>الإجراءات</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filtered.map((product, i) => {
                    const cost    = parseN(product.cost_price);
                    const price   = parseN(product.selling_price);
                    const margin  = price - cost;
                    const pct     = price > 0 ? (margin / price) * 100 : 0;
                    const isGood  = pct >= 30;
                    const isFair  = pct >= 15 && pct < 30;

                    return (
                      <tr
                        key={product.id}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        {/* # */}
                        <td className="px-4 py-3.5 text-slate-400 dark:text-slate-600 text-xs w-10">
                          {i + 1}
                        </td>

                        {/* Product */}
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-3">
                            <ProductAvatar name={product.name} imageUrl={product.image_url} />
                            <span className="font-semibold text-slate-800 dark:text-slate-200 leading-snug">
                              {product.name}
                            </span>
                          </div>
                        </td>

                        {/* SKU */}
                        <td className="px-4 py-3.5">
                          <span className="font-mono text-xs px-2 py-1 rounded-md
                            bg-slate-100 dark:bg-slate-800
                            text-slate-600 dark:text-slate-400
                            border border-slate-200 dark:border-slate-700"
                            dir="ltr">
                            {product.sku}
                          </span>
                        </td>

                        {/* Cost Price — admin only */}
                        {isAdmin && (
                          <td className="px-4 py-3.5">
                            <span className="text-sm font-medium text-slate-600 dark:text-slate-400"
                              dir="ltr">
                              {fmtPrice(product.cost_price)} ج.م
                            </span>
                          </td>
                        )}

                        {/* Total Asset Cost (unit cost × qty) — admin only */}
                        {isAdmin && (
                          <td className="px-4 py-3.5">
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300"
                              dir="ltr">
                              {fmtPrice(parseN(product.cost_price) * product.stock_quantity)} ج.م
                            </span>
                          </td>
                        )}

                        {/* Selling Price */}
                        <td className="px-4 py-3.5">
                          <span className="text-sm font-semibold text-slate-800 dark:text-slate-200"
                            dir="ltr">
                            {fmtPrice(product.selling_price)} ج.م
                          </span>
                        </td>

                        {/* Gross Margin % */}
                        <td className="px-4 py-3.5">
                          <span className={`text-sm font-bold ${
                            isGood ? 'text-emerald-600 dark:text-emerald-400'
                            : isFair ? 'text-amber-600 dark:text-amber-400'
                            : 'text-red-600 dark:text-red-400'
                          }`}>
                            {pct.toFixed(1)}%
                          </span>
                          <span className="text-xs text-slate-400 dark:text-slate-600 mr-1">
                            ({fmtPrice(margin)} ج.م)
                          </span>
                        </td>

                        {/* Stock */}
                        <td className="px-4 py-3.5">
                          <div className="flex flex-col items-start gap-1">
                            <StockBadge qty={product.stock_quantity} />
                            <span className="text-xs text-slate-400 dark:text-slate-600 pr-1">
                              {product.stock_quantity} قطعة
                            </span>
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => openEdit(product)}
                              className="px-3 py-1.5 text-xs rounded-lg font-medium transition
                                bg-indigo-50 text-indigo-700 hover:bg-indigo-100
                                dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
                            >
                              تعديل
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(product)}
                              className="px-3 py-1.5 text-xs rounded-lg font-medium transition
                                bg-red-50 text-red-600 hover:bg-red-100
                                dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/60"
                            >
                              حذف
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/50 border-t
              border-slate-100 dark:border-slate-800
              text-xs text-slate-400 dark:text-slate-500 flex items-center justify-between">
              <span>
                {filtered.length !== products.length
                  ? `${filtered.length} نتيجة من ${products.length} منتج`
                  : `${products.length} منتج`}
              </span>
              <span>
                إجمالي وحدات المخزون:{' '}
                <span className="font-semibold text-slate-600 dark:text-slate-300">
                  {products.reduce((s, p) => s + p.stock_quantity, 0).toLocaleString('en-US')}
                </span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ══ Add / Edit Modal ════════════════════════════════════════════ */}
      {showModal && (
        <Modal onClose={closeModal}>
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0
              bg-indigo-100 dark:bg-indigo-900/40">
              <svg className="w-5 h-5 text-indigo-600 dark:text-indigo-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d={editTarget
                    ? 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z'
                    : 'M12 4v16m8-8H4'} />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
                {editTarget ? 'تعديل المنتج' : 'إضافة منتج جديد'}
              </h2>
              {editTarget && (
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 font-mono">
                  {editTarget.sku}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4">

            {/* Name */}
            <Field label="اسم المنتج *">
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="مثال: كريم تبييض البشرة"
                className={inputCls}
              />
            </Field>

            {/* SKU */}
            <Field label="رمز المنتج (SKU) *">
              <input
                type="text"
                dir="ltr"
                value={form.sku}
                onChange={(e) => setForm((p) => ({ ...p, sku: e.target.value.toUpperCase() }))}
                placeholder="CREAM-001"
                className={`${inputCls} font-mono tracking-wider`}
              />
            </Field>

            {/* Prices row */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="سعر التكلفة (ج.م)">
                <input
                  type="number" min="0" step="0.01" dir="ltr"
                  value={form.cost_price}
                  onChange={(e) => setForm((p) => ({ ...p, cost_price: e.target.value }))}
                  placeholder="0"
                  className={inputCls}
                />
              </Field>
              <Field label="سعر البيع (ج.م)">
                <input
                  type="number" min="0" step="0.01" dir="ltr"
                  value={form.selling_price}
                  onChange={(e) => setForm((p) => ({ ...p, selling_price: e.target.value }))}
                  placeholder="0"
                  className={inputCls}
                />
              </Field>
            </div>

            {/* Live margin preview */}
            {(modalCost > 0 || modalPrice > 0) && (
              <div className={`rounded-xl p-3 text-xs flex items-center justify-between
                border ${parseFloat(modalMarginPct) >= 30
                  ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800/50'
                  : parseFloat(modalMarginPct) >= 15
                    ? 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800/50'
                    : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800/50'}`}>
                <span className="text-slate-500 dark:text-slate-400">هامش الربح التقديري</span>
                <span className={`font-bold text-sm ${
                  parseFloat(modalMarginPct) >= 30 ? 'text-emerald-600 dark:text-emerald-400'
                  : parseFloat(modalMarginPct) >= 15 ? 'text-amber-600 dark:text-amber-400'
                  : 'text-red-600 dark:text-red-400'}`}>
                  {modalMarginPct}%
                  <span className="font-normal text-xs mr-1">
                    ({fmtPrice(modalMargin)} ج.م / وحدة)
                  </span>
                </span>
              </div>
            )}

            {/* Stock */}
            <Field label="الكمية في المخزون">
              <input
                type="number" min="0" step="1" dir="ltr"
                value={form.stock_quantity}
                onChange={(e) => setForm((p) => ({ ...p, stock_quantity: e.target.value }))}
                placeholder="0"
                className={inputCls}
              />
            </Field>

            {/* Image URL */}
            <Field label="رابط صورة المنتج (اختياري)">
              <input
                type="url" dir="ltr"
                value={form.image_url}
                onChange={(e) => setForm((p) => ({ ...p, image_url: e.target.value }))}
                placeholder="https://example.com/image.jpg"
                className={inputCls}
              />
            </Field>

            {/* Campaign aliases (SKU mapping) */}
            <Field label="أكواد الحملات (Aliases)">
              <input
                type="text" dir="ltr"
                value={form.aliases}
                onChange={(e) => setForm((p) => ({ ...p, aliases: e.target.value }))}
                placeholder="ipl, laser-ad, heating-Pad"
                className={inputCls}
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500" dir="rtl">
                أكواد بديلة (مفصولة بفاصلة) يستخدمها الميديا باير في إعلانات Meta / إيزي أوردر.
                أي طلب يصل بأحد هذه الأكواد سيُطابق هذا المنتج لخصم/إرجاع المخزون تلقائياً.
              </p>
            </Field>

            {/* Error */}
            {formError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400
                bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50
                px-3 py-2.5 rounded-xl">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {formError}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3 mt-6">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2
                bg-indigo-600 hover:bg-indigo-700 text-white
                py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50"
            >
              {saving ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white
                    rounded-full animate-spin" />
                  جارٍ الحفظ...
                </>
              ) : (editTarget ? 'حفظ التعديلات' : 'إضافة المنتج')}
            </button>
            <button
              onClick={closeModal}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                bg-slate-100 hover:bg-slate-200 text-slate-700
                dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                disabled:opacity-50"
            >
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ══ Supply Batch / Purchase Modal (admin only) ══════════════════ */}
      {showPurchaseModal && isAdmin && (
        <Modal onClose={closePurchaseModal}>
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0
              bg-emerald-100 dark:bg-emerald-900/40">
              <svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
                إدخال شحنة جديدة
              </h2>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                يُحدَّث سعر التكلفة تلقائياً بمعادلة WAC
              </p>
            </div>
          </div>

          {/* ── Success state ── */}
          {purchaseResult ? (
            <div className="space-y-4">
              <div className="rounded-xl p-4 bg-emerald-50 dark:bg-emerald-900/20
                border border-emerald-200 dark:border-emerald-800/50 text-center">
                <div className="text-3xl mb-2">✅</div>
                <p className="font-bold text-emerald-700 dark:text-emerald-400 text-sm">
                  {purchaseResult.message}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {purchaseResult.product.name}
                </p>
              </div>

              {/* WAC comparison */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'التكلفة السابقة', value: `${fmtPrice(purchaseResult.previousCost)} ج.م`, cls: 'text-slate-600 dark:text-slate-400' },
                  { label: 'التكلفة الجديدة (WAC)', value: `${fmtPrice(purchaseResult.newCost)} ج.م`, cls: 'text-emerald-600 dark:text-emerald-400' },
                  { label: 'المخزون الجديد', value: `${purchaseResult.newStock} قطعة`, cls: 'text-indigo-600 dark:text-indigo-400' },
                ].map((m) => (
                  <div key={m.label}
                    className="bg-white dark:bg-slate-800 rounded-xl p-3 text-center border
                      border-slate-200 dark:border-slate-700">
                    <p className={`font-bold text-base tabular-nums ${m.cls}`} dir="ltr">
                      {m.value}
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                      {m.label}
                    </p>
                  </div>
                ))}
              </div>

              <button
                onClick={closePurchaseModal}
                className="w-full py-2.5 rounded-xl text-sm font-semibold
                  bg-emerald-600 hover:bg-emerald-700 text-white transition"
              >
                تم — إغلاق
              </button>
            </div>
          ) : (
            /* ── Form state ── */
            <div className="space-y-4">

              {/* Arrival date */}
              <Field label="تاريخ وصول الشحنة">
                <input
                  type="date"
                  dir="ltr"
                  value={purchaseForm.purchaseDate}
                  onChange={(e) => setPurchaseForm((p) => ({ ...p, purchaseDate: e.target.value }))}
                  className={inputCls}
                />
              </Field>

              {/* Product select */}
              <Field label="المنتج *">
                <select
                  value={purchaseForm.productId}
                  onChange={(e) => setPurchaseForm((p) => ({ ...p, productId: e.target.value }))}
                  className={`${inputCls} [&>option]:bg-white [&>option]:text-slate-900 dark:[&>option]:bg-slate-800 dark:[&>option]:text-slate-100`}
                >
                  <option value="">— اختر منتجاً —</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.sku})
                    </option>
                  ))}
                </select>
              </Field>

              {/* Quantity + Unit Cost */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="الكمية المُضافة *">
                  <input
                    type="number" min="1" step="1" dir="ltr"
                    value={purchaseForm.quantity}
                    onChange={(e) => setPurchaseForm((p) => ({ ...p, quantity: e.target.value }))}
                    placeholder="0"
                    className={inputCls}
                  />
                </Field>
                <Field label="سعر تكلفة الوحدة (ج.م) *">
                  <input
                    type="number" min="0" step="0.01" dir="ltr"
                    value={purchaseForm.unitCost}
                    onChange={(e) => setPurchaseForm((p) => ({ ...p, unitCost: e.target.value }))}
                    placeholder="0.00"
                    className={inputCls}
                  />
                </Field>
              </div>

              {/* WAC live preview */}
              {purchaseSelectedProduct && purchaseQty > 0 && purchaseCost > 0 && (
                <div className="rounded-xl border bg-indigo-50 border-indigo-200
                  dark:bg-indigo-900/20 dark:border-indigo-800/50 p-3.5 space-y-2.5">
                  <p className="text-[11px] font-bold uppercase tracking-widest
                    text-indigo-500 dark:text-indigo-400">
                    معاينة تكلفة WAC الجديدة
                  </p>

                  {/* Formula breakdown */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-white dark:bg-slate-800 rounded-lg p-2.5 border
                      border-indigo-100 dark:border-indigo-800/40">
                      <p className="text-slate-400 dark:text-slate-500 mb-0.5">المخزون الحالي</p>
                      <p className="font-bold text-slate-700 dark:text-slate-200 tabular-nums" dir="ltr">
                        {currentStock} قطعة × {fmtPrice(currentWAC)} ج.م
                      </p>
                    </div>
                    <div className="bg-white dark:bg-slate-800 rounded-lg p-2.5 border
                      border-indigo-100 dark:border-indigo-800/40">
                      <p className="text-slate-400 dark:text-slate-500 mb-0.5">الشحنة الجديدة</p>
                      <p className="font-bold text-slate-700 dark:text-slate-200 tabular-nums" dir="ltr">
                        {purchaseQty} قطعة × {fmtPrice(purchaseCost)} ج.م
                      </p>
                    </div>
                  </div>

                  {/* Result row */}
                  <div className="flex items-center justify-between gap-3
                    bg-white dark:bg-slate-800 rounded-lg p-2.5 border
                    border-indigo-200 dark:border-indigo-700/50">
                    <div className="text-xs">
                      <p className="text-slate-400 dark:text-slate-500">
                        التكلفة المرجحة (WAC) الجديدة
                      </p>
                      <p className="text-[11px] text-slate-400 dark:text-slate-600 mt-0.5">
                        المخزون الجديد: {newStock} قطعة
                      </p>
                    </div>
                    <div className="text-left">
                      {currentWAC !== parseFloat(previewWAC.toFixed(2)) && (
                        <p className="text-[11px] text-slate-400 line-through tabular-nums" dir="ltr">
                          {fmtPrice(currentWAC)} ج.م
                        </p>
                      )}
                      <p className="font-black text-indigo-600 dark:text-indigo-400 text-base tabular-nums" dir="ltr">
                        {fmtPrice(previewWAC)} ج.م
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Current WAC info (when product selected but qty/cost not yet entered) */}
              {purchaseSelectedProduct && !(purchaseQty > 0 && purchaseCost > 0) && (
                <div className="flex items-center gap-2.5 rounded-xl border
                  border-slate-200 dark:border-slate-700
                  bg-slate-50 dark:bg-slate-800/50 p-3 text-xs text-slate-500 dark:text-slate-400">
                  <svg className="w-4 h-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>
                    التكلفة الحالية (WAC):{' '}
                    <span className="font-bold text-slate-700 dark:text-slate-300" dir="ltr">
                      {fmtPrice(currentWAC)} ج.م
                    </span>
                    {' '} · المخزون:{' '}
                    <span className="font-bold text-slate-700 dark:text-slate-300">
                      {currentStock} قطعة
                    </span>
                  </span>
                </div>
              )}

              {/* Error */}
              {purchaseError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400
                  bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50
                  px-3 py-2.5 rounded-xl">
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {purchaseError}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-1">
                <button
                  onClick={handlePurchaseSave}
                  disabled={purchaseSaving}
                  className="flex-1 flex items-center justify-center gap-2
                    bg-emerald-600 hover:bg-emerald-700 text-white
                    py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50"
                >
                  {purchaseSaving ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/40 border-t-white
                        rounded-full animate-spin" />
                      جارٍ التسجيل...
                    </>
                  ) : 'تسجيل الشحنة'}
                </button>
                <button
                  onClick={closePurchaseModal}
                  disabled={purchaseSaving}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                    bg-slate-100 hover:bg-slate-200 text-slate-700
                    dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                    disabled:opacity-50"
                >
                  إلغاء
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* ══ Delete Confirmation Modal ════════════════════════════════════ */}
      {deleteConfirm && (
        <Modal onClose={() => !deleting && setDeleteConfirm(null)}>
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-14 h-14
              rounded-full bg-red-100 dark:bg-red-900/30 mb-4">
              <svg className="w-7 h-7 text-red-600 dark:text-red-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-1">
              تأكيد حذف المنتج
            </h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm mb-1">
              هل تريد حذف المنتج التالي نهائياً؟
            </p>
            <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
              {deleteConfirm.name}
            </p>
            <p className="font-mono text-xs text-slate-400 dark:text-slate-500 mb-6">
              {deleteConfirm.sku}
            </p>
            <p className="text-xs text-red-500 dark:text-red-400 mb-6">
              لا يمكن التراجع عن هذا الإجراء.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 flex items-center justify-center gap-2
                  bg-red-600 hover:bg-red-700 text-white
                  py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50"
              >
                {deleting ? (
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white
                    rounded-full animate-spin" />
                ) : 'نعم، احذف'}
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                  bg-slate-100 hover:bg-slate-200 text-slate-700
                  dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                  disabled:opacity-50"
              >
                إلغاء
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Table helpers ───────────────────────────────────────────────────────── */
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-right font-semibold whitespace-nowrap">
      {children}
    </th>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputCls = `w-full px-3 py-2.5 rounded-xl text-sm outline-none transition
  border border-slate-300 dark:border-slate-700
  bg-white dark:bg-slate-800
  text-slate-900 dark:text-slate-200
  placeholder-slate-400 dark:placeholder-slate-600
  focus:ring-2 focus:ring-indigo-400 focus:border-transparent`;
