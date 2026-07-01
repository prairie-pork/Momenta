(async function () {

// Retry helper: keeps trying up to `tries` times with delay for TLS13 flakiness
async function retryQuery(fn, tries = 3, delay = 1500) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.warn('retry ' + (i + 1) + '/' + tries + ' failed, retrying...');
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

const user = await requireAuth();
if (!user) {
  throw new Error('Redirecting to login...');
}

// =============================================
// User Bar
// =============================================
const userBar = document.getElementById('sidebar-user');
const userEmailSpan = document.getElementById('sidebar-email');
const logoutBtn = document.getElementById('logout-btn');
const loadingScreen = document.getElementById('loading-screen');

userEmailSpan.textContent = user.email;
userBar.style.display = 'block';
loadingScreen.querySelector('p').textContent = 'Loading data...';

logoutBtn.addEventListener('click', async () => {
  await signOut();
  window.location.href = 'login.html';
});

// =============================================
// Calendar Switcher / Farm Management State
// =============================================
let calendars = [];
let currentCalendarId = null;
let currentCalendar = null; // full object

async function loadCalendars() {
  const { data: owned, error: err1 } = await supabase
    .from('calendars')
    .select('*')
    .eq('owner_id', user.id);
  if (err1) { console.error('Error loading owned calendars:', err1); throw err1; }

  const { data: memberCalIds, error: err2 } = await supabase
    .from('calendar_members')
    .select('calendar_id')
    .eq('user_id', user.id);
  if (err2) { console.error('Error loading memberships:', err2); throw err2; }

  let memberCals = [];
  if (memberCalIds && memberCalIds.length > 0) {
    const ids = memberCalIds.map(m => m.calendar_id);
    const { data: cals, error: err3 } = await supabase
      .from('calendars')
      .select('*')
      .in('id', ids);
    if (!err3) memberCals = cals || [];
  }

  calendars = [...(owned || []), ...memberCals];
  const seen = {};
  calendars = calendars.filter(c => { if (seen[c.id]) return false; seen[c.id] = true; return true; });

  // Filter out Personal calendars — only show farms
  calendars = calendars.filter(c => c.type !== 'personal');

  // Restore last-used calendar from localStorage, or pick first
  const savedId = localStorage.getItem('momenta_calendar_id');
  if (savedId && calendars.find(c => c.id === savedId)) {
    currentCalendarId = savedId;
  } else {
    currentCalendarId = calendars.length > 0 ? calendars[0].id : null;
  }
  currentCalendar = calendars.find(c => c.id === currentCalendarId) || null;
  if (currentCalendarId) {
    localStorage.setItem('momenta_calendar_id', currentCalendarId);
  } else {
    localStorage.removeItem('momenta_calendar_id');
  }
  await renderCalendarSwitcher();
  updateFarmButton();
  updateFarmAvailability();
  subscribeToCalendarChanges();
}

async function ensureActiveCalendar() {
  if (currentCalendarId) return true;
  try {
    await loadCalendars();
  } catch (err) {
    console.error('Could not load calendars:', err);
    return false;
  }
  return !!currentCalendarId;
}

let calendarSubscription = null;

function subscribeToCalendarChanges() {
  if (calendarSubscription) {
    supabase.removeChannel(calendarSubscription);
    calendarSubscription = null;
  }
  if (!currentCalendarId) return;
  calendarSubscription = supabase.channel('calendar-changes-' + currentCalendarId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'events', filter: 'calendar_id=eq.' + currentCalendarId },
      (payload) => {
        if (payload.new && payload.new.user_id === user.id) return;
        updateCalendar();
      }
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'calendar_events', filter: 'calendar_id=eq.' + currentCalendarId },
      (payload) => {
        if (payload.new && payload.new.user_id === user.id) return;
        updateCalendar();
      }
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'custom_event_types' },
      async (payload) => {
        console.log('[Momenta] Realtime: custom_event_types changed', payload.eventType, payload.new?.id, payload.old?.id);
        await loadCalendarCustomEventTypes();
        await updateCalendar();
      }
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'calendar_members', filter: 'user_id=eq.' + user.id },
      async () => {
        await loadCalendars();
        await updateCalendar();
      }
    )
    .subscribe();
}

async function renderCalendarSwitcher() {
  const container = document.getElementById('calendar-list');
  if (!container) return;

  if (calendars.length === 0) {
    container.innerHTML = '<p class="empty-farms">No farms yet.</p>';
    return;
  }

  // Check which farms have other members (for icon)
  const farmIds = calendars.filter(c => c.type === 'farm').map(c => c.id);
  const sharedIds = new Set();
  if (farmIds.length > 0) {
    const { data: memberCounts } = await supabase
      .from('calendar_members')
      .select('calendar_id')
      .in('calendar_id', farmIds);
    if (memberCounts) {
      for (const m of memberCounts) sharedIds.add(m.calendar_id);
    }
  }

  const iconPrivate = '<span class="cal-btn-icon" title="Private farm"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7.5 8 2.5l6 5V14H2V7.5z"/><path d="M6 14V9h4v5"/></svg></span>';
  const iconShared = '<span class="cal-btn-icon" title="Shared farm"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5" r="2.25"/><circle cx="10.5" cy="5" r="2.25"/><path d="M1 13.5c0-2.5 2-3.75 4.5-3.75S9.5 11 9.5 13.5"/><path d="M6.5 13.5c0-2 1.75-3.25 4-3.25s4 1.25 4 3.25"/></svg></span>';


  let html = '';
  for (const cal of calendars) {
    const active = cal.id === currentCalendarId ? ' cal-btn-active' : '';
    const icon = sharedIds.has(cal.id) ? iconShared : iconPrivate;
    const label = escapeHtml(cal.name);
    html += '<button class="cal-btn' + active + '" data-cal-id="' + escapeAttr(cal.id) + '">' + icon + '<span class="cal-btn-label">' + label + '</span></button>';
  }
  container.innerHTML = html;
  container.querySelectorAll('.cal-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentCalendarId = btn.dataset.calId;
      currentCalendar = calendars.find(c => c.id === currentCalendarId) || null;
      localStorage.setItem('momenta_calendar_id', currentCalendarId);
      await renderCalendarSwitcher();
      updateFarmButton();
      subscribeToCalendarChanges();
      updateCalendar();
    });
  });
}

function updateFarmButton() {
  const btn = document.getElementById('manage-farm-btn');
  if (!btn) return;
  if (currentCalendar && currentCalendar.type === 'farm' && currentCalendar.owner_id === user.id) {
    btn.style.display = 'block';
  } else {
    btn.style.display = 'none';
  }
}

function updateFarmAvailability() {
  const hasFarm = calendars.length > 0;
  const disabledIds = ['manage-farm-btn', 'add-batch-btn', 'all-events-btn', 'year-view-btn'];
  for (const id of disabledIds) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !hasFarm;
  }
  // Mobile nav buttons
  const mobileDisabledIds = ['mobile-add-batch-btn', 'mobile-add-event-btn', 'mobile-review-btn'];
  for (const id of mobileDisabledIds) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = !hasFarm;
      if (!hasFarm) btn.classList.add('mobile-nav-disabled');
      else btn.classList.remove('mobile-nav-disabled');
    }
  }
}

// =============================================
// Calendar State
// =============================================
const monthDisplay = document.getElementById('month-display');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const dayCells = document.querySelectorAll('.day-cell');

const currentDate = new Date();
let currentMonthIndex = currentDate.getMonth();
let currentYear = currentDate.getFullYear();

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// =============================================
// Event Colors
// =============================================
const EVENT_STYLES = {
  breed:     { bg: 'rgba(0, 128, 0, 0.18)',   label: 'Breed',  badge: '#2d7a2d' },
  lock_up:   { bg: 'rgba(70, 130, 255, 0.18)', label: 'Move In', badge: '#4169e1' },
  farrowing: { bg: 'rgba(255, 200, 0, 0.20)', label: 'Farrow', badge: '#b8860b' },
  vaccinate: { bg: 'rgba(147, 50, 200, 0.18)', label: 'Vax',   badge: '#9632c8' },
  weaning:   { bg: 'rgba(200, 50, 50, 0.18)',  label: 'Wean',  badge: '#aa2222' }
};

const CUSTOM_EVENT_COLORS = [
  '#0f766e', '#0891b2', '#ea580c', '#db2777',
  '#475569', '#7c2d12', '#14b8a6', '#f97316',
  '#be123c', '#334155', '#0369a1', '#a16207',
  '#84cc16', '#06b6d4', '#eab308', '#d946ef',
  '#22c55e', '#3b82f6', '#f43f5e', '#2dd4bf',
  '#a78bfa', '#fb923c', '#34d399', '#60a5fa'
];
let customEventTypes = [];
let selectedCustomColor = CUSTOM_EVENT_COLORS[0];
const LOCK_ICON = '<span class="private-event-icon"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg></span>';

function eventStyle(type) {
  if (EVENT_STYLES[type]) return EVENT_STYLES[type];
  if (type && type.startsWith('custom:')) {
    const id = type.slice(7);
    const custom = customEventTypes.find(t => t.id === id);
    if (custom) return { label: custom.name, badge: custom.color, bg: hexToRgba(custom.color, 0.18) };
    console.warn('[Momenta] eventStyle: custom type not found in loaded types. id=' + id + ', type=' + type + ', loadedTypes=' + customEventTypes.length, customEventTypes.map(t => t.id));
  }
  return { label: 'Event', badge: '#64748b', bg: 'rgba(100, 116, 139, 0.16)' };
}

function isCustomEvent(evt) {
  return !!(evt && evt.event_type && evt.event_type.startsWith('custom:'));
}

function sortEventsForDisplay(events) {
  return [...(events || [])].sort((a, b) => {
    const aCustom = isCustomEvent(a);
    const bCustom = isCustomEvent(b);
    if (aCustom !== bCustom) return aCustom ? 1 : -1;
    return String(a.start_date || '').localeCompare(String(b.start_date || ''));
  });
}

function importantEventForBackground(events) {
  return (events || []).find(evt => !isCustomEvent(evt));
}

function hexToRgba(hex, alpha) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return 'rgba(100, 116, 139, ' + alpha + ')';
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
}

// =============================================
// Helper: format a Date as YYYY-MM-DD
// =============================================
function fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

// =============================================
// Notes CRUD (existing calendar_events table)
// =============================================
async function fetchNotes(year, month) {
  if (!currentCalendarId) return {};
  const { data, error } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('year', year)
    .eq('month', month)
    .eq('calendar_id', currentCalendarId);
  if (error) { console.error('Error fetching notes:', error); return {}; }
  const byDay = {};
  if (data) {
    for (const row of data) {
      byDay[row.day] = row;
    }
  }
  return byDay;
}

async function saveNote(year, month, day, text) {
  if (!currentCalendarId) return;
  await supabase
    .from('calendar_events')
    .upsert({
      user_id: user.id,
      year, month, day,
      col1: text,
      col2: '',
      calendar_id: currentCalendarId,
    }, { onConflict: 'user_id, year, month, day, calendar_id' });
}

// =============================================
// Batch Events CRUD (events table)
// =============================================
async function fetchBatchEvents(year, month) {
  if (!currentCalendarId) return [];
  const lastDay = new Date(year, month + 1, 0).getDate();
  const ym = year + '-' + String(month + 1).padStart(2, '0');
  const monthStart = ym + '-01';
  const monthEnd = ym + '-' + String(lastDay).padStart(2, '0');
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('calendar_id', currentCalendarId)
    .lte('start_date', monthEnd);
  if (error) { console.error('Error fetching events:', error); return []; }
  return (data || []).filter(evt => (evt.end_date || evt.start_date) >= monthStart);
}

async function loadCustomEventTypes() {
  const { data, error } = await supabase
    .from('custom_event_types')
    .select('*')
    .eq('created_by', user.id)
    .order('name', { ascending: true });
  if (error) { console.error('Error loading custom event types:', error); customEventTypes = []; return []; }
  customEventTypes = data || [];
  console.log('[Momenta] loadCustomEventTypes: loaded ' + customEventTypes.length + ' types for user ' + user.id, customEventTypes.map(t => ({ id: t.id, name: t.name })));
  return customEventTypes;
}

async function loadCalendarCustomEventTypes() {
  console.log('[Momenta] loadCalendarCustomEventTypes: calendar=' + currentCalendarId);
  await loadCustomEventTypes();
  if (!currentCalendarId) return customEventTypes;

  const { data: eventTypes } = await supabase
    .from('events')
    .select('event_type')
    .eq('calendar_id', currentCalendarId)
    .filter('event_type', 'like', 'custom:%');
  if (!eventTypes || eventTypes.length === 0) {
    console.log('[Momenta] loadCalendarCustomEventTypes: no custom events in this calendar');
    return customEventTypes;
  }

  const ids = [...new Set(eventTypes.map(e => e.event_type.slice(7)))];
  const ownIds = new Set(customEventTypes.map(t => t.id));
  const missingIds = ids.filter(id => !ownIds.has(id));
  console.log('[Momenta] loadCalendarCustomEventTypes: found ' + ids.length + ' custom type(s) in calendar, ' + missingIds.length + ' missing (not owned by current user)');
  if (missingIds.length === 0) return customEventTypes;

  console.log('[Momenta] loadCalendarCustomEventTypes: fetching shared types', missingIds);
  const { data: sharedTypes, error: sharedErr } = await supabase
    .from('custom_event_types')
    .select('*')
    .in('id', missingIds);
  if (sharedErr) console.error('[Momenta] loadCalendarCustomEventTypes: error fetching shared types', sharedErr);
  if (sharedTypes) {
    console.log('[Momenta] loadCalendarCustomEventTypes: loaded ' + sharedTypes.length + ' shared types', sharedTypes.map(t => ({ id: t.id, name: t.name, created_by: t.created_by })));
    customEventTypes.push(...sharedTypes);
  } else {
    console.warn('[Momenta] loadCalendarCustomEventTypes: shared types query returned 0 results — likely an RLS block. missingIds:', missingIds);
  }
  return customEventTypes;
}

// Build a map: { '2026-06-02': [event, ...], ... }
function buildEventsMap(events) {
  const map = {};
  for (const evt of events) {
    const start = new Date(evt.start_date + 'T00:00:00');
    const end = evt.end_date ? new Date(evt.end_date + 'T00:00:00') : new Date(evt.start_date + 'T00:00:00');
    let cur = new Date(start);
    while (cur <= end) {
      const key = fmtDate(cur);
      if (!map[key]) map[key] = [];
      map[key].push(evt);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return map;
}

// =============================================
// Batch Config CRUD
// =============================================
const DEFAULT_CONFIG = {
  pregnancy_days: 115,
  breed_range: 3,
  lock_up_before_farrowing: 2,
  vaccinate_after_farrowing: 10,
  weaning_after_farrowing: 23,
  batch_spacing_days: 14
};

let currentConfig = { ...DEFAULT_CONFIG };

function batchDisplayName(batchName, batchNumber) {
  if (batchNumber == null) return batchName || '';
  if (!batchName) return '' + batchNumber;
  const fc = batchName[0];
  const lc = batchName[batchName.length - 1];
  if (/[^a-zA-Z0-9]/.test(fc)) return batchNumber + batchName;
  if (/[^a-zA-Z0-9]/.test(lc)) return batchName + batchNumber;
  return batchName + ' ' + batchNumber;
}

async function loadConfig() {
  const { data, error } = await supabase
    .from('batch_configs')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) { console.error('Error loading config:', error); throw error; }
  if (data) {
    currentConfig = {
      pregnancy_days: data.pregnancy_days,
      breed_range: data.breed_range,
      lock_up_before_farrowing: data.lock_up_before_farrowing,
      vaccinate_after_farrowing: data.vaccinate_after_farrowing,
      weaning_after_farrowing: data.weaning_after_farrowing,
      batch_spacing_days: data.batch_spacing_days
    };
  }
}

async function saveConfig(config) {
  const { error } = await supabase
    .from('batch_configs')
    .upsert({
      user_id: user.id,
      pregnancy_days: config.pregnancy_days,
      breed_range: config.breed_range,
      lock_up_before_farrowing: config.lock_up_before_farrowing,
      vaccinate_after_farrowing: config.vaccinate_after_farrowing,
      weaning_after_farrowing: config.weaning_after_farrowing,
      batch_spacing_days: config.batch_spacing_days
    }, { onConflict: 'user_id' });
  if (error) throw error;
}

// =============================================
// Generate Batch Events
// =============================================
function calcBatchEvents(config, breedStartStr, namePrefix, batchCount, startBatchNumber) {
  const results = [];
  const breedStart = new Date(breedStartStr + 'T00:00:00');

  for (let b = 0; b < batchCount; b++) {
    const bn = startBatchNumber + b;
    // Shift by batch spacing
    const bs = new Date(breedStart);
    bs.setDate(bs.getDate() + b * config.batch_spacing_days);

    const be = new Date(bs);
    be.setDate(be.getDate() + (config.breed_range - 1));

    const farrowStart = new Date(bs);
    farrowStart.setDate(farrowStart.getDate() + config.pregnancy_days);

    const farrowEnd = new Date(farrowStart);
    farrowEnd.setDate(farrowEnd.getDate() + (config.breed_range - 1));

    const lockUp = new Date(farrowStart);
    lockUp.setDate(lockUp.getDate() - config.lock_up_before_farrowing);

    const vaccinate = new Date(farrowStart);
    vaccinate.setDate(vaccinate.getDate() + config.vaccinate_after_farrowing);

    const wean = new Date(farrowStart);
    wean.setDate(wean.getDate() + config.weaning_after_farrowing);

    results.push(
      { batch_name: namePrefix, batch_number: bn, event_type: 'breed',     start_date: fmtDate(bs), end_date: fmtDate(be) },
      { batch_name: namePrefix, batch_number: bn, event_type: 'lock_up',   start_date: fmtDate(lockUp), end_date: null },
      { batch_name: namePrefix, batch_number: bn, event_type: 'farrowing', start_date: fmtDate(farrowStart), end_date: fmtDate(farrowEnd) },
      { batch_name: namePrefix, batch_number: bn, event_type: 'vaccinate', start_date: fmtDate(vaccinate), end_date: null },
      { batch_name: namePrefix, batch_number: bn, event_type: 'weaning',   start_date: fmtDate(wean), end_date: null }
    );
  }
  return results;
}

async function saveBatchEvents(events) {
  if (!currentCalendarId) throw new Error('Please create or select a farm before adding batches.');
  const rows = events.map(e => ({
    user_id: user.id,
    batch_name: e.batch_name,
    batch_number: e.batch_number,
    event_type: e.event_type,
    start_date: e.start_date,
    end_date: e.end_date,
    calendar_id: currentCalendarId
  }));
  const { error } = await supabase.from('events').insert(rows);
  if (error) throw error;
}

// =============================================
// updateCalendar
// =============================================
let calendarUpdating = false;
async function updateCalendar() {
  if (calendarUpdating) return;
  calendarUpdating = true;
  try {
  const headerText = months[currentMonthIndex] + ' ' + currentYear;
  monthDisplay.textContent = headerText;
  const calendarHeader = document.getElementById('calendar-header');
  if (calendarHeader) calendarHeader.textContent = headerText;
  await loadCalendarCustomEventTypes();

  for (let i = 0; i < dayCells.length; i++) {
    dayCells[i].innerHTML = '';
    dayCells[i].style.display = 'flex';
    dayCells[i].style.background = '';
    dayCells[i].classList.remove('today-cell');
    dayCells[i].classList.add('empty-day-cell');
  }

  const firstDayIndex = new Date(currentYear, currentMonthIndex, 1).getDay();
  const totalDays = new Date(currentYear, currentMonthIndex + 1, 0).getDate();

  const today = new Date();

  // Fetch notes AND batch events in parallel
  const [notesByDay, batchEvents] = await Promise.all([
    fetchNotes(currentYear, currentMonthIndex),
    fetchBatchEvents(currentYear, currentMonthIndex)
  ]);
  const eventsMap = buildEventsMap(batchEvents);

  for (let day = 1; day <= totalDays; day++) {
    const slot = firstDayIndex + day - 1;
    const cell = dayCells[slot];
    cell.classList.remove('empty-day-cell');

    // Highlight today's date
    if (currentYear === today.getFullYear() && currentMonthIndex === today.getMonth() && day === today.getDate()) {
      cell.classList.add('today-cell');
    }

    // Day number (append FIRST so it's on top)
    const num = document.createElement('span');
    num.classList.add('day-number');
    num.textContent = day;
    cell.appendChild(num);

    // Events on this day?
    const dateKey = currentYear + '-' + String(currentMonthIndex + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const dayEvents = sortEventsForDisplay(eventsMap[dateKey]);

    if (dayEvents && dayEvents.length > 0) {
      const backgroundEvent = importantEventForBackground(dayEvents) || dayEvents[0];
      if (backgroundEvent) {
        const backgroundStyle = eventStyle(backgroundEvent.event_type);
        cell.style.background = backgroundStyle.bg;
      }

      const labelsDiv = document.createElement('div');
      labelsDiv.classList.add('event-labels');
      let primaryBadgeRendered = false;
      for (const evt of dayEvents) {
        const style = eventStyle(evt.event_type);
        const badge = document.createElement('span');
        badge.classList.add('event-badge', evt.event_type);
        badge.style.backgroundColor = style.badge;
        const isCustom = evt.event_type.startsWith('custom:');
        if (!isCustom && !primaryBadgeRendered) {
          primaryBadgeRendered = true;
          badge.classList.add('primary-badge');
          const typeSpan = document.createElement('span');
          typeSpan.textContent = style.label;
          const batchSpan = document.createElement('span');
          batchSpan.textContent = batchDisplayName(evt.batch_name, evt.batch_number);
          badge.appendChild(typeSpan);
          badge.appendChild(batchSpan);
        } else if (isCustom) {
          if (evt.is_private) {
            badge.innerHTML = LOCK_ICON + style.label;
          } else {
            badge.textContent = style.label;
          }
        } else {
          badge.textContent = style.label;
        }
        labelsDiv.appendChild(badge);
      }
      cell.appendChild(labelsDiv);
    }

    // Notes container - single editable column
    const notesContainer = document.createElement('div');
    notesContainer.classList.add('notes-container');

    const note = document.createElement('div');
    note.classList.add('notes-column');
    note.contentEditable = 'true';

    const saved = notesByDay[day];
    if (saved) {
      note.innerText = saved.col1 || '';
    }

    note.addEventListener('input', () => {
      saveNote(currentYear, currentMonthIndex, day, note.innerText);
    });

    notesContainer.appendChild(note);
    cell.appendChild(notesContainer);
  }

  // Hide 6th row on short months; min-height on grid keeps layout stable
  if (firstDayIndex + totalDays <= 35) {
    for (let i = 35; i < 42; i++) {
      dayCells[i].style.display = 'none';
    }
  }
  } finally {
    calendarUpdating = false;
  }
}

prevBtn.addEventListener('click', async () => {
  currentMonthIndex--;
  if (currentMonthIndex < 0) { currentMonthIndex = 11; currentYear--; }
  await updateCalendar();
});

nextBtn.addEventListener('click', async () => {
  currentMonthIndex++;
  if (currentMonthIndex > 11) { currentMonthIndex = 0; currentYear++; }
  await updateCalendar();
});

document.getElementById('today-btn').addEventListener('click', async () => {
  const t = new Date();
  currentMonthIndex = t.getMonth();
  currentYear = t.getFullYear();
  await updateCalendar();
});

// =============================================
// Modal Logic
// =============================================
function showModal(id) {
  document.getElementById(id).style.display = 'flex';
}
function hideModal(id) {
  document.getElementById(id).style.display = 'none';
}

// Close modal when clicking overlay background
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', (e) => {
    if (e.target === el) el.style.display = 'none';
  });
});

// =============================================
// Settings Modal
// =============================================
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('set-pregnancy').value = currentConfig.pregnancy_days;
  document.getElementById('set-breed-range').value = currentConfig.breed_range;
  document.getElementById('set-lockup').value = currentConfig.lock_up_before_farrowing;
  document.getElementById('set-vaccinate').value = currentConfig.vaccinate_after_farrowing;
  document.getElementById('set-weaning').value = currentConfig.weaning_after_farrowing;
  document.getElementById('set-spacing').value = currentConfig.batch_spacing_days;
  document.getElementById('settings-message').className = 'auth-message';
  document.getElementById('settings-message').textContent = '';
  showModal('settings-modal');
});

document.getElementById('cancel-settings').addEventListener('click', () => {
  hideModal('settings-modal');
});

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('settings-message');
  const btn = document.getElementById('save-settings-btn');
  const newConfig = {
    pregnancy_days: parseInt(document.getElementById('set-pregnancy').value),
    breed_range: parseInt(document.getElementById('set-breed-range').value),
    lock_up_before_farrowing: parseInt(document.getElementById('set-lockup').value),
    vaccinate_after_farrowing: parseInt(document.getElementById('set-vaccinate').value),
    weaning_after_farrowing: parseInt(document.getElementById('set-weaning').value),
    batch_spacing_days: parseInt(document.getElementById('set-spacing').value)
  };
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await saveConfig(newConfig);
    currentConfig = newConfig;
    msg.className = 'auth-message success';
    msg.textContent = 'Settings saved!';
    setTimeout(() => hideModal('settings-modal'), 1000);
  } catch (err) {
    msg.className = 'auth-message error';
    msg.textContent = err.message || 'Failed to save settings.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
});

// =============================================
// Feedback
// =============================================
const feedbackFields = {
  'Bug Report': [
    { id: 'fb-bug-what', label: 'What happened?', type: 'textarea', required: true },
    { id: 'fb-bug-expected', label: 'What did you expect to happen?', type: 'textarea', required: false },
    { id: 'fb-bug-steps', label: 'Steps to reproduce', type: 'textarea', required: false }
  ],
  'Feature Request': [
    { id: 'fb-feature-desc', label: 'What would you like to see added', type: 'textarea', required: true },
    { id: 'fb-feature-why', label: 'How would this help your farm?', type: 'textarea', required: false }
  ],
  'General Feedback': [
    { id: 'fb-general', label: 'Your feedback', type: 'textarea', required: true }
  ]
};

document.querySelectorAll('.feedback-trigger').forEach(btn => {
  btn.addEventListener('click', () => {
  document.getElementById('feedback-type').value = '';
  document.getElementById('feedback-fields').innerHTML = '';
  document.getElementById('feedback-message').className = 'auth-message';
  document.getElementById('feedback-message').textContent = '';
  showModal('feedback-modal');
  });
});

document.getElementById('cancel-feedback').addEventListener('click', () => {
  hideModal('feedback-modal');
});

document.getElementById('feedback-type').addEventListener('change', () => {
  const type = document.getElementById('feedback-type').value;
  const container = document.getElementById('feedback-fields');
  container.innerHTML = '';
  if (!type || !feedbackFields[type]) return;
  for (const field of feedbackFields[type]) {
    const div = document.createElement('div');
    div.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = field.label;
    label.htmlFor = field.id;
    div.appendChild(label);
    const ta = document.createElement('textarea');
    ta.id = field.id;
    ta.required = field.required;
    div.appendChild(ta);
    container.appendChild(div);
  }
});

document.getElementById('feedback-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = document.getElementById('feedback-message');
  const type = document.getElementById('feedback-type').value;
  if (!type) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please select a feedback type.';
    return;
  }
  const fields = feedbackFields[type];
  let body = 'Feedback Type: ' + type + '\n\n';
  let allFilled = true;
  for (const field of fields) {
    const el = document.getElementById(field.id);
    const val = el.value.trim();
    if (field.required && !val) { allFilled = false; break; }
    const label = field.label.replace(/[?]\s*$/, '');
    body += label + ':\n' + (val || '(not provided)') + '\n\n';
  }
  if (!allFilled) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please fill in all required fields.';
    return;
  }

  const subject = '[Momenta] ' + type;
  const mailto = 'mailto:prairepork@proton.me?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body.trim());
  window.open(mailto);
  hideModal('feedback-modal');
});

// =============================================
// Add Batch Modal
// =============================================
document.getElementById('add-batch-btn').addEventListener('click', () => {
  const today = new Date();
  document.getElementById('batch-breed-date').value = fmtDate(today);
  document.getElementById('batch-name-prefix').value = 'Batch';
  document.getElementById('batch-count').value = 1;
  document.getElementById('batch-message').className = 'auth-message';
  document.getElementById('batch-message').textContent = '';
  showModal('add-batch-modal');
});

document.getElementById('cancel-batch').addEventListener('click', () => {
  hideModal('add-batch-modal');
});

function renderColorSwatches() {
  const container = document.getElementById('custom-type-colors');
  if (!container) return;
  container.innerHTML = CUSTOM_EVENT_COLORS.map(color =>
    '<button type="button" class="color-swatch' + (color === selectedCustomColor ? ' selected' : '') + '" data-color="' + color + '" style="background:' + color + '"></button>'
  ).join('');
  container.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCustomColor = btn.dataset.color;
      renderColorSwatches();
    });
  });
}

async function populateCustomEventTypeSelect() {
  await loadCustomEventTypes();
  const select = document.getElementById('custom-event-type');
  if (!select) return;
  if (customEventTypes.length === 0) {
    select.innerHTML = '<option value="">Create a custom event in Settings first</option>';
    return;
  }
  select.innerHTML = customEventTypes.map(t => {
    const days = Number(t.duration_days || 1);
    const label = t.name + ' - ' + days + ' day' + (days === 1 ? '' : 's');
    return '<option value="' + escapeAttr(t.id) + '">' + escapeHtml(label) + '</option>';
  }).join('');
}

document.getElementById('add-custom-event-btn').addEventListener('click', async () => {
  const today = new Date();
  document.getElementById('custom-event-date').value = fmtDate(today);
  const privateCheckbox = document.getElementById('custom-event-private');
  privateCheckbox.checked = false;
  privateCheckbox.disabled = false;
  document.getElementById('custom-event-message').className = 'auth-message';
  document.getElementById('custom-event-message').textContent = '';
  await populateCustomEventTypeSelect();
  // Sync checkbox state for the initially selected type
  document.getElementById('custom-event-type').dispatchEvent(new Event('change'));
  showModal('custom-event-modal');
});

document.getElementById('custom-events-settings-btn').addEventListener('click', async () => {
  document.getElementById('custom-type-name').value = '';
  document.getElementById('custom-type-duration').value = 1;
  document.getElementById('custom-type-message').className = 'auth-message';
  document.getElementById('custom-type-message').textContent = '';
  renderColorSwatches();
  await loadCustomEventTypes();
  renderCustomEventTypes();
  showModal('custom-events-settings-modal');
});

document.getElementById('close-custom-events-settings').addEventListener('click', () => {
  hideModal('custom-events-settings-modal');
});

document.getElementById('cancel-custom-event').addEventListener('click', () => {
  hideModal('custom-event-modal');
});

document.getElementById('custom-event-type').addEventListener('change', function () {
  const typeId = this.value;
  const type = customEventTypes.find(t => t.id === typeId);
  const privateCheckbox = document.getElementById('custom-event-private');
  if (type && type.is_private) {
    privateCheckbox.checked = true;
    privateCheckbox.disabled = true;
  } else {
    privateCheckbox.checked = false;
    privateCheckbox.disabled = false;
  }
});

document.getElementById('custom-event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('custom-event-message');
  const btn = document.getElementById('save-custom-event-btn');
  const typeId = document.getElementById('custom-event-type').value;
  const date = document.getElementById('custom-event-date').value;
  const isPrivate = document.getElementById('custom-event-private').checked;

  if (!typeId || !date) {
    msg.className = 'auth-message error';
    msg.textContent = 'Choose a custom event and start date.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Adding...';
  try {
    if (!(await ensureActiveCalendar())) throw new Error('Please create or select a farm first.');
    const custom = customEventTypes.find(t => t.id === typeId);
    if (!custom) throw new Error('Choose a saved custom event.');
    const days = Math.max(1, parseInt(custom.duration_days || 1));
    const end = new Date(date + 'T00:00:00');
    end.setDate(end.getDate() + days - 1);
    const { error } = await supabase.from('events').insert({
      user_id: user.id,
      batch_name: custom.name,
      batch_number: 0,
      event_type: 'custom:' + typeId,
      start_date: date,
      end_date: days > 1 ? fmtDate(end) : null,
      calendar_id: currentCalendarId,
      is_private: isPrivate
    });
    if (error) throw error;
    msg.className = 'auth-message success';
    msg.textContent = 'Event added!';
    await updateCalendar();
    setTimeout(() => hideModal('custom-event-modal'), 900);
  } catch (err) {
    msg.className = 'auth-message error';
    msg.textContent = err.message || 'Failed to add event.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Event';
  }
});

document.getElementById('add-batch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('batch-message');
  const btn = document.getElementById('generate-batches-btn');

  let namePrefix = document.getElementById('batch-name-prefix').value.trim();
  const breedDate = document.getElementById('batch-breed-date').value;
  const batchCount = parseInt(document.getElementById('batch-count').value);

  if (!namePrefix) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please enter a batch name.';
    return;
  }

  // Extract starting number: if the name ends with digits, split them off
  let startBatchNumber = 1;
  const numberMatch = namePrefix.match(/^(.+?)(\d+)$/);
  if (numberMatch) {
    namePrefix = numberMatch[1];
    startBatchNumber = parseInt(numberMatch[2]);
  }
  if (!breedDate) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please select a breed start date.';
    return;
  }
  if (batchCount < 1 || batchCount > 20) {
    msg.className = 'auth-message error';
    msg.textContent = 'Batch count must be between 1 and 20.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    if (!(await ensureActiveCalendar())) {
      throw new Error('Please create or select a farm before adding batches.');
    }

    // Load latest config from DB; keep using current/default settings if it flakes.
    try {
      await retryQuery(() => loadConfig());
    } catch (configErr) {
      console.warn('Could not load batch config, using current settings:', configErr);
    }

    // Load existing breed events for all conflict checks
    const { data: existingBreeds } = await supabase
      .from('events')
      .select('start_date, end_date, batch_name, batch_number')
      .eq('event_type', 'breed')
      .eq('calendar_id', currentCalendarId);

    const start = new Date(breedDate + 'T00:00:00');
    let conflictMsg = '';

    // 1. Duplicate batch name check
    for (let b = 0; b < batchCount && !conflictMsg; b++) {
      const bn = startBatchNumber + b;
      const dup = (existingBreeds || []).find(e =>
        e.batch_name === namePrefix && e.batch_number === bn
      );
      if (dup) {
        conflictMsg = batchDisplayName(namePrefix, bn) + ' already exists. Use a different name or starting number.';
      }
    }

    // 2. Spacing and overlap check
    for (let b = 0; b < batchCount && !conflictMsg; b++) {
      const bs = new Date(start);
      bs.setDate(bs.getDate() + b * currentConfig.batch_spacing_days);
      const be = new Date(bs);
      be.setDate(be.getDate() + (currentConfig.breed_range - 1));

      // Check spacing from existing batch breed start dates
      for (const ex of (existingBreeds || [])) {
        const exStart = new Date(ex.start_date + 'T00:00:00');
        const diffDays = Math.abs(Math.round((bs - exStart) / (1000 * 60 * 60 * 24)));
        if (diffDays > 0 && diffDays < currentConfig.batch_spacing_days) {
          conflictMsg = batchDisplayName(namePrefix, startBatchNumber + b) + ' breed start (' + fmtDate(bs) + ') is only ' + diffDays + ' day(s) from ' + batchDisplayName(ex.batch_name, ex.batch_number) + ' (' + ex.start_date + '). Minimum spacing is ' + currentConfig.batch_spacing_days + ' days.';
          break;
        }
      }

      // Check every day in this batch's breed range for date overlap
      if (!conflictMsg) {
        let cur = new Date(bs);
        while (cur <= be) {
          const dateStr = fmtDate(cur);
          for (const ex of (existingBreeds || [])) {
            const exStart = ex.start_date;
            const exEnd = ex.end_date || ex.start_date;
            if (dateStr >= exStart && dateStr <= exEnd) {
              conflictMsg = 'Date ' + dateStr + ' conflicts with ' + batchDisplayName(ex.batch_name, ex.batch_number);
              break;
            }
          }
          if (conflictMsg) break;
          cur.setDate(cur.getDate() + 1);
        }
      }
    }

    if (conflictMsg) {
      msg.className = 'auth-message error';
      msg.textContent = conflictMsg;
      btn.disabled = false;
      btn.textContent = 'Generate Batches';
      return;
    }

    const events = calcBatchEvents(currentConfig, breedDate, namePrefix, batchCount, startBatchNumber);
    await saveBatchEvents(events);

    msg.className = 'auth-message success';
    msg.textContent = batchCount + ' batch(es) generated! (' + events.length + ' events)';
    await updateCalendar();
    setTimeout(() => hideModal('add-batch-modal'), 1500);
  } catch (err) {
    msg.className = 'auth-message error';
    msg.textContent = err.message || 'Failed to generate batches.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Batches';
  }
});

// =============================================
// All Events Modal
// =============================================
document.getElementById('all-events-btn').addEventListener('click', async () => {
  const container = document.getElementById('events-list-container');
  container.innerHTML = '<p style="text-align:center;color:#888;">Loading...</p>';
  showModal('events-list-modal');

  if (!(await ensureActiveCalendar())) {
    container.innerHTML = '<p class="empty-events">Create or select a farm to view events.</p>';
    return;
  }
  await loadCalendarCustomEventTypes();

  const { data: allEvents, error } = await supabase
    .from('events')
    .select('*')
    .eq('calendar_id', currentCalendarId)
    .order('start_date', { ascending: true });

  if (error) {
    container.innerHTML = '<p class="empty-events">Error loading events.</p>';
    return;
  }

  if (!allEvents || allEvents.length === 0) {
    container.innerHTML = '<p class="empty-events">No scheduled events yet. Click "+ Add Batch" to create one.</p>';
    return;
  }

  // Group by batch
  const groups = {};
  for (const evt of allEvents) {
    const key = evt.event_type.startsWith('custom:') ? 'event|' + evt.id : evt.batch_name + '|' + evt.batch_number;
    if (!groups[key]) {
      groups[key] = { batchName: evt.batch_name, batchNumber: evt.batch_number, events: [], isCustom: evt.event_type.startsWith('custom:') };
    }
    groups[key].events.push(evt);
  }

  let html = '';
  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    const breedEvt = g.events.find(e => e.event_type === 'breed') || g.events[0];
    const breedDate = breedEvt ? breedEvt.start_date : '?';
    const batchLabel = escapeHtml(batchDisplayName(g.batchName, g.batchNumber));
    const batchNameAttr = escapeAttr(g.batchName);
    const batchNumberAttr = escapeAttr(g.batchNumber);

    html += '<div class="batch-group">';
    html += '<h3>' + (g.isCustom ? escapeHtml(g.batchName) : batchLabel) + ' <span style="font-weight:normal;font-size:0.85em;color:#666;">' + (g.isCustom ? 'date ' : 'breed ') + escapeHtml(breedDate) + '</span></h3>';
    html += g.isCustom
      ? '<button class="delete-btn" data-action="delete-event" data-id="' + escapeAttr(g.events[0].id) + '">Delete Event</button>'
      : '<button class="delete-btn" data-action="delete-batch" data-name="' + batchNameAttr + '" data-number="' + batchNumberAttr + '">Delete Batch</button>';

    // Events list
    for (const evt of g.events) {
      const style = eventStyle(evt.event_type);
      const dateRange = evt.end_date && evt.end_date !== evt.start_date
        ? evt.start_date + ' - ' + evt.end_date
        : evt.start_date;
      const isPrivate = evt.is_private && g.isCustom;
      const lockHtml = isPrivate ? LOCK_ICON : '';
      html += '<div class="event-row">';
      html += '<span class="event-type-dot" style="background:' + style.badge + '"></span>';
      html += '<span class="event-type-label" style="color:' + style.badge + '">' + lockHtml + style.label + '</span>';
      html += '<span class="event-date" style="font-size:1.15em;font-weight:bold;">' + escapeHtml(dateRange) + '</span>';
      const rescheduleLabel = g.isCustom ? g.batchName : batchDisplayName(g.batchName, g.batchNumber);
      html += '<button data-action="reschedule" data-id="' + escapeAttr(evt.id) + '" data-type="' + escapeAttr(evt.event_type) + '" data-start="' + escapeAttr(evt.start_date) + '" data-end="' + escapeAttr(evt.end_date || '') + '" data-batch="' + escapeAttr(rescheduleLabel) + '" data-batch-name="' + batchNameAttr + '" data-batch-number="' + batchNumberAttr + '">Reschedule</button>';
      html += '</div>';
    }

    html += '</div>';
  }

  container.innerHTML = html;

  // Wire up batch delete/reschedule buttons
  container.querySelectorAll('[data-action="delete-batch"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      const number = parseInt(btn.dataset.number);
      if (!confirm('Delete entire ' + name + ' ' + number + ' (' + btn.closest('.batch-group').querySelectorAll('.event-row').length + ' events)?')) return;
      const { error: delErr } = await supabase.from('events').delete()
        .eq('batch_name', name).eq('batch_number', number).eq('calendar_id', currentCalendarId);
      if (delErr) { alert('Error: ' + delErr.message); return; }
      await updateCalendar();
      btn.closest('.batch-group').remove();
    });
  });

  container.querySelectorAll('[data-action="delete-event"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      const { error: delErr } = await supabase.from('events').delete()
        .eq('id', btn.dataset.id).eq('calendar_id', currentCalendarId);
      if (delErr) { alert('Error: ' + delErr.message); return; }
      await updateCalendar();
      btn.closest('.batch-group').remove();
    });
  });

  container.querySelectorAll('[data-action="reschedule"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeLabel = eventStyle(btn.dataset.type).label || btn.dataset.type;
      document.getElementById('reschedule-title').textContent = 'Reschedule ' + typeLabel;
      document.getElementById('reschedule-note').textContent = 'Updating ' + btn.dataset.batch + ' - ' + typeLabel;
      document.getElementById('reschedule-new-date').value = btn.dataset.start;
      // Show end date for range events (breed, farrow)
      const endGroup = document.getElementById('reschedule-end-group');
      if (btn.dataset.type === 'breed' || btn.dataset.type === 'farrowing') {
        endGroup.style.display = 'block';
        document.getElementById('reschedule-end-date').value = btn.dataset.end;
      } else {
        endGroup.style.display = 'none';
      }
      document.getElementById('save-reschedule-btn').dataset.eventId = btn.dataset.id;
      document.getElementById('save-reschedule-btn').dataset.eventType = btn.dataset.type;
      document.getElementById('save-reschedule-btn').dataset.batchName = btn.dataset.batchName;
      document.getElementById('save-reschedule-btn').dataset.batchNumber = btn.dataset.batchNumber;
      document.getElementById('reschedule-message').className = 'auth-message';
      document.getElementById('reschedule-message').textContent = '';
      showModal('reschedule-modal');
    });
  });
});

document.getElementById('close-events-list').addEventListener('click', () => {
  hideModal('events-list-modal');
});

// =============================================
// Reschedule Modal
// =============================================
document.getElementById('cancel-reschedule').addEventListener('click', () => {
  hideModal('reschedule-modal');
});

function checkEventOrder(eventType, newDate, newEnd, batchEvents) {
  const ORDER = ['breed', 'lock_up', 'farrowing', 'vaccinate', 'weaning'];
  const idx = ORDER.indexOf(eventType);
  if (idx === -1) return null;

  console.log('checkEventOrder: type=' + eventType + ' newDate=' + newDate + ' newEnd=' + newEnd);
  for (const evt of batchEvents) {
    console.log('  existing event: type=' + evt.event_type + ' start=' + evt.start_date + ' end=' + evt.end_date);
  }

  for (const evt of batchEvents) {
    const evtIdx = ORDER.indexOf(evt.event_type);
    if (evtIdx === -1) continue;

    const otherStart = evt.start_date;
    const otherEnd = evt.end_date || evt.start_date;
    const selfEnd = newEnd || newDate;
    const selfLabel = eventStyle(eventType).label || eventType;
    const otherLabel = eventStyle(evt.event_type).label || evt.event_type;

    if (evtIdx < idx && newDate <= otherEnd) {
      console.log('  BLOCKED: ' + selfLabel + ' (' + newDate + ') must be after ' + otherLabel + ' (ends ' + otherEnd + ')');
      return selfLabel + ' must be after ' + otherLabel + ' (' + otherEnd + ')';
    }
    if (evtIdx > idx && selfEnd >= otherStart) {
      console.log('  BLOCKED: ' + selfLabel + ' (' + selfEnd + ') must be before ' + otherLabel + ' (starts ' + otherStart + ')');
      return selfLabel + ' must be before ' + otherLabel + ' (' + otherStart + ')';
    }
  }
  console.log('  ALLOWED: no conflict');
  return null;
}

document.getElementById('reschedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('reschedule-message');
  const btn = document.getElementById('save-reschedule-btn');
  const eventId = btn.dataset.eventId;
  const eventType = btn.dataset.eventType;
  const newDate = document.getElementById('reschedule-new-date').value;
  const newEndDate = document.getElementById('reschedule-end-date').value || null;
  const batchName = btn.dataset.batchName;
  const batchNumber = parseInt(btn.dataset.batchNumber);

  if (!newDate) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please select a date.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Checking...';

  try {
    if (!(await ensureActiveCalendar())) {
      throw new Error('Please create or select a farm before updating events.');
    }

    if (!eventType.startsWith('custom:')) {
      const { data: batchEvents } = await supabase
        .from('events')
        .select('event_type, start_date, end_date')
        .eq('batch_name', batchName)
        .eq('batch_number', batchNumber)
        .eq('calendar_id', currentCalendarId)
        .neq('id', eventId);

      const conflict = checkEventOrder(eventType, newDate, newEndDate, batchEvents || []);
      if (conflict) {
        msg.className = 'auth-message error';
        msg.textContent = conflict;
        btn.disabled = false;
        btn.textContent = 'Update';
        return;
      }
    }

    btn.textContent = 'Updating...';

    const updateData = { start_date: newDate };
    if (eventType === 'breed' || eventType === 'farrowing') {
      updateData.end_date = newEndDate;
    }

    const { error } = await supabase
      .from('events')
      .update(updateData)
      .eq('id', eventId)
      .eq('calendar_id', currentCalendarId);

    if (error) throw error;

    msg.className = 'auth-message success';
    msg.textContent = 'Event updated!';
    await updateCalendar();
    setTimeout(() => {
      hideModal('reschedule-modal');
      hideModal('events-list-modal');
    }, 1200);
  } catch (err) {
    msg.className = 'auth-message error';
    msg.textContent = err.message || 'Failed to update.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update';
  }
});

// =============================================
// Year View — Mini Calendars
// =============================================
let yearViewYear = currentYear;

function buildEventsMapForYear(events) {
  const map = {};
  for (const evt of events) {
    const start = new Date(evt.start_date + 'T00:00:00');
    const end = evt.end_date ? new Date(evt.end_date + 'T00:00:00') : new Date(evt.start_date + 'T00:00:00');
    let cur = new Date(start);
    while (cur <= end) {
      const key = fmtDate(cur);
      if (!map[key]) map[key] = [];
      map[key].push(evt);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return map;
}

async function renderYearView(year) {
  const title = document.getElementById('year-view-year');
  const container = document.getElementById('year-view-content');
  title.textContent = year;
  container.innerHTML = '<p style="text-align:center;color:#888;">Loading...</p>';

  if (!(await ensureActiveCalendar())) {
    container.innerHTML = '<p class="empty-events">Create or select a farm to view events.</p>';
    return;
  }
  await loadCalendarCustomEventTypes();

  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('calendar_id', currentCalendarId)
    .lte('start_date', year + '-12-31')
    .order('start_date', { ascending: true });

  if (error) {
    container.innerHTML = '<p class="empty-events">Error loading events.</p>';
    return;
  }

  const yearStart = year + '-01-01';
  const eventsByDate = buildEventsMapForYear((events || []).filter(evt => (evt.end_date || evt.start_date) >= yearStart));
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  let html = '<div class="year-mini-calendars">';

  for (let m = 0; m < 12; m++) {
    const firstDay = new Date(year, m, 1).getDay();
    const totalDays = new Date(year, m + 1, 0).getDate();

    html += '<div class="mini-month">';
    html += '<div class="mini-month-header">' + months[m] + '</div>';
    html += '<div class="mini-grid">';

    for (const dn of dayNames) {
      html += '<div class="mini-day-name">' + dn + '</div>';
    }

    for (let i = 0; i < firstDay; i++) {
      html += '<div class="mini-day-cell"></div>';
    }

    for (let d = 1; d <= totalDays; d++) {
      const dateKey = year + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const dayEvents = sortEventsForDisplay(eventsByDate[dateKey]);
      let cls = 'mini-day-cell';
      let bgStyle = '';
      let dotsHtml = '';

      if (dayEvents && dayEvents.length > 0) {
        cls += ' has-event';
        const backgroundEvent = importantEventForBackground(dayEvents) || dayEvents[0];
        if (backgroundEvent) {
          const backgroundStyle = eventStyle(backgroundEvent.event_type);
          bgStyle = 'background:' + backgroundStyle.bg;
        }
        const seen = {};
        for (const evt of dayEvents) {
          if (!seen[evt.event_type]) {
            seen[evt.event_type] = true;
            const s = eventStyle(evt.event_type);
            if (s) dotsHtml += '<span class="mini-event-dot" style="background:' + s.badge + '"></span>';
          }
        }
        if (dotsHtml) dotsHtml = '<div class="mini-event-dots">' + dotsHtml + '</div>';
      }

      html += '<div class="' + cls + '" style="' + bgStyle + '">' + d + dotsHtml + '</div>';
    }

    html += '</div></div>';
  }

  html += '</div>';

  // Legend
  html += '<div class="year-view-legend">';
  for (const [type, style] of Object.entries(EVENT_STYLES)) {
    html += '<span class="legend-item"><span class="legend-dot" style="background:' + style.badge + '"></span>' + style.label + '</span>';
  }
  for (const custom of customEventTypes) {
    html += '<span class="legend-item"><span class="legend-dot" style="background:' + escapeAttr(custom.color) + '"></span>' + escapeHtml(custom.name) + '</span>';
  }
  html += '</div>';

  container.innerHTML = html;
}

document.getElementById('year-view-btn').addEventListener('click', async () => {
    yearViewYear = currentYear;
    await renderYearView(yearViewYear);
    showModal('year-view-modal');
  });

document.getElementById('close-year-view').addEventListener('click', () => {
  hideModal('year-view-modal');
});

document.getElementById('prev-year-btn').addEventListener('click', () => {
  yearViewYear--;
  renderYearView(yearViewYear);
});

document.getElementById('next-year-btn').addEventListener('click', () => {
  yearViewYear++;
  renderYearView(yearViewYear);
});

document.getElementById('print-year-view').addEventListener('click', () => {
  window.print();
});

// =============================================
// Manage Farm Modal
// =============================================
document.getElementById('manage-farm-btn').addEventListener('click', async () => {
  if (!currentCalendar || currentCalendar.type !== 'farm' || currentCalendar.owner_id !== user.id) return;
  document.getElementById('manage-farm-name').textContent = currentCalendar.name;
  document.getElementById('invite-message').className = 'auth-message';
  document.getElementById('invite-message').textContent = '';
  await loadFarmData();
  showModal('manage-farm-modal');
});

document.getElementById('close-manage-farm').addEventListener('click', () => {
  hideModal('manage-farm-modal');
});

document.getElementById('delete-farm-btn').addEventListener('click', async () => {
  if (!currentCalendar || currentCalendar.owner_id !== user.id) return;
  if (!confirm('Delete "' + currentCalendar.name + '" permanently? This cannot be undone.')) return;
  const calId = currentCalendar.id;
  const { error } = await supabase.from('calendars').delete().eq('id', calId);
  if (error) { alert('Error deleting farm: ' + error.message); return; }
  hideModal('manage-farm-modal');
  await loadCalendars();
  await updateCalendar();
});

document.getElementById('rename-farm-btn').addEventListener('click', async () => {
  if (!currentCalendar || currentCalendar.owner_id !== user.id) return;
  const name = prompt('Enter the new farm name:', currentCalendar.name);
  if (!name || !name.trim()) return;
  const { error } = await supabase
    .from('calendars')
    .update({ name: name.trim() })
    .eq('id', currentCalendar.id);
  if (error) { alert('Error renaming farm: ' + error.message); return; }
  await loadCalendars();
  document.getElementById('manage-farm-name').textContent = currentCalendar.name;
});

async function loadFarmData() {
  if (!currentCalendar) return;
  // Load members
  const { data: members, error: memErr } = await supabase
    .from('calendar_members')
    .select('*')
    .eq('calendar_id', currentCalendar.id);
  if (memErr) { console.error('Error loading members:', memErr); return; }

  // Load invite codes
  const { data: invites, error: invErr } = await supabase
    .from('invite_codes')
    .select('*')
    .eq('calendar_id', currentCalendar.id)
    .order('created_at', { ascending: false });
  if (invErr) { console.error('Error loading invites:', invErr); return; }

  renderFarmMembers(members || []);
  renderFarmInvites(invites || []);
}

function renderCustomEventTypes() {
  const container = document.getElementById('custom-event-types-list');
  if (!container) return;
  if (customEventTypes.length === 0) {
    container.innerHTML = '<p class="empty-events compact">No custom events yet.</p>';
    return;
  }
  container.innerHTML = customEventTypes.map(t => {
    const days = Number(t.duration_days || 1);
    const lockIcon = t.is_private ? LOCK_ICON : '';
    return '<div class="custom-type-row">'
      + '<span class="custom-type-dot" style="background:' + escapeAttr(t.color) + '"></span>'
      + '<span class="custom-type-name">' + lockIcon + escapeHtml(t.name) + '</span>'
      + '<span class="custom-type-days">' + days + ' day' + (days === 1 ? '' : 's') + '</span>'
      + '<button type="button" data-action="rename-custom-type" data-id="' + escapeAttr(t.id) + '">Rename</button>'
      + '<button type="button" class="delete-btn" data-action="delete-custom-type" data-id="' + escapeAttr(t.id) + '">Delete</button>'
      + '</div>';
  }).join('');
  container.querySelectorAll('[data-action="rename-custom-type"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const existing = customEventTypes.find(t => t.id === btn.dataset.id);
      if (!existing) return;
      const name = prompt('New name:', existing.name);
      if (!name || !name.trim()) return;
      const { error } = await supabase.from('custom_event_types').update({ name: name.trim() })
        .eq('id', btn.dataset.id).eq('created_by', user.id);
      if (error) { alert('Error: ' + error.message); return; }
      await loadCustomEventTypes();
      renderCustomEventTypes();
      await populateCustomEventTypeSelect();
      await updateCalendar();
    });
  });
  container.querySelectorAll('[data-action="delete-custom-type"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this custom event? Existing scheduled events will stay on the calendar.')) return;
      const { error } = await supabase.from('custom_event_types').delete()
        .eq('id', btn.dataset.id).eq('created_by', user.id);
      if (error) { alert('Error: ' + error.message); return; }
      await loadCustomEventTypes();
      renderCustomEventTypes();
      await populateCustomEventTypeSelect();
      await updateCalendar();
    });
  });
}

document.getElementById('add-custom-type-btn').addEventListener('click', async () => {
  const msg = document.getElementById('custom-type-message');
  const input = document.getElementById('custom-type-name');
  const name = input.value.trim();
  const duration = parseInt(document.getElementById('custom-type-duration').value);
  const isPrivate = document.getElementById('custom-type-private').checked;
  if (!name) {
    msg.className = 'auth-message error';
    msg.textContent = 'Enter a name.';
    return;
  }
  if (!duration || duration < 1 || duration > 30) {
    msg.className = 'auth-message error';
    msg.textContent = 'Days must be 1 to 30.';
    return;
  }
  const { error } = await supabase.from('custom_event_types').insert({
    calendar_id: currentCalendarId,
    name,
    color: selectedCustomColor,
    duration_days: duration,
    created_by: user.id,
    is_private: isPrivate
  });
  if (error) {
    msg.className = 'auth-message error';
    msg.textContent = error.message || 'Failed to add custom event.';
    return;
  }
  input.value = '';
  document.getElementById('custom-type-duration').value = 1;
  document.getElementById('custom-type-private').checked = false;
  msg.className = 'auth-message success';
  msg.textContent = 'Custom event created.';
  await loadCustomEventTypes();
  renderCustomEventTypes();
  await populateCustomEventTypeSelect();
});

async function renderFarmMembers(members) {
  const container = document.getElementById('farm-members-list');
  if (members.length === 0) {
    container.innerHTML = '<p style="color:#888;font-size:0.9em;">No members yet.</p>';
    return;
  }
  // Resolve user emails via the get_user_emails RPC function
  const userIds = members.map(m => m.user_id);
  const { data: emails } = await supabase.rpc('get_user_emails', { ids: userIds });
  const emailMap = {};
  if (emails) for (const row of emails) emailMap[row.user_id] = row.email;

  let html = '';
  for (const m of members) {
    const role = m.role === 'owner' ? ' (Owner)' : '';
    const email = emailMap[m.user_id] || m.user_id.substring(0, 8) + '...';
    html += '<div style="padding:6px 0;border-bottom:1px solid #eee;font-size:0.95em;">';
    html += '<span>' + escapeHtml(email) + '</span>' + role;
    if (m.role !== 'owner') {
      html += ' <button class="delete-btn" style="font-size:0.75em;padding:2px 10px;float:right;" data-action="remove-member" data-user="' + escapeAttr(m.user_id) + '">Remove</button>';
    }
    html += '</div>';
  }
  container.innerHTML = html;
  container.querySelectorAll('[data-action="remove-member"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this member?')) return;
      const { error } = await supabase.from('calendar_members').delete()
        .eq('calendar_id', currentCalendar.id)
        .eq('user_id', btn.dataset.user);
      if (error) { alert('Error: ' + error.message); return; }
      await loadFarmData();
    });
  });
}

async function renderFarmInvites(invites) {
  const container = document.getElementById('farm-invites-list');
  // Only show unused invites
  const active = invites.filter(inv => !inv.used_by);
  if (active.length === 0) {
    container.innerHTML = '<p style="color:#888;font-size:0.9em;">No active invite codes.</p>';
    return;
  }
  const now = new Date();
  let html = '';
  for (const inv of active) {
    const expired = new Date(inv.expires_at) < now ? ' (EXPIRED)' : '';
    html += '<div style="padding:6px 0;border-bottom:1px solid #eee;font-size:0.95em;">';
    html += '<span style="font-family:monospace;font-weight:bold;font-size:1.1em;letter-spacing:2px;">' + escapeHtml(inv.code) + '</span>';
    html += ' <span style="color:#666;">→ ' + escapeHtml(inv.email) + '</span>';
    html += ' <span style="color:#c00;">' + expired + '</span>';
    html += ' <button class="delete-btn" style="font-size:0.75em;padding:2px 10px;float:right;" data-action="delete-invite" data-id="' + escapeAttr(inv.id) + '">Delete</button>';
    html += '</div>';
  }
  container.innerHTML = html;
  container.querySelectorAll('[data-action="delete-invite"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { error } = await supabase.from('invite_codes').delete().eq('id', btn.dataset.id);
      if (error) { alert('Error: ' + error.message); return; }
      await loadFarmData();
    });
  });
}

document.getElementById('generate-invite-btn').addEventListener('click', async () => {
  const msg = document.getElementById('invite-message');
  const email = prompt('Enter the email of the person to invite:');
  if (!email || !email.includes('@')) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please enter a valid email address.';
    return;
  }

  // Generate a random 6-char alphanumeric code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

  // Expires in 7 days
  const expires = new Date();
  expires.setDate(expires.getDate() + 7);

  const { error } = await supabase.from('invite_codes').insert({
    calendar_id: currentCalendar.id,
    code: code,
    email: email,
    created_by: user.id,
    expires_at: expires.toISOString()
  });

  if (error) {
    msg.className = 'auth-message error';
    msg.textContent = 'Error generating code: ' + error.message;
    return;
  }

  msg.className = 'auth-message success';
  msg.textContent = 'Code generated! Share this with ' + email + ': ' + code;
  await loadFarmData();
});

// =============================================
// Create Farm Calendar
// =============================================
document.getElementById('create-farm-btn').addEventListener('click', async () => {
  const name = prompt('Enter a name for the new Farm calendar:');
  if (!name || !name.trim()) return;
  const { error } = await supabase.from('calendars').insert({
    owner_id: user.id,
    name: name.trim(),
    type: 'farm'
  });
  if (error) { alert('Error creating farm: ' + error.message); return; }
  await loadCalendars();
  // Auto-select the new farm
  const farm = calendars.find(c => c.type === 'farm' && c.owner_id === user.id && c.name === name.trim());
  if (farm) {
    currentCalendarId = farm.id;
    currentCalendar = farm;
    localStorage.setItem('momenta_calendar_id', farm.id);
    await renderCalendarSwitcher();
    updateFarmButton();
    subscribeToCalendarChanges();
    await updateCalendar();
  }
});

// =============================================
// Join Farm Modal
// =============================================
document.getElementById('join-farm-btn').addEventListener('click', () => {
  document.getElementById('invite-code-input').value = '';
  document.getElementById('join-farm-message').className = 'auth-message';
  document.getElementById('join-farm-message').textContent = '';
  showModal('join-farm-modal');
});

document.getElementById('cancel-join-farm').addEventListener('click', () => {
  hideModal('join-farm-modal');
});

document.getElementById('join-farm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('join-farm-message');
  const btn = document.getElementById('join-farm-btn-submit');
  const code = document.getElementById('invite-code-input').value.trim().toUpperCase();

  if (!code) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please enter an invite code.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Joining...';

  try {
    const { error: redeemErr } = await supabase.rpc('redeem_invite', { invite_code: code });
    if (redeemErr) throw redeemErr;

    msg.className = 'auth-message success';
    msg.textContent = 'Successfully joined the farm!';

    // Reload calendars
    await loadCalendars();
    setTimeout(() => {
      hideModal('join-farm-modal');
      updateCalendar();
    }, 1500);
  } catch (err) {
    msg.className = 'auth-message error';
    msg.textContent = err.message || 'Failed to join farm.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Join Farm';
  }
});

// =============================================
// Initialize
// =============================================
try {
  await retryQuery(() => loadConfig());
} catch (e) { console.error('loadConfig failed after retries:', e); }

try {
  await retryQuery(() => loadCalendars());
} catch (e) { console.error('loadCalendars failed after retries:', e); }

try {
  await retryQuery(() => updateCalendar());
} catch (e) { console.error('updateCalendar failed after retries:', e); }

loadingScreen.style.display = 'none';

// =============================================
// Mobile Nav Wiring
// =============================================
(function setupMobileNav() {
  // Sync mobile month display with main display
  const mobileMonthDisplay = document.getElementById('mobile-month-display');
  const origUpdateCalendar = updateCalendar;

  function syncMobileMonth() {
    if (mobileMonthDisplay) {
      mobileMonthDisplay.textContent = months[currentMonthIndex] + ' ' + currentYear;
    }
  }

  // Patch updateCalendar to also sync mobile display
  window._origUpdateCalendar = updateCalendar;

  // Initial sync
  syncMobileMonth();

  // Observe month display changes to keep mobile in sync
  const monthDisplayEl = document.getElementById('month-display');
  if (monthDisplayEl) {
    new MutationObserver(() => syncMobileMonth()).observe(monthDisplayEl, { childList: true, subtree: true, characterData: true });
  }

  // Mobile prev/next/today
  document.getElementById('mobile-prev-btn').addEventListener('click', () => {
    document.getElementById('prev-btn').click();
  });
  document.getElementById('mobile-next-btn').addEventListener('click', () => {
    document.getElementById('next-btn').click();
  });
  document.getElementById('mobile-today-btn').addEventListener('click', () => {
    document.getElementById('today-btn').click();
  });

  // Drawer helpers
  const drawers = ['mobile-farms-drawer', 'mobile-review-drawer', 'mobile-settings-drawer'];
  function closeAllDrawers() {
    drawers.forEach(id => { document.getElementById(id).style.display = 'none'; });
    document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
  }
  function toggleDrawer(drawerId, btnEl) {
    const drawer = document.getElementById(drawerId);
    const isOpen = drawer.style.display !== 'none';
    closeAllDrawers();
    if (!isOpen) {
      drawer.style.display = 'block';
      if (btnEl) btnEl.classList.add('active');
    }
  }

  // Farms drawer
  document.getElementById('mobile-farms-btn').addEventListener('click', function() {
    // Sync farm list into mobile drawer
    const mobileList = document.getElementById('mobile-calendar-list');
    const desktopList = document.getElementById('calendar-list');
    if (mobileList && desktopList) mobileList.innerHTML = desktopList.innerHTML;
    // Wire up farm buttons in mobile list
    mobileList.querySelectorAll('.cal-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        currentCalendarId = btn.dataset.calId;
        currentCalendar = calendars.find(c => c.id === currentCalendarId) || null;
        localStorage.setItem('momenta_calendar_id', currentCalendarId);
        await renderCalendarSwitcher();
        updateFarmButton();
        subscribeToCalendarChanges();
        updateCalendar();
        closeAllDrawers();
      });
    });
    // Sync manage farm button visibility
    const mobileMngBtn = document.getElementById('mobile-manage-farm-btn');
    if (mobileMngBtn) {
      mobileMngBtn.style.display = (currentCalendar && currentCalendar.type === 'farm' && currentCalendar.owner_id === user.id) ? 'block' : 'none';
    }
    toggleDrawer('mobile-farms-drawer', this);
  });
  document.getElementById('close-farms-drawer').addEventListener('click', closeAllDrawers);

  // Mobile farm action buttons → delegate to desktop equivalents
  document.getElementById('mobile-create-farm-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('create-farm-btn').click();
  });
  document.getElementById('mobile-join-farm-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('join-farm-btn').click();
  });
  document.getElementById('mobile-manage-farm-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('manage-farm-btn').click();
  });
  document.getElementById('mobile-logout-btn').addEventListener('click', () => {
    document.getElementById('logout-btn').click();
  });

  // Keep mobile email in sync
  const mobileEmail = document.getElementById('mobile-sidebar-email');
  const desktopEmail = document.getElementById('sidebar-email');
  if (mobileEmail && desktopEmail) {
    mobileEmail.textContent = desktopEmail.textContent;
    new MutationObserver(() => { mobileEmail.textContent = desktopEmail.textContent; })
      .observe(desktopEmail, { childList: true, subtree: true, characterData: true });
  }

  // Add Batch button
  document.getElementById('mobile-add-batch-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('add-batch-btn').click();
  });

  // Add Event button
  document.getElementById('mobile-add-event-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('add-custom-event-btn').click();
  });

  // Review drawer
  document.getElementById('mobile-review-btn').addEventListener('click', function() {
    toggleDrawer('mobile-review-drawer', this);
  });
  document.getElementById('close-review-drawer').addEventListener('click', closeAllDrawers);
  document.getElementById('mobile-all-events-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('all-events-btn').click();
  });
  document.getElementById('mobile-year-view-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('year-view-btn').click();
  });

  // Settings drawer
  document.getElementById('mobile-settings-btn').addEventListener('click', function() {
    toggleDrawer('mobile-settings-drawer', this);
  });
  document.getElementById('close-settings-drawer').addEventListener('click', closeAllDrawers);
  document.getElementById('mobile-production-settings-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('settings-btn').click();
  });
  document.getElementById('mobile-custom-events-btn').addEventListener('click', () => {
    closeAllDrawers();
    document.getElementById('custom-events-settings-btn').click();
  });

  // Close drawers when tapping outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.mobile-drawer') && !e.target.closest('.mobile-nav-btn')) {
      closeAllDrawers();
    }
  });
})();

})();
