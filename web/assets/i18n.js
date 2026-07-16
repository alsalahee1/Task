// Lightweight i18n: English + Arabic (RTL). Language persists per device.
const DICT = {
  en: {
    // shared
    sign_in: 'Sign in', sign_out: 'Sign out', tagline: 'Airport wheelchair assistance — task manager',
    username: 'Username', password: 'Password',
    sla_met: 'SLA met', sla_breached: 'SLA breached', overdue: 'OVERDUE',
    // statuses
    st_CREATED: 'Unassigned', st_ASSIGNED: 'Assigned', st_ACCEPTED: 'Accepted',
    st_EN_ROUTE_TO_STORAGE: 'Going to storage', st_WHEELCHAIR_COLLECTED: 'Chair collected',
    st_ARRIVED_AT_PICKUP: 'At pickup point', st_PASSENGER_PICKED_UP: 'Passenger on board',
    st_IN_TRANSIT: 'In transit', st_PASSENGER_DELIVERED: 'Delivered',
    st_COMPLETED: 'Completed', st_CANCELLED: 'Cancelled',
    st_PROBLEM_REPORTED: 'Problem reported', st_ESCALATED: 'Escalated', st_GATE_CHANGED: 'Gate changed',
    // agent actions
    act_ACCEPTED: 'Accept task', act_EN_ROUTE_TO_STORAGE: 'Heading to wheelchair storage',
    act_WHEELCHAIR_COLLECTED: 'Wheelchair collected', act_ARRIVED_AT_PICKUP: 'Arrived at pickup point',
    act_PASSENGER_PICKED_UP: 'Passenger picked up', act_IN_TRANSIT: 'Start moving to destination',
    act_PASSENGER_DELIVERED: 'Passenger delivered', act_COMPLETED: 'Complete task',
    // agent app
    hi: 'Hi', my_tasks: 'My tasks', back_tasks: '← My tasks',
    active_tasks: 'active task(s)', on_duty: 'You are on duty', off_duty: 'You are off duty',
    on_duty_hint: 'Dispatch can assign you tasks', off_duty_hint: 'Go on duty to receive tasks',
    start_shift: 'Start shift', end_shift: 'End shift',
    no_tasks: 'No active tasks.', tasks_appear: 'New tasks appear here automatically.',
    chair_from: 'chair from', pickup_l: 'pickup', est: 'est', next: 'next',
    wheelchair_from: 'Wheelchair from', pickup: 'Pickup', destination: 'Destination',
    estimated: 'Estimated', report_problem: '⚠ Report problem',
    problem_prompt: 'Describe the problem (e.g. broken wheelchair, passenger not found, elevator out of service):',
    problem_sent: 'Problem reported to dispatch', task_done: 'Task completed — great job! ✅',
    offline_note: '📡 Offline — actions are queued and will sync',
    offline_saved: 'Offline — action saved, will sync automatically',
    total: 'Total', distance: 'Distance', estimate: 'estimate',
    // admin
    tab_board: 'Live board', tab_new: '＋ New task', tab_map: 'Map', tab_flights: 'Flights',
    tab_templates: 'Time templates', tab_reports: 'Reports', tab_team: 'Team',
    col_unassigned: 'Unassigned', col_assigned: 'Assigned', col_progress: 'In progress',
    col_completed: 'Completed', col_cancelled: 'Cancelled',
    no_agent: 'no agent', auto_assign: '⚡ Auto-assign best agent', assign_selected: 'Assign selected',
    cancel_task: 'Cancel task…', close: '✕ Close', create_task: 'Create task',
    new_task_title: 'New assistance task', passenger_name: 'Passenger name *',
    passenger_phone: 'Passenger phone (for SMS updates)', notes: 'Notes for the agent',
    assign_now: 'Assign now (optional)', assign_later: '— assign later —',
    auto_assign_opt: '⚡ auto-assign best available agent',
    flight_number: 'Flight number', direction: 'Direction *', priority: 'Priority',
    storage_opt: 'Wheelchair storage (optional)', no_storage: '— none (no storage chair needed) —',
    pickup_point: 'Pickup point *', your_estimate: 'Your estimate (min)', sla_target: 'SLA target (min)',
    sms_log: 'Passenger SMS log',
    tab_wheelchairs: 'Wheelchairs',
    tab_locations: 'Locations',
    all_terminals: 'All terminals',
    qr_label: 'Wheelchair QR code', qr_placeholder: 'scan or type e.g. WC-S1-001',
    scan: '📷 Scan', chair: 'Chair', scan_hint: 'Point the camera at the chair label',
    no_camera_qr: 'Camera scanning not supported on this device — type the code instead',
  },
  ar: {
    sign_in: 'تسجيل الدخول', sign_out: 'تسجيل الخروج',
    tagline: 'خدمة الكراسي المتحركة في المطار — إدارة المهام',
    username: 'اسم المستخدم', password: 'كلمة المرور',
    sla_met: 'ضمن الوقت المحدد', sla_breached: 'تجاوز الوقت المحدد', overdue: 'متأخر',
    st_CREATED: 'غير مُسند', st_ASSIGNED: 'مُسند', st_ACCEPTED: 'مقبول',
    st_EN_ROUTE_TO_STORAGE: 'في الطريق إلى المخزن', st_WHEELCHAIR_COLLECTED: 'تم استلام الكرسي',
    st_ARRIVED_AT_PICKUP: 'عند نقطة الاستلام', st_PASSENGER_PICKED_UP: 'الراكب معنا',
    st_IN_TRANSIT: 'في الطريق', st_PASSENGER_DELIVERED: 'تم التوصيل',
    st_COMPLETED: 'مكتملة', st_CANCELLED: 'ملغاة',
    st_PROBLEM_REPORTED: 'تم الإبلاغ عن مشكلة', st_ESCALATED: 'تصعيد', st_GATE_CHANGED: 'تغيّرت البوابة',
    act_ACCEPTED: 'قبول المهمة', act_EN_ROUTE_TO_STORAGE: 'التوجه إلى مخزن الكراسي',
    act_WHEELCHAIR_COLLECTED: 'تم استلام الكرسي المتحرك', act_ARRIVED_AT_PICKUP: 'وصلت إلى نقطة الاستلام',
    act_PASSENGER_PICKED_UP: 'تم استلام الراكب', act_IN_TRANSIT: 'بدء التحرك إلى الوجهة',
    act_PASSENGER_DELIVERED: 'تم توصيل الراكب', act_COMPLETED: 'إنهاء المهمة',
    hi: 'مرحباً', my_tasks: 'مهامي', back_tasks: '→ مهامي',
    active_tasks: 'مهمة نشطة', on_duty: 'أنت في الخدمة', off_duty: 'أنت خارج الخدمة',
    on_duty_hint: 'يمكن للمرسل إسناد مهام إليك', off_duty_hint: 'ابدأ الدوام لاستقبال المهام',
    start_shift: 'بدء الدوام', end_shift: 'إنهاء الدوام',
    no_tasks: 'لا توجد مهام نشطة.', tasks_appear: 'ستظهر المهام الجديدة هنا تلقائياً.',
    chair_from: 'الكرسي من', pickup_l: 'الاستلام', est: 'التقدير', next: 'التالي',
    wheelchair_from: 'الكرسي المتحرك من', pickup: 'نقطة الاستلام', destination: 'الوجهة',
    estimated: 'الوقت المقدر', report_problem: '⚠ الإبلاغ عن مشكلة',
    problem_prompt: 'صف المشكلة (مثل: كرسي معطل، لم يتم العثور على الراكب، المصعد لا يعمل):',
    problem_sent: 'تم إبلاغ المرسل بالمشكلة', task_done: 'اكتملت المهمة — أحسنت! ✅',
    offline_note: '📡 غير متصل — سيتم مزامنة الإجراءات تلقائياً',
    offline_saved: 'غير متصل — تم حفظ الإجراء وستتم مزامنته تلقائياً',
    total: 'الإجمالي', distance: 'المسافة', estimate: 'التقدير',
    tab_board: 'اللوحة المباشرة', tab_new: '＋ مهمة جديدة', tab_map: 'الخريطة', tab_flights: 'الرحلات',
    tab_templates: 'قوالب الوقت', tab_reports: 'التقارير', tab_team: 'الفريق',
    col_unassigned: 'غير مُسندة', col_assigned: 'مُسندة', col_progress: 'قيد التنفيذ',
    col_completed: 'مكتملة', col_cancelled: 'ملغاة',
    no_agent: 'بدون موظف', auto_assign: '⚡ إسناد تلقائي لأفضل موظف', assign_selected: 'إسناد المحدد',
    cancel_task: 'إلغاء المهمة…', close: '✕ إغلاق', create_task: 'إنشاء المهمة',
    new_task_title: 'مهمة مساعدة جديدة', passenger_name: 'اسم الراكب *',
    passenger_phone: 'هاتف الراكب (لرسائل SMS)', notes: 'ملاحظات للموظف',
    assign_now: 'إسناد الآن (اختياري)', assign_later: '— الإسناد لاحقاً —',
    auto_assign_opt: '⚡ إسناد تلقائي لأفضل موظف متاح',
    flight_number: 'رقم الرحلة', direction: 'الاتجاه *', priority: 'الأولوية',
    storage_opt: 'مخزن الكراسي (اختياري)', no_storage: '— بدون (لا حاجة لكرسي من المخزن) —',
    pickup_point: 'نقطة الاستلام *', your_estimate: 'تقديرك (دقيقة)', sla_target: 'هدف SLA (دقيقة)',
    sms_log: 'سجل رسائل الراكب',
    tab_wheelchairs: 'الكراسي المتحركة',
    tab_locations: 'المواقع',
    all_terminals: 'كل المباني',
    qr_label: 'رمز QR للكرسي', qr_placeholder: 'امسح أو اكتب مثل WC-S1-001',
    scan: '📷 مسح', chair: 'الكرسي', scan_hint: 'وجّه الكاميرا نحو ملصق الكرسي',
    no_camera_qr: 'المسح بالكاميرا غير مدعوم على هذا الجهاز — اكتب الرمز يدوياً',
  },
};

export let lang = localStorage.getItem('aero_lang') || 'en';

export const t = key => DICT[lang]?.[key] ?? DICT.en[key] ?? key;
export const statusLabel = s => t('st_' + s);
export const actionLabel = s => t('act_' + s);

export function setLang(l) {
  localStorage.setItem('aero_lang', l);
  location.reload();
}

export function applyDir() {
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = lang;
}

// Small language toggle button; call with a parent element.
export function langToggle(parent) {
  const btn = document.createElement('button');
  btn.textContent = lang === 'ar' ? 'English' : 'العربية';
  btn.title = 'Switch language';
  btn.onclick = () => setLang(lang === 'ar' ? 'en' : 'ar');
  parent.appendChild(btn);
  return btn;
}
