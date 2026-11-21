# Scalyo read-only API (`/api/v1`)

This API lets another system (for example the video studio) **read** a business's numbers from Scalyo:
- product profit and loss,
- the business totals,
- the orders,
- which ad platform, campaign and ad each order came from, with every number above available per platform (`channel=`).

**What it cannot do:**
- **Change anything.** Only `GET` is accepted. Any other method gets `405`.
- **Show customer data.** Customer name, phone, address, notes and tracking code are never returned.

The numbers come from the same code as the «التحليلات» page, so they always match what the owner sees there.

## Getting a key

1. The account owner opens **الربط مع الأنظمة (API)** in Scalyo.
2. They create a key and choose what it can read:
   - `products`: product profit and loss
   - `summary`: business numbers
   - `orders`: the orders
3. The key looks like `scalyo_` followed by 43 characters. It is shown **once**, so copy it then.
4. The owner can stop a key at any time. A stopped key stops working immediately.

**Keeping the key safe:**
- Keep the key on your **server**, for example in an environment variable such as `SCALYO_API_KEY`.
- Never put it in browser code, a mobile app, or a public repo.
- If a key leaks, the owner stops it and creates a new one.

## Basics

| | |
|---|---|
| Base URL | `https://scalyoo.com/api/v1` |
| Auth | Header `X-Api-Key: scalyo_…`. `Authorization: Bearer scalyo_…` also works. Never pass the key in the URL. |
| Dates | `from` / `to` as `YYYY-MM-DD`, **Cairo days**, both inclusive. Default: the last 30 days up to today. Max 366 days. |
| Date meaning | Order numbers count orders **placed** in the range (the same cohort as the dashboard). Ad spend counts spend dated in the range. |
| Money | EGP |
| Rate limit | 60 requests per minute per key. Over the limit you get `429` with a `Retry-After` header (seconds). |
| Freshness | `/products` and `/summary` are cached for 2 minutes. Polling more often than every 2 minutes returns the same numbers. |
| CORS | None. Call the API from your server, not from a browser. |

## Errors

Every error is JSON: `{ "error": "<code>", "message": "<text>" }`.

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `bad_request` | A bad parameter, for example a bad date or an unknown `group` |
| 401 | `missing_key` / `invalid_key` | No key, a wrong key, or a stopped key |
| 403 | `scope_missing` | The key was not allowed to read this endpoint |
| 404 | `not_found` | Unknown endpoint or unknown `product_id` |
| 405 | `read_only` | Anything other than `GET` |
| 429 | `rate_limited` / `too_many_failed_attempts` | Too many requests. Wait `Retry-After` seconds. |
| 501 | `not_available` | `products` and `summary` are not available for affiliate accounts |
| 503 | `busy` / `unavailable` | Busy for a moment. Retry after a few seconds. |
| 500 | `internal_error` | A problem on Scalyo's side |

## Which platform, campaign and ad (attribution)

Every EasyOrder order is tagged with the platform it came from (`channel`), its campaign and its ad.

**What EasyOrder passes on.** The store copies only **three** parameters from the link into the order. Nothing else in the link reaches Scalyo.

| Put in the ad link | Arrives as | Use it for |
|---|---|---|
| `utm_source` | `utm_source` | the platform |
| `utm_campaign` | `utm_campaign` | the campaign |
| `ref` | `ad_ref` | **the ad.** EasyOrder does not forward `utm_content`, so put the ad id in `ref`. |

These never reach Scalyo: `utm_medium`, `utm_content`, `utm_term`, `fbclid`, `ttclid` and the landing URL. EasyOrder uses them only for its own pixel tracking.

EasyOrder also records the referring site of the customer's first visit: `referrer`, for example `m.facebook.com`, `instagram.com` or `direct`.

**Tag your ads like this** (only the parameters, without the leading `?`):

- **Meta:** `utm_source={{site_source_name}}&utm_campaign={{campaign.id}}&ref={{ad.id}}`
  - `{{site_source_name}}` becomes `fb`, `ig`, `th`, `msg` or `an`.
  - The live ads already send `utm_source` and `utm_campaign`, so only `ref` is new.
- **TikTok:** `utm_source=tiktok&utm_campaign=__CAMPAIGN_ID__&ref=__CID__`
  - `__CID__` is the creative, which is the video.
  - For an upgraded Smart+ campaign the ad id macro is `__ADID_V2__`.
  - Macros must be UPPERCASE. Check them with Preview before publishing.

EasyOrder keeps the last `ref` a visitor arrived with, so a customer who comes back later without a `ref` keeps the ad they first came from.

**`channel` rules.** The first rule that matches wins.

| `channel` | When | `channel_basis` |
|---|---|---|
| `tiktok` | `utm_source` contains "tiktok" | `utm` |
| `meta` | `utm_source` is `fb`, `ig`, `th`, `msg`, `an`, or contains facebook / instagram / threads / messenger | `utm` |
| `other` | Any other `utm_source` (for example `chatgpt.com`), or a `utm_campaign` with no source | `utm` |
| `tiktok` | No UTM, and the referrer is a tiktok site | `referrer` |
| `meta` | No UTM, and the referrer is facebook / instagram / threads / messenger. About 92% of orders without UTM come from these sites, so they are Meta traffic. | `referrer` |
| `organic` | No UTM and no ad-platform referrer (direct, the store itself, google) | `none` |
| `unknown` | Nothing recorded: orders typed in by the team or imported from a file, and the few EasyOrder orders that couldn't be recovered | — |

**Older orders:** EasyOrder orders from before this feature were tagged from Scalyo's own log of incoming orders (from 2026-06-20). The rest were fetched once from EasyOrder.

**Ad spend per channel:** Scalyo only has **Meta** spend.
- With `channel=meta`, the spend is all of it.
- With any other channel, `ad_spend` is `0`, so `net_profit` does not include that platform's ads.
- For TikTok, subtract your own TikTok spend from `profit_before_ads`.

**Operating costs per channel:**
- Commissions follow their own orders.
- Every other daily cost is split by the channel's share of delivered orders.

With these rules, the channels always add up to the unfiltered numbers.

---

## `GET /me`

Use this to check that the key works.

```json
{
  "key": { "name": "سيستم الفيديوهات", "hint": "scalyo_ER8_N1…fVhI", "scopes": ["products", "summary", "orders"], "created_at": "2026-11-20T22:09:17.071Z" },
  "business": { "id": 1, "name": "Product Pulse" },
  "read_only": true,
  "customer_data": "hidden",
  "requests_per_minute": 60
}
```

## `GET /products?from=&to=&channel=`  (scope `products`)

Returns one row per catalogue product. These are the same numbers as the products table on «التحليلات».

Add `channel=meta|tiktok|organic|other|unknown` to get only that platform's numbers. They are computed the same way, with the [ad spend and operating-cost rules](#which-platform-campaign-and-ad-attribution).

```json
{
  "range": { "from": "2026-11-14", "to": "2026-11-20", "days": 7, "timezone": "Africa/Cairo" },
  "channel": null,
  "currency": "EGP",
  "generated_at": "2026-11-20T22:10:01.000Z",
  "count": 23,
  "products": [
    {
      "product_id": "5dcf099c-a0f3-43c3-b8d9-e2eab594455b",
      "name": "داش كام للسيارة 4 عدسات لاسلكية",
      "sku": "DASH-CAM",
      "stopped": false,
      "stock": 72,
      "selling_price": 1689,
      "cost_price": 900,
      "orders": 524,
      "confirmed": 294,
      "confirmation_rate": 56.1,
      "shipped": 244,
      "delivered": 133,
      "delivery_rate_of_shipped": 54.5,
      "delivered_of_orders_rate": 25.4,
      "revenue": 233951,
      "refunds": 0,
      "cogs": 125099.9,
      "shipping_cost": 15062.7,
      "ad_spend": 74154.26,
      "operating_expenses": 7776.83,
      "net_profit": 11857.31,
      "profit_before_ads": 86011.57,
      "profit_per_delivered": 89.15,
      "ad_cost_per_order": 141.52,
      "meta_purchases": 486,
      "cost_per_meta_purchase": 152.58
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `product_id` | Product id (a UUID string). Use it with `/orders?product_id=`. |
| `stopped` | The product was stopped in Scalyo («إيقاف المنتج») |
| `stock` | Current stock (live, not limited to the range). `null` if unknown. |
| `orders` | All orders placed in the range, any status |
| `confirmed` | Orders that reached confirmed or later: تم التأكيد، تم الشحن، تم التوصيل، جاري الإعادة، تم الإرجاع، مغلق - لن يشحن |
| `confirmation_rate` | `confirmed ÷ orders × 100` (the CR% column). `null` when there are no orders. |
| `shipped` | Orders that left to the courier: تم الشحن، تم التوصيل، جاري الإعادة، تم الإرجاع |
| `delivered` | Delivered orders (تم التوصيل) |
| `delivery_rate_of_shipped` | `delivered ÷ shipped × 100` (the DR% column). `null` when nothing was shipped. |
| `delivered_of_orders_rate` | `delivered ÷ orders × 100` (the NDR% column) |
| `revenue` | Total price of the delivered orders |
| `refunds` | Money paid back to customers after delivery |
| `cogs` | Cost of the delivered units, minus units that came back to stock |
| `shipping_cost` | Bosta fees: the actual per-parcel fee plus return pickups |
| `ad_spend` | Meta ad spend attributed to this product (by SKU in the campaign name) |
| `operating_expenses` | This product's share of the daily operating costs: its exact commissions plus a share of the shared costs, split by delivered count |
| `net_profit` | `revenue − refunds − cogs − ad_spend − shipping_cost − operating_expenses`. Negative means a loss. |
| `profit_before_ads` | `net_profit + ad_spend`. For TikTok, subtract your TikTok spend from this. |
| `profit_per_delivered` | `net_profit ÷ delivered` |
| `ad_cost_per_order` | `ad_spend ÷ orders` |
| `meta_purchases`, `cost_per_meta_purchase` | Purchases reported by the Meta pixel, and the spend per pixel purchase |

## `GET /summary?from=&to=&channel=`  (scope `summary`)

Returns the business numbers: the top cards of «التحليلات» for all products, plus the daily chart, the governorates and the rejection reasons.

`channel=` works here too. Every number, chart and breakdown then covers only that platform's orders.

```json
{
  "range": { "from": "2026-11-01", "to": "2026-11-19", "days": 19, "timezone": "Africa/Cairo" },
  "channel": null,
  "currency": "EGP",
  "orders": 2500, "confirmed": 1368, "delivered": 679, "rejected": 610, "returned": 140, "pending": 120,
  "confirmation_rate": 54.7, "delivery_rate_of_confirmed": 49.6, "delivered_of_orders_rate": 27.2,
  "revenue": 1150000, "refunds": 2400, "cogs": 520000, "shipping_cost": 61000,
  "ad_spend": 290000, "expenses_total": 296000, "operating_expenses": 89675.57,
  "operating_expenses_breakdown": [{ "label": "عمولات", "amount": 41000 }, { "label": "مصاريف تشغيل", "amount": 48675.57 }],
  "net_profit": 180924.43,
  "profit_before_ads": 476924.43,
  "profit_per_delivered": 266.46,
  "meta_purchases": 2310, "cost_per_meta_purchase": 125.54, "ad_cost_per_delivered": 427.1,
  "in_transit_now": { "orders": 180, "cash_on_way": 310000 },
  "daily": [{ "date": "2026-11-19", "orders": 140, "confirmed": 80, "delivered": 12, "revenue": 21000, "refunds": 0, "ad_spend": 15000, "meta_purchases": 128 }],
  "governorates": [{ "governorate": "القاهرة", "orders": 700, "confirmed": 400, "delivered": 210, "returned": 40, "revenue": 355000 }],
  "rejection_reasons": [{ "reason": "السعر", "count": 54 }]
}
```

The values above are only an example, but they add up the same way real ones do.

| Field | Meaning |
|---|---|
| `pending` | Orders still جديد or لا يرد |
| `delivery_rate_of_confirmed` | `delivered ÷ confirmed × 100` (the dashboard's DR card). Note: the per-product rate is per shipped. |
| `ad_spend` | Meta spend in the range |
| `expenses_total` | All expenses in the range (Meta plus manual expenses) |
| `net_profit` | `revenue − refunds − Σ product cogs − expenses_total − operating_expenses − Σ product shipping_cost`. This is the dashboard's «صافي الربح» card. |
| `profit_before_ads` | `net_profit + expenses_total` |
| `in_transit_now` | A **live snapshot**, not limited to the range: parcels on their way now and the cash Bosta will collect for them |
| `daily[].orders` | Orders placed that day (the Scalyo count, not the Meta pixel) |

## `GET /orders`  (scope `orders`)

Returns orders **without customer data**, newest first.

| Param | |
|---|---|
| `from`, `to` | The date range (placement day, Cairo) |
| `status` | One exact Arabic status, for example `تم التوصيل` (URL-encode it) |
| `group` | `new`, `follow_up`, `confirmed`, `shipped`, `delivered`, `returned`, `rejected`, `cancelled`, `closed` (see the table below) |
| `product_id` | From `/products`. This uses the same product matching as the products report, so `total` equals that product's `orders`. |
| `sku` | Exact SKU (case-insensitive) |
| `channel` | `meta`, `tiktok`, `organic`, `other` or `unknown` |
| `page`, `limit` | `page` starts at 1. `limit` defaults to 100, max 500. |

```json
{
  "range": { "from": "2026-11-20", "to": "2026-11-20", "days": 1, "timezone": "Africa/Cairo" },
  "channel": null,
  "currency": "EGP",
  "page": 1, "limit": 100, "total": 154, "has_more": true,
  "orders": [
    {
      "id": 19222,
      "source": "easyorder",
      "external_order_id": "f88a2389-3dc1-4240-847f-99300755ab5f",
      "status": "جديد",
      "status_group": "new",
      "product_name": "جهاز الالعاب الاسلكي SF3500 Retro",
      "sku": "SF3500",
      "quantity": 1,
      "price": 2289,
      "deposit": 0,
      "city": "القاهرة",
      "created_at": "2026-11-20T21:57:27.982Z",
      "created_day": "2026-11-20",
      "shipped_at": null,
      "delivered_at": null,
      "status_changed_at": null,
      "rejection_reason": null,
      "bosta_rating": "بدون",
      "easyorder_rating": "high",
      "channel": "meta",
      "channel_basis": "utm",
      "utm_source": "fb",
      "utm_campaign": "120254187807170202",
      "ad_ref": "120254187807190202",
      "referrer": "m.facebook.com"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `price` | The whole order's total (quantity included), not the unit price |
| `deposit` | The deposit paid before shipping (عربون) |
| `city` | The governorate or city as entered |
| `created_at` | ISO time in UTC. `created_day` is the Cairo calendar day. |
| `external_order_id` | The order's id in the source store. For EasyOrder this is the order UUID. |
| `bosta_rating` | Bosta's customer rating: ممتاز / متوسط / ضعيف / جديد / بدون |
| `easyorder_rating` | EasyOrder's customer rating: `high` / `moderate` / `low` / `unknown` |
| `channel`, `channel_basis` | The platform, and what decided it. See [attribution](#which-platform-campaign-and-ad-attribution). |
| `utm_source`, `utm_campaign` | As EasyOrder received them from the ad link |
| `ad_ref` | The link's `ref=`, meaning the ad id once the ads carry it. `null` before that. |
| `referrer` | The referring site of the customer's first visit |

| `status_group` | Statuses |
|---|---|
| `new` | جديد، مراجعة جديدة |
| `follow_up` | لا يرد، مؤجل، معلق حتي الدفع |
| `confirmed` | تم التأكيد |
| `shipped` | تم الشحن |
| `delivered` | تم التوصيل |
| `returned` | جاري الإعادة، تم الإرجاع |
| `rejected` | تم الرفض |
| `cancelled` | ملغي - عدم رد نهائي |
| `closed` | مغلق - لن يشحن، مغلق - منتج متوقف |
| `other` | Any status added later |

---

## Examples

```bash
curl -H "X-Api-Key: $SCALYO_API_KEY" "https://scalyoo.com/api/v1/products?from=2026-11-01&to=2026-11-20"
```

Python (server side):

```python
import os, time, requests

BASE = os.environ.get("SCALYO_API_URL", "https://scalyoo.com/api/v1")
KEY = os.environ["SCALYO_API_KEY"]          # never hard-code the key

def scalyo(path, **params):
    for _ in range(3):
        r = requests.get(f"{BASE}{path}", headers={"X-Api-Key": KEY}, params=params, timeout=60)
        if r.status_code in (429, 503):
            time.sleep(int(r.headers.get("Retry-After", "5")))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()

# `from` is a Python keyword, so pass the range as a dict
products = scalyo("/products", **{"from": "2026-11-01", "to": "2026-11-20"})["products"]
winners = sorted(products, key=lambda p: p["net_profit"], reverse=True)[:5]

# the same products, TikTok only (Scalyo has no TikTok spend: subtract yours)
tiktok = scalyo("/products", **{"from": "2026-11-01", "to": "2026-11-20", "channel": "tiktok"})["products"]
tiktok_profit = sum(p["profit_before_ads"] for p in tiktok) - my_tiktok_spend

# every page of delivered orders for one product
orders, page = [], 1
while True:
    res = scalyo("/orders", **{"from": "2026-11-01", "to": "2026-11-20",
                               "group": "delivered", "product_id": winners[0]["product_id"],
                               "page": page, "limit": 500})
    orders += res["orders"]
    if not res["has_more"]:
        break
    page += 1
```
