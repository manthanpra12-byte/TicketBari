// TicketBari frontend. Plain JavaScript, no build step.
// It only talks to the gateway (port 8080), just like any other client.

const API = `${location.protocol}//${location.hostname || 'localhost'}:8080`;
const $ = (id) => document.getElementById(id);

// ---- helpers ---------------------------------------------------------------

// Calls the gateway and always returns { status, body }. status 0 = could not connect.
async function api(path, options = {}) {
  try {
    const res = await fetch(API + path, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* empty body */ }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null };
  }
}

function post(path, data) {
  return api(path, { method: 'POST', body: JSON.stringify(data) });
}

// Turns an error response into a message a person can understand.
function explain(r) {
  if (r.status === 0) return 'Cannot reach the gateway. Is docker compose running?';
  if (r.status === 429) return 'Too many requests. The rate limiter asked us to slow down. Wait a second and try again.';
  if (r.status === 503 && r.body && r.body.circuit) return 'The booking service is down. The circuit breaker is OPEN, so the gateway fails fast.';
  if (r.status === 502) return 'The service did not answer (502).';
  return (r.body && r.body.error) || `Unexpected error (${r.status})`;
}

function banner(text, isInfo) {
  const b = $('banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.textContent = text;
  b.className = 'banner' + (isInfo ? ' info' : '');
}

// ---- user id (saved in the browser, can be changed) ---------------------------

let userId = localStorage.getItem('userId') || 'user-' + Math.floor(Math.random() * 9000 + 1000);
$('user-id').value = userId;
localStorage.setItem('userId', userId);
$('user-id').addEventListener('change', (e) => {
  userId = e.target.value.trim() || userId;
  localStorage.setItem('userId', userId);
});

// ---- tabs ----------------------------------------------------------------------

function showTab(name) {
  $('page-book').classList.toggle('hidden', name !== 'book');
  $('page-status').classList.toggle('hidden', name !== 'status');
  $('tab-book').classList.toggle('active', name === 'book');
  $('tab-status').classList.toggle('active', name === 'status');
  if (name === 'status') refreshStatus();
}
$('tab-book').onclick = () => showTab('book');
$('tab-status').onclick = () => showTab('status');

// ---- booking page: movies -> shows -> seats ----------------------------------------

let currentShow = null;
let selected = new Set();
let busy = false; // true while a booking is in progress
let lastSeats = []; // newest seat list, so clicks redraw instantly

async function loadMovies() {
  const r = await api('/api/movies');
  if (r.status !== 200) { $('movies').textContent = explain(r); return; }
  $('movies').innerHTML = '';
  r.body.forEach((m) => {
    const d = document.createElement('div');
    d.className = 'card click';
    d.innerHTML = `<div class="big">${m.title}</div><div class="label">${m.language} · ${m.duration_min} min</div>`;
    d.onclick = () => {
      document.querySelectorAll('#movies .card').forEach((c) => c.classList.remove('chosen'));
      d.classList.add('chosen');
      loadShows(m.id);
    };
    $('movies').appendChild(d);
  });
}

async function loadShows(movieId) {
  $('seats-section').classList.add('hidden');
  currentShow = null;
  const r = await api(`/api/movies/${movieId}/shows`);
  $('shows-section').classList.remove('hidden');
  if (r.status !== 200) { $('shows').textContent = explain(r); return; }
  $('shows').innerHTML = '';
  r.body.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'card click';
    const time = new Date(s.start_time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    d.innerHTML = `<div class="big">${time}</div><div class="label">Screen ${s.screen} · ₹${s.price}</div>`;
    d.onclick = () => {
      document.querySelectorAll('#shows .card').forEach((c) => c.classList.remove('chosen'));
      d.classList.add('chosen');
      openShow(s.id);
    };
    $('shows').appendChild(d);
  });
}

function openShow(showId) {
  currentShow = showId;
  selected = new Set();
  $('steps').innerHTML = '';
  $('seats-section').classList.remove('hidden');
  loadSeats();
}

async function loadSeats() {
  if (!currentShow) return;
  const showAtRequest = currentShow;
  const r = await api(`/api/shows/${showAtRequest}/seats`);
  if (showAtRequest !== currentShow) return; // user switched show meanwhile
  if (r.status !== 200) { banner(explain(r)); return; }
  banner('');
  drawSeats(r.body);
}

function drawSeats(seats) {
  lastSeats = seats;
  // drop selections that someone else took in the meantime
  if (!busy) {
    seats.forEach((s) => { if (s.status !== 'AVAILABLE') selected.delete(s.seat); });
  }
  // group by row letter: A1, A2 ... -> row A
  const rows = {};
  seats.forEach((s) => { (rows[s.seat[0]] = rows[s.seat[0]] || []).push(s); });

  const box = $('seats');
  box.innerHTML = '';
  Object.keys(rows).forEach((letter) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="rl">${letter}</span>`;
    rows[letter].forEach((s) => {
      const b = document.createElement('button');
      const isMine = selected.has(s.seat);
      b.className = 'seat ' + (isMine ? 'selected' : s.status.toLowerCase());
      b.textContent = s.seat.slice(1);
      b.title = s.seat + ' - ' + s.status;
      b.disabled = busy || (s.status !== 'AVAILABLE' && !isMine);
      b.onclick = () => toggleSeat(s.seat);
      row.appendChild(b);
    });
    box.appendChild(row);
  });
  updatePicked();
}

function toggleSeat(seat) {
  if (selected.has(seat)) selected.delete(seat);
  else if (selected.size < 6) selected.add(seat);
  else banner('You can pick at most 6 seats.', true);
  drawSeats(lastSeats);
}

function updatePicked() {
  $('picked').textContent = selected.size ? [...selected].join(', ') : 'none';
  $('book-btn').disabled = busy || selected.size === 0;
}

// The three steps of a booking, shown one by one
function step(text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  $('steps').appendChild(li);
  return li;
}

$('book-btn').onclick = async () => {
  busy = true;
  updatePicked();
  $('steps').innerHTML = '';
  const seats = [...selected];
  const showId = currentShow;

  // Step 1: hold the seats for 5 minutes (Redis lock)
  step(`Holding seats ${seats.join(', ')} ...`);
  const hold = await post('/api/holds', { show_id: showId, user_id: userId, seats });
  if (hold.status !== 200) {
    step('Hold failed: ' + explain(hold), 'fail');
    return finishBooking();
  }
  step(`Seats held for ${hold.body.expires_in_seconds} seconds`, 'done');

  // Step 2: ask for the booking. The server answers at once with 202 and a queue job starts.
  const book = await post('/api/bookings', { show_id: showId, user_id: userId, seats });
  if (book.status !== 202) {
    step('Booking failed: ' + explain(book), 'fail');
    return finishBooking();
  }
  step(`Booking accepted (202). Id ${book.body.booking_id.slice(0, 8)}... status PENDING`, 'done');

  // Step 3: a worker does the (fake) payment in the background. We ask every second.
  const waiting = step('Worker is processing payment ...');
  for (let i = 0; i < 60; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const s = await api(`/api/bookings/${book.body.booking_id}`);
    if (s.status === 200 && s.body.status === 'CONFIRMED') {
      waiting.textContent = `✅ CONFIRMED after ${i + 1}s. Seats ${s.body.seats.join(', ')} are yours.`;
      waiting.className = 'done';
      return finishBooking();
    }
    if (s.status === 200 && s.body.status === 'FAILED') {
      waiting.textContent = '❌ Payment failed after retries. Seats were released. Try again.';
      waiting.className = 'fail';
      return finishBooking();
    }
  }
  waiting.textContent = 'Still pending. Check again in a moment.';
  finishBooking();
};

function finishBooking() {
  busy = false;
  selected = new Set();
  loadSeats();
}

// keep the seat map fresh so you can see other people's holds
setInterval(() => {
  if (!busy && !$('page-book').classList.contains('hidden') && currentShow) loadSeats();
}, 3000);

// ---- status page ---------------------------------------------------------------------

function card(label, value, cls) {
  return `<div class="card"><div class="big ${cls || ''}">${value}</div><div class="label">${label}</div></div>`;
}

async function refreshStatus() {
  const [h, m] = await Promise.all([api('/health'), api('/metrics')]);

  if (!h.body) {
    $('nodes').innerHTML = card('gateway', 'DOWN', 'down');
    $('circuits').innerHTML = '';
  } else {
    const nodes = ['gateway', 'catalog', 'booking', 'redis'];
    $('nodes').innerHTML = nodes
      .map((n) => card(n, h.body[n] || '?', (h.body[n] || '').toLowerCase()))
      .join('') + card('overall', h.body.status, h.body.status === 'OK' ? 'up' : 'half_open');
    const c = h.body.circuits || {};
    $('circuits').innerHTML = Object.keys(c)
      .map((n) => card(n + ' breaker', c[n], c[n].toLowerCase()))
      .join('');
  }

  if (m.body) {
    const x = m.body;
    $('metrics').innerHTML = [
      card('requests', x.requests_total),
      card('rate limited (429)', x.rate_limited),
      card('cache hit ratio', (x.cache_hit_ratio * 100).toFixed(1) + '%'),
      card('bookings queued', x.bookings_enqueued),
      card('confirmed', x.bookings_confirmed, 'up'),
      card('failed', x.bookings_failed, x.bookings_failed ? 'down' : ''),
      card('payment retries', x.payment_retries),
      card('queue depth', x.queue_depth),
    ].join('');
  }
}

setInterval(() => {
  if (!$('page-status').classList.contains('hidden')) refreshStatus();
}, 2000);

// Fires 40 requests at the same moment and counts the answers
$('burst-btn').onclick = async () => {
  $('burst-result').textContent = 'Sending ...';
  const results = await Promise.all(Array.from({ length: 40 }, () => api('/api/movies')));
  const count = {};
  results.forEach((r) => { count[r.status] = (count[r.status] || 0) + 1; });
  $('burst-result').textContent = Object.entries(count)
    .map(([code, n]) => `${n} x ${code === '200' ? '200 OK' : code === '429' ? '429 Too Many Requests' : code}`)
    .join('   ');
  refreshStatus();
};

// ---- start ---------------------------------------------------------------------------
loadMovies();
