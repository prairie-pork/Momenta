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
  if (currentCalendarId) localStorage.setItem('momenta_calendar_id', currentCalendarId);
  await renderCalendarSwitcher();
  updateFarmButton();
  subscribeToCalendarChanges();
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
    .subscribe();
}

async function renderCalendarSwitcher() {
  const container = document.getElementById('calendar-list');
  if (!container) return;

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

  let html = '';
  for (const cal of calendars) {
    const active = cal.id === currentCalendarId ? ' cal-btn-active' : '';
    const icon = sharedIds.has(cal.id) ? '🤝' : '🏠';
    const label = cal.name;
    html += '<button class="cal-btn' + active + '" data-cal-id="' + cal.id + '">' + icon + ' ' + label + '</button>';
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
    btn.style.display = 'inline-block';
  } else {
    btn.style.display = 'none';
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

// =============================================
// Helper: format a Date as YYYY-MM-DD
// =============================================
function fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
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

async function saveNote(year, month, day, col1Text, col2Text) {
  if (!currentCalendarId) return;
  await supabase
    .from('calendar_events')
    .upsert({
      user_id: user.id,
      year, month, day,
      col1: col1Text,
      col2: col2Text,
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
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('calendar_id', currentCalendarId)
    .gte('start_date', ym + '-01')
    .lte('start_date', ym + '-' + String(lastDay).padStart(2, '0'));
  if (error) { console.error('Error fetching events:', error); return []; }
  return data || [];
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

  for (let i = 0; i < dayCells.length; i++) {
    dayCells[i].innerHTML = '';
    dayCells[i].style.display = 'flex';
    dayCells[i].style.background = '';
    dayCells[i].classList.remove('today-cell');
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
    const dayEvents = eventsMap[dateKey];

    if (dayEvents && dayEvents.length > 0) {
      const firstStyle = EVENT_STYLES[dayEvents[0].event_type];
      if (firstStyle) {
        cell.style.background = firstStyle.bg;
      }

      const labelsDiv = document.createElement('div');
      labelsDiv.classList.add('event-labels');
      for (const evt of dayEvents) {
        const style = EVENT_STYLES[evt.event_type];
        if (!style) continue;
        const badge = document.createElement('span');
        badge.classList.add('event-badge', evt.event_type);
        badge.textContent = style.label + ' ' + evt.batch_name + ' ' + evt.batch_number;
        labelsDiv.appendChild(badge);
      }
      cell.appendChild(labelsDiv);
    }

    // Notes container
    const notesContainer = document.createElement('div');
    notesContainer.classList.add('notes-container');

    const col1 = document.createElement('div');
    col1.classList.add('notes-column');
    col1.contentEditable = 'true';

    const col2 = document.createElement('div');
    col2.classList.add('notes-column');
    col2.contentEditable = 'true';

    const saved = notesByDay[day];
    if (saved) {
      col1.innerText = saved.col1 || '';
      col2.innerText = saved.col2 || '';
    }

    col1.addEventListener('input', () => {
      if (col1.scrollHeight > col1.clientHeight) {
        const text = col1.innerText;
        col1.innerText = text.slice(0, -1);
        col2.focus();
        col2.innerText = text.slice(-1);
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(col2);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      saveNote(currentYear, currentMonthIndex, day, col1.innerText, col2.innerText);
    });

    col2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        col2.style.height = 'auto';
        col2.style.alignSelf = 'flex-start';
        const ch = col2.scrollHeight;
        col2.style.height = '';
        col2.style.alignSelf = '';
        if (col2.clientHeight - ch < 18) e.preventDefault();
      }
    });

    col2.addEventListener('input', () => {
      col2.style.height = 'auto';
      col2.style.alignSelf = 'flex-start';
      const ch = col2.scrollHeight;
      col2.style.height = '';
      col2.style.alignSelf = '';
      if (ch > col2.clientHeight) {
        col2.innerText = col2.innerText.slice(0, -1);
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(col2);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      saveNote(currentYear, currentMonthIndex, day, col1.innerText, col2.innerText);
    });

    notesContainer.appendChild(col1);
    notesContainer.appendChild(col2);

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
// Add Batch Modal
// =============================================
document.getElementById('add-batch-btn').addEventListener('click', () => {
  // Set default date to today
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

  // Extract starting number if user typed e.g. "Batch 4"
  let startBatchNumber = 1;
  const numberMatch = namePrefix.match(/^(.+?)\s+(\d+)$/);
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
    // Load latest config from DB
    await loadConfig();

    // Check for duplicate breed ranges (not just start dates)
    const { data: existingBreeds } = await supabase
      .from('events')
      .select('start_date, end_date, batch_name, batch_number')
      .eq('event_type', 'breed')
      .eq('calendar_id', currentCalendarId);

    const start = new Date(breedDate + 'T00:00:00');
    let conflictMsg = '';

    for (let b = 0; b < batchCount && !conflictMsg; b++) {
      const bs = new Date(start);
      bs.setDate(bs.getDate() + b * currentConfig.batch_spacing_days);
      const be = new Date(bs);
      be.setDate(be.getDate() + (currentConfig.breed_range - 1));

      // Check every day in this batch's breed range
      let cur = new Date(bs);
      while (cur <= be) {
        const dateStr = fmtDate(cur);
        for (const ex of (existingBreeds || [])) {
          const exStart = ex.start_date;
          const exEnd = ex.end_date || ex.start_date;
          if (dateStr >= exStart && dateStr <= exEnd) {
            conflictMsg = 'Date ' + dateStr + ' conflicts with ' + ex.batch_name + ' ' + ex.batch_number;
            break;
          }
        }
        if (conflictMsg) break;
        cur.setDate(cur.getDate() + 1);
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
    const key = evt.batch_name + '|' + evt.batch_number;
    if (!groups[key]) {
      groups[key] = { batchName: evt.batch_name, batchNumber: evt.batch_number, events: [] };
    }
    groups[key].events.push(evt);
  }

  let html = '';
  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    const breedEvt = g.events.find(e => e.event_type === 'breed');
    const breedDate = breedEvt ? breedEvt.start_date : '?';

    html += '<div class="batch-group">';
    html += '<h3>' + g.batchName + ' ' + g.batchNumber + ' <span style="font-weight:normal;font-size:0.85em;color:#666;">breed ' + breedDate + '</span></h3>';
    html += '<button class="delete-btn" data-action="delete-batch" data-name="' + g.batchName + '" data-number="' + g.batchNumber + '">Delete Batch</button>';

    // Events list
    for (const evt of g.events) {
      const style = EVENT_STYLES[evt.event_type];
      if (!style) continue;
      const dateRange = evt.end_date && evt.end_date !== evt.start_date
        ? evt.start_date + ' - ' + evt.end_date
        : evt.start_date;
      html += '<div class="event-row">';
      html += '<span class="event-type-dot" style="background:' + style.badge + '"></span>';
      html += '<span class="event-type-label" style="color:' + style.badge + '">' + style.label + '</span>';
      html += '<span class="event-batch-label">' + g.batchName + ' ' + g.batchNumber + '</span>';
      html += '<span class="event-date" style="font-size:1.15em;font-weight:bold;">' + dateRange + '</span>';
      html += '<button data-action="reschedule" data-id="' + evt.id + '" data-type="' + evt.event_type + '" data-start="' + evt.start_date + '" data-end="' + (evt.end_date || '') + '" data-batch="' + g.batchName + ' ' + g.batchNumber + '" data-batch-name="' + g.batchName + '" data-batch-number="' + g.batchNumber + '">Reschedule</button>';
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

  container.querySelectorAll('[data-action="reschedule"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeLabel = (EVENT_STYLES[btn.dataset.type] || {}).label || btn.dataset.type;
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
    const selfLabel = (EVENT_STYLES[eventType] || {}).label || eventType;
    const otherLabel = (EVENT_STYLES[evt.event_type] || {}).label || evt.event_type;

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
    const { data: batchEvents } = await supabase
      .from('events')
      .select('event_type, start_date, end_date')
      .eq('batch_name', batchName)
      .eq('batch_number', batchNumber)
      .neq('id', eventId);

    const conflict = checkEventOrder(eventType, newDate, newEndDate, batchEvents || []);
    if (conflict) {
      msg.className = 'auth-message error';
      msg.textContent = conflict;
      btn.disabled = false;
      btn.textContent = 'Update';
      return;
    }

    btn.textContent = 'Updating...';

    const updateData = { start_date: newDate };
    if (eventType === 'breed' || eventType === 'farrowing') {
      updateData.end_date = newEndDate;
    }

    const { error } = await supabase
      .from('events')
      .update(updateData)
      .eq('id', eventId);

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

  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('calendar_id', currentCalendarId)
    .gte('start_date', year + '-01-01')
    .lte('start_date', year + '-12-31')
    .order('start_date', { ascending: true });

  if (error) {
    container.innerHTML = '<p class="empty-events">Error loading events.</p>';
    return;
  }

  const eventsByDate = buildEventsMapForYear(events || []);
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
      const dayEvents = eventsByDate[dateKey];
      let cls = 'mini-day-cell';
      let bgStyle = '';
      let dotsHtml = '';

      if (dayEvents && dayEvents.length > 0) {
        cls += ' has-event';
        const firstStyle = EVENT_STYLES[dayEvents[0].event_type];
        if (firstStyle) bgStyle = 'background:' + firstStyle.bg;
        const seen = {};
        for (const evt of dayEvents) {
          if (!seen[evt.event_type]) {
            seen[evt.event_type] = true;
            const s = EVENT_STYLES[evt.event_type];
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
  html += '</div>';

  container.innerHTML = html;
}

document.getElementById('year-view-btn').addEventListener('click', () => {
  yearViewYear = currentYear;
  renderYearView(yearViewYear);
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
  document.getElementById('manage-farm-heading').textContent = currentCalendar.name.toUpperCase();
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
    html += '<span>' + email + '</span>' + role;
    if (m.role !== 'owner') {
      html += ' <button class="delete-btn" style="font-size:0.75em;padding:2px 10px;float:right;" data-action="remove-member" data-user="' + m.user_id + '">Remove</button>';
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
    html += '<span style="font-family:monospace;font-weight:bold;font-size:1.1em;letter-spacing:2px;">' + inv.code + '</span>';
    html += ' <span style="color:#666;">→ ' + inv.email + '</span>';
    html += ' <span style="color:#c00;">' + expired + '</span>';
    html += ' <button class="delete-btn" style="font-size:0.75em;padding:2px 10px;float:right;" data-action="delete-invite" data-id="' + inv.id + '">Delete</button>';
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
    // Find the invite code
    const { data: invites, error: invErr } = await supabase
      .from('invite_codes')
      .select('*')
      .eq('code', code);

    if (invErr) throw invErr;

    if (!invites || invites.length === 0) {
      msg.className = 'auth-message error';
      msg.textContent = 'Invalid invite code.';
      btn.disabled = false;
      btn.textContent = 'Join Farm';
      return;
    }

    const invite = invites[0];

    // Check if already used
    if (invite.used_by) {
      msg.className = 'auth-message error';
      msg.textContent = 'This invite code has already been used.';
      btn.disabled = false;
      btn.textContent = 'Join Farm';
      return;
    }

    // Check if expired
    if (new Date(invite.expires_at) < new Date()) {
      msg.className = 'auth-message error';
      msg.textContent = 'This invite code has expired.';
      btn.disabled = false;
      btn.textContent = 'Join Farm';
      return;
    }

    // Check that the invite is for this user's email
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      msg.className = 'auth-message error';
      msg.textContent = 'This invite code is not for your email address.';
      btn.disabled = false;
      btn.textContent = 'Join Farm';
      return;
    }

    // Check if already a member
    const { data: existingMembers, error: memErr } = await supabase
      .from('calendar_members')
      .select('id')
      .eq('calendar_id', invite.calendar_id)
      .eq('user_id', user.id);

    if (memErr) throw memErr;

    if (existingMembers && existingMembers.length > 0) {
      msg.className = 'auth-message error';
      msg.textContent = 'You are already a member of this farm.';
      btn.disabled = false;
      btn.textContent = 'Join Farm';
      return;
    }

    // Add member
    const { error: addErr } = await supabase
      .from('calendar_members')
      .insert({
        calendar_id: invite.calendar_id,
        user_id: user.id,
        role: 'editor'
      });

    if (addErr) throw addErr;

    // Mark code as used
    const { error: useErr } = await supabase
      .from('invite_codes')
      .update({ used_by: user.id, used_at: new Date().toISOString() })
      .eq('id', invite.id);

    if (useErr) console.error('Error marking code used:', useErr);

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

})();
