(async function () {

const user = await requireAuth();
if (!user) {
  throw new Error('Redirecting to login...');
}

// =============================================
// User Bar
// =============================================
const userBar = document.getElementById('user-bar');
const userEmailSpan = document.getElementById('user-email');
const logoutBtn = document.getElementById('logout-btn');
const loadingScreen = document.getElementById('loading-screen');

userEmailSpan.textContent = 'Logged in as: ' + user.email;
userBar.style.display = 'flex';
loadingScreen.style.display = 'none';

logoutBtn.addEventListener('click', async () => {
  await signOut();
  window.location.href = 'login.html';
});

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
  const { data, error } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('year', year)
    .eq('month', month);
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
  const { error } = await supabase
    .from('calendar_events')
    .upsert({
      user_id: user.id,
      year, month, day,
      col1: col1Text,
      col2: col2Text,
    }, { onConflict: 'user_id, year, month, day' });
  if (error) console.error('Error saving note:', error);
}

// =============================================
// Batch Events CRUD (events table)
// =============================================
async function fetchBatchEvents(year, month) {
  // Calculate actual last day of this month (fixes "June 31" bug)
  const lastDay = new Date(year, month + 1, 0).getDate();
  const ym = year + '-' + String(month + 1).padStart(2, '0');
  const { data, error } = await supabase
    .from('events')
    .select('*')
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
  if (error) { console.error('Error loading config:', error); return; }
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
    end_date: e.end_date
  }));
  const { error } = await supabase.from('events').insert(rows);
  if (error) throw error;
}

// =============================================
// updateCalendar
// =============================================
async function updateCalendar() {
  monthDisplay.textContent = months[currentMonthIndex] + ' ' + currentYear;

  for (let i = 0; i < dayCells.length; i++) {
    dayCells[i].innerHTML = '';
    dayCells[i].style.display = 'flex';
    dayCells[i].style.background = '';
  }

  const firstDayIndex = new Date(currentYear, currentMonthIndex, 1).getDay();
  const totalDays = new Date(currentYear, currentMonthIndex + 1, 0).getDate();

  // Fetch notes AND batch events in parallel
  const [notesByDay, batchEvents] = await Promise.all([
    fetchNotes(currentYear, currentMonthIndex),
    fetchBatchEvents(currentYear, currentMonthIndex)
  ]);

  const eventsMap = buildEventsMap(batchEvents);

  for (let day = 1; day <= totalDays; day++) {
    const slot = firstDayIndex + day - 1;
    const cell = dayCells[slot];

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

    if (firstDayIndex + totalDays <= 35) {
      for (let i = 35; i < 42; i++) {
        dayCells[i].style.display = 'none';
      }
    }
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
      .eq('event_type', 'breed');

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
      html += '<button data-action="reschedule" data-name="' + g.batchName + '" data-number="' + g.batchNumber + '" data-breed="' + breedDate + '">Reschedule</button>';
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
        .eq('batch_name', name).eq('batch_number', number);
      if (delErr) { alert('Error: ' + delErr.message); return; }
      await updateCalendar();
      btn.closest('.batch-group').remove();
    });
  });

  container.querySelectorAll('[data-action="reschedule"]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('reschedule-breed-date').value = btn.dataset.breed;
      // Store batch info on the submit button
      document.getElementById('save-reschedule-btn').dataset.batchName = btn.dataset.name;
      document.getElementById('save-reschedule-btn').dataset.batchNumber = btn.dataset.number;
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

document.getElementById('reschedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('reschedule-message');
  const btn = document.getElementById('save-reschedule-btn');
  const newDate = document.getElementById('reschedule-breed-date').value;
  const batchName = btn.dataset.batchName;
  const batchNumber = parseInt(btn.dataset.batchNumber);

  if (!newDate) {
    msg.className = 'auth-message error';
    msg.textContent = 'Please select a date.';
    return;
  }

  // Check the FULL breed range doesn't conflict with existing batches
  const { data: allBreeds } = await supabase
    .from('events')
    .select('start_date, end_date, batch_name, batch_number')
    .eq('event_type', 'breed');

  const bs = new Date(newDate + 'T00:00:00');
  const be = new Date(bs);
  be.setDate(be.getDate() + (currentConfig.breed_range - 1));
  let conflictMsg = '';
  let cur = new Date(bs);
  while (cur <= be) {
    const dateStr = fmtDate(cur);
    for (const ex of (allBreeds || [])) {
      if (ex.batch_name === batchName && ex.batch_number === batchNumber) continue;
      const exEnd = ex.end_date || ex.start_date;
      if (dateStr >= ex.start_date && dateStr <= exEnd) {
        conflictMsg = dateStr + ' conflicts with ' + ex.batch_name + ' ' + ex.batch_number;
        break;
      }
    }
    if (conflictMsg) break;
    cur.setDate(cur.getDate() + 1);
  }

  if (conflictMsg) {
    msg.className = 'auth-message error';
    msg.textContent = conflictMsg;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Updating...';

  try {
    await loadConfig();
    // Delete old events for this batch
    const { error: delErr } = await supabase.from('events').delete()
      .eq('batch_name', batchName).eq('batch_number', batchNumber);
    if (delErr) throw delErr;

    // Generate new events
    const bs = new Date(newDate + 'T00:00:00');
    const be = new Date(bs);
    be.setDate(be.getDate() + (currentConfig.breed_range - 1));
    const farrowStart = new Date(bs);
    farrowStart.setDate(farrowStart.getDate() + currentConfig.pregnancy_days);
    const farrowEnd = new Date(farrowStart);
    farrowEnd.setDate(farrowEnd.getDate() + (currentConfig.breed_range - 1));
    const lockUp = new Date(farrowStart);
    lockUp.setDate(lockUp.getDate() - currentConfig.lock_up_before_farrowing);
    const vaccinate = new Date(farrowStart);
    vaccinate.setDate(vaccinate.getDate() + currentConfig.vaccinate_after_farrowing);
    const wean = new Date(farrowStart);
    wean.setDate(wean.getDate() + currentConfig.weaning_after_farrowing);

    const newEvents = [
      { user_id: user.id, batch_name: batchName, batch_number: batchNumber, event_type: 'breed',     start_date: fmtDate(bs), end_date: fmtDate(be) },
      { user_id: user.id, batch_name: batchName, batch_number: batchNumber, event_type: 'lock_up',   start_date: fmtDate(lockUp), end_date: null },
      { user_id: user.id, batch_name: batchName, batch_number: batchNumber, event_type: 'farrowing', start_date: fmtDate(farrowStart), end_date: fmtDate(farrowEnd) },
      { user_id: user.id, batch_name: batchName, batch_number: batchNumber, event_type: 'vaccinate', start_date: fmtDate(vaccinate), end_date: null },
      { user_id: user.id, batch_name: batchName, batch_number: batchNumber, event_type: 'weaning',   start_date: fmtDate(wean), end_date: null }
    ];

    const { error: insErr } = await supabase.from('events').insert(newEvents);
    if (insErr) throw insErr;

    msg.className = 'auth-message success';
    msg.textContent = 'Batch rescheduled!';
    await updateCalendar();
    setTimeout(() => {
      hideModal('reschedule-modal');
      hideModal('events-list-modal');
    }, 1200);
  } catch (err) {
    msg.className = 'auth-message error';
    msg.textContent = err.message || 'Failed to reschedule.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Batch';
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
// Initialize
// =============================================
await loadConfig();
await updateCalendar();

})();
