import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface Order {
  id: number;
  FullName: string;
  Phone: string;
  DeliveryRate: string;
  City: string;
  Address: string;
  Status: string;
  Note: string | null;
  ShippingNotes?: string | null;   // courier note — printed on the Bosta AWB
  createdAt: string;
  ProductName?: string;
  ProductPrice?: string;
  quantity?: number;            // number of units in the order (DB column, default 1)
  AssignedTo?: string;
  PostponedDate?: string;
  BostaTrackingCode?: string;   // set after successful Bosta shipment
  rejectionReason?: string;     // set when Status is 'تم الرفض'
  sku?: string;                 // SKU Shield: links order to inventory product for precise deduction
  hasDeposit?: boolean;         // true when a deposit / down-payment was collected
  depositAmount?: number;       // amount already paid (العربون / الديبوزت) in EGP
  unit_cost_price?: number;     // WAC locked at confirmation — used for accurate historical COGS
  no_answer_logs?: string[];    // ISO timestamps of logged call attempts (لا يرد)
}

export interface ShippingResultRow {
  orderId:      number;
  name:         string;
  phone:        string;
  trackingCode?: string;   // present on success
  error?:        string;   // present on failure
}

export interface ShippingResult {
  message: string;
  success: ShippingResultRow[];
  failed:  ShippingResultRow[];
}

export type PlanType = 'affiliate' | 'ecommerce';

export interface User {
  id:          number;
  email:       string;
  role:        'agent' | 'admin' | 'media_buyer';
  permissions?: string[];   // e.g. ['orders', 'analytics', 'inventory']
  business_id?: number | null;
  plan_type?:  PlanType;
}

export type AgentUpdate = Pick<Order, 'Status' | 'Note' | 'DeliveryRate'>;
export type AdminUpdate = Partial<Omit<Order, 'id' | 'createdAt'>>;

export const login = (email: string, password: string) =>
  api.post<{ token: string; user: User }>('/api/auth/login', { email, password });

/** Shape returned (HTTP 403) when the account must verify its email via OTP. */
export interface RequiresOtp {
  requires_otp: true;
  email:        string;
  message:      string;
}

/** Verify the 6-digit OTP for an unverified staff account → returns login payload. */
export const verifyOtp = (email: string, otp: string) =>
  api.post<{ token: string; user: User }>('/api/auth/verify-otp', { email, otp });

export interface RegisterPayload {
  email:      string;
  password:   string;
  brand_name: string;
  plan_type:  PlanType;
}

export const register = (payload: RegisterPayload) =>
  api.post<{ token: string; user: User }>('/api/auth/register', payload);

export const getOrders = () =>
  api.get<Order[]>('/api/orders');

/* ── Manual order creation (WhatsApp / Facebook / phone) ────────────────────── */
export interface CreateOrderPayload {
  FullName:      string;
  Phone:         string;
  Address?:      string;
  City?:         string;
  ProductName?:  string;
  sku?:          string;                 // SKU of the selected product
  ProductPrice?: string | number;        // Total / COD amount
  quantity?:     number;                  // number of units (default 1)
}

/** Create a manual order (status 'جديد', tenant-scoped). Admins + agents. */
export const createOrder = (data: CreateOrderPayload) =>
  api.post<Order>('/api/orders', data);

export const updateOrder = (id: number, data: AgentUpdate | AdminUpdate) =>
  api.patch<Order>(`/api/orders/${id}`, data);

export const deleteOrder = (id: number) =>
  api.delete(`/api/orders/${id}`);

/* ── No-answer call-attempt logging (5-attempt commission rule) ─────────────── */
export interface NoAnswerAttemptResult {
  no_answer_logs:    string[];   // updated array of ISO timestamps
  count:             number;     // attempts so far
  required:          number;     // attempts needed for the commission (5)
  commissionAwarded: boolean;    // true if THIS attempt unlocked the commission
}

/** Log one call attempt for a 'لا يرد' order. Awards comm_no_answer at 5 attempts. */
export const logNoAnswerAttempt = (id: number) =>
  api.post<NoAnswerAttemptResult>(`/api/orders/${id}/no-answer-attempt`);

/** Bulk-delete orders by id. Admin only. Tenant-scoped server-side. */
export const bulkDeleteOrders = (ids: number[]) =>
  api.delete<{ message: string; deleted: number }>('/api/orders/bulk', { data: { ids } });

export const bulkTransfer = (fromAgent: string, toAgent: string) =>
  api.post<{ message: string; transferred: number }>('/api/orders/bulk-transfer', { fromAgent, toAgent });

export interface AutoDistributeResult {
  message:     string;
  distributed: number;
  agentsCount: number;
}

export interface TransferResult {
  message:     string;
  transferred: number;
  targetEmail: string;
}

/* ── Flexible order distribution (equal or custom %) ─────────────────────────── */
export interface DistributionAllocation {
  agentId:    number;
  percentage: number;   // 0–100; for custom mode the set must sum to exactly 100
}

export interface DistributeResult {
  message:     string;
  distributed: number;
  mode:        'equal' | 'custom';
  breakdown:   { email: string; count: number }[];
}

/**
 * Distribute all 'جديد' orders across agents. The backend owns the exact math
 * (largest-remainder), so counts always sum precisely to the order total.
 *   • Equal  → distributeOrders('equal')
 *   • Custom → distributeOrders('custom', [{ agentId, percentage }, …])
 * Admin only.
 */
export const distributeOrders = (
  mode: 'equal' | 'custom',
  allocations?: DistributionAllocation[],
) =>
  api.post<DistributeResult>('/api/orders/distribute', { mode, allocations });

/** Distribute all unassigned 'جديد' orders evenly across present agents. */
export const autoDistributeOrders = () =>
  api.post<AutoDistributeResult>('/api/orders/auto-distribute');

/** Transfer specific orders to a target agent (by their DB user id). */
export const transferOrders = (orderIds: number[], targetAgentId: number) =>
  api.post<TransferResult>('/api/orders/transfer', { orderIds, targetAgentId });

export interface InventoryItem {
  id: number;
  ProductName: string;
  StockQuantity: number;
  updatedAt: string;
}

export const getInventory = () =>
  api.get<InventoryItem[]>('/api/inventory');

export const upsertInventory = (ProductName: string, StockQuantity: number) =>
  api.post<InventoryItem>('/api/inventory', { ProductName, StockQuantity });

/* ── Business Profile ───────────────────────────────────────────── */
export interface BusinessProfile {
  id:            number;
  brand_name:    string;
  contact_email: string;
  phone_number:  string;
  industry:      string;
  logo_url:      string;
  plan_type?:    PlanType;
  updated_at:    string;
}

export const getBusinessProfile = () =>
  api.get<BusinessProfile>('/api/business-profile');

export const updateBusinessProfile = (id: number, data: Partial<Omit<BusinessProfile, 'id' | 'updated_at'>>) =>
  api.patch<BusinessProfile>(`/api/business-profile/${id}`, data);

/* ── Products (Inventory) ────────────────────────────────────────── */
export interface Product {
  id:             string;         // UUID
  name:           string;
  sku:            string;
  cost_price:     number | string; // pg returns NUMERIC as string — use parseFloat()
  selling_price:  number | string;
  stock_quantity: number;
  image_url:      string | null;
  aliases:        string[];        // external campaign codes that map to this product
  created_at:     string;
}

export type ProductPayload = Omit<Product, 'id' | 'created_at'>;

export const getProducts = () =>
  api.get<Product[]>('/api/products');

export const createProduct = (data: ProductPayload) =>
  api.post<Product>('/api/products', data);

export const updateProduct = (id: string, data: Partial<ProductPayload>) =>
  api.patch<Product>(`/api/products/${id}`, data);

export const deleteProduct = (id: string) =>
  api.delete(`/api/products/${id}`);

/* ── Shipping (Bosta) ────────────────────────────────────────────── */
export const getShippingPending = () =>
  api.get<{ count: number }>('/api/shipping/pending');

/**
 * Forward specific confirmed orders to Bosta ("Send What You See").
 * @param allowOpen  Allow package opening on delivery (Bosta flag).
 * @param orderIds   The exact ids of the confirmed orders to dispatch — the
 *                   rows the user has filtered/sliced in the UI. The backend
 *                   ships these verbatim (ignoring any stale tracking code so
 *                   reverted orders can be re-sent), guarded by status.
 */
export const forwardToShipping = (allowOpen: boolean, orderIds: number[]) =>
  api.post<ShippingResult>('/api/shipping/forward', { allowOpen, orderIds });

/* ── Returns Log ─────────────────────────────────────────────────── */
export interface DailyReturn {
  product_name: string;
  sku:          string;
  quantity:     number;
  return_date:  string;
}

/** Fetch returns for a specific date (YYYY-MM-DD). Defaults to today on the server if omitted. */
export const getDailyReturns = (date: string) =>
  api.get<DailyReturn[]>(`/api/returns/daily?date=${date}`);

export interface ManualReturnPayload {
  productId:  string;
  quantity:   number;
  returnDate: string;   // YYYY-MM-DD
}

export interface ManualReturnResult {
  message:  string;
  product:  string;
  newStock: number;
}

/** Log a manual (backfill) return. Admin only. */
export const postManualReturn = (data: ManualReturnPayload) =>
  api.post<ManualReturnResult>('/api/returns/manual', data);

/* ── Bosta returns sync (backfill physically-returned orders) ─────── */
export interface SyncReturnsResult {
  message:      string;
  mode:         'explicit' | 'auto' | 'date';
  date:         string | null;
  scanned:      number;
  matchedLocal: number;
  processed:    number;   // orders newly status→returned + logged
  restocked:    number;   // of those, how many incremented product stock
  notFound:     string[]; // Bosta tracking numbers with no local order
  details:      unknown[];
}

/** Sync physically-returned Bosta orders. Pass { date:'YYYY-MM-DD' } to sync one
    day, { trackingNumbers:[…] } for specific ones, or {} for a full sweep. Admin only. */
export const syncBostaReturns = (payload: { date?: string; trackingNumbers?: string[] } = {}) =>
  api.post<SyncReturnsResult>('/api/bosta/sync-returns', payload);

/* ── Purchase Batches (Supply / WAC) ─────────────────────────────── */
export interface PurchasePayload {
  productId:    string;    // products.id (UUID)
  quantity:     number;    // incoming units (integer > 0)
  unitCost:     number;    // cost per incoming unit (EGP)
  purchaseDate?: string;   // YYYY-MM-DD — defaults to today on the server
}

export interface PurchaseResult {
  message:       string;
  product:       Product;   // updated product row (new WAC in cost_price)
  previousCost:  number;
  newCost:       number;    // new WAC cost_price after the batch
  addedQuantity: number;
  newStock:      number;
}

/** Record a supply batch and recompute WAC. Admin only. */
export const postPurchase = (data: PurchasePayload) =>
  api.post<PurchaseResult>('/api/products/purchases', data);

/* ── Staff Management ────────────────────────────────────────────── */
export interface StaffMember {
  id:              number;
  name:            string;
  email:           string;
  role:            'agent' | 'admin' | 'media_buyer';
  is_active:       boolean;
  is_absent:       boolean;
  permissions:     string[];
  commission_rate: number;       // legacy single-rate (kept for backward compat)
  comm_confirmed:  number;       // payout per confirmed order
  comm_delivered:  number;       // bonus per delivered order
  comm_rejected:   number;       // payout per rejected order
  comm_no_answer:  number;       // payout per no-answer / postponed order
  distribution_percentage?: number;  // saved auto-distribution weight (%)
  last_active_at?: string | null;    // presence heartbeat timestamp (ISO)
  created_at:      string;
}

export interface CreateStaffPayload {
  name?:            string;
  email:            string;
  password:         string;
  role?:            'agent' | 'admin' | 'media_buyer';
  permissions?:     string[];
  commission_rate?: number;
  comm_confirmed?:  number;
  comm_delivered?:  number;
  comm_rejected?:   number;
  comm_no_answer?:  number;
}

export interface UpdateStaffPayload {
  name?:            string;
  email?:           string;
  password?:        string;
  role?:            'agent' | 'admin' | 'media_buyer';
  is_active?:       boolean;
  permissions?:     string[];
  commission_rate?: number;
  comm_confirmed?:  number;
  comm_delivered?:  number;
  comm_rejected?:   number;
  comm_no_answer?:  number;
}

export interface ToggleAttendanceResult {
  user:               StaffMember;
  redistributed:      number;
  presentAgentsCount: number;
}

export const getStaff = () =>
  api.get<StaffMember[]>('/api/staff');

export const createStaff = (data: CreateStaffPayload) =>
  api.post<StaffMember>('/api/staff', data);

export const updateStaff = (id: number, data: UpdateStaffPayload) =>
  api.patch<StaffMember>(`/api/staff/${id}`, data);

export const toggleAttendance = (id: number, isAbsent: boolean) =>
  api.post<ToggleAttendanceResult>(`/api/staff/${id}/toggle-attendance`, { isAbsent });

/** Presence heartbeat — stamps the current user's last_active_at = NOW().
    Pinged on an interval while logged in. Any role. */
export const sendHeartbeat = () =>
  api.post<{ ok: boolean; at: string }>('/api/staff/heartbeat');

/** Persist per-agent auto-distribution weights (%). Drives weighted round-robin
    assignment of incoming EasyOrder webhook orders. Admin only. */
export const saveDistributionConfig = (allocations: DistributionAllocation[]) =>
  api.post<{ message: string; agents: StaffMember[] }>(
    '/api/staff/distribution',
    { allocations },
  );

/** Delete a staff member. Admin only. Server protects self + founding admin. */
export const deleteStaff = (id: number) =>
  api.delete<{ message: string; id: string }>(`/api/staff/${id}`);

/* ── Purchase History ────────────────────────────────────────────── */
export interface PurchaseHistoryItem {
  id:            number;
  product_name:  string;
  sku:           string;
  quantity:      number;
  cost_price:    number | string;   // pg NUMERIC → string; use parseFloat()
  purchase_date: string;            // YYYY-MM-DD
  created_at:    string;
}

/** Fetch all supply batches (newest first). Admin only. */
export const getPurchaseHistory = () =>
  api.get<PurchaseHistoryItem[]>('/api/products/purchases');

/* ── Team Analytics ──────────────────────────────────────────────── */
export interface AgentAnalytics {
  agent_id:         number;
  agent_name:       string;
  agent_email:      string;
  is_active:        boolean;

  /** Granular commission matrix (pg NUMERIC → string; use parseFloat()) */
  comm_confirmed:   number | string;
  comm_delivered:   number | string;
  comm_rejected:    number | string;
  comm_no_answer:   number | string;

  total_assigned:   number;

  status_new:       number;
  status_no_answer:  number;   // لا يرد only
  status_postponed:  number;   // مؤجل only
  status_cancelled:  number;
  status_confirmed: number;
  status_delivered: number;
  status_returned:  number;

  /** Non-Delivery Rate = returned / (delivered + returned) × 100.
   *  Null when the agent has no post-delivery data for the period.  */
  ndr_pct:          string | null;

  /** (confirmed × comm_confirmed) + (delivered × comm_delivered) + (rejected × comm_rejected) */
  earned_commission: string | number;
}

function buildAnalyticsQS(startDate?: string, endDate?: string, product?: string) {
  const qs = new URLSearchParams();
  if (startDate) qs.set('startDate', startDate);
  if (endDate)   qs.set('endDate',   endDate);
  /* Product filter — the dropdown's selected product NAME. 'كل المنتجات' / empty
     means "all", so we omit it (backend treats absence as no filter). */
  if (product && product !== 'كل المنتجات') qs.set('product', product);
  const q = qs.toString();
  return q ? `?${q}` : '';
}

/**
 * Fetch per-agent performance aggregation for the given date range.
 * Admin only — server enforces 403 for non-admins.
 */
export const getAgentAnalytics = (startDate?: string, endDate?: string) =>
  api.get<AgentAnalytics[]>(`/api/analytics/agents${buildAnalyticsQS(startDate, endDate)}`);

/* ── Dashboard Financial Overview (legacy — kept for backward compat) ── */
export interface DashboardOverview {
  total_expenses:        number;
  total_sales_delivered: number;
  net_profit:            number;
}

export const getDashboardOverview = (startDate?: string, endDate?: string) =>
  api.get<DashboardOverview>(`/api/analytics/overview${buildAnalyticsQS(startDate, endDate)}`);

/* ── Unified Dashboard Stats (new) ──────────────────────────────────── */

export interface DashboardOverviewStats {
  /** Meta-reported purchases (SUM of meta_purchases from expenses where meta_sync=true).
   *  This is the authoritative order count — it bypasses the ERP orders table so that
   *  manual orders not logged in the ERP are still counted. */
  total_orders:    number;
  /** Orders that reached تم التأكيد or beyond. */
  total_confirmed: number;
  /** Orders in status تم التوصيل. */
  total_delivered: number;
  /** Orders in status تم الرفض. */
  total_rejected:  number;
  /** Orders returned (جاري الإعادة + تم الإرجاع). */
  total_returned:  number;
  /** Orders still pending (جديد + لا يرد). */
  total_pending:   number;
  /** Sum of ProductPrice for delivered orders. */
  total_revenue:   number;
  /** Sum of ALL expense rows in the date range. */
  total_expenses:  number;
  /** Sum of Meta-synced expense rows only. */
  meta_spend:      number;
  /** TRUE-net-profit operating expenses from the treasury ledger (commissions,
   *  shipping, packaging, fixed/SaaS) — ad spend excluded to avoid double count.
   *  Business-wide total. */
  operating_expenses?: number;
  /** Per-source OPEX breakdown for the cost-stack tooltip. */
  opex_breakdown?:     { source: string; label: string; amount: number }[];
  /** Path A+ split inputs. commissions_total is attributed EXACTLY per product
   *  via opex_commission_by_product; shared_total is split by delivered-order
   *  count on the client. */
  opex_commissions_total?:     number;
  opex_shared_total?:          number;
  opex_commission_by_product?: Record<string, number>;
}

export interface DailyChartStat {
  /** YYYY-MM-DD in Egypt local time. */
  date:       string;
  /** Meta-reported purchases for this date (authoritative order count). */
  orders:     number;
  /** ERP-internal order count for this date (used for pixel efficiency). */
  erp_orders?: number;
  confirmed:  number;
  delivered:  number;
  /** Sum of ProductPrice for delivered orders on this day. */
  revenue:    number;
  /** Sum of Meta expense rows for this date. */
  ads_spend:  number;
}

export interface GovernorateStats {
  governorate:  string;
  total_orders: number;
  confirmed:    number;
  delivered:    number;
  returned:     number;
  /** Sum of ProductPrice for delivered orders in this governorate. */
  revenue:      number;
}

export interface RejectionReason {
  reason: string;
  count:  number;
}

/* ── External Affiliate Networks (affiliate plan exclusive) ───────────────── */
export interface ExternalNetworkStat {
  /** True when this network has saved credentials for the tenant. */
  connected:     boolean;
  revenue:       number;
  orders:        number;
  /** Absolute confirmed-order count (derived from confirmedRate). */
  confirmed:     number;
  /** Absolute delivered-order count (derived from deliveredRate). */
  delivered:     number;
  /** Confirmation percentage (0–100). */
  confirmedRate: number;
  /** Delivery percentage (0–100). */
  deliveredRate: number;
  /** True when the live API call failed (numbers degraded to zero). */
  error?:        boolean;
}

export interface ExternalStats {
  /** True when at least one external network is connected for this tenant. */
  enabled:       boolean;
  taagerRevenue: number;
  safqaRevenue:  number;
  /** taagerRevenue + safqaRevenue */
  totalRevenue:  number;
  /** taager.orders + safqa.orders */
  totalOrders:   number;
  taager:        ExternalNetworkStat;
  safqa:         ExternalNetworkStat;
}

export interface DashboardStats {
  overview:           DashboardOverviewStats;
  daily_chart_stats:  DailyChartStat[];
  governorates_stats: GovernorateStats[];
  rejection_reasons:  RejectionReason[];
  /** Present only for affiliate-plan tenants with connected networks (mock for now). */
  externalStats?:     ExternalStats;
}

/**
 * Fetch the unified analytics dashboard payload.
 * Returns overview, daily chart, governorates breakdown, and rejection reasons
 * — all strictly filtered by the given date range.
 * Admin only.
 */
export const getDashboardStats = (startDate?: string, endDate?: string, product?: string) =>
  api.get<DashboardStats>(`/api/analytics/dashboard${buildAnalyticsQS(startDate, endDate, product)}`);

/* ── Product Profitability ───────────────────────────────────────── */
export interface ProductProfitability {
  product_id:          string;
  product_name:        string;
  sku:                 string;
  cost_price:          number;
  /** Delivered orders count matched via orders.sku = products.sku. */
  units_delivered:     number;
  /** Orders actually shipped to the courier (تم الشحن/تم التوصيل/جاري الإعادة/تم الإرجاع).
   *  The Delivery-Rate denominator — excludes confirmed-not-shipped & new orders. */
  units_shipped:       number;
  /** Product Delivery Rate = units_delivered ÷ units_shipped × 100 (0 when none shipped). */
  delivery_rate:       number;
  /** Meta-reported purchases for this product (authoritative order count, CPA denominator).
   *  Sourced from SUM(meta_purchases) in expenses where sku matches. */
  total_orders:        number;
  /** ERP-internal confirmed order count for this product.
   *  Used for pixel efficiency: erp_orders / total_orders × 100. */
  erp_orders?:         number;
  /** Sum of ProductPrice for delivered orders. */
  delivered_revenue:   number;
  /** Sum of Meta-synced expense rows whose sku matches this product. */
  attributed_ad_spend: number;
  /** cost_price × units_delivered */
  cogs:                number;
  /** Exact per-AWB Bosta shipping (Σ orders.actual_shipping_fee) for delivered
   *  orders — the real shipping cost folded into this product's margin. */
  shipping_cost?:      number;
  /** delivered_revenue − cogs − attributed_ad_spend − shipping_cost */
  net_profit:          number;
  /** attributed_ad_spend / total_orders  (null when no Meta orders) */
  cpa:                 number | null;
  /** Meta-reported purchase conversions (same as total_orders — kept for compat). */
  meta_orders:         number;
}

/**
 * Fetch per-product profitability metrics for the given date range.
 * Matches orders and ad spend via product SKU.  Admin only.
 */
export const getProductsProfitability = (startDate?: string, endDate?: string, product?: string) =>
  api.get<ProductProfitability[]>(
    `/api/analytics/products-profitability${buildAnalyticsQS(startDate, endDate, product)}`
  );

/* ── Delivered Orders (detailed list, grouped by delivery day) ──────────── */
export interface DeliveredOrderRow {
  id:           number;
  name:         string;
  phone:        string;
  product:      string;
  /** Egypt-local delivery datetime, 'YYYY-MM-DD HH:MM'. */
  delivered_at: string;
  /** Order value (ProductPrice) in EGP. */
  value:        number;
}
export interface DeliveredDay {
  date:        string;   // YYYY-MM-DD (Egypt-local delivery day)
  count:       number;
  day_revenue: number;
  orders:      DeliveredOrderRow[];
}
export interface DeliveredOrdersResponse {
  total: number;
  days:  DeliveredDay[];
}

/**
 * Fetch the detailed list of DELIVERED orders, grouped by actual delivery day
 * (delivered_at), optionally scoped to a product. Admin + Media Buyer.
 */
export const getDeliveredOrders = (startDate?: string, endDate?: string, product?: string) =>
  api.get<DeliveredOrdersResponse>(
    `/api/analytics/delivered-orders${buildAnalyticsQS(startDate, endDate, product)}`
  );

/**
 * Fetch the requesting user's own performance for the given date range.
 * Available to all authenticated users.
 */
export const getMyPerformance = (startDate?: string, endDate?: string) =>
  api.get<AgentAnalytics>(`/api/analytics/my-performance${buildAnalyticsQS(startDate, endDate)}`);

/* ── Accounting / Financial Overview ────────────────────────────── */
export interface AccountingOverview {
  /** Sum of all collected deposit amounts across every order (cash in hand). */
  total_deposits:         number;
  /** Number of orders that have a deposit > 0. */
  count_with_deposit:     number;
  /** Net COD (price − deposit) for orders in status 'تم التوصيل'.
   *  Cash the courier collected but hasn't remitted yet. */
  bosta_receivables:      number;
  /** Number of delivered orders contributing to bosta_receivables. */
  count_delivered:        number;
  /** Net COD for orders in status 'تم الشحن' — still with couriers. */
  cash_in_transit:        number;
  /** Number of in-transit orders contributing to cash_in_transit. */
  count_in_transit:       number;
  /** Gross product price sum for all delivered orders (top-line revenue). */
  total_sales_delivered:  number;
  /** Net COD for confirmed orders not yet dispatched to Bosta. */
  confirmed_pending_ship: number;
  /** Number of confirmed-but-not-shipped orders. */
  count_confirmed:        number;
  /** Sum of all logged operational expenses. */
  total_expenses:         number;
}

/** Fetch financial overview aggregates. Admin only. */
export const getAccountingOverview = () =>
  api.get<AccountingOverview>('/api/accounting/overview');

/* ── Expenses ────────────────────────────────────────────────────── */
export interface Expense {
  id:           number;
  amount:       number | string;   // pg NUMERIC → string; use parseFloat()
  category:     string;
  description:  string | null;
  expense_date: string;            // YYYY-MM-DD
  created_at:   string;
}

export interface ExpensePayload {
  amount:        number;
  category:      string;
  description?:  string;
  expense_date?: string;           // YYYY-MM-DD; defaults to today on server
}

/** Fetch all logged expenses (newest first). Admin only. */
export const getExpenses = () =>
  api.get<Expense[]>('/api/accounting/expenses');

/** Log a new expense entry. Admin only. */
export const addExpense = (data: ExpensePayload) =>
  api.post<Expense>('/api/accounting/expenses', data);

/* ── Meta Ads Integration ────────────────────────────────────────── */

export interface MetaConfig {
  /** Ad Account ID without the "act_" prefix. */
  adAccountId:  string;
  /** Partially masked token for safe display (first 6 + ••• + last 4). */
  tokenPreview: string;
  /** True when both adAccountId and accessToken are saved in settings. */
  isConfigured: boolean;
  /** Length of the stored token (so the UI can show "token configured"). */
  tokenLength:  number;
}

export interface MetaConfigPayload {
  adAccountId:  string;
  accessToken:  string;
}

export interface MetaSyncResult {
  message:              string;
  startDate:            string;   // YYYY-MM-DD
  endDate:              string;   // YYYY-MM-DD
  totalSpend:           number;   // sum of all inserted spend values
  daysInserted:         number;   // unique dates with at least one inserted row
  daysReceived:         number;   // unique dates returned by Meta API
  campaignRowsInserted: number;   // total campaign-day rows written to DB
  synced_at:            string;   // ISO timestamp
}

/** Fetch currently saved Meta credentials (token is masked). Admin only. */
export const getMetaConfig = () =>
  api.get<MetaConfig>('/api/meta/config');

/** Save (upsert) Meta ad account credentials. Admin only. */
export const saveMetaConfig = (data: MetaConfigPayload) =>
  api.post<{ message: string; adAccountId: string; tokenLength: number }>('/api/meta/config', data);

/**
 * Sync Meta Ads spend for a custom date range into the expenses table.
 * Both dates are YYYY-MM-DD. If omitted, the server defaults both to today.
 * Admin only.
 */
export const syncMetaSpend = (startDate?: string, endDate?: string) =>
  api.post<MetaSyncResult>('/api/meta/sync', { startDate, endDate });

/* ── Multi-account Meta integration (agency mode) ────────────────────────── */

/** One Meta ad account row. Token is never exposed — only a masked preview. */
export interface MetaAccount {
  id:                  number;
  account_name:        string;
  ad_account_id:       string;   // without the "act_" prefix
  token_preview:       string;   // first 6 + ••• + last 4
  token_length:        number;
  assigned_user_id:    number | null;
  assigned_user_name:  string | null;
  assigned_user_email: string | null;
  is_active:           boolean;
  created_at:          string;
  updated_at:          string;
}

export interface CreateMetaAccountPayload {
  account_name:      string;
  ad_account_id:     string;          // numeric, no act_ prefix
  access_token:      string;
  assigned_user_id?: number | null;   // null/omit = admin / unassigned
}

export interface UpdateMetaAccountPayload {
  account_name?:     string;
  ad_account_id?:    string;
  access_token?:     string;          // omit/empty = keep existing token
  assigned_user_id?: number | null;
  is_active?:        boolean;
}

/** List all Meta ad accounts (masked tokens). Admin only. */
export const getMetaAccounts = () =>
  api.get<MetaAccount[]>('/api/meta/accounts');

/** Add a new Meta ad account. Admin only. */
export const createMetaAccount = (data: CreateMetaAccountPayload) =>
  api.post<{ message: string; id: number }>('/api/meta/accounts', data);

/** Update a Meta ad account (assign to a media buyer, toggle active, etc). Admin only. */
export const updateMetaAccount = (id: number, data: UpdateMetaAccountPayload) =>
  api.patch<{ message: string }>(`/api/meta/accounts/${id}`, data);

/** Delete a Meta ad account. Admin only. */
export const deleteMetaAccount = (id: number) =>
  api.delete<{ message: string }>(`/api/meta/accounts/${id}`);

/* ── Bosta Shipping Integration ──────────────────────────────────── */

/**
 * Shape returned by GET /api/shipping/settings/bosta.
 * Credentials are partially masked (first N chars + ****) so the UI can
 * confirm a value is configured without exposing the full secret.
 */
export interface BostaSettings {
  provider_name:    string;
  /** true when at least one row exists in shipping_settings for 'bosta' */
  configured:       boolean;
  is_active:        boolean;
  updated_at?:      string;
  /** Masked: first 6 chars + 20 stars. null when not set. */
  api_key?:         string | null;
  /** Masked: first 10 chars + 20 stars. null when not set. */
  bearer_token?:    string | null;
  /** Masked: first 4 chars + 12 stars. null when not set. */
  webhook_secret?:  string | null;
  /** Login email for dashboard auto-login — returned in full (not secret). */
  email?:           string | null;
  /** true when a login password is stored (the password itself is never returned). */
  password_set?:    boolean;
}

export interface BostaSettingsPayload {
  provider_name:    string;
  /** Pass '' to keep the existing value; pass a new value to update. */
  api_key?:         string;
  bearer_token?:    string;
  webhook_secret?:  string;
  /** Dashboard login email — powers auto-refresh of the bearer token. */
  email?:           string;
  /** Dashboard login password — stored to auto-refresh the bearer token. */
  password?:        string;
  is_active?:       boolean;
}

/** Fetch current Bosta credentials (masked). Admin only. */
export const getBostaSettings = () =>
  api.get<BostaSettings>('/api/shipping/settings/bosta');

/** Save (upsert) Bosta credentials. Admin only. */
export const saveBostaSettings = (data: BostaSettingsPayload) =>
  api.post<{ provider_name: string; is_active: boolean; updated_at: string }>(
    '/api/shipping/settings',
    data,
  );

/* ── EasyOrder integration (per-tenant) ──────────────────────────── */
export interface EasyorderSettings {
  business_id:    number;
  connected:      boolean;
  api_token:      string | null;   // masked (first 6 chars + stars), null when unset
  webhook_secret: string;          // shown in full so it can be pasted into EasyOrder
  webhook_url:    string;          // the unique URL the tenant pastes into EasyOrder
}

export interface EasyorderSettingsPayload {
  api_token?:         string;      // pass a new token to save; '' keeps existing
  regenerate_secret?: boolean;     // true → rotate the webhook secret
}

/** Get the tenant's EasyOrder settings (generates a webhook secret on first call). Admin only. */
export const getEasyorderSettings = () =>
  api.get<EasyorderSettings>('/api/integrations/easyorder');

/** Save the tenant's EasyOrder API token (and optionally rotate the secret). Admin only. */
export const saveEasyorderSettings = (data: EasyorderSettingsPayload) =>
  api.post<EasyorderSettings & { message: string }>('/api/integrations/easyorder', data);

/* ── Treasury ────────────────────────────────────────────────────── */
export interface TreasuryTransaction {
  id:               number;
  order_id:         number | null;
  amount:           number;
  type:             'revenue' | 'expense' | string;
  source:           string;
  description:      string | null;
  transaction_date: string;   // YYYY-MM-DD
  created_at:       string;   // ISO timestamp
}

export interface TreasurySummary {
  /* ── Totals ─────────────────────────────────────────────────── */
  total_revenue:      number;
  total_expenses:     number;
  net_balance:        number;
  /** النقد الفعلي للشركة — Current Total Balance (net cash in the vault):
   *  Σ opening balances + all incomes − all expenses/payouts. */
  current_total_balance: number;
  /** Σ of all OPENING_BALANCE (seed-capital) entries. */
  opening_balance:    number;
  count:              number;
  /* ── Revenue sub-breakdown ────────────────────────────────── */
  bosta_cod_revenue:  number;   // COD collected via Bosta webhook
  deposits_revenue:   number;   // العربونات logged via order-hook
  /* ── Expense sub-breakdown ────────────────────────────────── */
  total_commissions:  number;   // staff commission expenses (all comm_* sources)
  /* ── Live from orders table (pre-hook history) ────────────── */
  deposits_live:         number;   // SUM(depositAmount) across all orders
  count_with_deposit:    number;   // orders with depositAmount > 0
  /** Net COD for orders in 'تم الشحن' — cash still with couriers.
   *  NOT included in net_balance (unrealised). */
  pending_bosta_cash: number;
}

/* ── Commissions breakdown ───────────────────────────────────────────── */
export interface CommissionBreakdownAgent {
  agent_email:    string;
  total:          number;
  comm_confirmed: number;
  comm_delivered: number;
  comm_rejected:  number;
  comm_no_answer: number;
}

export interface CommissionBreakdownDay {
  date:       string;   // YYYY-MM-DD
  date_total: number;
  agents:     CommissionBreakdownAgent[];
}

/** Fetch commission expense entries grouped by date → agent. Admin only. */
export const getCommissionsBreakdown = () =>
  api.get<CommissionBreakdownDay[]>('/api/treasury/commissions-breakdown');

/* ── Manual treasury entry ───────────────────────────────────────────── */

/** Known manual-entry categories (mirrors MANUAL_CATEGORIES in
 *  backend/src/routes/treasury.js). The category code is stored in `source`
 *  and dictates whether the entry is income (revenue) or expense — the server
 *  derives the sign, so the client need only send the code. */
export const MANUAL_CATEGORIES: Record<
  string,
  { type: 'revenue' | 'expense'; label: string }
> = {
  OPENING_BALANCE:               { type: 'revenue', label: 'رصيد افتتاحي'     },
  AD_SPEND:                      { type: 'expense', label: 'مصاريف إعلانات'   },
  PACKAGING_COST:                { type: 'expense', label: 'تغليف'            },
  SHIPPING_PACKAGE_SUBSCRIPTION: { type: 'expense', label: 'باقة شحن'         },
  OPERATIONAL_EXPENSE:           { type: 'expense', label: 'مصروفات تشغيلية'  },
};
export type ManualCategory = keyof typeof MANUAL_CATEGORIES;

export interface AddTreasuryEntryPayload {
  amount:             number;
  /** Optional for known categories (server derives it); required for custom. */
  type?:              'revenue' | 'expense';
  source:             string;
  description?:       string;
  transaction_date?:  string;   // YYYY-MM-DD; defaults to today on server
}

/** Manually add a revenue or expense entry (order_id = NULL). Admin only. */
export const addTreasuryEntry = (data: AddTreasuryEntryPayload) =>
  api.post<TreasuryTransaction>('/api/treasury', data);

/** Fetch all treasury transactions + pre-computed summary. Admin only. */
export const getTreasury = () =>
  api.get<{ summary: TreasurySummary; transactions: TreasuryTransaction[] }>('/api/treasury');

/** Download bulk Air Waybill PDF for a list of order IDs. Admin only.
 *  Returns a Blob (application/pdf) or, if Bosta returns a URL, a JSON blob. */
export const getBulkAwb = (orderIds: number[]) =>
  api.get<Blob>('/api/shipping/bulk-awb', {
    params:       { ids: orderIds.join(',') },
    responseType: 'blob',
  });

/* ── Live Bosta wallet (business dashboard API) ──────────────────────────── */
export interface BostaWalletTransaction {
  id:          string;
  date:        string | null;
  amount:      number;
  type:        string;
  description: string;
  status:      string;
}

export interface BostaWallet {
  balance:         number | null;
  currency:        string;
  source_endpoint: string | null;
  transactions:    BostaWalletTransaction[];
}

/** Fetch the live Bosta wallet balance + recent transactions. Admin only. */
export const getBostaWallet = () =>
  api.get<BostaWallet>('/api/bosta/wallet');

/* ── Bosta follow-ups (orders needing attention / being returned) ────────── */
export interface BostaFollowUpOrder {
  trackingNumber: string;
  status:         string;
  customer:       string;
  phone:          string;
  cod:            number;
  city:           string;
  updatedAt:      string | null;
  /** Local order id (null when no matching order in our DB). */
  order_id:            number | null;
  /** Merchant follow-up note saved locally. */
  return_note:         string;
  /** Fee charged for the return leg (drives a treasury revenue entry). */
  return_shipping_fee: number;
}

export interface BostaFollowUps {
  action_required: BostaFollowUpOrder[];
  returning:       BostaFollowUpOrder[];
  counts:          { action_required: number; returning: number };
}

/** Fetch Bosta shipments needing action + parcels being returned. Admin only. */
export const getBostaFollowUps = () =>
  api.get<BostaFollowUps>('/api/bosta/follow-ups');

export interface FollowUpActionResult {
  message:             string;
  trackingNumber:      string;
  order_id:            number;
  return_note:         string;
  return_shipping_fee: number;
}

/**
 * Save a follow-up action (note + return shipping fee) against the local order
 * matching a Bosta tracking number. A non-zero fee posts a treasury revenue
 * entry; zeroing it removes that entry. Admin only.
 */
export const saveFollowUpAction = (
  trackingNumber: string,
  data: { return_note?: string; return_shipping_fee?: number },
) =>
  api.patch<FollowUpActionResult>(
    `/api/bosta/follow-ups/${encodeURIComponent(trackingNumber)}`,
    data,
  );

/* ── External Affiliate Network credentials (affiliate plan exclusive) ─────── */
export type AffiliateNetworkId = 'taager' | 'safqa';

export interface AffiliateNetworkSetting {
  /** True once a merchant id or token is saved for this network. */
  configured:    boolean;
  /** Per-tenant API endpoint URL (not secret — full value to prefill). '' when unset. */
  api_url:       string;
  /** Merchant ID (not secret — full value to prefill). '' when unset. */
  merchant_id:   string;
  /** Masked token preview (first 4 chars + bullets). null when not set. */
  token_preview: string | null;
}

export interface AffiliateSettings {
  taager: AffiliateNetworkSetting;
  safqa:  AffiliateNetworkSetting;
}

export interface AffiliateSettingsPayload {
  /** Omit or send '' to keep the existing value untouched. */
  taager_api_url?:     string;
  taager_merchant_id?: string;
  taager_api_token?:   string;
  safqa_api_url?:      string;
  safqa_merchant_id?:  string;
  safqa_api_token?:    string;
}

/** Fetch saved Taager / Safqa config (token masked). Admin + affiliate plan only. */
export const getAffiliateSettings = () =>
  api.get<AffiliateSettings>('/api/affiliate/settings');

/** Save (upsert) Taager / Safqa config. Admin + affiliate plan only. */
export const saveAffiliateSettings = (data: AffiliateSettingsPayload) =>
  api.post<{ message: string; saved: string[] }>('/api/affiliate/settings', data);

/** Disconnect a network — wipes its URL + Merchant ID + Token. Admin + affiliate plan only. */
export const disconnectAffiliate = (network: AffiliateNetworkId) =>
  api.post<{ message: string; network: string; removed: number }>(
    '/api/affiliate/disconnect',
    { network },
  );

export interface TaagerSyncResult {
  message:          string;
  fetched:          number;   // raw orders pulled from Taager
  upserted:         number;   // orders written/updated in our DB
  productsCreated:  number;   // new product stubs created during order sync
  skipped:          number;   // orders with no usable id
  /* Product-catalog backfill (best-effort; 0 if the catalog endpoint failed). */
  productsFetched?:  number;  // products pulled from Taager's catalog
  productsUpserted?: number;  // catalog rows enriched (cost / price / image)
  productsSkipped?:  number;  // catalog rows with no usable SKU
}

/** Deep-sync the tenant's Taager orders into the internal DB. Admin + affiliate plan only.
 *  Uses the authenticated `api` instance (JWT auto-attached via the request interceptor).
 *  Generous timeout — a full sync paginates Taager + writes many rows in a transaction. */
export const syncTaagerOrders = () =>
  api.post<TaagerSyncResult>('/api/affiliate/taager/sync', undefined, {
    timeout: 120_000, // 2 min — overrides the instance default for this long-running op
  });

export default api;
