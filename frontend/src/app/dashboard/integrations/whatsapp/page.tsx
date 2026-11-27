'use client';

/* «الربط مع واتساب» — the owner connects the business WhatsApp number (official
   Meta WhatsApp Cloud API) in three steps: paste the keys, send a test message to
   his own phone, wire the webhook so delivery ticks and replies come back.
   Nothing on this page messages a customer. The saved token / app secret never
   come back to the browser — only "saved ✓ …last 4". */

import { useCallback, useEffect, useState } from 'react';
import {
  getWhatsAppSettings,
  saveWhatsAppSettings,
  checkWhatsApp,
  sendWhatsAppTest,
  getWhatsAppAccountLink,
  linkWhatsAppAccount,
  getWhatsAppTemplates,
  getWhatsAppAuto,
  saveWhatsAppAuto,
  getWhatsAppRecontact,
  sendWhatsAppRecontact,
  type WhatsAppRecontactKind,
  getWhatsAppTrial,
  type WhatsAppTrialReport,
  type WhatsAppTrialGroup,
  type WhatsAppRecontactPreview,
  type WhatsAppAutoMode,
  type WhatsAppAutoResponse,
  type WhatsAppFlowRow,
  submitWhatsAppTemplate,
  type WhatsAppTemplate,
  type WhatsAppTemplatesResponse,
  type WhatsAppAccountLink,
  type WhatsAppMessage,
  type WhatsAppSettingsResponse,
} from '@/lib/api';
import { serverNow } from '@/lib/serverClock';
import WhatsAppMedia from '@/components/WhatsAppMedia';

type Toast = { message: string; type: 'success' | 'error' } | null;

const errMsg = (e: unknown, fallback: string) => {
  const err = e as { response?: { status?: number; data?: { error?: string } } };
  if (err?.response?.status === 403) return 'الصفحة دي للمدير بس';
  return err?.response?.data?.error || fallback;
};

const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('ar-EG-u-nu-latn', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
};

/* "من 5 دقايق" — on the SERVER's clock, so a wrong phone clock can't lie. */
const fmtAgo = (iso: string | null) => {
  if (!iso) return '';
  const mins = Math.floor((serverNow() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'دلوقتي';
  if (mins === 1) return 'من دقيقة';
  if (mins < 60) return `من ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return 'من ساعة';
  if (hours < 24) return `من ${hours} ساعة`;
  return fmtDate(iso);
};

/* "2010…" → "010…" — how the team reads numbers */
const localPhone = (p: string) => (/^201[0125]\d{8}$/.test(p) ? `0${p.slice(2)}` : p);

const QUALITY: Record<string, { label: string; cls: string }> = {
  GREEN:  { label: 'عالية',  cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  YELLOW: { label: 'متوسطة', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  RED:    { label: 'ضعيفة',  cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
};

const STATUS: Record<string, { label: string; cls: string }> = {
  sending:   { label: 'بتتبعت…',   cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  sent:      { label: 'اتبعتت ✓',  cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  delivered: { label: 'وصلت ✓✓',   cls: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
  read:      { label: 'اتقرت ✓✓',  cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  failed:    { label: 'موصلتش ✗', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  received:  { label: 'من العميل', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
};

const KIND: Record<string, string> = {
  test: 'رسالة تجربة', confirm: 'تأكيد أوردر', reminder: 'تذكير',
  button: 'داس على زرار', text: 'كتب رسالة', reaction: 'تفاعل', other: 'بعت حاجة',
};

const inputCls = `w-full min-w-0 px-3 py-2 rounded-xl text-sm outline-none bg-white dark:bg-slate-800
  border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100
  focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-60`;
const primaryBtn = `inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
  bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors`;
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 sm:p-6 space-y-4 shadow-sm';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the field is selectable as a fallback */ }
  };
  return (
    <button type="button" onClick={copy}
      className="shrink-0 px-3 py-2 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors">
      {copied ? 'اتنسخ ✓' : 'نسخ'}
    </button>
  );
}

function StepTitle({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-bold
        ${done ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
        {done ? '✓' : n}
      </span>
      <h2 className="text-base font-bold text-slate-900 dark:text-white">{title}</h2>
    </div>
  );
}

/* Meta's menu path, kept left-to-right with "→" — inside Arabic text a bare
   "WhatsApp ← API Setup" gets reordered and its arrow points the wrong way. */
const Path = ({ children }: { children: string }) => (
  <bdi dir="ltr" className="font-medium text-slate-600 dark:text-slate-300">{children}</bdi>
);

function Field({ label, saved, help, children }: {
  label: string; saved?: string | null; help?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 mb-1">
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</label>
        {saved && (
          <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            متحفظ ✓ آخره <bdi dir="ltr" className="font-mono">{saved}</bdi> — سيبه فاضي لو مش هتغيّره
          </span>
        )}
      </div>
      {children}
      {help && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{help}</p>}
    </div>
  );
}

/* What Meta says about a template, in the owner's words. */
const TEMPLATE_STATUS: Record<string, { label: string; cls: string }> = {
  APPROVED: { label: 'متوافق عليه ✓', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  PENDING:  { label: 'ميتا بتراجعه…', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  REJECTED: { label: 'مرفوض ✗', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  PAUSED:   { label: 'موقوف مؤقتًا', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  DISABLED: { label: 'متعطّل', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
};
const NOT_SENT = { label: 'لسه متبعتش لميتا', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' };

function TemplateCard({ t, busy, canSubmit, onSubmit }: {
  t: WhatsAppTemplate; busy: boolean; canSubmit: boolean; onSubmit: () => void;
}) {
  const st = t.meta ? (TEMPLATE_STATUS[t.meta.status ?? ''] ?? { label: t.meta.status ?? '—', cls: NOT_SENT.cls }) : NOT_SENT;
  const marketing = t.meta?.category && t.meta.category !== 'UTILITY';
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-900 dark:text-white">{t.title}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{t.when}</div>
        </div>
        <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${st.cls}`}>{st.label}</span>
      </div>
      {/* the message as the customer reads it (example values) */}
      <div className="rounded-2xl rounded-tr-sm bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50 p-3 max-w-md">
        <p dir="rtl" className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap leading-relaxed break-words">{t.preview}</p>
        <div className="mt-3 pt-2 border-t border-emerald-200/70 dark:border-emerald-900/60 flex flex-col gap-1.5">
          {t.buttons.map((b) => (
            <span key={b} className="text-center text-sm font-semibold text-sky-700 dark:text-sky-300 bg-white dark:bg-slate-900
              rounded-lg py-1.5 border border-slate-200 dark:border-slate-700">{b}</span>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-slate-400">الاسم والمنتج والمبلغ والعنوان اللي فوق مثال — بيتبدّلوا ببيانات كل أوردر.</p>
      {marketing && (
        <p className="text-xs font-semibold text-red-600 dark:text-red-400 leading-relaxed">
          ميتا صنّفت القالب ده «تسويق» مش «خدمة»، وده سعره أغلى — متستخدموش قبل ما نراجعه.
        </p>
      )}
      {t.meta?.rejected_reason && (
        <p className="text-xs text-red-600 dark:text-red-400">سبب الرفض من ميتا: <bdi dir="ltr">{t.meta.rejected_reason}</bdi></p>
      )}
      {!t.meta && (
        <button type="button" onClick={onSubmit} disabled={busy || !canSubmit} className={`w-full sm:w-auto ${primaryBtn}`}>
          {busy ? 'بيتبعت…' : 'ابعت لميتا للمراجعة'}
        </button>
      )}
    </div>
  );
}

/* What happened to one order in the WhatsApp flow, in the owner's words. */
const RELEASE_REASON: Record<string, string> = {
  timeout:      'مردّش في نص ساعة — نزل للبنات',
  no_whatsapp:  'الرقم مالوش واتساب — نزل للبنات',
  undelivered:  'الرسالة موصلتش — نزل للبنات',
  send_failed:  'الرسالة متبعتتش — نزل للبنات',
  deposit:      'أكد، بس محتاج عربون — نزل للبنات',
  cancel:       'عايز يلغي — نزل للبنات',
  support:      'طلب الدعم — نزل للبنات',
  late:         'الإرسال اتأخر — نزل للبنات من غير رسالة',
  switched_off: 'التشغيل اتقفل — نزل للبنات',
  moved:        'اتغيّرت حالته قبل الإرسال',
  no_amount:    'مفيش مبلغ في الأوردر — نزل للبنات',
  no_product:   'مفيش منتج في الأوردر — نزل للبنات',
  stuck:        'الإرسال وقف — نزل للبنات',
  watchdog:     'اتأخر في الحجز — نزل للبنات',
  enroll_failed: 'متسجّلش — نزل للبنات',
  reconfirm:    'أكد بعد ما طلب دعم أو إلغاء — نزل للبنات',
  dup:          'أكد، وعنده أوردر تاني — نزل للبنات',
  address:      'أكد، والعنوان ناقص — نزل للبنات',
  lost:         'أكد على طلب مفقود — نزل للبنات',
};
/* the same reasons for an old «لا يرد» order — it stays where it was */
const RECONTACT_REASON: Record<string, string> = {
  moved:        'موظفة خلّصته قبل الإرسال — متبعتلوش',
  send_failed:  'الرسالة متبعتتش',
  late:         'الإرسال اتأخر — متبعتلوش',
  stuck:        'الإرسال وقف — متبعتلوش',
  switched_off: 'التشغيل اتقفل — متبعتلوش',
  no_amount:    'مفيش مبلغ في الأوردر — متبعتلوش',
  no_product:   'مفيش منتج في الأوردر — متبعتلوش',
};
const fmtClock = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo' });
};
function flowLabel(f: WhatsAppFlowRow): { text: string; cls: string } {
  const grey  = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  const amber = 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  const green = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  if (f.outcome === 'confirmed') return { text: 'العميل أكد على واتساب ✓', cls: green };
  if (f.state === 'pending') return { text: `الرسالة هتتبعت ${fmtClock(f.send_at)}`, cls: grey };
  if (f.state === 'sending') return { text: 'بتتبعت…', cls: grey };
  /* an old «لا يرد» order: it never left its agent, so nothing "went down to the girls" */
  if (f.kind === 'recontact') {
    if (f.release_reason === 'recontact') return { text: f.customer_replied ? 'اتبعتله — العميل رد' : 'اتبعتله — مستنيين رده', cls: f.customer_replied ? amber : grey };
    return { text: RECONTACT_REASON[f.release_reason ?? ''] ?? 'متبعتلوش', cls: amber };
  }
  if (f.state === 'waiting') return { text: `اتبعتت — محجوز لحد ${fmtClock(f.hold_until)}`, cls: 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300' };
  return { text: RELEASE_REASON[f.release_reason ?? ''] ?? 'نزل للبنات', cls: amber };
}

function FlowRow({ f, tags }: { f: WhatsAppFlowRow; tags: Record<string, string> }) {
  const st = flowLabel(f);
  return (
    <li className="py-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-bold text-slate-900 dark:text-white">أوردر #{f.order_id}</span>
        <bdi dir="ltr" className="font-mono text-xs text-slate-500 dark:text-slate-400">{localPhone(f.phone)}</bdi>
        {f.is_test && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">تجربة</span>}
        {f.kind === 'recontact' && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">لا يرد قديم</span>}
        <span className="text-[11px] text-slate-400 mr-auto">{fmtAgo(f.created_at)}</span>
      </div>
      {f.product && <p className="text-xs text-slate-500 dark:text-slate-400 break-words">{f.product}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.text}</span>
        {f.tag && tags[f.tag] && (
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">{tags[f.tag]}</span>
        )}
        {f.order_status && <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">الحالة دلوقتي: {f.order_status}</span>}
        {f.holder && <span className="text-[11px] text-violet-600 dark:text-violet-400">مع {f.holder.split('@')[0]}</span>}
        {f.messages_sent > 1 && <span className="text-[11px] text-slate-400">{f.messages_sent} رسايل</span>}
      </div>
      {f.customer_text && <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">العميل كتب: «{f.customer_text}»</p>}
      {f.customer_text && /\[(audio|image|video|document|sticker)\]/.test(f.customer_text) && <WhatsAppMedia orderId={f.order_id} />}
      {f.last_error && <p className="text-xs text-red-600 dark:text-red-400 break-words" dir="ltr">{f.last_error}</p>}
    </li>
  );
}

/* ── the half-and-half trial: WhatsApp half vs agents-only half ─────────────── */
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');

function TrialCard({ trial, onRefresh, busy }: { trial: WhatsAppTrialReport; onRefresh: () => void; busy: boolean }) {
  const wa = trial.wa as WhatsAppTrialGroup;
  const ag = trial.control as WhatsAppTrialGroup;
  const rows: [string, (g: WhatsAppTrialGroup) => string, string?][] = [
    ['الأوردرات', (g) => String(g.orders)],
    ['اتأكد', (g) => `${g.confirmed} (${pct(g.confirmed, g.orders)})`],
    ['منهم بالواتساب من غير مكالمة', (g) => String(g.wa_confirmed)],
    ['اترفض', (g) => `${g.rejected} (${pct(g.rejected, g.orders)})`],
    ['لا يرد', (g) => `${g.no_answer} (${pct(g.no_answer, g.orders)})`],
    ['لسه مفتوح', (g) => String(g.open)],
    ['اتشحن', (g) => String(g.shipped)],
    ['في الطريق', (g) => String(g.in_transit)],
    ['اتسلّم', (g) => String(g.delivered)],
    ['رجع', (g) => String(g.returned)],
    ['التسليم من اللي خلص (اتسلّم ÷ اتسلّم + رجع)', (g) => pct(g.delivered, g.delivered + g.returned), 'font-bold'],
    ['اتسلّم من كل الأوردرات', (g) => pct(g.delivered, g.orders), 'font-bold'],
  ];
  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">مقارنة التجربة: واتساب قصاد البنات</h2>
        <button type="button" onClick={onRefresh} disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700
            text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
          {busy ? '…' : 'تحديث'}
        </button>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
        أوردرات المتجر من {fmtDate(trial.since ?? null)}{trial.until ? ` لحد ${fmtDate(trial.until)}` : ' لحد دلوقتي'}.
        العميل اللي آخر رقم في موبايله 8 أو 9 مع البنات زي ما هو (حوالي 20%)، والباقي في مجموعة الواتساب.
        الحكم على آخر سطرين، ومبيبقاش نهائي غير لما الشحنات توصل (4–5 أيام). فرق أقل من 6 نقط ممكن يكون صدفة.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 dark:text-slate-400">
              <th className="text-start font-medium py-1.5"></th>
              <th className="text-start font-semibold py-1.5 text-emerald-700 dark:text-emerald-300">مجموعة الواتساب (80%)</th>
              <th className="text-start font-semibold py-1.5">مجموعة البنات (20%)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map(([label, f, cls]) => (
              <tr key={label}>
                <td className="py-1.5 pe-2 text-slate-600 dark:text-slate-300">{label}</td>
                <td className={`py-1.5 tabular-nums text-slate-900 dark:text-white ${cls ?? ''}`}>{f(wa)}</td>
                <td className={`py-1.5 tabular-nums text-slate-900 dark:text-white ${cls ?? ''}`}>{f(ag)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!trial.no_mobile && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{trial.no_mobile} أوردر رقمهم مش موبايل مصري واضح — مش محسوبين في أي مجموعة.</p>
      )}
    </div>
  );
}

/* ── 6: one message to the OLD «لا يرد» orders ───────────────────────────────
   Count first, then the owner's own click sends. The order never moves: it
   stays «لا يرد» with its agent until the customer taps. */
const shiftDay = (day: string, by: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};
const fmtDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const SKIPPED: [keyof NonNullable<WhatsAppRecontactPreview['skipped']>, string][] = [
  ['other_order',      'ليهم أوردر تاني حد وصلّهم فيه (اتأكد، اترفض، اتأجل…)'],
  ['same_customer',    'نفس العميل طالب مرتين — هنبعتله مرة واحدة'],
  ['already_messaged', 'اتبعتلهم واتساب مننا قبل كده'],
  ['bad_number',       'الرقم مش موبايل مصري واضح'],
  ['no_amount',        'الأوردر مفيهوش مبلغ أو منتج'],
  ['control_group',    'من مجموعة «البنات بس» في التجربة (20%) — رسالة ليهم تبوّظ المقارنة'],
];

function RecontactCard({ ready, stopped, onQueued, showToast }: {
  ready: boolean; stopped: boolean; onQueued: () => void; showToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [info, setInfo]     = useState<WhatsAppRecontactPreview | null>(null);
  const [from, setFrom]     = useState('');
  const [to, setTo]         = useState('');
  const [count, setCount]   = useState('');
  const [busy, setBusy]     = useState<'' | 'count' | 'send'>('');
  const [error, setError]   = useState('');
  const [kind, setKind]     = useState<WhatsAppRecontactKind>('no_answer');
  const [sendNow, setSendNow] = useState(false);
  const kindLabel = kind === 'new' ? 'جديد' : 'لا يرد';
  /* another kind of orders → the old count no longer describes them */
  const pickKind = (k: WhatsAppRecontactKind) => {
    if (k === kind) return;
    setKind(k);
    setCount('');
    setSendNow(false);
    setInfo((old) => (old ? { results: old.results, max_days_back: old.max_days_back, today: old.today } : old));
    if (info?.today) { setFrom(shiftDay(info.today, k === 'new' ? -1 : -6)); setTo(k === 'new' ? info.today : shiftDay(info.today, -1)); }
  };

  const loadResults = useCallback(async () => {
    try {
      const { data: d } = await getWhatsAppRecontact();
      setInfo((old) => (old?.eligible !== undefined ? { ...old, results: d.results } : d));
      setFrom((v) => v || shiftDay(d.today, -6));
      setTo((v) => v || shiftDay(d.today, -1));
    } catch { /* the card still shows its form */ }
  }, []);
  useEffect(() => { if (ready) loadResults(); }, [ready, loadResults]);
  useEffect(() => {                       // answers arrive by themselves while the page is open
    if (!ready) return undefined;
    const t = setInterval(() => { if (!document.hidden) loadResults(); }, 30000);
    return () => clearInterval(t);
  }, [ready, loadResults]);

  const handleCount = async () => {
    setError('');
    setBusy('count');
    try {
      const { data: d } = await getWhatsAppRecontact({ from, to, status: kind });
      setInfo(d);
      setSendNow(false);
      setCount(String(Math.min(kind === 'new' ? 150 : 50, d.can_send ?? 0) || ''));
    } catch (e) {
      setError(errMsg(e, 'تعذّر الحساب'));
    } finally {
      setBusy('');
    }
  };

  const n = parseInt(count, 10) || 0;
  const canSend = info?.can_send ?? 0;
  const waits = !!info?.quiet_until && !sendNow;              // between midnight and 10:00 a batch waits for 10:00
  const handleSend = async () => {
    setError('');
    if (!info?.from || !info?.to || n < 1) return;
    if (!window.confirm(
      `نبعت رسالة تأكيد الطلب على الواتساب لـ ${n} عميل؟\n\n`
      + `• أحدث ${n} أوردر «${kindLabel}» من ${fmtDay(info.from)} لـ ${fmtDay(info.to)}.\n`
      + '• رسالة واحدة لكل عميل، من غير تذكير.\n'
      + `• الأوردر بيفضل «${kindLabel}» مع الموظفة لحد ما العميل يدوس.\n`
      + (waits ? `• الرسايل هتطلع الساعة ${fmtClock(info.quiet_until ?? null)}، مش دلوقتي.\n` : '• الرسايل هتطلع دلوقتي.\n')
      + '• الرسايل دي لعملاء حقيقيين ومينفعش تترجع.')) return;
    setBusy('send');
    try {
      const { data: d } = await sendWhatsAppRecontact({ from: info.from, to: info.to, count: n, status: kind, send_now: sendNow });
      showToast(waits ? `اتجهز ${d.queued} رسالة — هتطلع ${fmtClock(d.first_at)}` : `اتجهز ${d.queued} رسالة — بتتبعت 10 في الدقيقة`, 'success');
      const { data: again } = await getWhatsAppRecontact({ from: info.from, to: info.to, status: kind });
      setInfo(again);
      setCount('');
      onQueued();
    } catch (e) {
      setError(errMsg(e, 'تعذّر الإرسال'));
    } finally {
      setBusy('');
    }
  };

  const r = info?.results;
  const stat = (label: string, value: number, tone = '') => (
    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
      <div className={`text-lg font-bold tabular-nums ${tone || 'text-slate-900 dark:text-white'}`}>{value}</div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight">{label}</div>
    </div>
  );

  return (
    <div className={card}>
      <StepTitle n={6} title="رسالة لأوردرات واقفة" done={(r?.sent ?? 0) > 0} />
      <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
        بنبعت رسالة تأكيد الطلب مرة واحدة لأوردرات موجودة فعلًا. الأوردر بيفضل مع الموظفة زي ما هو،
        ولو العميل داس «تأكيد الطلب» بيبقى «تم التأكيد» باسم «واتساب».
      </p>
      {ready && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {([
            ['no_answer', 'أوردرات «لا يرد»', 'البنات اتصلوا بيهم ومردّوش.'],
            ['new', 'أوردرات «جديد»', 'دخلوا والواتساب مش شغال، ولسه محدش كلمهم.'],
          ] as [WhatsAppRecontactKind, string, string][]).map(([k, title, desc]) => (
            <label key={k} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors
              ${kind === k ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-700 dark:bg-emerald-950/30'
                : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>
              <input type="radio" name="wa-recontact-kind" checked={kind === k} onChange={() => pickKind(k)} className="mt-1 w-4 h-4 accent-emerald-600 shrink-0" />
              <span>
                <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">{desc}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {!ready ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">احفظ المفاتيح واستنى موافقة ميتا على الرسالة الأول.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="من يوم">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" className={inputCls}
                min={info ? shiftDay(info.today, -info.max_days_back) : undefined} max={info?.today} />
            </Field>
            <Field label="لحد يوم">
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" className={inputCls}
                min={info ? shiftDay(info.today, -info.max_days_back) : undefined} max={info?.today} />
            </Field>
          </div>
          <button type="button" onClick={handleCount} disabled={!from || !to || busy !== ''}
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl text-sm font-semibold border border-slate-300 dark:border-slate-700
              text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
            {busy === 'count' ? 'بيحسب…' : 'احسب العدد (مفيش حاجة هتتبعت)'}
          </button>

          {info?.eligible !== undefined && info.cap && (
            <div className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
              <p className="text-sm text-slate-800 dark:text-slate-100 leading-relaxed">
                لقينا <b className="tabular-nums">{info.found}</b> أوردر «{kindLabel}» في الأيام دي، ينفع نبعت لـ{' '}
                <b className="tabular-nums text-emerald-700 dark:text-emerald-300">{info.eligible}</b> عميل منهم.
              </p>
              {!!info.by_day?.length && (
                <div className="flex flex-wrap gap-1.5">
                  {info.by_day.map((d) => (
                    <span key={d.day} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {fmtDay(d.day)}: <b className="tabular-nums">{d.n}</b>
                    </span>
                  ))}
                </div>
              )}
              {info.skipped && SKIPPED.some(([k]) => (info.skipped![k] ?? 0) > 0) && (
                <ul className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed list-disc pr-5 space-y-0.5">
                  {SKIPPED.filter(([k]) => (info.skipped![k] ?? 0) > 0).map(([k, label]) => (
                    <li key={k}><b className="tabular-nums">{info.skipped![k]}</b> مش هيتبعتلهم: {label}</li>
                  ))}
                </ul>
              )}
              {!!info.weak && (
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  منهم <b className="tabular-nums">{info.weak}</b> تقييمهم «ضعيف»: لو أكدوا مش هيتأكدوا لوحدهم، هتظهر للموظفة علامة «محتاج عربون».
                </p>
              )}
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                حد ميتا {info.cap.limit} عميل كل 24 ساعة، وإحنا بنقف عند {info.cap.safe}. اتبعت لـ{' '}
                <b className="tabular-nums">{info.cap.used}</b> في آخر 24 ساعة، فاضل <b className="tabular-nums">{info.cap.room}</b>.
              </p>
              {stopped && (
                <p className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed">التشغيل «متوقف» في الخطوة 5 — اختار «تجربة على أرقام محددة» واحفظ عشان تقدر تبعت.</p>
              )}
              {canSend > 0 ? (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-36">
                    <Field label="هنبعت لكام عميل؟">
                      <input type="number" inputMode="numeric" min={1} max={canSend} value={count} dir="ltr"
                        onChange={(e) => setCount(e.target.value)} className={`${inputCls} font-mono`} />
                    </Field>
                  </div>
                  <button type="button" onClick={handleSend} disabled={stopped || busy !== '' || n < 1 || n > canSend} className={primaryBtn}>
                    {busy === 'send' ? 'بيتجهز…' : `ابعت لـ ${n || '…'} عميل`}
                  </button>
                  <p className="basis-full text-xs text-slate-500 dark:text-slate-400">أقصى عدد دلوقتي {canSend}. بنبدأ بالأحدث، وبتتبعت 10 رسايل في الدقيقة.</p>
                  {info.quiet_until && (
                    <div className="basis-full rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 p-2.5 space-y-1.5">
                      <p className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
                        من 12 بالليل لـ 10 الصبح الدفعات بتستنى: الرسايل دي هتطلع الساعة <b>{fmtClock(info.quiet_until)}</b>.
                      </p>
                      <label className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200 cursor-pointer">
                        <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} className="w-4 h-4 accent-amber-600" />
                        ابعتهم دلوقتي حالًا من غير استنى
                      </label>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400">مفيش حد ينفع نبعتله دلوقتي.</p>
              )}
            </div>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">{error}</p>}

          {r && r.total > 0 && (
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">النتيجة لحد دلوقتي</h3>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {r.queued > 0 && stat('مستنية تتبعت', r.queued)}
                {stat('اتبعتت', r.sent)}
                {stat('وصلت', r.delivered)}
                {stat('اتقرت', r.read)}
                {stat('أكدوا', r.confirmed, 'text-emerald-700 dark:text-emerald-300')}
                {stat('أكد ومحتاج عربون', r.deposit)}
                {stat('طلب دعم أو كتب', r.support)}
                {stat('عايز يلغي', r.cancel)}
                {stat('موصلتش', r.failed + r.not_sent, r.failed + r.not_sent > 0 ? 'text-red-600 dark:text-red-400' : '')}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">تفاصيل كل أوردر في قايمة «الأوردرات اللي دخلت الواتساب» فوق، وعليها علامة «لا يرد قديم».</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MessageRow({ m }: { m: WhatsAppMessage }) {
  const st = STATUS[m.status] ?? STATUS.sent;
  const out = m.direction === 'out';
  return (
    <li className="py-3 flex items-start gap-3">
      <span className={`mt-0.5 w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm
        ${out ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'}`}
        title={out ? 'مننا للعميل' : 'من العميل لينا'}>
        {out ? '↖' : '↘'}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <bdi dir="ltr" className="font-mono text-sm text-slate-800 dark:text-slate-100">{localPhone(m.phone)}</bdi>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {KIND[m.kind] ?? m.kind}{m.template && m.kind !== 'test' ? ` · ${m.template}` : ''}
            {m.order_id ? ` · أوردر #${m.order_id}` : ''}
          </span>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
        </div>
        {!out && m.reply && <p className="text-sm text-slate-700 dark:text-slate-200 break-words">«{m.reply}»</p>}
        {out && m.reply && <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">ردّ العميل: «{m.reply}»</p>}
        {m.status === 'failed' && m.error_text && (
          <p className="text-xs text-red-600 dark:text-red-400 break-words">{m.error_text}</p>
        )}
      </div>
      <span className="shrink-0 text-[11px] text-slate-400 mt-1">{fmtAgo(m.created_at)}</span>
    </li>
  );
}

export default function WhatsAppPage() {
  const [data, setData]         = useState<WhatsAppSettingsResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadErr] = useState('');
  const [toast, setToast]       = useState<Toast>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId]               = useState('');
  const [token, setToken]                 = useState('');
  const [secret, setSecret]               = useState('');
  const [showSecrets, setShowSecrets]     = useState(false);
  const [saving, setSaving]               = useState(false);
  const [formError, setFormErr]           = useState('');

  const [checking, setChecking] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting]     = useState(false);
  const [testError, setTestErr]   = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [link, setLink]         = useState<WhatsAppAccountLink | null>(null);
  const [linking, setLinking]   = useState(false);
  const [tpl, setTpl]           = useState<WhatsAppTemplatesResponse | null>(null);
  const [tplBusy, setTplBusy]   = useState<string | null>(null);
  const [auto, setAuto]         = useState<WhatsAppAutoResponse | null>(null);
  const [autoMode, setAutoMode] = useState<WhatsAppAutoMode>('off');
  const [autoPhones, setAutoPhones] = useState('');
  const [autoHalf, setAutoHalf]     = useState(true);          // «on» = half the customers (the trial) or all of them
  const [trial, setTrial]           = useState<WhatsAppTrialReport | null>(null);
  const [trialBusy, setTrialBusy]   = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoError, setAutoErr] = useState('');

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const applyData = useCallback((d: WhatsAppSettingsResponse) => {
    setData(d);
    setPhoneNumberId(d.settings.phone_number_id ?? '');
    setWabaId(d.settings.waba_id ?? '');
  }, []);

  const load = useCallback(async () => {
    try {
      const { data: d } = await getWhatsAppSettings();
      applyData(d);
      setLoadErr('');
    } catch (e) {
      setLoadErr(errMsg(e, 'تعذّر تحميل الإعدادات'));
    } finally {
      setLoading(false);
    }
  }, [applyData]);

  useEffect(() => { load(); }, [load]);

  /* messages AND connection state (the webhook's «last received»), but never the
     form fields — the owner may be typing in them */
  const refreshMessages = useCallback(async (quiet = true) => {
    if (!quiet) setRefreshing(true);
    try {
      const { data: d } = await getWhatsAppSettings();
      setData(d);
    } catch { /* keep what's on screen */ } finally {
      if (!quiet) setRefreshing(false);
    }
  }, []);

  /* while the page is open and visible, delivery ticks and replies show up by themselves */
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) refreshMessages(true); }, 15000);
    return () => clearInterval(t);
  }, [refreshMessages]);

  const runCheck = async (silentSuccess = false) => {
    setChecking(true);
    try {
      const { data: r } = await checkWhatsApp();
      setData((cur) => (cur ? { ...cur, settings: r.settings } : cur));
      if (!silentSuccess) showToast('الاتصال بميتا شغال ✓', 'success');
      return true;
    } catch (e) {
      const err = e as { response?: { data?: { settings?: WhatsAppSettingsResponse['settings'] } } };
      const s = err?.response?.data?.settings;
      if (s) setData((cur) => (cur ? { ...cur, settings: s } : cur));
      showToast(errMsg(e, 'تعذّر فحص الاتصال'), 'error');
      return false;
    } finally {
      setChecking(false);
    }
  };

  const handleSave = async () => {
    setFormErr('');
    setSaving(true);
    try {
      const { data: d } = await saveWhatsAppSettings({
        phone_number_id: phoneNumberId.trim(),
        waba_id:         wabaId.trim(),
        access_token:    token.trim(),
        app_secret:      secret.trim(),
      });
      applyData(d);
      setToken('');
      setSecret('');
      setShowSecrets(false);
      const ok = await runCheck(true);
      if (ok) showToast('اتحفظ، والاتصال بميتا شغال ✓', 'success');
    } catch (e) {
      setFormErr(errMsg(e, 'تعذّر الحفظ'));
    } finally {
      setSaving(false);
    }
  };

  /* is the WhatsApp account linked to our Meta app? (asked once the keys are saved) */
  const canAskLink = !!data?.settings.configured && !!data?.settings.waba_id;
  useEffect(() => {
    if (!canAskLink) { setLink(null); return; }
    let off = false;
    getWhatsAppAccountLink()
      .then(({ data: d }) => { if (!off) setLink(d); })
      .catch(() => { /* the button below still works */ });
    return () => { off = true; };
  }, [canAskLink, data?.settings.updated_at]);

  /* the automation switch + what happened to each order in the flow */
  const applyAuto = useCallback((d: WhatsAppAutoResponse, withForm: boolean) => {
    setAuto(d);
    if (withForm) {
      setAutoMode(d.auto_mode);
      if (d.auto_mode === 'on') setAutoHalf(d.control_half !== false);
      setAutoPhones(d.test_phones.map((x) => (/^201[0125]\d{8}$/.test(x) ? `0${x.slice(2)}` : x)).join('\n'));
    }
  }, []);
  const loadAuto = useCallback(async (withForm: boolean) => {
    try {
      const { data: d } = await getWhatsAppAuto();
      applyAuto(d, withForm);
    } catch { /* the section shows its own state */ }
  }, [applyAuto]);
  useEffect(() => { loadAuto(true); }, [loadAuto]);
  /* the trial comparison — asked once the flow has ever been live, and on demand (not on the 20 s poll) */
  const loadTrial = useCallback(async () => {
    setTrialBusy(true);
    try { const { data: d } = await getWhatsAppTrial(); setTrial(d); } catch { /* the card just stays as it was */ } finally { setTrialBusy(false); }
  }, []);
  const everLive = !!auto?.live_since;
  useEffect(() => { if (everLive) loadTrial(); }, [everLive, auto?.auto_mode, loadTrial]);
  useEffect(() => {                       // the diary moves by itself while the page is open
    const t = setInterval(() => { if (!document.hidden) loadAuto(false); }, 20000);
    return () => clearInterval(t);
  }, [loadAuto]);

  const handleSaveAuto = async () => {
    setAutoErr('');
    const phones = autoPhones.split(/[\n,،]+/).map((x) => x.trim()).filter(Boolean);
    const going = autoMode === 'test' && auto?.auto_mode === 'off';
    if (going && !window.confirm(`نشغّل وضع التجربة على ${phones.length} رقم؟\n\nأي أوردر جديد من الأرقام دي بس هيتحجز ويتبعتله رسالة واتساب. باقي العملاء مش هيتأثروا.`)) return;
    const goingLive = autoMode === 'on' && (auto?.auto_mode !== 'on' || (auto?.control_half !== false) !== autoHalf);
    if (goingLive && !window.confirm(autoHalf
      ? 'نشغّل الواتساب على 80% من الأوردرات الجديدة؟\n\n'
        + '• العميل اللي آخر رقم في موبايله من 0 لـ 7: أوردره يتحجز ويتبعتله رسالة واتساب.\n'
        + '• العميل اللي آخر رقم 8 أو 9 (حوالي 20%): يروح للبنات زي ما هو، من غير أي رسالة — دول مقياس المقارنة.\n'
        + '• الرسايل دي لعملاء حقيقيين من دلوقتي.\n'
        + '• للإيقاف في أي وقت: اختار «متوقف» واحفظ.'
      : 'نشغّل الواتساب على كل الأوردرات الجديدة؟\n\n'
        + '• كل أوردر جديد هيتحجز ويتبعتله رسالة واتساب الأول.\n'
        + '• مفيش مجموعة مع البنات للمقارنة: مش هنعرف نقيس الواتساب فرق في التسليم قد إيه.\n'
        + '• الرسايل دي لعملاء حقيقيين من دلوقتي.\n'
        + '• للإيقاف في أي وقت: اختار «متوقف» واحفظ.')) return;
    setAutoSaving(true);
    try {
      const { data: d } = await saveWhatsAppAuto({ auto_mode: autoMode, test_phones: phones, split_test: false, control_half: autoMode === 'on' && autoHalf });
      applyAuto(d, true);
      showToast(d.auto_mode === 'off' ? 'التشغيل اتقفل'
        : d.auto_mode === 'on' ? (d.control_half ? 'الواتساب شغال على 80% من الأوردرات ✓' : 'الواتساب شغال على كل الأوردرات ✓') : 'وضع التجربة شغال ✓', 'success');
    } catch (e) {
      setAutoErr(errMsg(e, 'تعذّر الحفظ'));
    } finally {
      setAutoSaving(false);
    }
  };

  /* our message templates + what Meta says about each */
  const loadTemplates = useCallback(async () => {
    try {
      const { data: d } = await getWhatsAppTemplates();
      setTpl(d);
    } catch (e) {
      setTpl({ error: errMsg(e, 'تعذّر تحميل قوالب الرسايل'), templates: [] });
    }
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates, data?.settings.updated_at]);

  const handleSubmitTemplate = async (t: WhatsAppTemplate) => {
    if (!window.confirm(`نبعت «${t.title}» لميتا تراجعها؟\n\nبعد الإرسال النص مش بيتعدّل — لو حبيت تغيّره بعدين بنعمل نسخة جديدة.`)) return;
    setTplBusy(t.key);
    try {
      const { data: d } = await submitWhatsAppTemplate(t.key);
      setTpl(d);
      showToast('اتبعت لميتا ✓ المراجعة بتاخد من دقايق لـ 24 ساعة', 'success');
    } catch (e) {
      showToast(errMsg(e, 'تعذّر إرسال القالب'), 'error');
      loadTemplates();
    } finally {
      setTplBusy(null);
    }
  };

  const handleLink = async () => {
    setLinking(true);
    try {
      const { data: d } = await linkWhatsAppAccount();
      setLink(d);
      showToast(d.linked ? 'حساب الواتساب اتربط بالتطبيق ✓' : 'ميتا مأكدتش الربط — جرّب تاني', d.linked ? 'success' : 'error');
    } catch (e) {
      const msg = errMsg(e, 'تعذّر الربط');
      setLink({ linked: null, app: null, apps: [], error: msg });
      showToast(msg, 'error');
    } finally {
      setLinking(false);
    }
  };

  const handleTest = async () => {
    setTestErr('');
    setTesting(true);
    try {
      await sendWhatsAppTest(testPhone.trim());
      showToast('اتبعتت ✓ بص على الواتساب في التليفون', 'success');
    } catch (e) {
      setTestErr(errMsg(e, 'تعذّر إرسال الرسالة'));
    } finally {
      setTesting(false);
      refreshMessages(true);
    }
  };

  if (loading) {
    return (
      <div className="py-20 text-center">
        <div className="inline-block w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
      </div>
    );
  }
  if (loadError || !data) {
    return <div className="max-w-3xl mx-auto px-4 py-10 text-sm text-red-600 dark:text-red-400" dir="rtl">{loadError || 'تعذّر تحميل الإعدادات'}</div>;
  }

  const s = data.settings;
  const connected = s.configured && !!s.display_phone && !s.last_check_error;
  const webhookWired = !!s.last_webhook_at;
  const quality = s.quality_rating ? QUALITY[s.quality_rating] : null;
  const secretType = showSecrets ? 'text' : 'password';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5" dir="rtl">
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg max-w-[90vw] text-center
          text-white text-sm font-medium ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">الربط مع واتساب</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
          نربط رقم واتساب البيزنس بسكاليو عشان نبعت للعميل رسالة تأكيد الأوردر ونستقبل ردّه — عن طريق واتساب الرسمي من ميتا.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {['مفيش رسايل بتروح للعملاء من الصفحة دي', 'المفاتيح متحفظة على السيرفر بس', 'للمدير بس'].map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
              bg-emerald-50 text-emerald-700 border border-emerald-200
              dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/50">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {t}
            </span>
          ))}
        </div>
      </div>

      {/* Status */}
      <div className={`rounded-2xl border p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between
        ${connected ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800/60 dark:bg-emerald-950/20'
          : s.last_check_error ? 'border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/20'
          : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60'}`}>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500' : s.last_check_error ? 'bg-red-500' : 'bg-slate-400'}`} />
            <span className="font-bold text-slate-900 dark:text-white">
              {connected ? 'متوصل' : s.last_check_error ? 'فيه مشكلة في الاتصال' : s.configured ? 'المفاتيح متحفظة — افحص الاتصال' : 'لسه مش متوصل'}
            </span>
          </div>
          {connected ? (
            <div className="text-sm text-slate-700 dark:text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-1">
              <bdi dir="ltr" className="font-mono">{s.display_phone}</bdi>
              {s.verified_name && <span>«{s.verified_name}»</span>}
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${quality?.cls ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                جودة الرقم: {quality?.label ?? 'لسه متقيّمتش'}
              </span>
            </div>
          ) : s.last_check_error ? (
            <p className="text-sm text-red-700 dark:text-red-300 leading-relaxed">{s.last_check_error}</p>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">اتبع الخطوات اللي تحت — هنعملها مع بعض.</p>
          )}
          {s.last_check_at && <p className="text-[11px] text-slate-400">آخر فحص: {fmtAgo(s.last_check_at)}</p>}
        </div>
        {s.configured && (
          <button type="button" onClick={() => runCheck(false)} disabled={checking}
            className="shrink-0 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-300 dark:border-slate-700
              text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-50">
            {checking ? 'بيفحص…' : 'افحص الاتصال'}
          </button>
        )}
      </div>

      {/* 1 — keys */}
      <div className={card}>
        <StepTitle n={1} title="مفاتيح ميتا" done={s.configured} />
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          هتلاقيهم في صفحة التطبيق على <bdi dir="ltr">developers.facebook.com</bdi>. الزقهم هنا بإيدك ودوس حفظ —
          التوكن والـ App secret بيتحفظوا على السيرفر ومبيرجعوش للصفحة تاني.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Phone number ID" help={<>من <Path>WhatsApp → API Setup</Path>، تحت رقم التليفون</>}>
            <input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} dir="ltr" inputMode="numeric"
              autoComplete="off" placeholder="106540352242922" className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Messaging account ID" help={<>نفس الصفحة — ميتا بتسميه كمان <Path>WhatsApp Business Account ID</Path></>}>
            <input value={wabaId} onChange={(e) => setWabaId(e.target.value)} dir="ltr" inputMode="numeric"
              autoComplete="off" placeholder="102290129340398" className={`${inputCls} font-mono`} />
          </Field>
        </div>
        <Field label="Access token" saved={s.has_token ? s.token_hint : null}
          help={<>للتجربة: التوكن المؤقت من <Path>API Setup → Generate access token</Path> (بيخلص بعد ساعات). وبعدين الدائم من <Path>Business Settings → System users</Path>، بصلاحيات <Path>business_management</Path> و <Path>whatsapp_business_messaging</Path> و <Path>whatsapp_business_management</Path></>}>
          <input value={token} onChange={(e) => setToken(e.target.value)} dir="ltr" type={secretType}
            autoComplete="new-password" data-lpignore="true" data-1p-ignore spellCheck={false}
            placeholder={s.has_token ? '••••••••••••' : 'EAAG…'}
            className={`${inputCls} font-mono`} />
        </Field>
        <Field label="App secret" saved={s.has_app_secret ? s.app_secret_hint : null}
          help={<>من <Path>App settings → Basic → App secret</Path> (دوس <Path>Show</Path>). لازم عشان نقبل الردود اللي جاية من ميتا</>}>
          <input value={secret} onChange={(e) => setSecret(e.target.value)} dir="ltr" type={secretType}
            autoComplete="new-password" data-lpignore="true" data-1p-ignore spellCheck={false}
            placeholder={s.has_app_secret ? '••••••••••••' : '0123…cdef (32)'}
            className={`${inputCls} font-mono`} />
        </Field>
        <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={showSecrets} onChange={(e) => setShowSecrets(e.target.checked)} className="w-4 h-4 accent-emerald-600" />
          إظهار اللي بكتبه
        </label>
        {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <button type="button" onClick={handleSave} disabled={saving || !phoneNumberId.trim() || (!s.has_token && !token.trim())}
            className={`w-full sm:w-auto ${primaryBtn}`}>
            {saving ? 'بيتحفظ…' : 'حفظ'}
          </button>
          {s.updated_at && <span className="text-[11px] text-slate-400">آخر تعديل: {fmtDate(s.updated_at)}</span>}
        </div>
      </div>

      {/* 2 — test message */}
      <div className={card}>
        <StepTitle n={2} title="رسالة تجربة لتليفونك" done={data.messages.some((m) => m.kind === 'test' && m.status !== 'failed')} />
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
          هنبعت رسالة <bdi dir="ltr">«Hello World»</bdi> الجاهزة من ميتا للرقم اللي هتكتبه، عشان نتأكد إن الربط شغال.
        </p>
        <div className="flex flex-col sm:flex-row items-stretch gap-2">
          <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} dir="ltr" inputMode="tel" autoComplete="off"
            placeholder="01xxxxxxxxx" disabled={!s.configured} className={`${inputCls} sm:max-w-xs font-mono`}
            onKeyDown={(e) => { if (e.key === 'Enter' && testPhone.trim() && !testing) handleTest(); }} />
          <button type="button" onClick={handleTest} disabled={!s.configured || testing || !testPhone.trim()} className={primaryBtn}>
            {testing ? 'بيتبعت…' : 'ابعت'}
          </button>
        </div>
        {testError && <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">{testError}</p>}
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          {!s.configured ? 'احفظ المفاتيح الأول. ' : ''}
          لو لسه شغال برقم التجربة بتاع ميتا، ضيف رقمك الأول في قائمة الأرقام المسموح بيها
          (<Path>API Setup → To → Manage phone number list</Path>). الحد الأقصى {data.test_per_hour} رسايل تجربة في الساعة.
        </p>
      </div>

      {/* 3 — webhook */}
      <div className={card}>
        <StepTitle n={3} title="استقبال الردود وعلامات الوصول" done={webhookWired} />
        {!s.verify_token ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">احفظ المفاتيح الأول، وبعدها هيظهرلك هنا العنوان والكلمة اللي هتحطهم في ميتا.</p>
        ) : (
          <>
            <ol className="list-decimal pr-5 space-y-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              <li>في صفحة التطبيق على ميتا: «حالات الاستخدام» ثم «تخصيص» ثم «الخطوة 2. إعداد التشغيل»، وافتح سطر «تكوين Webhooks».</li>
              <li>الزق العنوان والكلمة دول، ودوس «التحقق والحفظ».</li>
              <li>في قايمة الحقول خلّي <Path>messages</Path> «مشترك».</li>
              <li>ارجع هنا ودوس «اربط دلوقتي» تحت.</li>
            </ol>
            <Field label="Callback URL">
              <div className="flex flex-col sm:flex-row items-stretch gap-2">
                <input readOnly value={data.webhook_url} dir="ltr" onFocus={(e) => e.currentTarget.select()} className={`${inputCls} font-mono text-xs sm:text-sm`} />
                <CopyButton text={data.webhook_url} />
              </div>
            </Field>
            <Field label="Verify token">
              <div className="flex flex-col sm:flex-row items-stretch gap-2">
                <input readOnly value={s.verify_token} dir="ltr" onFocus={(e) => e.currentTarget.select()} className={`${inputCls} font-mono text-xs sm:text-sm`} />
                <CopyButton text={s.verify_token} />
              </div>
            </Field>
            {!s.has_app_secret && (
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                لازم تحفظ الـ App secret في الخطوة 1، من غيره هنرفض أي حاجة جاية من ميتا.
              </p>
            )}
            <p className={`text-sm font-semibold ${webhookWired ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
              {webhookWired ? `✓ ميتا بتبعتلنا — آخر حاجة وصلت ${fmtAgo(s.last_webhook_at)}` : 'لسه موصلش حاجة من ميتا'}
            </p>
            {/* the account ↔ app link: without it Meta sends its dashboard test only, never real events */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 sm:p-4 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">ربط حساب الواتساب بالتطبيق</div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mt-0.5">
                    من غير الربط ده ميتا مش بتبعتلنا علامات «وصلت / اتقرت» ولا ردود العملاء.
                  </p>
                </div>
                {link?.linked !== true && (
                  <button type="button" onClick={handleLink} disabled={linking || !s.waba_id} className={`shrink-0 ${primaryBtn}`}>
                    {linking ? 'بيربط…' : 'اربط دلوقتي'}
                  </button>
                )}
              </div>
              {link?.linked === true && (
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  ✓ مربوط{link.app ? <> بتطبيق <bdi dir="ltr">{link.app}</bdi></> : null}
                </p>
              )}
              {link?.linked === false && (
                <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                  لسه مش مربوط{link.app ? <> بتطبيق <bdi dir="ltr">{link.app}</bdi></> : null} — دوس «اربط دلوقتي».
                </p>
              )}
              {link?.error && <p className="text-xs text-red-600 dark:text-red-400 leading-relaxed">{link.error}</p>}
              {!s.waba_id && <p className="text-xs text-amber-700 dark:text-amber-300">اكتب الـ Messaging account ID في الخطوة 1 واحفظ الأول.</p>}
            </div>
          </>
        )}
      </div>

      {/* 4 — message templates */}
      <div className={card}>
        <div className="flex items-center justify-between gap-3">
          <StepTitle n={4} title="قوالب الرسايل" done={!!tpl?.templates.length && tpl.templates.every((t) => t.meta?.status === 'APPROVED')} />
          <button type="button" onClick={loadTemplates}
            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700
              text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
            تحديث
          </button>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
          أي رسالة بنبدأ بيها الكلام مع العميل لازم ميتا تكون راجعت نصها الأول. دوس «ابعت لميتا للمراجعة» مرة واحدة لكل رسالة.
          الإرسال للمراجعة مش بيبعت حاجة لأي عميل.
        </p>
        {tpl?.error && <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">{tpl.error}</p>}
        {!tpl ? (
          <p className="text-sm text-slate-400 py-4 text-center">بيحمّل…</p>
        ) : (
          <div className="space-y-3">
            {tpl.templates.map((t) => (
              <TemplateCard key={t.key} t={t} busy={tplBusy === t.key} canSubmit={!tpl.error && !tplBusy}
                onSubmit={() => handleSubmitTemplate(t)} />
            ))}
          </div>
        )}
      </div>

      {/* 5 — automation (test mode) */}
      <div className={card}>
        <StepTitle n={5} title="التشغيل" done={auto?.auto_mode !== undefined && auto.auto_mode !== 'off'} />
        {!auto ? (
          <p className="text-sm text-slate-400 py-4 text-center">بيحمّل…</p>
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              لما التشغيل يتفتح، الأوردر الجديد بيتحجز بحالة «{auto.rules.hold_status}» ومبيظهرش للبنات،
              ويتبعتله رسالة التأكيد. لو العميل أكد بيبقى «تم التأكيد» باسم «واتساب»، ولو مردّش بينزل للبنات لوحده.
            </p>
            <ul className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed list-disc pr-5 space-y-0.5">
              <li>الرسالة بتتبعت بعد {auto.rules.send_delay_min} دقايق من الأوردر، في أي وقت.</li>
              <li>الأوردر محجوز {auto.rules.hold_min} دقيقة من وقت الإرسال، وبعدها ينزل للبنات ويتوزّع زي أي أوردر.</li>
              <li>بينزل فورًا لو الرقم مالوش واتساب، أو العميل داس «إلغاء الطلب» أو «طلب الدعم» أو كتب رسالة.</li>
              <li>تذكير بعد ساعتين وتذكير تاني يوم، للأوردر المفتوح بس، ومفيش رسايل من 12 بالليل لـ {auto.rules.quiet_until_hour} الصبح.</li>
              <li>العميل اللي تقييمه «ضعيف» في بوسطة (أو «low» في إيزي أوردر وبوسطة معندهاش تقييم ليه) مبيتأكدش بالدوسة: بيروح لموظفة عشان العربون، حتى لو التقييم وصل بعد التأكيد.</li>
            </ul>
            <div className="space-y-2">
              {([
                ['off', 'متوقف', 'مفيش أي أوردر بيتحجز ولا رسالة بتتبعت لوحدها.'],
                ['test', 'تجربة على أرقام محددة', 'الأوردرات اللي جاية من الأرقام اللي تحت بس. باقي العملاء زي ما هم بالظبط.'],
              ] as [WhatsAppAutoMode, string, string][]).map(([m, title, desc]) => (
                <label key={m} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors
                  ${autoMode === m ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-700 dark:bg-emerald-950/30'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>
                  <input type="radio" name="wa-auto-mode" checked={autoMode === m} onChange={() => setAutoMode(m)} className="mt-1 w-4 h-4 accent-emerald-600 shrink-0" />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{desc}</span>
                  </span>
                </label>
              ))}
              {auto.live_mode_open && (
                <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors
                  ${autoMode === 'on' && autoHalf ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-700 dark:bg-emerald-950/30'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>
                  <input type="radio" name="wa-auto-mode" checked={autoMode === 'on' && autoHalf} onChange={() => { setAutoMode('on'); setAutoHalf(true); }} className="mt-1 w-4 h-4 accent-emerald-600 shrink-0" />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">شغال على 80% من الأوردرات (تجربة أسبوع)</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      4 من كل 5 عملاء بيدخلوا الواتساب، والخامس (آخر رقم في موبايله 8 أو 9) بيروح للبنات زي ما هو — عشان نقارن الاتنين على التسليم.
                    </span>
                  </span>
                </label>
              )}
              {auto.live_mode_open && auto.live_all_open ? (
                <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors
                  ${autoMode === 'on' && !autoHalf ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-700 dark:bg-emerald-950/30'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>
                  <input type="radio" name="wa-auto-mode" checked={autoMode === 'on' && !autoHalf} onChange={() => { setAutoMode('on'); setAutoHalf(false); }} className="mt-1 w-4 h-4 accent-emerald-600 shrink-0" />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">شغال على كل العملاء</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      كل أوردر جديد بيدخل الواتساب الأول. من غير مجموعة مع البنات مفيش مقارنة على التسليم.
                    </span>
                  </span>
                </label>
              ) : (
                <div className="flex items-start gap-3 p-3 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 opacity-60">
                  <input type="radio" disabled className="mt-1 w-4 h-4 shrink-0" />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">شغال على كل العملاء</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">بيتفتح بعد أسبوع التجربة.</span>
                  </span>
                </div>
              )}
              {auto.daily_limit && (
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {auto.daily_limit.tier
                    ? <>حد ميتا لحسابك <b className="tabular-nums">{auto.daily_limit.meta.toLocaleString('en-US')}</b> عميل كل 24 ساعة (من ميتا نفسها).</>
                    : <>حد ميتا لسه متقراش من حسابك، فماشيين على أقل حد ({auto.daily_limit.meta}) — دوس «افحص الاتصال» فوق عشان يتقرا.</>}
                  {' '}اتبعت لـ <b className="tabular-nums">{auto.daily_limit.used}</b> في آخر 24 ساعة،
                  ولما نوصل <b className="tabular-nums">{auto.daily_limit.new_orders.toLocaleString('en-US')}</b> الأوردر الجديد بيروح للبنات عادي من غير رسالة.
                </p>
              )}
            </div>
            {autoMode === 'test' && (
              <Field label="أرقام التجربة" help="رقم في كل سطر (010…). اعمل أوردر من المتجر بواحد من الأرقام دي عشان تجرّب.">
                <textarea value={autoPhones} onChange={(e) => setAutoPhones(e.target.value)} dir="ltr" rows={3}
                  placeholder={'01xxxxxxxxx\n01xxxxxxxxx'} className={`${inputCls} font-mono`} />
              </Field>
            )}
            {autoError && <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">{autoError}</p>}
            <button type="button" onClick={handleSaveAuto} disabled={autoSaving || !s.configured} className={`w-full sm:w-auto ${primaryBtn}`}>
              {autoSaving ? 'بيتحفظ…' : 'حفظ التشغيل'}
            </button>

            {!!auto.to_review?.length && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/30 p-3 space-y-2">
                <h3 className="text-sm font-bold text-amber-900 dark:text-amber-200">
                  راجعهم قبل الشحن ({auto.to_review.length})
                </h3>
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  أوردرات العميل أكدها بنفسه على واتساب ومفيش موظفة كلمته، وكتب رسالة. اقرا الرسالة قبل ما الأوردر يتشحن.
                </p>
                <ul className="divide-y divide-amber-200 dark:divide-amber-800/60">
                  {auto.to_review.map((x) => (
                    <li key={x.order_id} className="py-2 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-bold text-slate-900 dark:text-white">أوردر #{x.order_id}</span>
                        {x.product && <span className="text-xs text-slate-600 dark:text-slate-300 break-words">{x.product}</span>}
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 mr-auto">{fmtAgo(x.updated_at)}</span>
                      </div>
                      <p className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words">«{x.customer_text}»</p>
                      {/\[(audio|image|video|document|sticker)\]/.test(x.customer_text) && <WhatsAppMedia orderId={x.order_id} />}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">الأوردرات اللي دخلت الواتساب</h3>
                <button type="button" onClick={() => loadAuto(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700
                    text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">تحديث</button>
              </div>
              {!auto.flows.length ? (
                <p className="text-sm text-slate-400 py-5 text-center">لسه مفيش</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {auto.flows.map((f) => <FlowRow key={f.order_id} f={f} tags={auto.tags} />)}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {trial?.started && trial.control_half && trial.wa && trial.control && <TrialCard trial={trial} onRefresh={loadTrial} busy={trialBusy} />}

      {/* 6 — one message to the old «لا يرد» orders */}
      <RecontactCard ready={!!s.configured && !!auto} stopped={auto?.auto_mode === 'off'}
        onQueued={() => loadAuto(false)} showToast={showToast} />

      {/* Log */}
      <div className={card}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white">سجل الرسايل</h2>
          <button type="button" onClick={() => refreshMessages(false)} disabled={refreshing}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700
              text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
            {refreshing ? '…' : 'تحديث'}
          </button>
        </div>
        {!data.messages.length ? (
          <p className="text-sm text-slate-400 py-6 text-center">لسه مفيش رسايل</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.messages.map((m) => <MessageRow key={m.id} m={m} />)}
          </ul>
        )}
        {!webhookWired && data.messages.some((m) => m.direction === 'out') && (
          <p className="text-xs text-slate-500 dark:text-slate-400">علامات «وصلت» و«اتقرت» وردود العملاء بتظهر بعد الخطوة 3.</p>
        )}
      </div>
    </div>
  );
}
