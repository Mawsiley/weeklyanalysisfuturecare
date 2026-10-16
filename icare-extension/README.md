# FutureCare Weekly — iCare Reports (1.0.0)

إضافة Chrome مستقلة لتطبيق التحليل الأسبوعي (weeklyanalysisfuturecare). تجلب تقرير الأداء من iCare باستخدام جلستك المسجّلة — لا تحفظ كلمة مرور؛ التوكن في ذاكرة المتصفح فقط ويُمسح عند إغلاقه، ولا يصل إلى صفحة التحليل.

## التثبيت
1. `chrome://extensions` ← فعّل Developer mode ← Load unpacked ← اختر هذا المجلد.
2. افتح https://icare.com.sa وسجّل الدخول (مرة لكل جلسة متصفح).
3. في التحليل الأسبوعي: صندوق «📥 جلب تقرير الأداء من iCare» ← اختر الشهر والمدن ← جلب الآن.

## المصدر ولكل صفحة
| الصفحة | المصدر في iCare | المعالجة |
|---|---|---|
| الرئيسية (index.html) | `/performance-follow-up/report` — جدة، مكة، ينبع | مسار رفع الملف المعتاد (استبعاد Deactive، تصفير الجزئي، الفترة من Last Visit) |
| DR Not Done | نفس التقرير | DRP>0 و DRD=0 مع استبعاد Deactive |
| GP Extra | gp-extra-req-list | غير مربوط بعد — رفع يدوي |

الطلبات: `filter-options` ← لكل مدينة `report-plan?month&city` ← `report?month&city&ids` (دفعات 200). يُبنى الملف بنفس أعمدة تصدير iCare (`performance-report_<الشهر>_all`).
الصفحات المسموح لها فقط: weeklyanalysisfuturecare.netlify.app و localhost:5177 (للاختبار).
المصدر محفوظ أيضاً في مستودع التطبيق: `icare-extension/`.
