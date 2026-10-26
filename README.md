<div dir="rtl">

# نظام سوليتا لإدارة الطلبات والمندوبين

نظام إداري وتشغيلي لمتجر **سوليتا** للأحذية، مرتبط بمتجر EasyOrders الحالي (`https://solita.myeasyorders.com/`).
النظام **لا يستبدل صفحة الدفع الحالية** في المتجر؛ الطلبات تُنشأ في EasyOrders كالمعتاد ثم تصل إلى النظام عبر Webhook.

المزايا الأساسية:

- استيراد الطلبات ومزامنتها في الاتجاهين مع EasyOrders (Webhook + API).
- تعيين المندوبين يدوياً وإعادة التعيين مع سجل كامل.
- لوحة مندوب للموبايل: بدء التوصيل، تسجيل محاولة فاشلة، إرسال "تم التسليم".
- **موافقة المشرف إلزامية** قبل إرسال حالة `delivered` إلى EasyOrders.
- متابعة النقدية (الدفع عند الاستلام) والتسويات والفروقات.
- سجل تدقيق (Audit) غير قابل للتعديل لكل الأحداث.
- واجهة عربية بالكامل (RTL)، متجاوبة مع الكمبيوتر والتابلت والموبايل.

---

## 1. هيكل المشروع

```
solita-courier/
├── api/index.js                 نقطة دخول Vercel Serverless (تستدعي تطبيق Express)
├── client/                      الواجهة: React + Vite
│   ├── public/favicon.svg
│   ├── src/assets/solita-logo.svg   شعار سوليتا الرسمي (بدون أي تعديل)
│   ├── src/components/          مكونات عامة (أزرار، نوافذ تأكيد، شارات الحالة...)
│   ├── src/features/auth/       تسجيل الدخول وحماية المسارات
│   ├── src/hooks/  src/services/  src/utils/  src/styles/
│   ├── src/layouts/             تخطيط لوحة المشرف وتخطيط المندوب
│   └── src/pages/admin|courier/ صفحات المشرف وصفحات المندوب
├── server/                      الخادم: Node.js + Express + Mongoose
│   ├── src/config/env.js        قراءة متغيرات البيئة والتحقق منها
│   ├── src/db/                  الاتصال بقاعدة البيانات (مُعاد الاستخدام) وإنشاء الفهارس
│   ├── src/models/              نماذج MongoDB
│   ├── src/routes/ controllers/ services/ middleware/ validators/
│   ├── src/integrations/easyorders/  عميل EasyOrders API وتحويل البيانات
│   ├── src/jobs/                المعالجة الدورية (متوافقة مع Serverless)
│   ├── scripts/init-database.js  scripts/create-admin.js
│   └── tests/                   الاختبارات الآلية
├── .env.example  .gitignore  vercel.json  package.json (npm workspaces)
```

## 2. المتطلبات

- Node.js الإصدار **20.19 أو أحدث** (يُفضّل 22 LTS) و npm.
- حساب MongoDB Atlas (عند التشغيل الحقيقي).
- حساب Vercel للنشر.
- حساب EasyOrders بصلاحية إنشاء API Key و Webhook.

## 3. تثبيت الحزم

```bash
cd solita-courier
npm install
```

## 4. التشغيل المحلي

### أ) بدون قاعدة بيانات (الوضع التجريبي)

مناسب لتجربة الواجهة قبل إضافة بيانات MongoDB:

```bash
npm run dev:mock
```

- الخادم: `http://localhost:4000` — الواجهة: `http://localhost:5173`
- يستخدم قاعدة بيانات مؤقتة في الذاكرة (`mongodb-memory-server`؛ أول تشغيل يحمّل نسخة MongoDB تلقائياً).
- يتم إنشاء بيانات **وهمية** واضحة (أسماء "تجريبي") ويظهر شريط بنفسجي في كل صفحة يوضح أن البيانات وهمية.
- حسابات تجريبية (للوضع التجريبي فقط):
  - مشرف: `01000000001` / `Demo12345678`
  - مندوب: `01000000002` / `Demo12345678`
- الوضع التجريبي **مرفوض تلقائياً** عند `NODE_ENV=production` أو على Vercel، ولا يكتب أبداً في قاعدة بيانات حقيقية حتى لو كان `MONGODB_URI` موجوداً.

### ب) مع MongoDB Atlas

```bash
cp .env.example .env      # ثم املأ القيم
npm run db:init
npm run admin:create
npm run dev
```

## 5. متغيرات البيئة

| المتغير | مطلوب | الوصف |
|---|---|---|
| `MONGODB_URI` | نعم | رابط الاتصال بـ MongoDB Atlas. اسم قاعدة البيانات ثابت: `solita` |
| `SESSION_SECRET` | نعم في الإنتاج | نص عشوائي ≥ 32 حرفاً (لتوقيع رموز CSRF) |
| `CLIENT_ORIGIN` | نعم | رابط الواجهة، مثل `https://solita-courier.vercel.app` (يمكن وضع أكثر من رابط مفصولة بفاصلة) |
| `EASYORDERS_API_KEY` | للمزامنة | مفتاح EasyOrders API بصلاحيات `orders:read` و `orders:update` |
| `EASYORDERS_API_BASE_URL` | لا | الافتراضي `https://api.easy-orders.net` |
| `EASYORDERS_WEBHOOK_SECRET` | للـ Webhook | قيمة `secret` التي يعرضها EasyOrders بعد إنشاء الـ Webhook |
| `EASYORDERS_STATUS_WEBHOOK_SECRET` | اختياري | فقط إذا أنشأت Webhook منفصلاً لتغيير الحالة بسر مختلف |
| `CRON_SECRET` | مُوصى به | يحمي مسار المعالجة الدورية `/api/cron/process` |
| `PORT` | لا | منفذ الخادم المحلي (افتراضي 4000) |
| `MOCK_MODE` | لا | `true` للوضع التجريبي المحلي فقط |

لتوليد سر قوي:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

عند نقص أي إعداد إلزامي، يرفض الخادم البدء برسالة واضحة (محلياً)، وعلى Vercel يرد بخطأ `CONFIG_ERROR` مع تسجيل التفاصيل في سجلات Vercel.

## 6. إعداد MongoDB Atlas

1. أنشئ Cluster (الخطة المجانية M0 تكفي للبداية).
2. **Database Access**: أنشئ مستخدم قاعدة بيانات بكلمة مرور قوية وصلاحية `readWrite`.
3. **Network Access**: أضف `0.0.0.0/0` (لأن عناوين Vercel متغيرة) — أو استخدم تكامل Vercel مع Atlas.
4. **Connect → Drivers**: انسخ رابط `mongodb+srv://...` وضعه في `MONGODB_URI`.
5. لا حاجة لكتابة اسم قاعدة البيانات في الرابط؛ النظام يستخدم `solita` دائماً.

## 7. تهيئة قاعدة البيانات

```bash
npm run db:init
```

ينشئ أو يتحقق من كل المجموعات والفهارس (بما فيها فهرس `easyOrdersId` الفريد لمنع تكرار الطلبات). آمن للتشغيل أكثر من مرة و**لا يحذف أي بيانات أو فهارس**.

## 8. إنشاء حساب المشرف

```bash
npm run admin:create
```

- يطلب الاسم ورقم الموبايل والبريد (اختياري) وكلمة المرور (مخفية أثناء الكتابة).
- كلمة المرور تُحفظ بتشفير Argon2id ولا تُطبع أبداً.
- إذا كان الرقم لحساب مشرف موجود: لا يغيّر شيئاً. لتغيير كلمة المرور: `npm run admin:create -- --reset-password`.
- إذا كان الرقم لحساب مندوب: **يرفض** (لا تتم ترقية مندوب إلى مشرف أبداً).
- بديل غير تفاعلي: `ADMIN_NAME` و `ADMIN_PHONE` و `ADMIN_EMAIL` و `ADMIN_PASSWORD` كمتغيرات بيئة (يتم التحقق منها).

حسابات المندوبين تُنشأ من لوحة المشرف ← المندوبون، وكلمة المرور الأولى مؤقتة يُطلب تغييرها عند أول دخول.

## 9. تشغيل الاختبارات

```bash
npm test          # اختبارات الخادم + الواجهة
npm run lint
npm run build
npm run check     # الثلاثة معاً
```

- اختبارات الخادم تستخدم MongoDB مؤقتة في الذاكرة فقط وتتجاهل `MONGODB_URI`، فلا يمكن أن تمس بيانات الإنتاج.
- EasyOrders يتم محاكاته في الاختبارات (Mock).
- إذا كان لديك `mongod` مثبت محلياً يمكن استخدامه بدلاً من التحميل: `MONGOMS_SYSTEM_BINARY=/path/to/mongod npm test`.

## 10. إعداد EasyOrders API Key

1. لوحة البائع في EasyOrders ← الإعدادات ← **Public API**.
2. **Create New API Key** واختر الصلاحيات: `orders:read` و `orders:update`.
3. انسخ المفتاح فوراً (لا يظهر مرة أخرى) وضعه في `EASYORDERS_API_KEY`.

ما يستخدمه النظام (حسب التوثيق الرسمي `https://public-api-docs.easy-orders.net/`):

- المصادقة بالترويسة `Api-Key: <المفتاح>`.
- `GET /api/v1/external-apps/orders/:order_id` لجلب الطلب كاملاً.
- `PATCH /api/v1/external-apps/orders/:order_id/status` بجسم `{"status": "..."}` لتحديث الحالة.
- الحد: 40 طلباً في الدقيقة؛ النظام يلتزم بـ 35 عبر عداد مشترك في قاعدة البيانات، ويتعامل مع HTTP 429.

المفتاح لا يُرسل أبداً للمتصفح ولا يُسجَّل في السجلات.

## 11. إعداد Webhook

1. EasyOrders ← **Public API ← Webhooks ← Create Webhook**.
2. أدخل الرابط (انظر القسم 14) واحفظ.
3. انسخ قيمة **secret** التي تظهر وضعها في `EASYORDERS_WEBHOOK_SECRET`.

يتحقق النظام من الترويسة `secret` في كل طلب Webhook (حسب التوثيق، بدون اختراع أي توقيع آخر). كل مسار Webhook يقبل شكلي البيانات (طلب جديد / تغيير حالة)، لذلك يكفي Webhook واحد إن كان EasyOrders يرسل الحدثين لنفس الرابط.

التعامل مع الحالات الصعبة:

- **التكرار**: بصمة SHA-256 للمحتوى + فهرس فريد ⇒ الحدث المكرر لا يُعالج مرتين.
- **ترتيب غير صحيح**: تحديثات الطلب الأقدم (`updated_at`) يتم تجاهلها؛ تغيير حالة غير متسلسل يتم التحقق منه بجلب الطلب من API.
- **طلب غير معروف / بيانات ناقصة**: يُجلب الطلب كاملاً من API، أو يؤجَّل الحدث لإعادة المحاولة.
- **أخطاء مؤقتة**: يُحفظ الحدث ويعاد معالجته لاحقاً (رد `202`).
- **الحفاظ على البيانات الداخلية**: تحديثات EasyOrders لا تغيّر التعيين، المراجعات، أو سجلات النقدية.
- **منع الحلقات**: معالجة الـ Webhook لا تُرسل أي تحديث إلى EasyOrders إطلاقاً.

## 12. النشر على Vercel

المشروع مُعد كمشروع Vercel **واحد** من جذر المستودع:

- الواجهة تُبنى إلى `client/dist` وتُقدَّم كملفات ثابتة، مع إعادة توجيه كل مسارات React إلى `index.html`.
- كل طلبات `/api/*` تُوجَّه إلى `api/index.js` (Vercel Function واحدة تشغّل Express).
- الواجهة والـ API على نفس النطاق ⇒ لا حاجة لـ CORS، والكوكيز `SameSite=Lax` و `Secure` و `HttpOnly` تعمل مباشرة.

الخطوات:

1. ارفع المشروع إلى مستودع GitHub.
2. في Vercel: **Add New Project** واختر المستودع.
3. **Root Directory**: اتركه جذر المستودع (`./`). الإعدادات تُقرأ من `vercel.json` (Framework: Other، Build: `npm run build`، Output: `client/dist`).
4. أضف متغيرات البيئة (القسم 13) ثم **Deploy**.
5. بعد النشر: شغّل `npm run db:init` و `npm run admin:create` من جهازك مع نفس `MONGODB_URI`.

ملاحظات Serverless:

- لا توجد عمليات دائمة ولا طوابير في الذاكرة. كل عمليات المزامنة محفوظة في MongoDB (`syncoperations`) وتنفَّذ فوراً بعد الإجراء، ثم تعاد محاولتها عبر Cron أو زر "معالجة العمليات المستحقة الآن" أو `npm run sync:run`.
- الاتصال بـ MongoDB مخزّن على مستوى العملية ويُعاد استخدامه في الاستدعاءات الدافئة.
- `vercel.json` يحدد Cron يومي (`0 3 * * *`) لأن خطة Hobby تسمح بتشغيل يومي فقط. على خطة Pro يمكن تغييره إلى `*/10 * * * *`.
- لا يتم رفع ملفات على قرص Vercel؛ "إثبات التسليم" حالياً حقل نصي مرجعي (رقم إيصال/اسم المستلم).

## 13. متغيرات البيئة على Vercel

Project → Settings → Environment Variables (بيئة Production):

```
MONGODB_URI=...
SESSION_SECRET=...
CLIENT_ORIGIN=https://<اسم-مشروعك>.vercel.app
EASYORDERS_API_KEY=...
EASYORDERS_API_BASE_URL=https://api.easy-orders.net
EASYORDERS_WEBHOOK_SECRET=...
CRON_SECRET=...
```

لا تضف `MOCK_MODE` على Vercel. `NODE_ENV` يضبطه Vercel تلقائياً. أعد النشر بعد تغيير أي متغير.

## 14. روابط Webhook في الإنتاج

```
https://<نطاقك>/api/webhooks/easyorders/orders
https://<نطاقك>/api/webhooks/easyorders/status
```

للتحقق السريع (يجب أن يرجع 401 بدون السر الصحيح):

```bash
curl -i -X POST https://<نطاقك>/api/webhooks/easyorders/orders -H "Content-Type: application/json" -d '{}'
```

## 15. الربط مع موقع سوليتا الحالي

- يستمر العملاء في الشراء من `https://solita.myeasyorders.com/` بنفس صفحة الدفع الحالية. **لا يتم إنشاء أي طلب من هذا النظام**، لذلك لا يوجد خطر تكرار الطلبات.
- بمجرد إعداد Webhook، كل طلب جديد يظهر في صفحة "الطلبات" بحالة "جديد".
- يمكن إضافة رابط داخلي لفريق العمل إلى لوحة النظام (مثلاً نطاق فرعي `ops.solita...`) عبر إعداد Domain في Vercel؛ اللوحة غير مخصصة للعملاء ومحمية بتسجيل الدخول و `noindex`.

## 16. حل المشكلات الشائعة

| المشكلة | الحل |
|---|---|
| `MONGODB_URI is required` | أضف الرابط في `.env` أو استخدم `npm run dev:mock` |
| `CONFIG_ERROR` على Vercel | متغير ناقص أو `SESSION_SECRET` أقصر من 32 حرفاً؛ راجع Runtime Logs |
| `DATABASE_UNAVAILABLE` | تحقق من Network Access في Atlas (اسمح بـ `0.0.0.0/0`) ومن اسم المستخدم/كلمة المرور |
| "انتهت صلاحية الجلسة الأمنية" | حدّث الصفحة (رمز CSRF جديد). تأكد أن `CLIENT_ORIGIN` يطابق نطاق الواجهة |
| Webhook يرجع 401 | قيمة `EASYORDERS_WEBHOOK_SECRET` لا تطابق السر في EasyOrders |
| Webhook يرجع 503 | لم يتم ضبط `EASYORDERS_WEBHOOK_SECRET` |
| المزامنة "فشلت" بخطأ `EASYORDERS_API_KEY is not configured` | أضف المفتاح ثم استخدم "إعادة المحاولة" في صفحة المزامنة |
| المزامنة "فشلت" برمز 401/403 | المفتاح خاطئ أو بدون صلاحية `orders:update` |
| "إعادة محاولة مجدولة" مع حد الطلبات | تم تجاوز 40 طلب/دقيقة؛ ستتم المحاولة تلقائياً في الدقيقة التالية |
| أول `npm test` بطيء | تحميل MongoDB المؤقتة لأول مرة فقط |

## 17. الشعار

الشعار الرسمي المرفق محفوظ بدون أي تعديل في:

```
client/src/assets/solita-logo.svg     (يظهر في صفحة الدخول والقوائم)
client/public/favicon.svg             (نسخة مطابقة لأيقونة المتصفح)
```

لاستبداله: ضع الملف الجديد بنفس الاسم والمسار (أو عدّل الاستيراد في `client/src/components/ui.jsx`). يُعرض باستخدام `object-fit: contain` للحفاظ على النسب والألوان والشفافية.

## 18. إيقاف الوضع التجريبي والتحقق من الجاهزية

1. تأكد أن `MOCK_MODE` غير موجود أو `false`، وأن `MONGODB_URI` مضبوط.
2. `npm run db:init` ثم `npm run admin:create`.
3. سجّل الدخول كمشرف وافتح "نظرة عامة" ← بطاقة **جاهزية التكامل**: يجب أن تكون كل البنود "مُهيأ".
4. اختبار حقيقي مع EasyOrders (يتطلب بياناتك):
   - أنشئ طلباً تجريبياً في المتجر ← يجب أن يظهر في "الطلبات".
   - غيّر حالته في EasyOrders ← يجب أن تتغير "حالة EasyOrders" في النظام.
   - عيّن مندوباً، ابدأ التوصيل من حساب المندوب (يتم إرسال `in_delivery`)، أرسل "تم التسليم"، ثم وافق كمشرف ← يجب أن تصبح الحالة في EasyOrders `delivered` وتظهر "تمت المزامنة".
5. تأكد من عدم ظهور الشريط البنفسجي "وضع تجريبي".

---

## مرجع سريع للحالات

- **حالة EasyOrders** (`sourceStatus`): تُحفظ كما هي (`pending`, `confirmed`, `pending_payment`, `paid`, `paid_failed`, `processing`, `waiting_for_pickup`, `in_delivery`, `delivered`, `canceled`, `returning_from_delivery`, `request_refund`, `refund_in_progress`, `refunded`) وأي قيمة جديدة تُعرض كما هي دون أعطال.
- **حالة التوصيل الداخلية** (`deliveryStatus`): `new` ← `assigned` ← `out_for_delivery` ← `pending_delivery_review` ← `delivered`، أو `failed` / `cancelled`.
- **حالة المراجعة**: `pending` / `approved` / `rejected`.
- **حالة المزامنة**: `pending` / `retry_scheduled` / `needs_reconciliation` / `succeeded` / `failed`.

قواعد مهمة:

- تعيين المندوب لا يغيّر حالة EasyOrders.
- المحاولة الفاشلة لا تلغي الطلب في EasyOrders، ولا توجد حالة `failed` في EasyOrders.
- "تم التسليم" من المندوب لا يرسل `delivered`؛ فقط موافقة المشرف تفعل ذلك، ولا تُعتبر المزامنة ناجحة إلا بعد رد EasyOrders بالنجاح.
- إذا انتهت مهلة الطلب لـ EasyOrders (نتيجة غير مؤكدة)، يقرأ النظام حالة الطلب من EasyOrders قبل إعادة الإرسال.
- إلغاء الطلب في EasyOrders يلغي سير التوصيل الداخلي (مع الإبقاء على المندوب في السجل) ما لم يكن الطلب في مرحلة المراجعة أو مُسلّماً، وعندها يظهر تنبيه "تعارض".
- تعيين `delivered` مباشرة في EasyOrders لا يعتمد التسليم داخلياً؛ يظهر تنبيه تعارض.
- التسليم لا يعني استلام النقدية؛ النقدية تُسجّل وتُتحقق في "النقدية والتسويات"، والطلب لا يدخل في أكثر من تسوية.

## نقاط الـ API

المصادقة: `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `GET /api/auth/csrf` · `POST /api/auth/change-password` · `GET /api/auth/notifications`

المشرف: `/api/admin/overview` · `/api/admin/couriers` (POST/GET) · `/api/admin/couriers/:id` (GET/PATCH) · `/api/admin/couriers/:id/active` · `/api/admin/couriers/:id/password` · `/api/admin/orders` · `/api/admin/orders/:id` · `/api/admin/orders/:id/assignment` · `/api/admin/orders/:id/status` · `/api/admin/orders/:id/events` · `/api/admin/delivery-reviews` · `/api/admin/delivery-reviews/:id` · `/approve` · `/reject` · `/api/admin/sync/failures` · `/api/admin/sync/:id/retry` · `/api/admin/sync/process-due` · `/api/admin/cash/overview` · `/api/admin/cash/eligible-orders` · `/api/admin/cash/remittances` (+ `/:id/receive` `/:id/verify` `/:id/cancel`)

المندوب: `GET /api/courier/orders` · `GET /api/courier/orders/:id` · `PATCH /api/courier/orders/:id/status` · `POST /api/courier/orders/:id/delivery-report` · `GET /api/courier/cash` · `POST /api/courier/cash/remittances`

Webhooks: `POST /api/webhooks/easyorders/orders` · `POST /api/webhooks/easyorders/status` — Cron: `GET /api/cron/process`

## الأمان باختصار

Argon2id لكلمات المرور · جلسات في قاعدة البيانات بكوكيز `HttpOnly` + `Secure` + `SameSite=Lax` (بادئة `__Host-` في الإنتاج) · CSRF (Double-submit موقّع + فحص Origin) · Helmet · تحديد معدل الطلبات بعدّاد في MongoDB (يعمل عبر كل نسخ Serverless) + قفل مؤقت للحساب بعد محاولات فاشلة · Zod مع رفض الحقول غير المعروفة (منع Mass Assignment) · الصلاحيات تُفرض في الخادم من بيانات المستخدم في قاعدة البيانات فقط · المندوب لا يرى إلا طلباته · حد حجم الطلب 256KB · رسائل أخطاء آمنة · إخفاء الأسرار من السجلات وسجل التدقيق.

</div>
