# v5: السلات المتروكة وإعدادات الموقع

الهدف: يقدر صاحب المتجر يتحكم من اللوحة في كل حاجة على الموقع مش موجودة في EasyOrders، ويشوف السلات اللي ما كملتش (EasyOrders «الطلبات المفقودة» بيسجل بس اللي ضغط «اطلب» وفشل، مش السلات المتروكة).

## 1) روابط عامة للموقع `/api/public/*`
- **بدون تسجيل دخول وبدون CSRF وبدون كوكيز.** مركّبة قبل middleware اللوحة، فقواعد CORS والجلسات و CSRF الخاصة باللوحة **مش متغيرة**.
- CORS مسموح بس لنطاق المتجر من المتغير الجديد `STOREFRONT_ORIGINS` (الافتراضي `https://solita.myeasyorders.com`). نطاق اللوحة نفسه مش مسموح هنا.
- `POST /events` لازم يكون فيه `Origin` مسموح، وإلا `403 BAD_ORIGIN`.
- حجم الطلب ≤ 32KB (`413` لو أكبر). بيقبل `application/json` أو `text/plain` (عشان `navigator.sendBeacon` من غير preflight).
- حد طلبات لكل IP في MongoDB: 120 طلب/دقيقة للأحداث، و120/دقيقة لـ site-config (الحد كبير لأن شبكات الموبايل في مصر بتحط زباين كتير ورا IP واحد). الرد `429 RATE_LIMITED`.
- `Cross-Origin-Resource-Policy: cross-origin` على الروابط العامة بس.

### `POST /api/public/events`
```json
{
  "visitorId": "3f1c2b9e-8a7d-4c1e-9b2a-1d2e3f4a5b6c",
  "newVisit": true,
  "events": [
    { "type": "page_view", "path": "/products/samba-wb", "title": "Samba" },
    { "type": "product_view", "product": { "slug": "samba-wb", "sku": "samba-WB", "name": "Samba أبيض × أسود", "price": 1650 } },
    { "type": "cart_add", "item": { "slug": "samba-wb", "sku": "samba-WB", "name": "Samba", "size": "42", "qty": 1, "price": 1650 } },
    { "type": "cart_remove", "item": { "slug": "samba-wb", "size": "42", "qty": 1 } },
    { "type": "cart_snapshot", "items": [ { "slug": "samba-wb", "sku": "samba-WB", "name": "Samba", "size": "42", "qty": 2, "price": 1650 } ] },
    { "type": "checkout_contact", "name": "أحمد", "phone": "01001234567" },
    { "type": "order_placed", "orderId": "<EasyOrders order id>", "shortId": 1234, "phone": "01001234567" }
  ]
}
```
- `visitorId`: 16–64 حرف `[A-Za-z0-9-]` (مثلاً `crypto.randomUUID()`) محفوظ على الجهاز. `newVisit: true` في أول batch من كل زيارة (لعدّ الزيارات).
- `events`: من 1 لـ 50 حدث. الـ envelope **strict** (أي حقل زيادة فوق → 400). كل حدث بيتفحص لوحده: الحقول غير المعروفة بتتشال، والحدث الغلط بيتساب ويتعد في `rejected` من غير ما يوقع الـ batch كله.
- `price` بالجنيه للقطعة الواحدة (زي ما ظاهر على الموقع)، وبيتخزن بالقرش. `qty` من 1 لـ 20. `size` نص أو رقم. `cart_snapshot` ≤ 30 منتج.
- `cart_remove` من غير `qty` = يشيل المنتج بالمقاس ده كله.
- `phone`: موبايل مصري (`01xxxxxxxxx`، بيقبل `+20` ومسافات وأرقام عربية). رقم غلط = الحدث يتساب.
- `order_placed`: لازم `orderId` أو `shortId`.
- **الرد:** `202 {"ok": true, "accepted": 6, "rejected": 1}`. أخطاء: `400 VALIDATION_ERROR` / `400 INVALID_JSON` / `403 BAD_ORIGIN` / `413 PAYLOAD_TOO_LARGE` / `429 RATE_LIMITED`.

### `GET /api/public/site-config`
`Cache-Control: public, max-age=60, s-maxage=60`.
```json
{
  "revision": 3,
  "updatedAt": "2026-11-13T10:00:00.000Z",
  "settings": {
    "toggles": { "shelf": true, "cards": true, "sounds": true, "trackingBubble": true },
    "shelf": { "lines": [ { "sku": "alex333-BBGoldtext", "fallbacks": [] }, "... 6 lines بالظبط" ] },
    "cards": { "speed": "slow | normal | fast" },
    "suggestions": { "count": 8, "order": "random | easyorders" },
    "cartReminder": { "enabled": true, "messages": [ { "ar": "...", "en": "..." } ] },
    "announcement": { "enabled": false, "text": { "ar": "", "en": "" }, "link": "" },
    "features": {
      "shipping":     { "title": { "ar": "شحن مجاني", "en": "Free shipping" }, "text": { "ar": "...", "en": "..." } },
      "customerCare": { "title": { "ar": "...", "en": "..." }, "text": { "ar": "...", "en": "..." } },
      "warranty":     { "title": { "ar": "...", "en": "..." }, "text": { "ar": "...", "en": "..." } },
      "payment":      { "title": { "ar": "...", "en": "..." }, "text": { "ar": "...", "en": "..." } }
    },
    "gift": { "title": { "ar": "هدية مع كل حذاء", "en": "..." }, "text": { "ar": "شرابات بلون يناسب الحذاء.", "en": "..." } },
    "whatsapp": { "account": "@solita.917", "productMessage": { "ar": "... «{product}» ...", "en": "... {product} ..." }, "generalMessage": { "ar": "...", "en": "..." } },
    "delivery": { "text": { "ar": "يستغرق التوصيل عادةً من 1 إلى 3 أيام عمل (أيام العمل من الأحد إلى الخميس).", "en": "..." } }
  }
}
```
- `revision: 0` و `updatedAt: null` = لسه محدش حفظ، والإعدادات هي الافتراضية (نفس اللي على الموقع النهارده).
- لو قسم متخزن فيه مشكلة، القسم ده بس بيرجع للافتراضي.
- إعدادات اللوحة بس (`admin.cartWhatsappTemplate`) **مش** بتظهر هنا.
- لو السيستم وقع، الموقع لازم يكمل بآخر نسخة محفوظة على الجهاز أو بالافتراضي (ده شغل سكربت الموقع، مش جزء من الـ PR ده).

## 2) قاعدة البيانات (مجموعات جديدة، الفهارس بتتعمل من `npm run db:init` / `initDatabase`)
| المجموعة | الموديل | ملاحظات |
|---|---|---|
| `visitors` | `Visitor` | `visitorId` فريد، firstSeen/lastSeen، visits، pages، آخر 20 صفحة. **TTL 90 يوم** على `lastSeen`. مفيش IP ولا user agent. |
| `storefront_carts` | `StorefrontCart` | منتجات، قيمة بالقرش، اسم/رقم لو اتكتب، `status: open | contacted | converted | expired`، contactedAt/By، convertedOrderId/ShortId/Order. سلة واحدة **نشطة** لكل زائر (فهرس فريد partial على `active: true`). **TTL 90 يوم** على `lastActivityAt`. |
| `storefront_daily_stats` | `StorefrontDailyStat` | مشاهدات وإضافات لكل منتج في اليوم (بتوقيت القاهرة). TTL 120 يوم. |
| `site_settings` | `SiteSettings` | مستند واحد `key: "site"`، `settings` بتتفحص بـ Zod عند الحفظ وبتتدمج مع الافتراضي عند القراءة، `revision`، `updatedBy`. |

### تحويل السلة لطلب
- `order_placed` من الموقع → السلة `converted` (`convertedVia: "order_placed"`)، وأي حدث بعده يبدأ سلة جديدة.
- طلب جديد من EasyOrders (Webhook أو السحب أو الاستيراد اليدوي، كلهم بيعدوا على `upsertOrderFromSource`) بنفس رقم الهاتف لسلة نشطة آخر نشاط فيها خلال 14 يوم → `converted` (`convertedVia: "phone_match"`). الـ matching بالرقم **للطلبات الجديدة بس** (مش تحديث طلب قديم).
- لو `order_placed` جه قبل ما الطلب يوصل السيستم، السلة بتتربط بالطلب (`convertedOrder`) أول ما يوصل.
- الـ hook ده `convertCartsForOrder()` **عمره ما يرمي خطأ** ومش بيغير أي حاجة في الطلب. سلوك الطلبات الحالي زي ما هو.
- السلة النشطة اللي مفيهاش نشاط 30 يوم بتبقى `expired` في المعالجة الدورية (`/api/cron/process`)، والرد بقى فيه `storefront: { expired }`.

## 3) اللوحة
- **«السلات المتروكة»** `/admin/abandoned-carts`: فلتر الفترة (اليوم، 3 أيام، 7، 30، الكل)، الحالة، «فيها رقم»، «لم يُتواصل معها». لكل سلة: المنتجات والمقاسات، القيمة، الاسم والرقم، آخر نشاط/زيارة. زرار **واتساب** (بنفس `whatsappLink` الموجود) برسالة من الإعدادات فيها `{name}` `{items}` `{total}`، وزرار «تم التواصل» و«تجاهل».
- **«إعدادات الموقع»** `/admin/site-settings`: فورم لكل الإعدادات فوق، عربي + إنجليزي لكل نص، زرار «استعادة الإعدادات الافتراضية» (بيملأ الفورم بس، الحفظ بزرار الحفظ).
- كارت **«سلوك الزوار»** (آخر 7 أيام) في «نظرة عامة» وفي صفحة السلات: زوار اليوم/7 أيام، السلات المتروكة وقيمتها، اللي اتحولت لطلبات، الأكثر مشاهدة، والأكثر إضافة للسلة من غير شراء.

### Admin API (مشرف + CSRF زي باقي اللوحة)
- `GET /api/admin/storefront/carts?range=today|3d|7d|30d|all&status=active|open|contacted|converted|expired|all&hasPhone=true|false&notContacted=true&page=&limit=` → `{ items, pagination }`
- `POST /api/admin/storefront/carts/:id/contacted` · `POST /api/admin/storefront/carts/:id/dismiss` → `{ cart }` (`422` لو السلة اتحولت أو انتهت، `404` لو مش موجودة)
- `GET /api/admin/storefront/summary`
- `GET /api/admin/site-settings` → `{ settings, defaults, revision, updatedAt, updatedBy }`
- `PATCH /api/admin/site-settings` (الإعدادات كاملة، strict) → نفس الرد

## 4) الاختبارات
- `server/tests/storefront.test.js` (22 اختبار): CORS، الـ Origin، 32KB، `text/plain`، الـ validation وإسقاط الحقول، حد الطلبات لكل IP، بناء السلة، التحويل بـ `order_placed` وبرقم الهاتف من الـ Webhook، عدم التحويل لطلب قديم أو سلة أقدم من 14 يوم، الانتهاء بعد 30 يوم، فهارس TTL، صلاحيات المشرف، الفلاتر، الإعدادات (الحفظ، الـ validation، الرجوع للافتراضي لكل قسم)، وحدود اليوم بتوقيت القاهرة.
- `client/src/features/storefront/cartMessage.test.js`: رسالة واتساب للسلة.

## بعد الدمج
- متغير بيئة جديد **اختياري**: `STOREFRONT_ORIGINS` (الافتراضي `https://solita.myeasyorders.com`، فمش لازم يتضاف لو ده النطاق).
- مفيش migration للبيانات، بس **لازم `npm run db:init` مرة واحدة بعد الدمج** (على قاعدة الإنتاج، يوسف بيشغله) عشان يعمل المجموعات الجديدة وفهارسها، خصوصًا فهارس الحذف التلقائي (TTL) والفهرس الفريد للسلة النشطة، لأن `autoIndex` مقفول في الإنتاج. الأمر آمن ومش بيمسح أي حاجة.
- **مفيش حاجة اتنشرت.** سكربت الموقع اللي بيبعت الأحداث ويقرأ الإعدادات هيتعمل بعد الدمج على الروابط دي.
