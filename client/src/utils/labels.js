// Arabic labels for raw status values. Raw values stay in the database;
// unknown values fall back to the raw string, so new statuses never break the UI.

export const SOURCE_STATUS_LABELS = {
  pending: 'قيد الانتظار',
  confirmed: 'مؤكد',
  pending_payment: 'بانتظار الدفع',
  paid: 'مدفوع',
  paid_failed: 'فشل الدفع',
  processing: 'قيد التجهيز',
  waiting_for_pickup: 'بانتظار الاستلام من المخزن',
  in_delivery: 'جاري التوصيل',
  delivered: 'تم التسليم',
  canceled: 'ملغي',
  returning_from_delivery: 'مرتجع من التوصيل',
  request_refund: 'طلب استرداد',
  refund_in_progress: 'جاري الاسترداد',
  refunded: 'تم الاسترداد',
};

export const DELIVERY_STATUS_LABELS = {
  new: 'جديد',
  assigned: 'معيّن لمندوب',
  out_for_delivery: 'خرج للتوصيل',
  pending_delivery_review: 'بانتظار مراجعة التسليم',
  delivered: 'تم التسليم (معتمد)',
  failed: 'محاولة فاشلة',
  cancelled: 'ملغي',
};

export const REVIEW_STATUS_LABELS = {
  pending: 'بانتظار المراجعة',
  approved: 'تمت الموافقة',
  rejected: 'مرفوض',
};

export const REVIEW_SYNC_LABELS = {
  not_started: 'لم تبدأ',
  pending: 'جاري المزامنة',
  synced: 'تمت المزامنة',
  failed: 'فشلت المزامنة',
};

export const ORDER_SYNC_LABELS = {
  none: 'لا توجد مزامنة',
  pending: 'جاري المزامنة',
  synced: 'متزامن',
  failed: 'فشلت المزامنة',
};

export const SYNC_OP_LABELS = {
  pending: 'بانتظار التنفيذ',
  in_progress: 'جاري التنفيذ',
  retry_scheduled: 'إعادة محاولة مجدولة',
  needs_reconciliation: 'يحتاج تحقق من EasyOrders',
  succeeded: 'نجحت',
  failed: 'فشلت',
};

export const FAILURE_REASON_LABELS = {
  no_answer: 'العميل لم يرد',
  reschedule_requested: 'العميل طلب تأجيل الموعد',
  address_not_found: 'تعذر الوصول للعنوان',
  customer_refused: 'العميل رفض الاستلام',
  other: 'سبب آخر',
};

export const REMITTANCE_STATUS_LABELS = {
  declared: 'أعلنه المندوب',
  received: 'تم الاستلام (بانتظار التحقق)',
  reconciled: 'تمت التسوية',
  discrepancy: 'يوجد فرق',
  cancelled: 'ملغاة',
};

export const PAYMENT_STATUS_LABELS = {
  unpaid: 'غير مدفوع',
  paid: 'مدفوع',
  failed: 'فشل الدفع',
  refunded: 'مسترد',
};

export const EVENT_LABELS = {
  order_imported: 'تم استيراد الطلب من EasyOrders',
  source_updated: 'تحديث بيانات من EasyOrders',
  source_status_changed: 'تغيرت حالة EasyOrders',
  source_status_echo: 'تأكيد حالة من EasyOrders',
  stale_source_update_ignored: 'تم تجاهل تحديث قديم من EasyOrders',
  assigned: 'تعيين مندوب',
  reassigned: 'إعادة تعيين مندوب',
  unassigned: 'إلغاء تعيين المندوب',
  delivery_started: 'بدأ المندوب التوصيل',
  delivery_failed: 'محاولة توصيل فاشلة',
  delivery_submitted: 'أرسل المندوب تأكيد التسليم للمراجعة',
  review_approved: 'وافق المشرف على التسليم',
  review_rejected: 'رفض المشرف تأكيد التسليم',
  sync_requested: 'طلب مزامنة مع EasyOrders',
  sync_succeeded: 'نجحت المزامنة مع EasyOrders',
  sync_failed: 'فشلت محاولة المزامنة',
  sync_retry_requested: 'إعادة محاولة المزامنة يدوياً',
  order_cancelled: 'إلغاء الطلب',
  order_reopened: 'إعادة فتح الطلب',
  source_conflict_acknowledged: 'تم الاطلاع على التعارض',
  remittance_linked: 'إضافة الطلب لتسوية نقدية',
  remittance_released: 'إزالة الطلب من تسوية ملغاة',
  remittance_created: 'إنشاء تسوية نقدية',
  remittance_received: 'استلام النقدية',
  remittance_verified: 'التحقق من النقدية',
  remittance_cancelled: 'إلغاء التسوية',
  courier_created: 'إنشاء حساب المندوب',
  courier_updated: 'تعديل بيانات المندوب',
  courier_activated: 'تفعيل الحساب',
  courier_deactivated: 'إيقاف الحساب',
  courier_password_reset: 'إعادة تعيين كلمة المرور',
  password_changed: 'تغيير كلمة المرور',
};

export const label = (map, value) => (value ? map[value] || value : '—');

// Badge tones per status.
export const DELIVERY_TONES = {
  new: 'neutral',
  assigned: 'info',
  out_for_delivery: 'indigo',
  pending_delivery_review: 'warning',
  delivered: 'success',
  failed: 'danger',
  cancelled: 'muted',
};

export const SOURCE_TONES = {
  pending: 'neutral',
  confirmed: 'info',
  pending_payment: 'warning',
  paid: 'success',
  paid_failed: 'danger',
  processing: 'info',
  waiting_for_pickup: 'indigo',
  in_delivery: 'indigo',
  delivered: 'success',
  canceled: 'muted',
  returning_from_delivery: 'warning',
  request_refund: 'warning',
  refund_in_progress: 'warning',
  refunded: 'muted',
};

export const REVIEW_TONES = { pending: 'warning', approved: 'success', rejected: 'danger' };
export const SYNC_TONES = {
  none: 'muted',
  not_started: 'muted',
  pending: 'warning',
  in_progress: 'warning',
  retry_scheduled: 'warning',
  needs_reconciliation: 'warning',
  synced: 'success',
  succeeded: 'success',
  failed: 'danger',
};
export const REMITTANCE_TONES = {
  declared: 'info',
  received: 'warning',
  reconciled: 'success',
  discrepancy: 'danger',
  cancelled: 'muted',
};
