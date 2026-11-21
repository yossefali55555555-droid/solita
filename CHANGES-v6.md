# v6: كوبونات الطلبات وأوائل سوليتا

## 1) الكوبون على الطلب
- `Order.couponCode` (lowercase) و`Order.couponDiscount` (قرش) من `coupon_code` و`coupon_discount` في بيانات EasyOrders (Webhook والسحب والاستيراد). تأكدنا إن طلب فيه كوبون بيرجع الحقلين من `GET /orders/:id`. الحقلين بيتحدثوا مع باقي حقول المصدر، وغيابهم من بيانات جزئية مبيمسحش القديم.
- فهرس sparse على `couponCode`. **`npm run db:init` مرة واحدة بعد الدمج** (فهرس الطلبات + مجموعة `founders`).

## 2) أوائل سوليتا
- مجموعة `founders` (`Founder`): رقم فريد، العميل، رقم الهاتف (فريد)، الطلب (فريد)، تاريخ الانضمام، `benefitUntil` (12 شهر)، `personalCode` (كوبون المؤسس) و`friendCode` (كوبون الصاحب) و`notes`.
- **الترقيم تلقائي** عند الموافقة على التسليم (`approveReview`): أول العملاء لحد الحد الأقصى، مرة لكل رقم هاتف ولكل طلب، ولا بيرمي خطأ ولا بيغير الطلب. الطلبات التجريبية مستبعدة.
- الأكواد بتتعمل في EasyOrders وبتتسجل هنا. `friendCode` كل طلب بيستخدمه (غير الملغي) = فرصة زيادة في السحب (`drawEntries = 1 + referrals`)، ومنع تكرار نفس الكود عند مؤسسين.
- `site_settings.founders`: `{ enabled, cap = 50, showCounterAfter = 10 }` (قسم جديد في الإعدادات، له default، فمفيش migration).
- `GET /api/public/site-config` بقى فيه `settings.founders = { enabled, cap, taken, remaining, showCounter }`. أرقام بس، من غير أي بيانات عميل. `showCounter` بيبقى `true` بعد `showCounterAfter` مؤسسين.
- Admin: `GET /api/admin/founders`، `PATCH /api/admin/founders/:id` (`personalCode`, `friendCode`, `notes` بس، strict).
- اللوحة: صفحة «أوائل سوليتا» وقسم في «إعدادات الموقع».

## الاختبارات
- `server/tests/founders.test.js` (7 اختبارات): قراءة الكوبون، الترقيم والتكرار والحد الأقصى والإيقاف، الصلاحيات، الإحالات وتفرد الأكواد، والعداد العام من غير بيانات عملاء.
- السيرفر كله 143 اختبار ناجح، والـ client lint/test/build ناجحين.

## بعد الدمج
- `npm run db:init` على الإنتاج (يوسف).
- سكربت الموقع (مرحلة تانية، مش في الـ PR ده): يقرأ `settings.founders` ويظهر «باقي X من 50» لما `showCounter` تبقى true.
