/**
 * Commons — the whole client.
 *
 * Built to docs/simple-ui.md. Three rules that shape everything here:
 *   1. Server text is only ever set with textContent, so a post can never
 *      inject markup into somebody else's browser.
 *   2. Nodes are built through el(), which drops falsy children — passing null
 *      straight to Element.append() renders the word "null" on the page.
 *   3. No prompt(), confirm() or alert(): they are unlabelled and unstyled, so
 *      every question is asked with a real form in a <dialog>.
 */

const API = '/api/community';

const state = {
  me: null,
  categories: [],
  unreadHellos: 0,
  queueSize: 0,
  account: null,
  lit: null,            // { slug } — the rail room glowing for a live event
};

// ------------------------------------------------------- motion + live state

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let sky = null;                 // set by the dynamic import in start()
let lastHash = null;            // the hash show() last rendered
let transitioning = false;      // a view transition is in flight
let showSeq = 0;                // every show() takes a ticket; a deferred swap only runs if its ticket is still the newest
let cutTimer = 0;               // the timer that strips .cut — cleared on the next navigation so a fast second cut is not cut short
let stagedCard = null;          // the .cat/.post the person tapped, named 'stage' until show() runs
let live = [];                  // { id, what } queued by the stream for the next same-hash render
let routeHash = null;           // the hash renderRoute() was dispatched for; a render that outlives it stands down
let pendingChrome = { route: 'home', room: null };   // applied to <html> inside the swap, so the accent flips at the cut
const DEPTH = (h) => h === '#/' ? 0
  : /^#\/(p|u|plan|people)\//.test(h) ? 2 : 1;

function stage(node, titleSel) {
  if (reduced.matches || typeof document.startViewTransition !== 'function') return;
  clearStage();
  node.style.viewTransitionName = 'stage';
  node.querySelector(titleSel)?.style.setProperty('view-transition-name', 'hero-title');
  stagedCard = node;
}
function clearStage() {
  for (const n of document.querySelectorAll('[style*="view-transition-name"]')) n.style.viewTransitionName = '';
  stagedCard = null;
}
function cardFor(hash) {
  const sel = hash.startsWith('#/c/') ? `.cat[data-slug="${CSS.escape(decodeURIComponent(hash.slice(4)))}"]`
            : hash.startsWith('#/p/') ? `.post[data-id="${CSS.escape(decodeURIComponent(hash.slice(4)))}"]` : null;
  const node = sel && view().querySelector(sel);
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight ? node : null;
}
function renderShell() { renderNav(); renderRooms(); }

// ---------------------------------------------------------------- utilities

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (init.body !== undefined && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
    init.headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(API + path, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong. Please try again.');
  return data;
}

let toastTimer = null;
function say(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

const MIN = 60_000, HR = 60 * MIN, DAY = 24 * HR;
function ago(ts) {
  const d = Date.now() - ts;
  if (d < MIN) return 'just now';
  if (d < HR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HR)} hours ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function when(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
}
function money(cents, currency) {
  if (cents === null || cents === undefined) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(cents / 100);
}

function go(route) { window.location.hash = route; }
const isHelp = (kind) => kind === 'help';

// ------------------------------------------------------------------ dialogs

/**
 * One <dialog> serves every question the app needs to ask. Native dialogs trap
 * focus and close on Escape for free, which a hand-rolled overlay would not.
 * Resolves to the typed text, true, or null when the person backs out.
 */
function askDialog({ title, label, help, confirmText, danger = false, needsText = false }) {
  const host = document.getElementById('dialog');
  host.replaceChildren();
  return new Promise((resolve) => {
    const input = needsText ? el('input', { type: 'text', id: 'dialogInput' }) : null;
    let answered = null;

    const form = el('form', { method: 'dialog' },
      el('h2', { id: 'dialogTitle', text: title }),
      help ? el('p', { class: 'hint', text: help }) : null,
      input ? el('label', { class: 'field' }, el('span', { class: 'lab', text: label }), input) : null,
      el('div', { class: 'row' },
        el('button', {
          class: danger ? '' : 'primary', type: 'submit', text: confirmText,
          onclick: () => { answered = needsText ? (input.value.trim() || ' ') : true; },
          style: danger ? 'border-color:var(--danger);color:var(--danger)' : null,
        }),
        el('button', { type: 'button', class: 'quiet', text: 'Cancel', onclick: () => { answered = null; host.close(); } }),
      ),
    );
    host.append(form);
    host.addEventListener('close', () => resolve(answered), { once: true });
    host.showModal();
    (input ?? form.querySelector('button')).focus();
  });
}

// -------------------------------------------------------------- shared bits

/** Who wrote it, when, and what they say they know about this category. */
function who(author, ts, knows = []) {
  return el('p', { class: 'who' },
    el('a', { href: `#/u/${encodeURIComponent(author.handle)}`, text: author.displayName }),
    knows.length ? el('span', { class: 'tag knows', text: `Says they know ${knows.join(', ')}` }) : null,
    author.helpfulCount > 0 ? el('span', { class: 'tag', text: `${author.helpfulCount} thanks` }) : null,
    el('span', { text: ago(ts) }),
  );
}

/** Stars as text, because a row of glyphs alone is not readable to everyone. */
function stars(rating) {
  return el('span', { class: 'stars' },
    el('span', { 'aria-hidden': 'true', text: '★'.repeat(rating) + '☆'.repeat(5 - rating) }),
    el('span', { class: 'sr', text: `${rating} out of 5` }));
}

function ratingLine(summary) {
  if (!summary || summary.count === 0) return el('p', { class: 'hint', style: 'margin:0', text: 'No reviews yet.' });
  const parts = [];
  if (summary.average !== null) parts.push(`${summary.average} out of 5`);
  parts.push(summary.count === 1 ? '1 review' : `${summary.count} reviews`);
  if (summary.verified) parts.push(`${summary.verified} from help given here`);
  return el('p', { class: 'hint', style: 'margin:0', text: parts.join(' · ') });
}

function tradeLine(person) {
  if (!person.trade && !person.identityVerified) return null;
  return el('p', { class: 'row', style: 'gap:8px; margin:0 0 8px' },
    person.trade ? el('span', { class: 'tag trade', text: person.trade }) : null,
    person.identityVerified
      ? el('span', { class: 'tag worked', text: '✓ Identity checked' })
      : null,
    person.worksInTrade ? el('span', { class: 'hint', text: 'Says they do this for a living' }) : null);
}

function reviewCard(review) {
  return el('div', { class: `review${review.verified ? ' verified' : ''}` },
    el('p', { class: 'who', style: 'margin:0 0 6px' },
      stars(review.rating),
      el('a', { href: `#/u/${encodeURIComponent(review.author.handle)}`, text: review.author.displayName }),
      el('span', { text: ago(review.createdAt) })),
    el('p', { class: 'row', style: 'gap:8px; margin:0 0 8px' },
      review.verified
        ? el('span', { class: 'tag worked', text: 'Helped them on Commons' })
        : el('span', { class: 'tag warnish', text: 'Says they hired them. We cannot check this.' })),
    el('p', { class: 'body', style: 'margin:0', text: review.body }),
    el('div', { class: 'row', style: 'margin-top:10px' },
      review.viewerIsAuthor
        ? el('button', {
            class: 'quiet', text: 'Delete',
            onclick: async () => {
              const yes = await askDialog({ title: 'Delete your review?', confirmText: 'Delete', danger: true });
              if (!yes) return;
              await api(`/reviews/${review.id}`, { method: 'DELETE' });
              route();
            },
          })
        : state.me ? reportButton('review', review.id) : null,
    ),
  );
}

function priceBox(estimate) {
  return el('div', { class: 'price-box' },
    el('p', { class: 'hint', style: 'margin:0', text: estimate.title }),
    el('p', { class: 'price', style: 'margin:2px 0', text: money(estimate.estimateCents, estimate.currency) }),
    el('p', { class: 'hint', style: 'margin:0',
      text: `Rough price, from ${estimate.sampleSize} similar items.` }),
  );
}

function postCard(post) {
  const marks = el('p', { class: 'row', style: 'gap:8px; margin:8px 0 0' },
    post.acceptedReplyId ? el('span', { class: 'tag worked', text: 'Answered' }) : null,
    post.meetup ? el('span', { class: 'tag when', text: `${when(post.meetup.startsAt)} · ${post.meetup.rsvps.length} coming` }) : null,
    post.estimate ? el('span', { class: 'tag', text: money(post.estimate.estimateCents, post.estimate.currency) }) : null,
    ...post.tags.map((t) => el('span', { class: 'tag', text: t })),
  );
  const answers = post.replyCount === 1 ? '1 answer' : `${post.replyCount} answers`;
  return el('button', { class: 'post', 'data-id': post.id, onclick: (e) => { stage(e.currentTarget, '.t'); go(`#/p/${post.id}`); } },
    el('span', { class: 't', text: post.title }),
    el('span', { class: 'ex', text: post.body }),
    el('span', { class: 'who' },
      el('span', { text: post.author.displayName }),
      el('span', { text: ago(post.updatedAt) }),
      el('span', { text: answers }),
    ),
    marks.childElementCount ? marks : null,
  );
}

// ------------------------------------------------------------------- header

function renderAccount() {
  const host = document.getElementById('account');
  host.replaceChildren();
  if (!state.me) {
    host.append(el('button', { class: 'primary', text: 'Sign in', onclick: () => go('#/in') }));
  } else {
    host.append(el('button', {
      class: 'quiet', text: 'Sign out',
      onclick: async () => {
        await api('/auth/logout', { method: 'POST' });
        state.me = null;
        state.unreadHellos = 0;
        renderAccount(); renderNav(); renderRooms(); go('#/');
        say('You are signed out.');
      },
    }));
  }
  sky?.redraw();   // the header's boxes changed, so the sky's text zones did too
}

/**
 * The rooms rail: every room, one tap away, on every page.
 *
 * Names only, grouped the way the home page groups them, with the room you are
 * in marked. Trade rooms carry their professional count as a small number.
 * On a phone the same list is a full-screen sheet behind the Rooms button.
 */
function renderRooms() {
  const host = document.getElementById('roomList');
  if (!host) return;
  const here = window.location.hash || '#/';

  const room = (c) => el('button', {
    class: 'room' + (state.lit?.slug === c.slug ? ' lit' : ''),
    'data-slug': c.slug,
    'data-kind': c.kind,
    'aria-current': here === `#/c/${c.slug}` ? 'true' : null,
    onclick: () => { closeRooms(); go(`#/c/${c.slug}`); },
  },
    here === `#/c/${c.slug}` ? el('span', { class: 'mark', 'aria-hidden': 'true' }) : null,
    el('span', { class: `dot ${c.kind}` }),
    el('span', { text: c.name }),
    isHelp(c.kind) && c.professionals
      ? el('span', { class: 'n' }, String(c.professionals), el('span', { class: 'sr', text: c.professionals === 1 ? ' checked professional' : ' checked professionals' }))
      : null,
  );

  const section = (title, rooms, extra) => rooms.length || extra
    ? el('div', {}, el('h2', { text: title }), ...rooms.map(room), extra)
    : null;

  const startEntry = state.me
    ? el('button', { class: 'room start', onclick: () => { closeRooms(); go('#/start'); }, text: '+ Start a group' })
    : null;

  replaceKids(host,
    section('Professionals', state.categories.filter((c) => c.kind === 'help')),
    section('Groups', state.categories.filter((c) => c.kind === 'group'), startEntry),
    section('Just talk', state.categories.filter((c) => c.kind === 'social')),
  );
}

const BEHIND_RAIL = () => [document.querySelector('header.top'), document.querySelector('nav.main'), document.getElementById('view')];
function openRooms() {
  const rail = document.getElementById('rooms');
  if (!rail || rail.classList.contains('open')) return;
  rail.classList.add('open');
  document.getElementById('roomsToggle')?.setAttribute('aria-expanded', 'true');
  // Only on a phone is the rail a sheet over the page; on desktop it is always there.
  if (window.matchMedia('(max-width: 899px)').matches) {
    for (const n of BEHIND_RAIL()) n?.setAttribute('inert', '');
    document.getElementById('roomsClose')?.focus();
  }
}
function closeRooms() {
  const rail = document.getElementById('rooms');
  if (!rail || !rail.classList.contains('open')) return;
  rail.classList.remove('open');
  document.getElementById('roomsToggle')?.setAttribute('aria-expanded', 'false');
  const wasInside = rail.contains(document.activeElement);
  for (const n of BEHIND_RAIL()) n?.removeAttribute('inert');
  if (wasInside) document.getElementById('roomsToggle')?.focus();
}

function renderNav() {
  const host = document.getElementById('nav');
  const here = window.location.hash || '#/';
  const items = [
    ['#/', 'Home'],
    ['#/meet', 'Together'],
    ['#/people', 'People'],
  ];
  if (state.me) {
    items.push(['#/start', 'Start a group']);
    items.push(['#/hellos', 'Hellos', state.unreadHellos]);
    if (state.me.role === 'moderator') items.push(['#/mod', 'Reports', state.queueSize]);
    items.push(['#/you', 'You']);
  } else {
    items.push(['#/in', 'Join']);
  }
  host.replaceChildren(...items.map(([href, label, badge]) => el('li', {},
    el('a', { href, 'aria-current': here === href ? 'page' : null },
      label,
      badge ? el('span', { class: 'badge', text: String(badge) }) : null,
      here === href ? el('span', { class: 'mark', 'aria-hidden': 'true' }) : null),
  )));
}

// -------------------------------------------------------------------- views

const view = () => document.getElementById('view');
/** replaceChildren stringifies null, so every variadic call goes through here. */
function replaceKids(host, ...nodes) {
  host.replaceChildren(...nodes.flat().filter(Boolean));
}

/**
 * The one choke point every view calls. Swaps the page, re-renders nav and
 * rooms, applies the route/room attributes to <html>, and — only when the hash
 * actually changed — plays the title card (.cut) inside a view transition.
 * A same-hash re-render (the live stream) swaps plainly and marks the node
 * that just arrived.
 */
function show(...nodes) {
  const host = view();
  // A view transition defers the swap by a frame or two. If another show()
  // lands in that gap — a live update re-rendering the room while the hash
  // has already moved on to the post — the deferred swap would overwrite the
  // newer, correct view with the older one. The ticket makes it stand down.
  const hash = window.location.hash || '#/';
  // A render that outlived its hash — a live update fetching the room while
  // the person tapped a post — must not paint. route() re-renders afterwards.
  if (routeHash !== null && hash !== routeHash) return;
  const seq = ++showSeq;
  const navigating = hash !== lastHash;
  const from = lastHash;
  lastHash = hash;
  if (navigating) live = [];

  const swap = () => {
    replaceKids(host, ...nodes);
    const html = document.documentElement;
    html.dataset.route = pendingChrome.route;
    if (pendingChrome.room) html.dataset.room = pendingChrome.room; else delete html.dataset.room;
    renderShell();
    if (navigating) window.scrollTo(0, 0);   // a live update never jumps the page
    host.classList.remove('cut', 'staged');
    clearTimeout(cutTimer);
    if (navigating && !reduced.matches) { void host.offsetWidth; host.classList.add('cut'); cutTimer = setTimeout(() => host.classList.remove('cut', 'staged'), 1000); }
    if (!navigating && live.length) markArrived(host);
  };

  const pushIn = Boolean(stagedCard && document.contains(stagedCard));
  // Never on first paint, and never under a cross-document transition from /welcome/.
  const canMorph = navigating && from !== null && !reduced.matches && typeof document.startViewTransition === 'function'
    && !transitioning && !document.activeViewTransition;
  if (!canMorph) { clearStage(); swap(); return; }

  const pullOut = !pushIn && from !== null && DEPTH(hash) < DEPTH(from);
  if (pullOut) { host.style.viewTransitionName = 'stage'; host.querySelector('h1')?.style.setProperty('view-transition-name', 'hero-title'); }

  transitioning = true;
  const t = document.startViewTransition(() => {
    if (seq !== showSeq) return;   // stale: a newer show() has already rendered the right view
    swap();
    host.style.viewTransitionName = '';
    if (pushIn && host.scrollHeight <= 3 * window.innerHeight) {
      host.style.viewTransitionName = 'stage';
      host.querySelector('h1')?.style.setProperty('view-transition-name', 'hero-title');
      host.classList.add('staged');
    } else if (pullOut) {
      const back = cardFor(from);
      if (back) { back.style.viewTransitionName = 'stage'; back.querySelector('.nm, .t')?.style.setProperty('view-transition-name', 'hero-title'); }
    }
  });
  t.finished.catch(() => {}).finally(() => { transitioning = false; clearStage(); });
}

/** After a same-page live re-render: the node the event was about gets a rule and the word New. */
function markArrived(host) {
  let said = null;
  live = live.filter(({ id, what }) => {
    const node = host.querySelector(`[data-id="${CSS.escape(String(id))}"]`);
    if (!node) return true;   // not rendered yet; the next render will have it
    node.classList.add('arrived');
    node.querySelector('.who')?.append(el('span', { class: 'tag new', text: 'New' }));
    said = what;
    return false;
  });
  // A sighted person sees the rule and the word; say it once for everyone else.
  const region = document.getElementById('arrivals');
  if (said && region) {
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = said === 'answer' ? 'New answer on this page.' : 'New post on this page.'; });
  }
}
/** A live re-render would destroy a half-typed message; while a field has focus, wait. */
function typing() {
  const a = document.activeElement;
  return Boolean(a && view().contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'));
}
function signalRule() {
  if (reduced.matches) return;
  const m = view();
  m.classList.remove('signal'); void m.offsetWidth; m.classList.add('signal');
  setTimeout(() => m.classList.remove('signal'), 950);
}
function litRoom(slug) {
  if (!slug) return;
  state.lit = { slug };
  document.querySelector(`.room[data-slug="${CSS.escape(slug)}"]`)?.classList.add('lit');
  setTimeout(() => {
    if (state.lit?.slug === slug) state.lit = null;
    document.querySelector(`.room[data-slug="${CSS.escape(slug)}"]`)?.classList.remove('lit');
  }, 1200);
}
function arrive(kind, slug) { sky?.pulse(kind); litRoom(slug); }

function signInFirst(what) {
  if (state.me) return false;
  show(
    el('h1', { text: 'Please sign in' }),
    el('p', { class: 'hint', text: `You need an account to ${what}.` }),
    el('button', { class: 'primary', text: 'Sign in or join', onclick: () => go('#/in') }),
  );
  return true;
}

/**
 * Home: who do you want to talk to?
 *
 * Three kinds of room. Trade rooms, where checked professionals answer;
 * groups, which members start themselves; and somewhere to just talk. The
 * page is a directory, not an explanation — one line each and a count.
 */
function viewHome() {
  const card = (c) => {
    const trade = isHelp(c.kind);
    const count = trade
      ? (c.professionals === 1 ? '1 checked professional' : `${c.professionals} checked professionals`)
      : (c.threadCount === 1 ? '1 post' : `${c.threadCount} posts`);
    return el('button', { class: `cat ${c.kind}`, 'data-slug': c.slug, onclick: (e) => { stage(e.currentTarget, '.nm'); go(`#/c/${c.slug}`); } },
      el('span', { class: 'nm', text: c.name }),
      el('span', { class: 'hn', text: c.description }),
      el('span', { class: 'ct', text: count + (c.startedBy ? ` · started by ${c.startedBy.displayName}` : '') }),
    );
  };
  const trades = state.categories.filter((c) => c.kind === 'help');
  const groups = state.categories.filter((c) => c.kind === 'group');
  const social = state.categories.filter((c) => c.kind === 'social');

  const startCard = el('button', { class: 'cat start', onclick: () => go('#/start') },
    el('span', { class: 'nm', text: 'Start a group' }),
    el('span', { class: 'hn', text: 'A book club, a bike club, walking partners.' }),
    el('span', { class: 'ct', text: 'Yours to run' }),
  );

  show(
    el('h1', { text: 'Who do you want to talk to?' }),
    el('h2', { text: 'Professionals', style: 'margin-top:8px' }),
    el('p', { class: 'hint', style: 'margin:-6px 0 12px', text: 'One room per trade. Anyone can ask; checked professionals answer.' }),
    el('div', { class: 'cats' }, ...trades.map(card)),
    el('h2', { text: 'Groups' }),
    el('p', { class: 'hint', style: 'margin:-6px 0 12px', text: 'Started by members. Join one, or start your own.' }),
    el('div', { class: 'cats' }, ...groups.map(card), startCard),
    el('h2', { text: 'Just talk' }),
    el('div', { class: 'cats' }, ...social.map(card)),
  );
}

async function viewCategory(slug) {
  const { channel, threads } = await api(`/channels/${encodeURIComponent(slug)}`);
  if (isHelp(channel.kind)) return showQuestions(channel, threads);
  return showChat(channel, threads);
}

/** A trade room reads as questions with answers, with its professionals up top. */
function showQuestions(category, posts) {
  const pros = el('div', { class: 'card tight' }, el('p', { class: 'hint', style: 'margin:0', text: 'Finding the professionals in this room…' }));
  api(`/channels/${encodeURIComponent(category.slug)}/professionals`)
    .then(({ professionals }) => {
      if (!professionals.length) {
        replaceKids(pros,
          el('p', { style: 'margin:0 0 4px; font-weight:600', text: 'No checked professionals here yet' }),
          el('p', { class: 'hint', style: 'margin:0', text: 'Do this for a living? Add your trade on your page and ask to be checked.' }));
        return;
      }
      replaceKids(pros,
        el('p', { style: 'margin:0 0 8px; font-weight:600',
          text: professionals.length === 1 ? '1 checked professional in this room' : `${professionals.length} checked professionals in this room` }),
        el('div', { class: 'row', style: 'gap:8px' }, ...professionals.map((p) =>
          el('a', { class: 'pro', href: `#/u/${encodeURIComponent(p.handle)}` },
            el('span', { class: 'nm', text: p.displayName }),
            el('span', { class: 'hint', text: p.trade + (p.reviews && p.reviews.average !== null ? ` · ${p.reviews.average} out of 5` : '') })))));
    })
    .catch(() => replaceKids(pros, el('p', { class: 'hint', style: 'margin:0', text: 'Could not load the professionals just now.' })));

  show(
    el('h1', { text: category.name }),
    el('p', { class: 'hint', text: category.description }),
    pros,
    askForm(category),
    el('h2', { text: posts.length === 1 ? '1 question' : `${posts.length} questions` }),
    posts.length
      ? el('div', {}, ...posts.map(postCard))
      : el('p', { class: 'empty', text: 'No questions yet. Ask the first one.' }),
  );
}

function askForm(category) {
  if (!state.me) {
    return el('div', { class: 'card' },
      el('p', { style: 'margin:0 0 12px', text: 'Sign in to ask a question.' }),
      el('button', { class: 'primary', text: 'Sign in or join', onclick: () => go('#/in') }));
  }

  const title = el('input', { type: 'text', id: 'q-title', maxlength: 140 });
  const body = el('textarea', { id: 'q-body' });
  const subjects = el('input', { type: 'text', id: 'q-subjects' });
  const photo = el('input', { type: 'file', id: 'q-photo', accept: 'image/*' });
  const note = el('p', { style: 'margin:0' });
  const priced = el('div');
  let estimate = null;

  const extras = el('div', { hidden: true },
    el('label', { class: 'field' },
      el('span', { class: 'lab', text: 'Subjects' }),
      el('span', { class: 'help', text: 'Separate them with commas. This is optional.' }),
      subjects),
    el('label', { class: 'field' },
      el('span', { class: 'lab', text: 'Photo of the item' }),
      el('span', { class: 'help', text: 'We work out a rough price from the photo. This is optional.' }),
      photo),
    priced,
  );

  photo.addEventListener('change', async () => {
    const file = photo.files?.[0];
    if (!file) return;
    priced.replaceChildren(el('p', { class: 'hint', text: 'Working out a rough price…' }));
    const form = new FormData();
    form.append('image', file);
    form.append('hint', title.value);
    try {
      const res = await fetch('/api/estimate', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'We could not read that photo.');
      estimate = {
        title: data.item.title,
        estimateCents: data.estimate?.estimateCents ?? null,
        lowCents: data.estimate?.lowCents ?? null,
        highCents: data.estimate?.highCents ?? null,
        currency: data.estimate?.currency ?? 'USD',
        confidence: data.estimate?.confidence ?? 0,
        sampleSize: data.estimate?.sampleSize ?? 0,
      };
      priced.replaceChildren(priceBox(estimate));
      if (!title.value) title.value = `Is it worth fixing? ${data.item.title}`;
    } catch (error) {
      estimate = null;
      priced.replaceChildren(el('p', { class: 'err', text: error.message }));
    }
  });

  const send = el('button', { class: 'primary', text: 'Ask' });
  send.addEventListener('click', async () => {
    if (!title.value.trim() || !body.value.trim()) {
      note.replaceChildren(el('span', { class: 'err', text: 'Please fill in both boxes.' }));
      return;
    }
    send.disabled = true;
    try {
      const payload = {
        title: title.value.trim(),
        body: body.value.trim(),
        tags: subjects.value.split(',').map((t) => t.trim()).filter(Boolean),
      };
      if (estimate) payload.estimate = estimate;
      const { thread } = await api(`/channels/${encodeURIComponent(category.slug)}/threads`, { method: 'POST', body: payload });
      go(`#/p/${thread.id}`);
    } catch (error) {
      note.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally {
      send.disabled = false;
    }
  });

  const more = el('button', { class: 'quiet', text: 'Add a photo or subjects' });
  more.addEventListener('click', () => {
    extras.hidden = !extras.hidden;
    more.textContent = extras.hidden ? 'Add a photo or subjects' : 'Hide extras';
  });

  return el('div', { class: 'card' },
    el('h2', { style: 'margin:0 0 14px', text: 'Ask the room' }),
    el('label', { class: 'field' },
      el('span', { class: 'lab', text: 'Your question' }),
      title),
    el('label', { class: 'field' },
      el('span', { class: 'lab', text: 'More detail' }),
      el('span', { class: 'help', text: 'What happens, and what you have already tried.' }),
      body),
    el('div', { class: 'row' }, send, more),
    note,
    extras,
  );
}

/** A club or social category reads as a chat: oldest first, box at the bottom. */
function showChat(category, posts) {
  const stream = [...posts].sort((a, b) => a.createdAt - b.createdAt);
  show(
    el('h1', { text: category.name }),
    el('p', { class: 'hint', text: category.description }),
    el('div', { class: 'row', style: 'margin-bottom:14px' },
      el('button', { text: 'Plan a get-together', onclick: () => go(`#/plan/${category.slug}`) })),
    stream.length
      ? el('div', { class: 'chat' }, ...stream.map(messageCard))
      : el('p', { class: 'empty', text: 'Nothing here yet. Say the first hello.' }),
    writer(category),
  );
}

function messageCard(post) {
  const answers = post.replyCount === 1 ? '1 answer' : `${post.replyCount} answers`;
  const box = el('div', { hidden: true });

  const reply = el('button', { class: 'quiet', text: 'Answer' });
  reply.addEventListener('click', () => {
    if (!state.me) return go('#/in');
    if (!box.hidden) { box.hidden = true; reply.textContent = 'Answer'; return; }
    const field = el('textarea', { id: `a-${post.id}`, style: 'min-height:80px' });
    const send = el('button', { class: 'primary', text: 'Send' });
    send.addEventListener('click', async () => {
      if (!field.value.trim()) return;
      send.disabled = true;
      try {
        await api(`/threads/${post.id}/replies`, { method: 'POST', body: { body: field.value.trim() } });
        route();
      } catch (error) { say(error.message); send.disabled = false; }
    });
    box.replaceChildren(
      el('label', { class: 'field', style: 'margin:12px 0 8px' },
        el('span', { class: 'lab', text: 'Your answer' }), field),
      send,
    );
    box.hidden = false;
    reply.textContent = 'Close';
    field.focus();
  });

  return el('div', { class: 'msg', 'data-id': post.id },
    who(post.author, post.createdAt, post.authorTopics),
    // A chat line's title is derived from its own first words, so showing it
    // would just repeat the message. A planned get-together has a real title,
    // and it is the most important line on the card.
    post.meetup ? el('h2', { style: 'margin:8px 0 0; font-size:19px', text: post.title }) : null,
    post.meetup ? el('p', { class: 'row', style: 'margin:8px 0 0' },
      el('span', { class: 'tag when', text: `${when(post.meetup.startsAt)} · ${post.meetup.rsvps.length} coming` })) : null,
    el('p', { class: 'body', text: post.body }),
    el('div', { class: 'acts' },
      reply,
      post.replyCount > 0
        ? el('button', { class: 'quiet', text: `Read ${answers}`, onclick: () => go(`#/p/${post.id}`) })
        : null,
    ),
    box,
  );
}

function writer(category) {
  if (!state.me) {
    return el('div', { class: 'card' },
      el('p', { style: 'margin:0 0 12px', text: 'Sign in to join in.' }),
      el('button', { class: 'primary', text: 'Sign in or join', onclick: () => go('#/in') }));
  }
  const field = el('textarea', { id: 'msg', style: 'min-height:90px' });
  const send = el('button', { class: 'primary', text: 'Send' });
  send.addEventListener('click', async () => {
    const text = field.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      // A chat line has no headline, so the first few words become the title
      // the server needs. People never see or type it.
      const title = text.split(/\s+/).slice(0, 8).join(' ').slice(0, 140);
      await api(`/channels/${encodeURIComponent(category.slug)}/threads`, {
        method: 'POST', body: { title, body: text },
      });
      field.value = '';
      route();
    } catch (error) {
      say(error.message);
    } finally {
      send.disabled = false;
    }
  });
  return el('div', { class: 'writer' },
    el('label', { class: 'field', style: 'margin-bottom:10px' },
      el('span', { class: 'lab', text: 'Write a message' }), field),
    send);
}

/**
 * Starting a group.
 *
 * Two fields and a choice. A member can start a group or a chat; trade rooms
 * are set up by moderators, because a room called "Plumbers" is a claim about
 * who answers in it.
 */
function viewStart() {
  if (signInFirst('start a group')) return;
  const name = el('input', { type: 'text', id: 's-name', maxlength: 60 });
  const about = el('input', { type: 'text', id: 's-about', maxlength: 280 });
  const kind = el('select', { id: 's-kind' },
    el('option', { value: 'group', text: 'A club or group — something that keeps going' }),
    el('option', { value: 'social', text: 'Just a chat — a place to talk' }));
  const note = el('p', { style: 'margin:0' });
  const create = el('button', { class: 'primary', text: 'Start it' });

  create.addEventListener('click', async () => {
    if (!name.value.trim() || !about.value.trim()) {
      note.replaceChildren(el('span', { class: 'err', text: 'Give it a name and say what it is for.' }));
      return;
    }
    create.disabled = true;
    try {
      const { channel } = await api('/channels', {
        method: 'POST',
        body: { name: name.value.trim(), kind: kind.value, description: about.value.trim() },
      });
      await loadCategories();
      say('Started. It is yours to run.');
      go(`#/c/${channel.slug}`);
    } catch (error) {
      note.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally { create.disabled = false; }
  });

  show(
    el('h1', { text: 'Start a group' }),
    el('p', { class: 'hint', text: 'A Sunday book club. A bike club. Three people who want to walk on Tuesdays. Three a day, so the list stays readable.' }),
    el('div', { class: 'card' },
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'Name' }), name),
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'What it is for' }),
        el('span', { class: 'help', text: 'One line. Ten words or fewer reads best.' }), about),
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'What kind of room' }), kind),
      el('div', { class: 'row' }, create, el('button', { class: 'quiet', text: 'Cancel', onclick: () => go('#/') })),
      note,
    ),
  );
}

/** Plan a get-together — its own page, so the chat box stays a chat box. */
function viewPlan(slug) {
  if (signInFirst('plan a get-together')) return;
  const category = state.categories.find((c) => c.slug === slug);
  const title = el('input', { type: 'text', id: 'g-title', maxlength: 140 });
  const body = el('textarea', { id: 'g-body' });
  const startsAt = el('input', { type: 'datetime-local', id: 'g-when' });
  const capacity = el('input', { type: 'number', id: 'g-many', min: '0', value: '0' });
  const note = el('p', { style: 'margin:0' });

  const send = el('button', { class: 'primary', text: 'Post it' });
  send.addEventListener('click', async () => {
    if (!title.value.trim() || !body.value.trim() || !startsAt.value) {
      note.replaceChildren(el('span', { class: 'err', text: 'Please fill in every box.' }));
      return;
    }
    send.disabled = true;
    try {
      const { thread } = await api(`/channels/${encodeURIComponent(slug)}/threads`, {
        method: 'POST',
        body: {
          title: title.value.trim(),
          body: body.value.trim(),
          meetup: {
            startsAt: new Date(startsAt.value).getTime(),
            capacity: Number(capacity.value) || 0,
          },
        },
      });
      go(`#/p/${thread.id}`);
    } catch (error) {
      note.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally {
      send.disabled = false;
    }
  });

  show(
    el('h1', { text: 'Plan a get-together' }),
    el('p', { class: 'hint', text: category ? `It will show in ${category.name}.` : '' }),
    el('div', { class: 'card' },
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'What is it' }), title),
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'More detail' }), body),
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'When' }), startsAt),
      el('p', { class: 'hint', style: 'margin:-6px 0 16px',
        text: 'You tell each person where to come, privately, once they say they are coming. Commons never shows an address on the page.' }),
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'How many people can come' }),
        el('span', { class: 'help', text: 'Put 0 for no limit.' }), capacity),
      el('div', { class: 'row' }, send, el('button', { class: 'quiet', text: 'Cancel', onclick: () => go(`#/c/${slug}`) })),
      note,
    ),
  );
}

// -------------------------------------------------------------------- posts

async function viewPost(id) {
  const { thread, replies, rsvps } = await api(`/threads/${encodeURIComponent(id)}`);
  pendingChrome.room = thread.channelKind;
  const help = isHelp(thread.channelKind);
  const parts = [
    el('p', { class: 'who' }, el('a', { href: `#/c/${thread.channelSlug}`, text: `Back to ${thread.channelName}` })),
    el('h1', { text: thread.title }),
    who(thread.author, thread.createdAt, thread.authorTopics),
    el('p', { class: 'body', text: thread.body }),
  ];
  if (thread.tags.length) {
    parts.push(el('p', { class: 'row', style: 'gap:8px' }, ...thread.tags.map((t) => el('span', { class: 'tag', text: t }))));
  }
  if (thread.estimate) parts.push(priceBox(thread.estimate));
  if (thread.meetup) parts.push(meetupBox(thread, rsvps));

  parts.push(el('div', { class: 'row', style: 'margin-top:16px' },
    thread.viewerIsAuthor
      ? el('button', {
          class: 'quiet', text: 'Delete this',
          onclick: async () => {
            const yes = await askDialog({ title: 'Delete this?', help: 'It cannot be brought back.', confirmText: 'Delete', danger: true });
            if (!yes) return;
            await api(`/threads/${thread.id}`, { method: 'DELETE' });
            say('Deleted.');
            go(`#/c/${thread.channelSlug}`);
          },
        })
      : reportButton('thread', thread.id),
  ));

  const heading = replies.length === 1 ? '1 answer' : `${replies.length} answers`;
  parts.push(el('h2', { text: heading }));
  if (!replies.length) {
    parts.push(el('p', { class: 'empty', text: help ? 'No answers yet. Yours would help.' : 'Nothing back yet.' }));
  }
  for (const reply of replies) parts.push(answerNode(thread, reply));
  parts.push(answerForm(thread));
  if (thread.meetup) parts.push(meetupMessages(thread));
  show(parts);
}

function answerNode(thread, reply) {
  const node = el('div', { class: `answer${reply.accepted ? ' worked' : ''}`, 'data-id': reply.id },
    reply.accepted ? el('p', { style: 'margin:0 0 6px' }, el('span', { class: 'tag worked', text: 'This is the answer that worked' })) : null,
    who(reply.author, reply.createdAt, reply.authorTopics),
    el('p', { class: 'body', text: reply.body }),
  );

  const acts = el('div', { class: 'row', style: 'margin-top:10px' });
  if (state.me && !reply.viewerIsAuthor) {
    acts.append(el('button', {
      class: `quiet${reply.viewerFoundHelpful ? ' on' : ''}`,
      text: `Say thanks (${reply.helpfulCount})`,
      onclick: async (event) => {
        try {
          const res = await api(`/replies/${reply.id}/helpful`, { method: 'POST' });
          event.currentTarget.textContent = `Say thanks (${res.helpfulCount})`;
          event.currentTarget.classList.toggle('on', res.viewerFoundHelpful);
        } catch (error) { say(error.message); }
      },
    }));
  } else {
    acts.append(el('span', { class: 'who', text: `${reply.helpfulCount} thanks` }));
  }

  if (thread.viewerIsAuthor) {
    acts.append(el('button', {
      class: 'quiet',
      text: reply.accepted ? 'Undo' : 'This one worked',
      onclick: async () => {
        try {
          await api(`/threads/${thread.id}/accept`, { method: 'POST', body: { replyId: reply.accepted ? null : reply.id } });
          route();
        } catch (error) { say(error.message); }
      },
    }));
  }
  if (reply.viewerIsAuthor) {
    acts.append(el('button', {
      class: 'quiet', text: 'Delete',
      onclick: async () => {
        const yes = await askDialog({ title: 'Delete your answer?', confirmText: 'Delete', danger: true });
        if (!yes) return;
        await api(`/replies/${reply.id}`, { method: 'DELETE' });
        route();
      },
    }));
  } else if (state.me) {
    acts.append(reportButton('reply', reply.id));
  }
  node.append(acts);
  return node;
}

function reportButton(kind, id) {
  return el('button', {
    class: 'quiet', text: 'Report a problem',
    onclick: async () => {
      const reason = await askDialog({
        title: 'Report a problem',
        label: 'What is wrong with it',
        help: 'Three reports hide something while we check it.',
        confirmText: 'Send report',
        needsText: true,
      });
      if (reason === null) return;
      try {
        const res = await api('/report', { method: 'POST', body: { kind, id, reason: reason.trim() } });
        say(res.hidden ? 'Reported. It is hidden while we check it.' : 'Reported. Thank you.');
      } catch (error) { say(error.message); }
    },
  });
}

function answerForm(thread) {
  if (!state.me) {
    return el('div', { class: 'card' },
      el('p', { style: 'margin:0 0 12px', text: 'Sign in to answer.' }),
      el('button', { class: 'primary', text: 'Sign in or join', onclick: () => go('#/in') }));
  }
  const field = el('textarea', { id: 'answer' });
  const send = el('button', { class: 'primary', text: 'Send' });
  send.addEventListener('click', async () => {
    if (!field.value.trim()) return;
    send.disabled = true;
    try {
      await api(`/threads/${thread.id}/replies`, { method: 'POST', body: { body: field.value.trim() } });
      field.value = '';
      route();
    } catch (error) { say(error.message); send.disabled = false; }
  });
  return el('div', { class: 'card', style: 'margin-top:18px' },
    el('label', { class: 'field' },
      el('span', { class: 'lab', text: 'Your answer' }),
      isHelp(thread.channelKind) ? el('span', { class: 'help', text: 'Say what you have done yourself.' }) : null,
      field),
    send);
}

function meetupBox(thread, rsvps) {
  const meetup = thread.meetup;
  const full = meetup.capacity > 0 && meetup.rsvps.length >= meetup.capacity && !thread.viewerRsvpd;
  return el('div', { class: 'card', style: 'margin-top:14px' },
    el('p', { style: 'font-weight:700; margin:0', text: when(meetup.startsAt) }),
    el('p', { class: 'hint', style: 'margin:0 0 12px',
      text: `${meetup.rsvps.length} coming${meetup.capacity ? `, room for ${meetup.capacity}` : ''}` }),
    state.me
      ? el('button', {
          class: thread.viewerRsvpd ? '' : 'primary',
          text: thread.viewerRsvpd ? 'I cannot come' : full ? 'Join the waiting list' : "I'm coming",
          onclick: async () => {
            try {
              const res = await api(`/threads/${thread.id}/rsvp`, { method: 'POST' });
              say(res.viewerRsvpd ? (res.waitlisted ? 'You are on the waiting list.' : 'See you there.') : 'Taken off the list.');
              route();
            } catch (error) { say(error.message); }
          },
        })
      : el('button', { class: 'primary', text: 'Sign in to come', onclick: () => go('#/in') }),
    rsvps.length
      ? el('p', { class: 'row', style: 'gap:8px; margin:14px 0 0' },
          ...rsvps.map((p, i) => el('span', {
            class: 'tag',
            text: meetup.capacity > 0 && i >= meetup.capacity ? `${p.displayName} (waiting)` : p.displayName,
          })))
      : null,
    state.me
      ? el('p', { class: 'hint', style: 'margin:14px 0 0', text: thread.viewerIsAuthor
          ? 'Tell each person where to come in the private messages below.'
          : thread.viewerRsvpd
            ? 'The host will send you the details privately.'
            : 'Say you are coming and the host will send you the details privately.' })
      : null,
  );
}

/**
 * The private side of a get-together.
 *
 * The host sees one conversation per person coming; a guest sees only their
 * own. This is the only private channel in Commons, and the server checks both
 * halves of it on every read — the client just draws what it is given.
 */
function meetupMessages(thread) {
  if (!state.me) return null;
  const host = thread.viewerIsAuthor;
  if (!host && !thread.viewerRsvpd) return null;

  const box = el('div', { class: 'card', style: 'margin-top:18px' },
    el('h2', { style: 'margin:0 0 6px', text: host ? 'Private messages' : `Messages with ${thread.author.displayName}` }),
    el('p', { class: 'hint', style: 'margin:0 0 14px', text: host
      ? 'Only you and that person can read these. This is where you send the address.'
      : 'Only you and the host can read these.' }),
  );
  const body = el('div');
  box.append(body);

  if (host) {
    api(`/threads/${thread.id}/message-channels`)
      .then(({ channels }) => {
        if (!channels.length) {
          body.replaceChildren(el('p', { class: 'hint', text: 'Nobody is coming yet.' }));
          return;
        }
        body.replaceChildren(...channels.map((c) => el('button', {
          class: 'post',
          onclick: () => openConversation(thread, c.guest.id, body, c.guest.displayName),
        },
          el('span', { class: 't', text: c.guest.displayName }),
          el('span', { class: 'who' },
            el('span', { text: c.count === 1 ? '1 message' : `${c.count} messages` }),
            c.unread ? el('span', { class: 'tag knows', text: `${c.unread} new` }) : null,
            c.lastAt ? el('span', { text: ago(c.lastAt) }) : el('span', { text: 'Not started' })),
        )));
      })
      .catch((error) => body.replaceChildren(el('p', { class: 'err', text: error.message })));
  } else {
    openConversation(thread, state.me.id, body, thread.author.displayName);
  }
  return box;
}

function openConversation(thread, guestId, host, withName) {
  host.replaceChildren(el('p', { class: 'hint', text: 'Loading…' }));
  const url = `/threads/${thread.id}/messages${thread.viewerIsAuthor ? `?guest=${encodeURIComponent(guestId)}` : ''}`;

  api(url).then((data) => {
    const list = data.messages.length
      ? el('div', { class: 'chat' }, ...data.messages.map((m) => el('div', { class: 'msg' },
          el('p', { class: 'who' },
            el('span', { style: 'font-weight:600', text: m.viewerIsAuthor ? 'You' : (m.author?.displayName ?? 'Someone who has left') }),
            el('span', { text: ago(m.createdAt) })),
          el('p', { class: 'body', text: m.body }),
          m.viewerIsAuthor ? null : el('div', { class: 'row', style: 'margin-top:8px' }, reportButton('message', m.id)),
        )))
      : el('p', { class: 'empty', text: thread.viewerIsAuthor
          ? 'Nothing yet. Send them the address.'
          : 'Nothing yet. The host will be in touch.' });

    const field = el('textarea', { id: 'pm', style: 'min-height:90px' });
    const send = el('button', { id: 'pm-send', class: 'primary', text: 'Send' });
    send.addEventListener('click', async () => {
      if (!field.value.trim()) return;
      send.disabled = true;
      try {
        await api(`/threads/${thread.id}/messages`, {
          method: 'POST',
          body: thread.viewerIsAuthor
            ? { body: field.value.trim(), guest: guestId }
            : { body: field.value.trim() },
        });
        field.value = '';
        openConversation(thread, guestId, host, withName);
      } catch (error) {
        say(error.message);
      } finally { send.disabled = false; }
    });

    // Falsy children are dropped here for the same reason show() drops them:
    // replaceChildren(null) puts the word "null" on the page.
    replaceKids(host,
      thread.viewerIsAuthor
        ? el('div', { class: 'row', style: 'margin-bottom:12px' },
            el('button', { class: 'quiet', text: 'Back to everyone', onclick: () => route() }),
            el('span', { style: 'font-weight:600', text: withName }))
        : null,
      list,
      data.guestIsComing === false
        ? el('p', { class: 'hint', style: 'margin-top:12px', text: 'They are not coming any more, so this conversation is closed.' })
        : el('div', { style: 'margin-top:14px' },
            el('label', { class: 'field' }, el('span', { class: 'lab', text: 'Your message' }), field),
            send),
    );
  }).catch((error) => host.replaceChildren(el('p', { class: 'err', text: error.message })));
}

/**
 * Writing a review.
 *
 * Two kinds. "They helped me here" has to point at the question or
 * get-together it came from, which the server checks; the options offered are
 * whatever the API says actually happened between these two people. "I hired
 * them" is accepted on trust and labelled that way wherever it appears.
 */
function reviewForm(subject, alreadyReviewed) {
  if (!state.me) {
    return el('div', { class: 'card' },
      el('p', { style: 'margin:0 0 12px', text: 'Sign in to write a review.' }),
      el('button', { class: 'primary', text: 'Sign in or join', onclick: () => go('#/in') }));
  }
  if (state.me.id === subject.id) return null;
  if (alreadyReviewed) {
    return el('p', { class: 'hint', style: 'margin-top:14px', text: 'You have already reviewed them.' });
  }

  const rating = el('select', { id: 'r-rating' },
    ...[5, 4, 3, 2, 1].map((n) => el('option', { value: String(n), text: `${n} out of 5` })));
  const body = el('textarea', { id: 'r-body', maxlength: 2000 });
  const kind = el('select', { id: 'r-kind' },
    el('option', { value: 'helped', text: 'They helped me on Commons' }),
    el('option', { value: 'hired', text: 'I hired them for paid work' }));
  const sharedPick = el('select', { id: 'r-thread' });
  const sharedField = el('label', { class: 'field' },
    el('span', { class: 'lab', text: 'Which one' }), sharedPick);
  const unverifiedNote = el('p', { class: 'warnbox', hidden: true,
    text: 'We cannot check paid work. Your review will be shown as unchecked, with your name on it.' });
  const note = el('p', { style: 'margin:0' });

  api(`/people/${encodeURIComponent(subject.handle)}/shared`)
    .then(({ shared }) => {
      if (!shared.length) {
        // Nothing happened between them here, so only the honest option is left.
        kind.value = 'hired';
        kind.options[0].disabled = true;
        kind.options[0].textContent = 'They helped me on Commons (nothing found)';
        sharedField.hidden = true;
        unverifiedNote.hidden = false;
        return;
      }
      sharedPick.replaceChildren(...shared.map((t) => el('option', { value: t.id, text: t.title })));
    })
    .catch(() => { sharedField.hidden = true; });

  kind.addEventListener('change', () => {
    const hired = kind.value === 'hired';
    sharedField.hidden = hired;
    unverifiedNote.hidden = !hired;
  });

  const send = el('button', { class: 'primary', text: 'Post review' });
  send.addEventListener('click', async () => {
    if (!body.value.trim()) {
      note.replaceChildren(el('span', { class: 'err', text: 'Please say something about them.' }));
      return;
    }
    send.disabled = true;
    try {
      const payload = { kind: kind.value, rating: Number(rating.value), body: body.value.trim() };
      if (kind.value === 'helped') {
        if (!sharedPick.value) throw new Error('Choose which question or get-together this was about.');
        payload.threadId = sharedPick.value;
      }
      await api(`/people/${encodeURIComponent(subject.handle)}/reviews`, { method: 'POST', body: payload });
      say('Review posted.');
      route();
    } catch (error) {
      note.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally { send.disabled = false; }
  });

  return el('details', { class: 'card' },
    el('summary', { text: `Write a review of ${subject.displayName}` }),
    el('div', { style: 'margin-top:14px' },
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'What is this about' }), kind),
      sharedField,
      unverifiedNote,
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'Your rating' }), rating),
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'What happened' }),
        el('span', { class: 'help', text: 'Your name is shown with it.' }),
        body),
      el('div', { class: 'row' }, send), note,
    ),
  );
}

// ------------------------------------------------------------- other pages

async function viewMeetups() {
  const { meetups } = await api('/meetups');
  show(
    el('h1', { text: 'Get-togethers' }),
    el('p', { class: 'hint', text: 'Coming up soon. Going on your own is normal here.' }),
    meetups.length
      ? el('div', {}, ...meetups.map(postCard))
      : el('p', { class: 'empty', text: 'Nothing planned yet. You could be the first.' }),
  );
}

async function viewPeople(trade = '') {
  const { people } = await api(trade ? `/people?trade=${encodeURIComponent(trade)}` : '/people');
  const free = people.filter((p) => p.openToChat);
  const rest = people.filter((p) => !p.openToChat);

  const search = el('input', { type: 'text', id: 'tradeq', value: trade, placeholder: 'plumber, electrician…' });
  const findBar = el('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); go(`#/people/${encodeURIComponent(search.value.trim())}`); } },
    el('label', { class: 'field', style: 'margin-bottom:10px' },
      el('span', { class: 'lab', text: 'Looking for a trade?' }),
      el('span', { class: 'help', text: 'Finds people who say they do it for a living.' }),
      search),
    el('div', { class: 'row' },
      el('button', { class: 'primary', type: 'submit', text: 'Find' }),
      trade ? el('button', { type: 'button', class: 'quiet', text: 'Show everyone', onclick: () => go('#/people') }) : null));

  // The server sends them best-reviewed first. Three sections, and nobody is in
  // two of them: who is free to talk right now, then everyone with reviews in
  // the server's order, then everyone without. The last section exists so a new
  // member is not invisible — you cannot earn reviews if nobody ever sees you.
  const shown = new Set(free.map((p) => p.id));
  const reviewed = people.filter((p) => !shown.has(p.id) && p.reviews && p.reviews.count > 0);
  const newcomers = people.filter((p) => !shown.has(p.id) && (!p.reviews || p.reviews.count === 0));

  if (trade) {
    const rated = people.filter((p) => p.reviews && p.reviews.count > 0);
    const unrated = people.filter((p) => !p.reviews || p.reviews.count === 0);
    return show(
      el('h1', { text: 'People' }),
      findBar,
      el('h2', { text: `Say they work as “${trade}”` }),
      rated.length
        ? el('div', { class: 'people' }, ...rated.map(personCard))
        : el('p', { class: 'hint', text: 'Nobody doing that has been reviewed yet.' }),
      unrated.length
        ? el('div', {},
            el('h2', { text: 'No reviews yet' }),
            el('div', { class: 'people' }, ...unrated.map(personCard)))
        : null,
      people.length ? null : el('p', { class: 'empty', text: 'Nobody here says they do that for a living.' }),
    );
  }

  show(
    el('h1', { text: 'People' }),
    findBar,
    free.length
      ? el('div', {}, el('h2', { style: 'margin-top:8px', text: 'Free to talk now' }), el('div', { class: 'people' }, ...free.map(personCard)))
      : el('p', { class: 'hint', text: 'Nobody is free to talk right now.' }),
    reviewed.length
      ? el('div', {},
          el('h2', { text: 'Best reviewed' }),
          el('p', { class: 'hint', style: 'margin:-4px 0 12px',
            text: 'Ordered by their reviews. Reviews about paid work are not checked by us.' }),
          el('div', { class: 'people' }, ...reviewed.map(personCard)))
      : null,
    el('h2', { text: reviewed.length ? 'No reviews yet' : 'Everyone' }),
    newcomers.length
      ? el('div', { class: 'people' }, ...newcomers.map(personCard))
      : el('p', { class: 'hint', text: 'Everybody here has been reviewed.' }),
  );
}

function personCard(person) {
  return el('div', { class: 'person' },
    el('h3', {}, el('a', { href: `#/u/${encodeURIComponent(person.handle)}`, text: person.displayName })),
    tradeLine(person),
    el('p', { class: 'who', style: 'margin:0 0 8px' },
      el('span', { text: person.neighborhood || 'No area given' })),
    person.reviews && person.reviews.count ? ratingLine(person.reviews) : null,
    person.openToChat ? el('p', { class: 'free', style: 'margin:0 0 8px', text: 'Free to talk now' }) : null,
    person.bio ? el('p', { class: 'hint', style: 'margin:0 0 8px', text: person.bio }) : null,
    person.skills.length
      ? el('p', { class: 'row', style: 'gap:8px; margin:0 0 8px' }, ...person.skills.slice(0, 4).map((s) => el('span', { class: 'tag knows', text: s })))
      : null,
    state.me && state.me.id !== person.id ? helloButton(person) : null,
  );
}

function helloButton(person) {
  return el('button', {
    text: 'Say hello',
    onclick: async () => {
      const note = await askDialog({
        title: `Say hello to ${person.displayName}`,
        label: 'Add a line if you like',
        help: 'You can send one hello a day to each person.',
        confirmText: 'Send hello',
        needsText: true,
      });
      if (note === null) return;
      try {
        await api('/waves', { method: 'POST', body: { toUserId: person.id, note: note.trim() } });
        say('Hello sent.');
      } catch (error) { say(error.message); }
    },
  });
}

/**
 * Shut, or reopen, one person's way of reaching you.
 *
 * The wording spells out what a block does and — just as important — what it
 * does not, because the two are easy to confuse. It stops contact. It does not
 * take down anything either of them has posted, and it does not remove a review
 * already written.
 */
function blockButton(person, blocked) {
  return el('button', {
    class: 'quiet',
    style: blocked ? 'margin-top:10px' : 'margin-top:10px; border-color:var(--danger); color:var(--danger)',
    text: blocked ? `Unblock ${person.displayName}` : `Block ${person.displayName}`,
    onclick: async () => {
      const yes = await askDialog({
        title: blocked ? `Unblock ${person.displayName}?` : `Block ${person.displayName}?`,
        help: blocked
          ? 'They will be able to say hello, come to your get-togethers, and message you about them again.'
          : 'They will not be able to say hello to you, message you, come to your get-togethers, or review you — and nor will you to them. Their posts and any review already written stay where they are. They are not told.',
        confirmText: blocked ? 'Unblock' : 'Block',
        danger: !blocked,
      });
      if (!yes) return;
      try {
        const path = `/people/${encodeURIComponent(person.handle)}/block`;
        const result = await api(path, { method: blocked ? 'DELETE' : 'POST' });
        if (blocked) say('Unblocked.');
        else if (result.rsvpsWithdrawn > 0) say('Blocked, and you are no longer down as coming to each other\'s get-togethers.');
        else say('Blocked.');
        route();
      } catch (error) { say(error.message); }
    },
  });
}

async function viewPerson(handle) {
  const { user, threads, summary, reviews, viewerBlocked } = await api(`/people/${encodeURIComponent(handle)}`);
  const { viewerHasReviewed } = state.me
    ? await api(`/people/${encodeURIComponent(handle)}/reviews`).catch(() => ({ viewerHasReviewed: false }))
    : { viewerHasReviewed: false };
  const mine = state.me && state.me.id === user.id;
  show(
    el('h1', { text: user.displayName }),
    el('div', { class: 'card' },
      tradeLine(user),
      el('p', { class: 'hint', style: 'margin:0 0 8px', text: user.neighborhood || 'No area given' }),
      ratingLine(summary),
      user.bio ? el('p', { style: 'margin:10px 0 10px', text: user.bio }) : null,
      user.skills.length
        ? el('p', { class: 'row', style: 'gap:8px; margin:0 0 10px' },
            el('span', { class: 'hint', text: 'Can help with:' }),
            ...user.skills.map((s) => el('span', { class: 'tag knows', text: s })))
        : null,
      user.helpfulCount ? el('p', { class: 'hint', style: 'margin:0 0 10px', text: `${user.helpfulCount} answers that worked.` }) : null,
      state.me && !mine && !viewerBlocked ? helloButton(user) : null,
      viewerBlocked
        ? el('p', { class: 'warnbox', style: 'margin:10px 0 0',
            text: 'You have blocked them. They cannot say hello, message you, come to your get-togethers, or review you. Their posts are still here.' })
        : null,
      state.me && !mine ? blockButton(user, viewerBlocked) : null,
      state.me && state.me.role === 'moderator' && state.me.id !== user.id
        ? el('button', {
            class: 'quiet', style: 'margin-top:10px',
            text: user.role === 'moderator' ? 'Remove as moderator' : 'Make a moderator',
            onclick: async () => {
              const next = user.role === 'moderator' ? 'member' : 'moderator';
              const yes = await askDialog({
                title: next === 'moderator' ? `Make ${user.displayName} a moderator?` : `Remove ${user.displayName} as a moderator?`,
                help: 'Moderators can put back or remove anything that gets reported.',
                confirmText: 'Yes',
              });
              if (!yes) return;
              try {
                await api(`/people/${encodeURIComponent(user.handle)}/role`, { method: 'POST', body: { role: next } });
                say('Changed.');
                route();
              } catch (error) { say(error.message); }
            },
          })
        : null,
    ),
    el('h2', { text: summary.count === 1 ? '1 review' : `${summary.count} reviews` }),
    summary.unverified > 0
      ? el('p', { class: 'warnbox',
          text: 'Everyone who answers or works here has had their identity checked. Reviews about paid work happened off Commons, so we cannot check those.' })
      : null,
    reviews.length
      ? el('div', { class: 'stack' }, ...reviews.map(reviewCard))
      : el('p', { class: 'hint', text: 'Nobody has reviewed them yet.' }),
    viewerBlocked ? null : reviewForm(user, viewerHasReviewed),
    el('h2', { text: 'Their posts' }),
    threads.length ? el('div', {}, ...threads.map(postCard)) : el('p', { class: 'hint', text: 'Nothing yet.' }),
  );
}

async function viewYou() {
  if (signInFirst('see your page')) return;
  await refreshAccount();
  const me = state.me;
  const name = el('input', { type: 'text', id: 'p-name', value: me.displayName, maxlength: 60 });
  const area = el('input', { type: 'text', id: 'p-area', value: me.neighborhood, maxlength: 80 });
  const about = el('textarea', { id: 'p-about', maxlength: 500 }); about.value = me.bio;
  const canHelp = el('input', { type: 'text', id: 'p-help', value: me.skills.join(', ') });
  const trade = el('input', { type: 'text', id: 'p-trade', value: me.trade, maxlength: 60 });
  const forLiving = el('input', { type: 'checkbox', checked: me.worksInTrade });
  const note = el('p', { style: 'margin:0' });

  const free = el('input', { type: 'checkbox', checked: me.openToChat });
  free.addEventListener('change', async () => {
    try {
      const { user } = await api('/me', { method: 'PATCH', body: { openToChat: free.checked } });
      state.me = user;
      say(user.openToChat ? 'People can see you are free to talk.' : 'You are no longer shown as free to talk.');
    } catch (error) { say(error.message); free.checked = !free.checked; }
  });

  const save = el('button', { class: 'primary', text: 'Save' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const { user } = await api('/me', {
        method: 'PATCH',
        body: {
          displayName: name.value.trim(),
          neighborhood: area.value.trim(),
          bio: about.value.trim(),
          skills: canHelp.value.split(',').map((s) => s.trim()).filter(Boolean),
          trade: trade.value.trim(),
          worksInTrade: forLiving.checked,
        },
      });
      state.me = user;
      await loadCategories();
      note.replaceChildren(el('span', { class: 'ok', text: 'Saved.' }));
    } catch (error) {
      note.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally { save.disabled = false; }
  });

  show(
    el('h1', { text: 'Your page' }),
    el('div', { class: 'card' },
      el('label', { class: 'toggle' }, free, "I'm free to talk right now"),
    ),
    el('div', { class: 'card' },
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'Your name' }), name),
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'Your area' }),
        el('span', { class: 'help', text: 'Just the area. Never your address.' }), area),
      el('label', { class: 'field' }, el('span', { class: 'lab', text: 'A bit about you' }), about),
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'What you can help with' }),
        el('span', { class: 'help', text: 'Separate them with commas. Shown next to your answers. We check who you are, not what you can do.' }),
        canHelp),
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'Your trade' }),
        el('span', { class: 'help', text: 'Such as Plumber or Gardener. You need an identity check to list one.' }),
        trade),
      el('label', { class: 'toggle', style: 'margin-bottom:16px' }, forLiving, 'I do this for a living'),
      el('div', { class: 'row' }, save), note,
    ),
    await notificationsPanel(),
    accountPanel(),
    await blockedPanel(),
    await myModeration(),
  );
}

async function viewHellos() {
  if (signInFirst('see your hellos')) return;
  const { waves } = await api('/waves');
  await api('/waves/read', { method: 'POST' });
  state.unreadHellos = 0;
  renderNav();
  show(
    el('h1', { text: 'Hellos' }),
    waves.length
      ? el('div', { class: 'stack' }, ...waves.map((wave) => el('div', { class: 'card', style: 'margin:0' },
          el('p', { class: 'who' },
            wave.from ? el('a', { href: `#/u/${encodeURIComponent(wave.from.handle)}`, text: wave.from.displayName }) : el('span', { text: 'Someone who has left' }),
            el('span', { text: ago(wave.createdAt) })),
          wave.note ? el('p', { class: 'body', text: wave.note }) : null)))
      : el('p', { class: 'empty', text: 'No hellos yet.' }),
  );
}

async function viewSearch(q) {
  const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
  show(
    el('h1', { text: 'Search' }),
    el('p', { class: 'hint', text: `${results.length} found for “${q}”` }),
    results.length ? el('div', {}, ...results.map(postCard)) : el('p', { class: 'empty', text: 'Nothing found. Try a simpler word.' }),
  );
}

function viewJoin() {
  let mode = 'signup';
  const username = el('input', { type: 'text', id: 'j-user', autocomplete: 'username' });
  const name = el('input', { type: 'text', id: 'j-name', autocomplete: 'name' });
  const email = el('input', { type: 'email', id: 'j-email', autocomplete: 'email' });
  const phone = el('input', { type: 'tel', id: 'j-phone', autocomplete: 'tel' });
  const password = el('input', { type: 'password', id: 'j-pass', autocomplete: 'current-password' });
  const note = el('p', { style: 'margin:0' });
  const nameField = el('label', { class: 'field' }, el('span', { class: 'lab', text: 'Your name' }), name);
  const contactFields = el('div', {},
    el('label', { class: 'field' },
      el('span', { class: 'lab', text: 'Email address' }),
      el('span', { class: 'help', text: 'We send a code to check it. Never shown to other members.' }),
      email),
    el('label', { class: 'field' },
      el('span', { class: 'lab', text: 'Phone number' }),
      el('span', { class: 'help', text: 'Also checked with a code. Never shown to other members.' }),
      phone),
  );
  const heading = el('h1', { text: 'Join Commons' });
  const submit = el('button', { class: 'primary', text: 'Create my account' });
  const swap = el('button', { class: 'quiet', text: 'I already have an account' });

  swap.addEventListener('click', () => {
    mode = mode === 'signup' ? 'login' : 'signup';
    const joining = mode === 'signup';
    heading.textContent = joining ? 'Join Commons' : 'Sign in';
    submit.textContent = joining ? 'Create my account' : 'Sign in';
    swap.textContent = joining ? 'I already have an account' : 'I need an account';
    nameField.hidden = !joining;
    contactFields.hidden = !joining;
    note.replaceChildren();
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const body = mode === 'signup'
        ? {
            handle: username.value.trim(),
            displayName: name.value.trim() || undefined,
            email: email.value.trim(),
            phone: phone.value.trim(),
            password: password.value,
          }
        : { handle: username.value.trim(), password: password.value };
      const { user, codesSent } = await api(`/auth/${mode}`, { method: 'POST', body });
      state.me = user;
      renderAccount(); renderNav();
      await Promise.all([loadCategories(), loadHellos()]);
      // A code that did not go is said plainly, and the person is still in.
      const missed = codesSent && (!codesSent.email || !codesSent.phone);
      say(missed
        ? `Welcome, ${user.displayName}. We could not send your code just now. Ask for it again from your page.`
        : `Welcome, ${user.displayName}.`);
      go('#/');
    } catch (error) {
      note.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally { submit.disabled = false; }
  });

  show(
    heading,
    el('div', { class: 'card', style: 'max-width:28rem' },
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'Username' }),
        el('span', { class: 'help', text: 'Letters and numbers. This is the only name other members see.' }),
        username),
      nameField,
      contactFields,
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'Password' }),
        el('span', { class: 'help', text: 'At least 10 characters.' }),
        password),
      el('div', { class: 'row' }, submit, swap),
      note,
    ),
  );
}

/**
 * The moderation queue.
 *
 * Three reports hide something automatically, which is fast but blunt: three
 * people who agree with each other can silence anybody. This is where that gets
 * looked at by a person. Keeping something puts it back and clears the reports,
 * so the same crowd cannot simply report it again.
 */
async function viewModeration() {
  if (signInFirst('see reports')) return;
  if (state.me.role !== 'moderator') {
    return show(
      el('h1', { text: 'Reports' }),
      el('p', { class: 'hint', text: 'Only moderators can see this.' }));
  }
  const [{ cases }, log, identity] = await Promise.all([
    api('/moderation/queue'),
    api('/moderation/log').catch(() => ({ cases: [] })),
    api('/identity/queue').catch(() => ({ requests: [] })),
  ]);
  state.queueSize = cases.length;
  renderNav();

  show(
    el('h1', { text: 'Reports' }),
    identity.requests.length
      ? el('div', {},
          el('h2', { style: 'margin-top:8px', text: 'Waiting to be identity-checked' }),
          el('p', { class: 'hint', style: 'margin:0 0 12px',
            text: 'Arrange to see something in person or by video. Never ask anybody to send a photo of a document, and never write down what was on it.' }),
          el('div', { class: 'stack' }, ...identity.requests.map(identityCard)))
      : null,
    el('h2', { style: 'margin-top:8px', text: 'Reported content' }),
    el('p', { class: 'hint', text: cases.length
      ? 'Content people have reported. Keeping it puts it back and clears the reports.'
      : 'Nothing is waiting.' }),
    cases.length
      ? el('div', { class: 'stack' }, ...cases.map(caseCard))
      : el('p', { class: 'empty', text: 'Nothing to look at. That is a good sign.' }),
    log.cases.length
      ? el('div', {},
          el('h2', { text: 'Already decided' }),
          el('div', { class: 'stack' }, ...log.cases.slice(0, 10).map(decidedCard)))
      : null,
  );
}

function caseCard(item) {
  const decide = async (decision) => {
    const reason = await askDialog({
      title: decision === 'kept' ? 'Put this back?' : 'Remove this?',
      label: 'Why',
      help: decision === 'kept'
        ? 'It becomes visible again and the reports are cleared.'
        : 'It stays hidden. The author can reply once.',
      confirmText: decision === 'kept' ? 'Put it back' : 'Remove it',
      danger: decision === 'removed',
      needsText: true,
    });
    if (reason === null) return;
    try {
      await api(`/moderation/${item.kind}/${item.targetId}/decide`, {
        method: 'POST', body: { decision, reason: reason.trim() },
      });
      say(decision === 'kept' ? 'Put back.' : 'Removed.');
      route();
    } catch (error) { say(error.message); }
  };

  return el('div', { class: 'card', style: 'margin:0' },
    el('p', { class: 'row', style: 'gap:8px; margin:0 0 8px' },
      el('span', { class: 'tag', text: item.preview.where }),
      item.hidden ? el('span', { class: 'tag warnish', text: 'Hidden right now' }) : null,
      el('span', { class: 'tag', text: item.reports.length === 1 ? '1 report' : `${item.reports.length} reports` }),
      item.appeal ? el('span', { class: 'tag trade', text: 'The author replied' }) : null),
    el('h3', { text: item.preview.title }),
    item.author ? el('p', { class: 'who', style: 'margin:4px 0 8px' },
      el('a', { href: `#/u/${encodeURIComponent(item.author.handle)}`, text: item.author.displayName })) : null,
    item.missing
      ? el('p', { class: 'hint', text: 'The author deleted it.' })
      : el('p', { class: 'body', style: 'margin:0', text: item.preview.body }),
    el('div', { style: 'margin-top:12px' },
      el('p', { class: 'hint', style: 'margin:0 0 4px', text: 'Why people reported it' }),
      el('ul', { class: 'reasons' }, ...item.reports.map((r) =>
        el('li', { text: r.reason || 'No reason given' }))),
    ),
    item.appeal
      ? el('div', { class: 'appeal' },
          el('p', { class: 'hint', style: 'margin:0 0 4px', text: 'The author says' }),
          el('p', { style: 'margin:0', text: item.appeal }))
      : null,
    item.missing ? null : el('div', { class: 'row', style: 'margin-top:14px' },
      el('button', { class: 'primary', text: 'Put it back', onclick: () => decide('kept') }),
      el('button', { text: 'Remove it', onclick: () => decide('removed') })),
  );
}

function identityCard(item) {
  const decide = async (outcome) => {
    const detail = await askDialog({
      title: outcome === 'verified' ? `Confirm ${item.user.displayName}?` : `Refuse ${item.user.displayName}?`,
      label: outcome === 'verified' ? 'How you checked' : 'Why',
      help: outcome === 'verified'
        ? 'For example: driving licence, seen in person at the library. This is kept for the record. Never write down the number.'
        : 'They will see this.',
      confirmText: outcome === 'verified' ? 'Confirm them' : 'Refuse',
      danger: outcome === 'refused',
      needsText: true,
    });
    if (detail === null) return;
    try {
      await api(`/identity/${encodeURIComponent(item.user.handle)}/decide`, {
        method: 'POST',
        body: outcome === 'verified'
          ? { outcome, method: detail.trim() }
          : { outcome, reason: detail.trim() },
      });
      say(outcome === 'verified' ? 'Confirmed.' : 'Refused.');
      route();
    } catch (error) { say(error.message); }
  };

  return el('div', { class: 'card', style: 'margin:0' },
    el('p', { class: 'row', style: 'gap:8px; margin:0 0 8px' },
      el('a', { href: `#/u/${encodeURIComponent(item.user.handle)}`, style: 'font-weight:600', text: item.user.displayName }),
      item.contactVerified?.email
        ? el('span', { class: 'tag worked', text: 'Email confirmed' })
        : el('span', { class: 'tag warnish', text: 'Email not confirmed' }),
      item.contactVerified?.phone
        ? el('span', { class: 'tag worked', text: 'Phone confirmed' })
        : el('span', { class: 'tag warnish', text: 'Phone not confirmed' })),
    el('p', { class: 'body', style: 'margin:0', text: item.note }),
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'primary', text: 'Confirm them', onclick: () => decide('verified') }),
      el('button', { text: 'Refuse', onclick: () => decide('refused') })),
  );
}

function decidedCard(item) {
  return el('div', { class: 'card tight', style: 'margin:0' },
    el('p', { class: 'row', style: 'gap:8px; margin:0 0 6px' },
      el('span', { class: item.decision === 'kept' ? 'tag worked' : 'tag warnish',
        text: item.decision === 'kept' ? 'Put back' : 'Removed' }),
      item.decidedBy ? el('span', { class: 'hint', text: `by ${item.decidedBy.displayName}` }) : null,
      item.decidedAt ? el('span', { class: 'hint', text: ago(item.decidedAt) }) : null),
    el('p', { style: 'margin:0; font-weight:600', text: item.preview.title }),
    item.decisionReason ? el('p', { class: 'hint', style: 'margin:4px 0 0', text: item.decisionReason }) : null,
  );
}

/**
 * Your own account: what is checked, and what that unlocks.
 *
 * Contact details appear here and nowhere else — no other member ever sees an
 * email address or a phone number through any route.
 */
/**
 * Everybody the signed-in member has blocked, and a way back.
 *
 * A block that cannot be found again is a trap: people block in a bad moment
 * and want to undo it later, and without a list the only route back is
 * remembering a handle. Nothing here is visible to anybody else.
 */
async function blockedPanel() {
  let blocks;
  try {
    ({ blocks } = await api('/blocks'));
  } catch { return null; }
  if (!blocks.length) return null;

  return el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0', text: blocks.length === 1 ? '1 person you have blocked' : `${blocks.length} people you have blocked` }),
    el('p', { class: 'hint', text: 'They cannot reach you and you cannot reach them. They are not told.' }),
    el('div', { class: 'stack' }, ...blocks.map(({ person, createdAt }) =>
      el('div', { class: 'row', style: 'gap:10px; justify-content:space-between; padding:8px 0; border-top:1px solid var(--border)' },
        el('div', {},
          el('a', { href: `#/u/${encodeURIComponent(person.handle)}`, text: person.displayName }),
          el('p', { class: 'hint', style: 'margin:2px 0 0', text: `Blocked ${ago(createdAt)}` })),
        el('button', {
          class: 'quiet', text: 'Unblock',
          onclick: async () => {
            try {
              await api(`/people/${encodeURIComponent(person.handle)}/block`, { method: 'DELETE' });
              say('Unblocked.');
              route();
            } catch (error) { say(error.message); }
          },
        }),
      ))),
  );
}

/**
 * Notifications, on this device.
 *
 * Push is the one thing that reaches somebody after they have closed the
 * tab: an answer to their question, a hello, a message about a get-together.
 * The browser asks its own permission question; the words here say what will
 * happen before it does, and what to do if it was said no to once.
 */
async function notificationsPanel() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const config = await api('/push/config').catch(() => ({ enabled: false, publicKey: null }));
  const note = el('p', { class: 'hint', style: 'margin:10px 0 0' });
  const iphoneInBrowser = /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone;

  if (!config.enabled) {
    return el('div', { class: 'card' },
      el('h2', { style: 'margin-top:0', text: 'Notifications' }),
      el('p', { class: 'hint', style: 'margin:0', text: 'Not set up on this Commons yet.' }));
  }
  if (!supported) {
    return el('div', { class: 'card' },
      el('h2', { style: 'margin-top:0', text: 'Notifications' }),
      el('p', { class: 'hint', style: 'margin:0', text: 'This browser cannot show them.' }));
  }

  const reg = await navigator.serviceWorker.ready;
  let current = await reg.pushManager.getSubscription();
  const status = el('p', { style: 'margin:0 0 10px; font-weight:600' });
  const on = el('button', { class: 'primary', text: 'Turn on notifications' });
  const off = el('button', { class: 'quiet', text: 'Turn them off' });
  const test = el('button', { class: 'quiet', text: 'Send a test' });
  const row = el('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap' }, on, off, test);

  function paint() {
    const denied = Notification.permission === 'denied';
    status.textContent = current ? 'On for this device.' : denied ? 'Blocked in this browser.' : 'Off on this device.';
    on.hidden = Boolean(current) || denied;
    off.hidden = !current;
    test.hidden = !current;
    note.textContent = denied
      ? 'Allow notifications for this site in your browser settings, then come back.'
      : iphoneInBrowser
        ? 'On an iPhone, add Commons to your home screen first. Then turn these on from there.'
        : current ? 'You will be told when somebody answers you, says hello, or messages you about a get-together.'
          : 'When somebody answers your question, says hello, or messages you about a get-together.';
  }

  const keyBytes = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  on.addEventListener('click', async () => {
    on.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { paint(); return; }
      // The browser's own failure text ("Registration failed - push service
      // error") is nobody's business; the server's sentences are already plain.
      try {
        current = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
      } catch { say('This browser could not set that up just now. Try again later.'); return; }
      await api('/push/subscribe', { method: 'POST', body: current.toJSON() });
      say('Notifications are on for this device.');
    } catch (error) { say(error.message || 'That did not work. Try again.'); }
    finally { on.disabled = false; paint(); }
  });
  off.addEventListener('click', async () => {
    off.disabled = true;
    try {
      const endpoint = current?.endpoint;
      await current?.unsubscribe();
      current = null;
      if (endpoint) await api('/push/subscribe', { method: 'DELETE', body: { endpoint } });
      say('Notifications are off on this device.');
    } catch (error) { say(error.message); }
    finally { off.disabled = false; paint(); }
  });
  test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const { sent } = await api('/push/test', { method: 'POST' });
      say(sent > 0 ? 'Sent. It should appear in a moment.' : 'Nothing to send to. Turn them on first.');
    } catch (error) { say(error.message); }
    finally { test.disabled = false; }
  });

  paint();
  return el('div', { class: 'card', id: 'notifications' },
    el('h2', { style: 'margin-top:0', text: 'Notifications' }),
    status, row, note);
}

function accountPanel() {
  const a = state.account;
  if (!a) return null;

  const codeRow = (channel, label, value, done) => {
    const field = el('input', { type: 'text', inputmode: 'numeric', id: `code-${channel}` });
    const box = el('div', { hidden: true },
      el('label', { class: 'field', style: 'margin:10px 0 8px' },
        el('span', { class: 'lab', text: 'The six-digit code' }), field),
      el('button', {
        class: 'primary', text: 'Confirm',
        onclick: async () => {
          try {
            await api('/auth/confirm-code', { method: 'POST', body: { channel, code: field.value.trim() } });
            say(`${label} confirmed.`);
            route();
          } catch (error) { say(error.message); }
        },
      }));

    return el('div', { style: 'padding:12px 0; border-top:1px solid var(--border)' },
      el('p', { class: 'row', style: 'gap:10px; margin:0' },
        el('span', { style: 'font-weight:600', text: label }),
        done
          ? el('span', { class: 'tag worked', text: 'Confirmed' })
          : el('span', { class: 'tag warnish', text: 'Not confirmed yet' })),
      el('p', { class: 'hint', style: 'margin:4px 0 0', text: value }),
      done ? null : el('div', {},
        el('button', {
          class: 'quiet', style: 'margin-top:8px', text: 'Send me a code',
          onclick: async () => {
            try {
              await api('/auth/send-code', { method: 'POST', body: { channel } });
              box.hidden = false;
              say('Code sent.');
            } catch (error) { say(error.message); }
          },
        }),
        box),
    );
  };

  const request = a.identityRequest;
  const identityBlock = a.identityVerified
    ? el('p', { class: 'row', style: 'gap:10px; margin:0' },
        el('span', { style: 'font-weight:600', text: 'Identity' }),
        el('span', { class: 'tag worked', text: 'Checked' }))
    : el('div', {},
        el('p', { class: 'row', style: 'gap:10px; margin:0 0 6px' },
          el('span', { style: 'font-weight:600', text: 'Identity' }),
          request && request.outcome === null
            ? el('span', { class: 'tag', text: 'Waiting to be checked' })
            : el('span', { class: 'tag warnish', text: 'Not checked' })),
        el('p', { class: 'hint', style: 'margin:0 0 8px',
          text: 'You need this to answer questions, list a trade, or host a get-together. You do not need it to ask for help, to chat, or to come along to anything.' }),
        request && request.outcome === 'refused'
          ? el('p', { class: 'err', style: 'margin:0 0 8px', text: request.refusedReason || 'That was not accepted.' })
          : null,
        request && request.outcome === null
          ? el('p', { class: 'hint', style: 'margin:0', text: 'A moderator will be in touch.' })
          : el('button', {
              text: 'Ask to be checked',
              onclick: async () => {
                const note = await askDialog({
                  title: 'Ask to be checked',
                  label: 'What can you show, and where',
                  help: 'Do not send a photo of anything. Say what you can show and where, and a moderator will arrange it. We never store the document.',
                  confirmText: 'Send',
                  needsText: true,
                });
                if (note === null || !note.trim()) return;
                try {
                  await api('/identity/request', { method: 'POST', body: { note: note.trim() } });
                  say('Sent. A moderator will be in touch.');
                  route();
                } catch (error) { say(error.message); }
              },
            }),
      );

  return el('div', { class: 'card' },
    el('h2', { style: 'margin:0 0 6px', text: 'Your account' }),
    el('p', { class: 'hint', style: 'margin:0 0 6px', text: 'Only you can see any of this.' }),
    codeRow('email', 'Email address', a.email, a.emailVerified),
    codeRow('phone', 'Phone number', a.phone, a.phoneVerified),
    el('div', { style: 'padding:12px 0 0; border-top:1px solid var(--border)' }, identityBlock),
  );
}

/** What has happened to your own posts. Shown on your page. */
async function myModeration() {
  try {
    const { mine } = await api('/moderation/mine');
    if (!mine.length) return null;
    return el('div', {},
      el('h2', { text: 'Reported posts' }),
      el('div', { class: 'stack' }, ...mine.map((item) => el('div', { class: 'card', style: 'margin:0' },
        el('p', { class: 'row', style: 'gap:8px; margin:0 0 8px' },
          item.hidden
            ? el('span', { class: 'tag warnish', text: 'Hidden while we check it' })
            : el('span', { class: 'tag worked', text: 'Still visible' }),
          item.decision === 'removed' ? el('span', { class: 'tag warnish', text: 'Removed' }) : null,
          item.decision === 'kept' ? el('span', { class: 'tag worked', text: 'Checked and kept' }) : null),
        el('p', { style: 'margin:0 0 6px; font-weight:600', text: item.preview.title }),
        item.reasons.length
          ? el('div', {},
              el('p', { class: 'hint', style: 'margin:0 0 4px', text: 'What people said' }),
              el('ul', { class: 'reasons' }, ...item.reasons.map((r) => el('li', { text: r }))))
          : null,
        item.decisionReason
          ? el('p', { class: 'hint', style: 'margin:8px 0 0', text: `A moderator said: ${item.decisionReason}` })
          : null,
        item.appeal
          ? el('p', { class: 'hint', style: 'margin:8px 0 0', text: `You said: ${item.appeal}` })
          : item.canAppeal
            ? el('button', {
                class: 'quiet', style: 'margin-top:10px', text: 'Reply to this',
                onclick: async () => {
                  const note = await askDialog({
                    title: 'Reply about your post',
                    label: 'What you want a moderator to know',
                    help: 'It goes back to a moderator to look at again. You can send this once.',
                    confirmText: 'Send',
                    needsText: true,
                  });
                  if (note === null || !note.trim()) return;
                  try {
                    await api(`/moderation/${item.kind}/${item.targetId}/appeal`, { method: 'POST', body: { note: note.trim() } });
                    say('Sent. A moderator will look again.');
                    route();
                  } catch (error) { say(error.message); }
                },
              })
            : null,
      ))),
    );
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ routing

/**
 * Render whatever the hash says.
 *
 * Serialised deliberately. Views fetch before they paint, so two overlapping
 * calls — a navigation and a live update arriving together — used to race, and
 * whichever finished last won. That put people back on the category page a
 * moment after they posted. Only one render runs at a time now, and anything
 * asked for while one is in flight causes exactly one more afterwards, by
 * which point the hash is settled.
 */
let rendering = false;
let renderAgain = false;

async function route() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try {
    await renderRoute();
  } finally {
    rendering = false;
    if (renderAgain) { renderAgain = false; route(); }
  }
}

async function renderRoute() {
  const hash = window.location.hash || '#/';
  routeHash = hash;
  // Nav and rooms are re-rendered inside show()'s swap (renderShell), so the
  // marks glide with the same cut as the page. Decide the chrome here; show()
  // applies it to <html> at the moment of the swap.
  const route = hash === '#/' ? 'home'
    : hash.startsWith('#/c/') ? 'room'
    : hash.startsWith('#/p/') ? 'post'
    : hash.startsWith('#/u/') ? 'person'
    : 'other';
  const roomSlug = hash.startsWith('#/c/') ? decodeURIComponent(hash.slice(4))
    : hash.startsWith('#/plan/') ? decodeURIComponent(hash.slice(7))
    : null;
  const room = roomSlug !== null ? (state.categories.find((c) => c.slug === roomSlug)?.kind ?? null) : null;
  pendingChrome = { route, room };
  try {
    if (hash.startsWith('#/c/')) return await viewCategory(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/p/')) return await viewPost(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/u/')) return await viewPerson(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/plan/')) return viewPlan(decodeURIComponent(hash.slice(7)));
    if (hash === '#/start') return viewStart();
    if (hash.startsWith('#/find/')) return await viewSearch(decodeURIComponent(hash.slice(7)));
    if (hash === '#/meet') return await viewMeetups();
    if (hash.startsWith('#/people/')) return await viewPeople(decodeURIComponent(hash.slice(9)));
    if (hash === '#/people') return await viewPeople();
    if (hash === '#/you') return await viewYou();
    if (hash === '#/hellos') return await viewHellos();
    if (hash === '#/mod') return await viewModeration();
    if (hash === '#/in') return viewJoin();
    return viewHome();
  } catch (error) {
    show(
      el('h1', { text: 'That did not work' }),
      el('p', { class: 'hint', text: error.message }),
      el('button', { class: 'primary', text: 'Go home', onclick: () => go('#/') }),
    );
  }
}

// ------------------------------------------------------------- live updates

function connectStream() {
  const stream = new EventSource(`${API}/stream`);
  const hash = () => window.location.hash || '#/';

  stream.addEventListener('thread.created', (event) => {
    const data = JSON.parse(event.data);
    const category = state.categories.find((c) => c.id === data.channelId);
    if (category) category.threadCount += 1;
    arrive(category?.kind ?? 'help', category?.slug);
    if ((hash() === `#/c/${category?.slug}` || hash() === '#/') && !typing()) {
      live.push({ id: data.threadId, what: 'post' });
      signalRule(); route();
    }
  });
  stream.addEventListener('reply.created', (event) => {
    const data = JSON.parse(event.data);
    const category = state.categories.find((c) => c.id === data.channelId);
    const onPost = hash() === `#/p/${data.threadId}`;
    arrive(category?.kind ?? 'help', category?.slug);
    if ((onPost || hash() === `#/c/${category?.slug}`) && !typing()) {
      live.push(onPost ? { id: data.replyId, what: 'answer' } : { id: data.threadId, what: 'post' });
      signalRule(); route();
    }
  });
  stream.addEventListener('thread.updated', (event) => {
    const data = JSON.parse(event.data);
    if (hash() === `#/p/${data.threadId}`) route();
  });
  stream.addEventListener('presence.changed', () => {
    if (hash() === '#/people') route();
  });
  stream.addEventListener('meetup.message', (event) => {
    const data = JSON.parse(event.data);
    if (!state.me || data.toUserId !== state.me.id) return;
    sky?.pulse('social');
    if (hash() === `#/p/${data.threadId}`) route();
    else say('You have a new private message about a get-together.');
  });
  stream.addEventListener('wave.sent', (event) => {
    const data = JSON.parse(event.data);
    if (state.me && data.toUserId === state.me.id) {
      sky?.pulse('social');
      state.unreadHellos += 1;
      renderNav();
      say('Somebody said hello to you.');
    }
  });
  stream.onerror = () => {}; // EventSource retries on its own.
}

// ---------------------------------------------------------------- bootstrap

/**
 * Re-read the signed-in person's own account state.
 *
 * Confirming a code or asking to be checked changes what /me returns, and the
 * page has to see that — reading it once at start-up left the panel showing a
 * state the server had already moved on from.
 */
async function refreshAccount() {
  if (!state.me) return;
  try {
    const { user, queueSize, account } = await api('/me');
    state.me = user ?? state.me;
    state.queueSize = queueSize ?? 0;
    state.account = account;
  } catch { /* signed out elsewhere; the next action will say so */ }
}

async function loadCategories() {
  const { channels } = await api('/channels');
  state.categories = channels;
  renderRooms();
}

async function loadHellos() {
  if (!state.me) return;
  try {
    const { unread } = await api('/waves');
    state.unreadHellos = unread;
    renderNav();
  } catch { /* signed out somewhere else; the next action will say so */ }
}

document.getElementById('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if (q) go(`#/find/${encodeURIComponent(q)}`);
});
window.addEventListener('hashchange', route);
document.getElementById('roomsToggle')?.addEventListener('click', () => {
  const open = document.getElementById('rooms')?.classList.contains('open');
  if (open) closeRooms(); else openRooms();
});
document.getElementById('roomsClose')?.addEventListener('click', closeRooms);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeRooms(); });

// The theme: the OS decides unless the person has tapped the word-button once.
// The choice is restored before first paint by the inline script in <head>.
const THEME_KEY = 'commons-theme';
const osDark = window.matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => { const t = document.documentElement.dataset.theme; return t === 'light' || t === 'dark' ? t : (osDark.matches ? 'dark' : 'light'); };
function labelTheme() { const b = document.getElementById('themeToggle'); if (b) b.textContent = effectiveTheme() === 'dark' ? 'Turn lights on' : 'Turn lights off'; }
document.getElementById('themeToggle')?.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode: the choice lasts the session */ }
  labelTheme();
});
osDark.addEventListener('change', labelTheme);
labelTheme();

(async function start() {
  try {
    const { user, queueSize, account } = await api('/me');
    state.me = user;
    state.queueSize = queueSize ?? 0;
    state.account = account;
  } catch { state.me = null; }
  renderAccount();
  // The header sky. Never awaited and never a static import: a 404 or a throw
  // leaves a solid night header and a working app.
  import('/ambient.js').then((m) => { sky = m.startAmbient(document.getElementById('sky')); }).catch(() => {});
  await loadCategories();
  await loadHellos();
  await route();
  connectStream();
})();
