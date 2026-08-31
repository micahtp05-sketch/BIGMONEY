/**
 * Commons — a single-page client over /api/community.
 *
 * No framework and no build step, matching the rest of this repo. Two rules
 * hold the whole thing together:
 *   1. Everything the server sends is rendered as text, never as markup, so a
 *      post can never inject script into someone else's browser.
 *   2. Views are pure functions of route + fetched data; live events just
 *      re-run the current view.
 */

const API = '/api/community';

const state = {
  me: null,
  channels: [],
  waves: [],
  unreadWaves: 0,
};

// ---------------------------------------------------------------- utilities

/** Build an element. `text` sets textContent — there is no innerHTML path. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
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
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message, bad = false) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
function ago(ts) {
  const diff = Date.now() - ts;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function when(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function money(cents, currency) {
  if (cents === null || cents === undefined) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' })
    .format(cents / 100);
}

const KIND_LABEL = { help: 'Ask for help', group: 'Groups', social: 'Together' };

function go(route) { window.location.hash = route; }

// ------------------------------------------------------------- shared parts

/** Byline with the author's self-declared, channel-relevant topics beside it. */
function byline(author, ts, topics = []) {
  return el('div', { class: 'byline' },
    el('a', { href: `#/u/${encodeURIComponent(author.handle)}`, text: author.displayName }),
    topics.length
      ? el('span', { class: 'chip topic', title: 'Self-declared on their profile — not verified', text: `says they know ${topics.join(', ')}` })
      : null,
    author.helpfulCount > 0
      ? el('span', { class: 'chip', title: 'Answers marked as the one that helped', text: `${author.helpfulCount} solved` })
      : null,
    el('span', { text: ago(ts) }),
  );
}

function estimateCard(estimate) {
  return el('div', { class: 'estimate' },
    el('div', { class: 'small muted', text: estimate.title }),
    el('div', { class: 'price', text: money(estimate.estimateCents, estimate.currency) }),
    el('div', { class: 'small muted', text:
      `${money(estimate.lowCents, estimate.currency)}–${money(estimate.highCents, estimate.currency)} · ` +
      `${estimate.sampleSize} comparables · ${Math.round(estimate.confidence * 100)}% confidence` }),
  );
}

function threadCard(thread) {
  const chips = el('div', { class: 'row', style: 'gap:6px' },
    thread.acceptedReplyId ? el('span', { class: 'chip answered', text: '✓ answered' }) : null,
    thread.meetup ? el('span', { class: 'chip meetup', text: `${when(thread.meetup.startsAt)} · ${thread.meetup.rsvps.length} going` }) : null,
    thread.estimate ? el('span', { class: 'chip', text: money(thread.estimate.estimateCents, thread.estimate.currency) }) : null,
    ...thread.tags.map((tag) => el('span', { class: 'chip', text: `#${tag}` })),
  );
  return el('button', {
    class: 'thread-item',
    onclick: () => go(`#/t/${thread.id}`),
  },
    el('p', { class: 't', text: thread.title }),
    el('p', { class: 'excerpt', text: thread.body }),
    el('div', { class: 'row', style: 'gap:10px' },
      byline(thread.author, thread.updatedAt, thread.authorTopics),
      el('span', { class: 'byline', text: `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}` }),
    ),
    chips.childElementCount ? chips : null,
  );
}

// ----------------------------------------------------------------- sidebar

function renderAccount() {
  const host = document.getElementById('account');
  host.replaceChildren();

  if (!state.me) {
    host.append(el('button', { class: 'primary', style: 'width:100%', onclick: () => go('#/join'), text: 'Sign in or join' }));
    return;
  }

  host.append(
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('a', { href: '#/me', text: state.me.displayName, style: 'font-weight:600' }),
      el('button', {
        id: 'waves', class: 'ghost', title: 'Waves from other members',
        onclick: () => go('#/waves'),
      }, '👋', state.unreadWaves ? el('span', { class: 'badge', text: String(state.unreadWaves) }) : null),
    ),
    el('label', { class: 'check', style: 'margin-top:8px' },
      el('input', {
        type: 'checkbox', checked: state.me.openToChat,
        onchange: async (event) => {
          try {
            const { user } = await api('/me', { method: 'PATCH', body: { openToChat: event.target.checked } });
            state.me = user;
            toast(user.openToChat ? "You're listed as open to chat." : 'No longer listed as open to chat.');
          } catch (error) { toast(error.message, true); }
        },
      }),
      'Open to chat right now',
    ),
    el('button', {
      class: 'ghost', style: 'padding-left:0',
      onclick: async () => {
        await api('/auth/logout', { method: 'POST' });
        state.me = null; state.waves = []; state.unreadWaves = 0;
        renderAccount(); route();
      },
      text: 'Sign out',
    }),
  );
}

function renderChannelNav() {
  const host = document.getElementById('channelNav');
  host.replaceChildren();
  const current = window.location.hash;

  for (const kind of ['help', 'group', 'social']) {
    const inKind = state.channels.filter((c) => c.kind === kind);
    if (!inKind.length) continue;
    const group = el('div', { class: 'navgroup' }, el('h3', { text: KIND_LABEL[kind] }));
    for (const channel of inKind) {
      group.append(el('button', {
        class: 'navlink',
        'aria-current': current === `#/c/${channel.slug}` ? 'true' : 'false',
        onclick: () => go(`#/c/${channel.slug}`),
        title: channel.description,
      },
        el('span', { class: `dot ${channel.kind}` }),
        el('span', { text: channel.name }),
        channel.matchesYourSkills ? el('span', { class: 'star', title: 'Matches a skill on your profile', text: '★' }) : null,
        el('span', { class: 'count', text: String(channel.threadCount) }),
      ));
    }
    host.append(group);
  }

  // Static links live in the HTML; keep their current-state in step too.
  for (const link of document.querySelectorAll('#sidebar .navlink[data-route]')) {
    link.setAttribute('aria-current', link.dataset.route === current ? 'true' : 'false');
    if (!link.dataset.bound) {
      link.dataset.bound = '1';
      link.addEventListener('click', () => go(link.dataset.route));
    }
  }
}

// ------------------------------------------------------------------- views

const view = () => document.getElementById('view');

function show(...nodes) {
  view().replaceChildren(...nodes.flat().filter(Boolean));
  window.scrollTo(0, 0);
}

function header(title, lede, ...extra) {
  return el('div', {}, el('h1', { text: title }), lede ? el('p', { class: 'lede', text: lede }) : null, ...extra);
}

function requireSignIn(action) {
  if (state.me) return false;
  show(header('Sign in first', `You need an account to ${action}.`),
    el('button', { class: 'primary', onclick: () => go('#/join'), text: 'Sign in or join' }));
  return true;
}

// ---- home ----
async function viewHome() {
  const { meetups } = await api('/meetups');
  const helpChannels = state.channels.filter((c) => c.kind === 'help');
  const recent = [...state.channels].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 4);

  show(
    header('Welcome to Commons',
      'Three things live here: somewhere to ask people nearby for help with the house, standing groups you can belong to, and low-effort ways to spend time with other people. Pick a channel on the left, or start below.'),
    el('div', { class: 'card' },
      el('h2', { text: 'Need a hand with something?' }),
      el('p', { class: 'small muted', text: 'Describe the problem and what you have already tried. People who have done the same repair will weigh in.' }),
      el('div', { class: 'row' }, ...helpChannels.map((c) =>
        el('button', { onclick: () => go(`#/c/${c.slug}`), text: c.name }))),
    ),
    el('div', { class: 'card' },
      el('h2', { text: "What's on" }),
      meetups.length
        ? el('div', {}, ...meetups.slice(0, 4).map(threadCard))
        : el('p', { class: 'small muted', text: 'No meetups posted yet. Anyone can put a time and a place in a social channel.' }),
    ),
    el('div', { class: 'card' },
      el('h2', { text: 'Busiest lately' }),
      el('div', { class: 'row' }, ...recent.map((c) =>
        el('button', { onclick: () => go(`#/c/${c.slug}`), text: `${c.name} · ${c.threadCount}` }))),
    ),
  );
}

// ---- channel ----
async function viewChannel(slug) {
  const { channel, threads } = await api(`/channels/${encodeURIComponent(slug)}`);
  show(
    header(channel.name, channel.description,
      el('div', { class: 'row', style: 'margin:-14px 0 20px' },
        el('span', { class: `chip kind-${channel.kind}`, text: KIND_LABEL[channel.kind] }),
        ...channel.topics.map((t) => el('span', { class: 'chip', text: t })),
      )),
    composer(channel),
    threads.length
      ? el('div', {}, ...threads.map(threadCard))
      : el('p', { class: 'empty', text: 'Nothing here yet. Be the first — an empty channel stays empty until somebody goes first.' }),
  );
}

function composer(channel) {
  if (!state.me) {
    return el('div', { class: 'card tight' },
      el('span', { class: 'muted small', text: 'Sign in to post here. ' }),
      el('a', { href: '#/join', text: 'Join Commons' }));
  }

  const isHelp = channel.kind === 'help';
  let attached = null;

  const title = el('input', { placeholder: isHelp ? 'What do you need? e.g. "Radiator cold at the top"' : 'Give your post a title', maxlength: 140 });
  const body = el('textarea', { placeholder: isHelp
    ? 'What is happening, how long for, and what you have already tried.'
    : 'Say more.' });
  const tags = el('input', { placeholder: 'Tags, comma separated (optional)' });
  const status = el('div', { class: 'small' });

  // Meetup fields — only meaningful where people actually gather.
  const meetupOn = el('input', { type: 'checkbox' });
  const startsAt = el('input', { type: 'datetime-local' });
  const place = el('input', { placeholder: 'Where — a public place works best' });
  const capacity = el('input', { type: 'number', min: '0', value: '0' });
  const meetupFields = el('div', { class: 'row', style: 'display:none; gap:10px; align-items:flex-end' },
    el('label', { class: 'field', style: 'flex:1 1 190px; margin:0' }, el('span', { text: 'When' }), startsAt),
    el('label', { class: 'field', style: 'flex:2 1 240px; margin:0' }, el('span', { text: 'Where' }), place),
    el('label', { class: 'field', style: 'flex:0 0 110px; margin:0' }, el('span', { text: 'Max (0 = any)' }), capacity),
  );
  meetupOn.addEventListener('change', () => {
    meetupFields.style.display = meetupOn.checked ? 'flex' : 'none';
  });

  // Photo -> price estimate, reusing the estimator pipeline so "repair or
  // replace?" starts from a number instead of a guess.
  const photo = el('input', { type: 'file', accept: 'image/*' });
  const estimateBox = el('div');
  photo.addEventListener('change', async () => {
    const file = photo.files?.[0];
    if (!file) return;
    estimateBox.replaceChildren(el('p', { class: 'small muted', text: 'Reading the photo and finding comparables…' }));
    const form = new FormData();
    form.append('image', file);
    form.append('hint', title.value);
    try {
      const res = await fetch('/api/estimate', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Estimate failed.');
      attached = {
        title: data.item.title,
        estimateCents: data.estimate?.estimateCents ?? null,
        lowCents: data.estimate?.lowCents ?? null,
        highCents: data.estimate?.highCents ?? null,
        currency: data.estimate?.currency ?? 'USD',
        confidence: data.estimate?.confidence ?? 0,
        sampleSize: data.estimate?.sampleSize ?? 0,
      };
      estimateBox.replaceChildren(estimateCard(attached));
      if (!title.value) title.value = `Worth fixing? ${data.item.title}`;
    } catch (error) {
      attached = null;
      estimateBox.replaceChildren(el('p', { class: 'err', text: `Could not estimate: ${error.message}` }));
    }
  });

  const post = el('button', { class: 'primary', text: isHelp ? 'Ask' : 'Post' });
  post.addEventListener('click', async () => {
    if (!title.value.trim() || !body.value.trim()) {
      status.replaceChildren(el('span', { class: 'err', text: 'A title and a body, please.' }));
      return;
    }
    const payload = {
      title: title.value.trim(),
      body: body.value.trim(),
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
    };
    if (attached) payload.estimate = attached;
    if (meetupOn.checked) {
      if (!startsAt.value || !place.value.trim()) {
        status.replaceChildren(el('span', { class: 'err', text: 'A meetup needs a time and a place.' }));
        return;
      }
      payload.meetup = {
        startsAt: new Date(startsAt.value).getTime(),
        place: place.value.trim(),
        capacity: Number(capacity.value) || 0,
      };
    }
    post.disabled = true;
    try {
      const { thread } = await api(`/channels/${encodeURIComponent(channel.slug)}/threads`, { method: 'POST', body: payload });
      go(`#/t/${thread.id}`);
    } catch (error) {
      status.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally {
      post.disabled = false;
    }
  });

  const details = el('details', { class: 'card' },
    el('summary', { text: isHelp ? 'Ask this channel for help' : 'Start a post' }),
    el('div', { style: 'margin-top:14px' },
      el('label', { class: 'field' }, el('span', { text: 'Title' }), title),
      el('label', { class: 'field' }, el('span', { text: 'Details' }), body),
      el('label', { class: 'field' }, el('span', { text: 'Tags' }), tags),
      channel.kind !== 'help'
        ? el('label', { class: 'check', style: 'margin-bottom:10px' }, meetupOn, 'This is a meetup — add a time and place')
        : null,
      channel.kind !== 'help' ? meetupFields : null,
      isHelp
        ? el('label', { class: 'field', style: 'margin-top:10px' },
            el('span', { text: 'Optional: attach a price estimate from a photo of the item' }), photo)
        : null,
      estimateBox,
      el('div', { class: 'row', style: 'margin-top:12px' }, post, status),
    ),
  );
  return details;
}

// ---- thread ----
async function viewThread(id) {
  const { thread, replies, rsvps } = await api(`/threads/${encodeURIComponent(id)}`);
  const parts = [];

  parts.push(el('div', { class: 'byline', style: 'margin-bottom:8px' },
    el('a', { href: `#/c/${thread.channelSlug}`, text: `← ${thread.channelName}` })));
  parts.push(el('h1', { text: thread.title }));
  parts.push(byline(thread.author, thread.createdAt, thread.authorTopics));
  parts.push(el('p', { class: 'body', text: thread.body }));
  if (thread.tags.length) {
    parts.push(el('div', { class: 'row', style: 'margin-top:10px; gap:6px' },
      ...thread.tags.map((t) => el('span', { class: 'chip', text: `#${t}` }))));
  }
  if (thread.estimate) parts.push(estimateCard(thread.estimate));
  if (thread.meetup) parts.push(meetupPanel(thread, rsvps));

  parts.push(el('div', { class: 'row', style: 'margin-top:14px' },
    thread.viewerIsAuthor
      ? el('button', {
          class: 'ghost', text: 'Delete',
          onclick: async () => {
            if (!confirm('Delete this thread?')) return;
            await api(`/threads/${thread.id}`, { method: 'DELETE' });
            toast('Deleted.');
            go(`#/c/${thread.channelSlug}`);
          },
        })
      : reportButton('thread', thread.id),
  ));

  parts.push(el('hr', { class: 'sep' }));
  parts.push(el('h2', { text: `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` }));

  if (!replies.length) {
    parts.push(el('p', { class: 'empty', text: emptyRepliesCopy(thread) }));
  }
  for (const reply of replies) parts.push(replyNode(thread, reply));

  parts.push(replyComposer(thread));
  show(parts);
}

/** A question with no answers and a supper with no takers need different nudges. */
function emptyRepliesCopy(thread) {
  if (thread.channelKind === 'help') {
    return 'No replies yet. If you know something about this, say so — a half-answer beats silence.';
  }
  if (thread.meetup) {
    return 'Nobody has said anything yet. Ask about the details, or just say you are coming.';
  }
  return 'No replies yet. Saying something small is enough.';
}

function replyNode(thread, reply) {
  // Built through el(), which drops nulls — Element.append(null) would render
  // the string "null" into the page.
  const node = el('div', { class: `reply${reply.accepted ? ' accepted' : ''}` },
    reply.accepted ? el('span', { class: 'chip answered', text: '✓ this is what worked' }) : null,
    byline(reply.author, reply.createdAt, reply.authorTopics),
    el('p', { class: 'body', text: reply.body }),
  );

  const actions = el('div', { class: 'actions' });
  if (state.me && !reply.viewerIsAuthor) {
    actions.append(el('button', {
      class: `ghost${reply.viewerFoundHelpful ? ' on' : ''}`,
      text: `👍 ${reply.helpfulCount}`,
      title: 'This was useful',
      onclick: async (event) => {
        try {
          const res = await api(`/replies/${reply.id}/helpful`, { method: 'POST' });
          event.currentTarget.textContent = `👍 ${res.helpfulCount}`;
          event.currentTarget.classList.toggle('on', res.viewerFoundHelpful);
        } catch (error) { toast(error.message, true); }
      },
    }));
  } else {
    actions.append(el('span', { class: 'byline', text: `👍 ${reply.helpfulCount}` }));
  }

  if (thread.viewerIsAuthor) {
    actions.append(el('button', {
      class: `ghost${reply.accepted ? ' on' : ''}`,
      text: reply.accepted ? 'Unmark' : 'This solved it',
      onclick: async () => {
        try {
          await api(`/threads/${thread.id}/accept`, { method: 'POST', body: { replyId: reply.accepted ? null : reply.id } });
          route();
        } catch (error) { toast(error.message, true); }
      },
    }));
  }
  if (reply.viewerIsAuthor) {
    actions.append(el('button', {
      class: 'ghost', text: 'Delete',
      onclick: async () => {
        if (!confirm('Delete this reply?')) return;
        await api(`/replies/${reply.id}`, { method: 'DELETE' });
        route();
      },
    }));
  } else if (state.me) {
    actions.append(reportButton('reply', reply.id));
  }
  node.append(actions);
  return node;
}

function reportButton(kind, id) {
  return el('button', {
    class: 'ghost', text: 'Report',
    onclick: async () => {
      const reason = prompt('What is wrong with this post?');
      if (reason === null) return;
      try {
        const res = await api('/report', { method: 'POST', body: { kind, id, reason } });
        toast(res.hidden ? 'Reported — it is now hidden pending review.' : 'Reported. Thank you.');
      } catch (error) { toast(error.message, true); }
    },
  });
}

function replyComposer(thread) {
  if (!state.me) {
    return el('div', { class: 'card tight' },
      el('span', { class: 'muted small', text: 'Sign in to reply. ' }),
      el('a', { href: '#/join', text: 'Join Commons' }));
  }
  const body = el('textarea', {
    placeholder: thread.channelKind === 'help'
      ? 'Answer from what you have actually done. Say what you are unsure about.'
      : 'Say something back.',
  });
  const send = el('button', { class: 'primary', text: 'Reply' });
  send.addEventListener('click', async () => {
    if (!body.value.trim()) return;
    send.disabled = true;
    try {
      await api(`/threads/${thread.id}/replies`, { method: 'POST', body: { body: body.value.trim() } });
      body.value = '';
      route();
    } catch (error) {
      toast(error.message, true);
    } finally {
      send.disabled = false;
    }
  });
  return el('div', { class: 'card', style: 'margin-top:18px' }, body, el('div', { style: 'margin-top:10px' }, send));
}

function meetupPanel(thread, rsvps) {
  const meetup = thread.meetup;
  const full = meetup.capacity > 0 && meetup.rsvps.length >= meetup.capacity && !thread.viewerRsvpd;
  return el('div', { class: 'card', style: 'margin-top:14px' },
    el('div', { class: 'spread' },
      el('div', {},
        el('div', { style: 'font-weight:600', text: when(meetup.startsAt) }),
        el('div', { class: 'small muted', text: meetup.place }),
        el('div', { class: 'small muted', text:
          `${meetup.rsvps.length} going${meetup.capacity ? ` · room for ${meetup.capacity}` : ''}` }),
      ),
      state.me
        ? el('button', {
            class: thread.viewerRsvpd ? '' : 'primary',
            text: thread.viewerRsvpd ? "Can't make it" : full ? 'Join the waitlist' : "I'll be there",
            onclick: async () => {
              try {
                const res = await api(`/threads/${thread.id}/rsvp`, { method: 'POST' });
                toast(res.viewerRsvpd ? (res.waitlisted ? 'You are on the waitlist.' : 'See you there.') : 'Taken off the list.');
                route();
              } catch (error) { toast(error.message, true); }
            },
          })
        : el('a', { href: '#/join', text: 'Sign in to RSVP' }),
    ),
    rsvps.length
      ? el('div', { class: 'row', style: 'margin-top:12px; gap:6px' },
          ...rsvps.map((p, i) => el('span', {
            class: meetup.capacity > 0 && i >= meetup.capacity ? 'chip' : 'chip topic',
            title: meetup.capacity > 0 && i >= meetup.capacity ? 'Waitlist' : 'Going',
            text: p.displayName,
          })))
      : null,
  );
}

// ---- meetups ----
async function viewMeetups() {
  const { meetups } = await api('/meetups');
  show(
    header("What's on", 'Every upcoming meetup, soonest first. Turning up alone is normal here.'),
    meetups.length
      ? el('div', {}, ...meetups.map(threadCard))
      : el('p', { class: 'empty', text: 'Nothing scheduled. Post a time and a place in Walks & Coffee — one person is enough to start.' }),
  );
}

// ---- people ----
async function viewPeople() {
  const { people } = await api('/people');
  const open = people.filter((p) => p.openToChat);
  const rest = people.filter((p) => !p.openToChat);

  show(
    header('Members', 'Who is here, what they say they know, and who is around to talk right now.'),
    open.length
      ? el('div', {},
          el('h2', { text: 'Open to chat right now' }),
          el('div', { class: 'grid' }, ...open.map(personCard)),
          el('hr', { class: 'sep' }))
      : el('p', { class: 'small muted', text: 'Nobody has flagged themselves as free to chat right now. You can be the first — the toggle is in the sidebar.' }),
    el('h2', { text: 'Everyone' }),
    rest.length ? el('div', { class: 'grid' }, ...rest.map(personCard)) : el('p', { class: 'small muted', text: '—' }),
  );
}

function personCard(person) {
  return el('div', { class: 'person' },
    el('h3', {}, el('a', { href: `#/u/${encodeURIComponent(person.handle)}`, text: person.displayName })),
    el('div', { class: 'handle', text: `@${person.handle}${person.neighborhood ? ` · ${person.neighborhood}` : ''}` }),
    person.openToChat ? el('div', { class: 'presence', style: 'margin-top:6px' }, el('i'), 'open to chat') : null,
    person.bio ? el('p', { class: 'small muted', style: 'margin:8px 0 0', text: person.bio }) : null,
    person.skills.length
      ? el('div', { class: 'row', style: 'margin-top:8px; gap:5px' }, ...person.skills.slice(0, 5).map((s) => el('span', { class: 'chip topic', text: s })))
      : null,
    state.me && state.me.id !== person.id ? waveButton(person) : null,
  );
}

function waveButton(person) {
  return el('button', {
    class: 'ghost', style: 'margin-top:10px; padding-left:0',
    text: '👋 Say hello',
    onclick: async () => {
      const note = prompt(`Send ${person.displayName} a wave. Add a line if you like:`);
      if (note === null) return;
      try {
        await api('/waves', { method: 'POST', body: { toUserId: person.id, note } });
        toast('Waved.');
      } catch (error) { toast(error.message, true); }
    },
  });
}

async function viewProfile(handle) {
  const { user, threads } = await api(`/people/${encodeURIComponent(handle)}`);
  show(
    header(user.displayName, user.bio || null),
    el('div', { class: 'card tight' },
      el('div', { class: 'handle small muted', text: `@${user.handle}${user.neighborhood ? ` · ${user.neighborhood}` : ''} · here since ${new Date(user.createdAt).toLocaleDateString()}` }),
      user.skills.length
        ? el('div', { class: 'row', style: 'margin-top:10px; gap:6px' }, ...user.skills.map((s) => el('span', { class: 'chip topic', text: s })))
        : null,
      user.helpfulCount
        ? el('p', { class: 'small muted', style: 'margin:10px 0 0', text: `${user.helpfulCount} answers marked as the one that helped.` })
        : null,
      state.me && state.me.id !== user.id ? waveButton(user) : null,
    ),
    el('h2', { text: 'Posts' }),
    threads.length ? el('div', {}, ...threads.map(threadCard)) : el('p', { class: 'small muted', text: 'Nothing posted yet.' }),
  );
}

// ---- me ----
function viewMe() {
  if (requireSignIn('edit your profile')) return;
  const me = state.me;
  const displayName = el('input', { value: me.displayName, maxlength: 60 });
  const bio = el('textarea', { value: me.bio, maxlength: 500, placeholder: 'A couple of lines. What you are around for.' });
  const neighborhood = el('input', { value: me.neighborhood, maxlength: 80, placeholder: 'Rough area only — never your address' });
  const skills = el('input', { value: me.skills.join(', '), placeholder: 'plumbing, sewing, wifi' });
  const status = el('div', { class: 'small' });

  const save = el('button', { class: 'primary', text: 'Save' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const { user } = await api('/me', { method: 'PATCH', body: {
        displayName: displayName.value.trim(),
        bio: bio.value.trim(),
        neighborhood: neighborhood.value.trim(),
        skills: skills.value.split(',').map((s) => s.trim()).filter(Boolean),
      } });
      state.me = user;
      renderAccount();
      await loadChannels();
      status.replaceChildren(el('span', { class: 'ok', text: 'Saved.' }));
    } catch (error) {
      status.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally {
      save.disabled = false;
    }
  });

  show(
    header('Your profile',
      'Skills you list here are shown next to your replies in matching channels. They are self-declared and shown as such — Commons verifies nothing.'),
    el('div', { class: 'card' },
      el('label', { class: 'field' }, el('span', { text: 'Display name' }), displayName),
      el('label', { class: 'field' }, el('span', { text: 'About you' }), bio),
      el('label', { class: 'field' }, el('span', { text: 'Neighbourhood' }), neighborhood),
      el('label', { class: 'field' }, el('span', { text: 'Skills, comma separated' }), skills),
      el('div', { class: 'row' }, save, status),
    ),
  );
}

async function viewWaves() {
  if (requireSignIn('see your waves')) return;
  const { waves } = await api('/waves');
  await api('/waves/read', { method: 'POST' });
  state.unreadWaves = 0;
  renderAccount();

  show(
    header('Waves', 'Someone here wanted you to know they saw you. Answering in a channel is the easiest reply.'),
    waves.length
      ? el('div', {}, ...waves.map((wave) => el('div', { class: 'card tight' },
          el('div', { class: 'byline' },
            wave.from ? el('a', { href: `#/u/${encodeURIComponent(wave.from.handle)}`, text: wave.from.displayName }) : 'Former member',
            el('span', { text: ago(wave.createdAt) })),
          wave.note ? el('p', { class: 'body', text: wave.note }) : null,
        )))
      : el('p', { class: 'empty', text: 'No waves yet.' }),
  );
}

// ---- search ----
async function viewSearch(q) {
  const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
  show(
    header(`Search: ${q}`, `${results.length} ${results.length === 1 ? 'match' : 'matches'}`),
    results.length ? el('div', {}, ...results.map(threadCard)) : el('p', { class: 'empty', text: 'Nothing matched. Try a plainer word — people describe problems, not categories.' }),
  );
}

// ---- new channel ----
function viewNewChannel() {
  if (requireSignIn('start a channel')) return;
  const name = el('input', { maxlength: 60, placeholder: 'e.g. Bike Repair Corner' });
  const kind = el('select', {},
    el('option', { value: 'help', text: 'Ask for help — problems and expert opinions' }),
    el('option', { value: 'group', text: 'Group — a standing shared interest' }),
    el('option', { value: 'social', text: 'Together — company and meetups' }),
  );
  const description = el('input', { maxlength: 280, placeholder: 'One line on what belongs here' });
  const topics = el('input', { placeholder: 'Topics, comma separated — these drive the skill badges' });
  const status = el('div', { class: 'small' });
  const create = el('button', { class: 'primary', text: 'Create channel' });

  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const { channel } = await api('/channels', { method: 'POST', body: {
        name: name.value.trim(),
        kind: kind.value,
        description: description.value.trim(),
        topics: topics.value.split(',').map((t) => t.trim()).filter(Boolean),
      } });
      await loadChannels();
      go(`#/c/${channel.slug}`);
    } catch (error) {
      status.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally {
      create.disabled = false;
    }
  });

  show(
    header('Start a channel', 'Three a day, so the list stays somewhere people can actually find things.'),
    el('div', { class: 'card' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
      el('label', { class: 'field' }, el('span', { text: 'Kind' }), kind),
      el('label', { class: 'field' }, el('span', { text: 'Description' }), description),
      el('label', { class: 'field' }, el('span', { text: 'Topics' }), topics),
      el('div', { class: 'row' }, create, status),
    ),
  );
}

// ---- join / sign in ----
function viewJoin() {
  let mode = 'signup';
  const handle = el('input', { placeholder: 'handle', autocomplete: 'username' });
  const displayName = el('input', { placeholder: 'Name people will see', autocomplete: 'name' });
  const password = el('input', { type: 'password', placeholder: 'At least 10 characters', autocomplete: 'current-password' });
  const status = el('div', { class: 'small' });
  const submit = el('button', { class: 'primary', text: 'Create account' });
  const toggle = el('button', { class: 'ghost', text: 'I already have an account' });
  const nameField = el('label', { class: 'field' }, el('span', { text: 'Display name' }), displayName);

  toggle.addEventListener('click', () => {
    mode = mode === 'signup' ? 'login' : 'signup';
    submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    toggle.textContent = mode === 'signup' ? 'I already have an account' : 'I need an account';
    nameField.style.display = mode === 'signup' ? 'block' : 'none';
    status.replaceChildren();
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const body = mode === 'signup'
        ? { handle: handle.value.trim(), displayName: displayName.value.trim() || undefined, password: password.value }
        : { handle: handle.value.trim(), password: password.value };
      const { user } = await api(`/auth/${mode}`, { method: 'POST', body });
      state.me = user;
      renderAccount();
      await Promise.all([loadChannels(), loadWaves()]);
      toast(`Welcome, ${user.displayName}.`);
      go('#/');
    } catch (error) {
      status.replaceChildren(el('span', { class: 'err', text: error.message }));
    } finally {
      submit.disabled = false;
    }
  });

  show(
    header('Join Commons',
      'One handle, one password. No email, because nothing here needs to reach you anywhere else.'),
    el('div', { class: 'card', style: 'max-width:440px' },
      el('label', { class: 'field' }, el('span', { text: 'Handle' }), handle),
      nameField,
      el('label', { class: 'field' }, el('span', { text: 'Password' }), password),
      el('div', { class: 'row' }, submit, toggle),
      status,
    ),
  );
}

// ------------------------------------------------------------------ routing

async function route() {
  const hash = window.location.hash || '#/';
  renderChannelNav();
  try {
    if (hash.startsWith('#/c/')) return await viewChannel(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/t/')) return await viewThread(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/u/')) return await viewProfile(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/search/')) return await viewSearch(decodeURIComponent(hash.slice(9)));
    if (hash === '#/meetups') return await viewMeetups();
    if (hash === '#/people') return await viewPeople();
    if (hash === '#/me') return viewMe();
    if (hash === '#/waves') return await viewWaves();
    if (hash === '#/join') return viewJoin();
    if (hash === '#/new-channel') return viewNewChannel();
    return await viewHome();
  } catch (error) {
    show(header('That did not work', error.message),
      el('button', { onclick: () => go('#/'), text: 'Back to the front page' }));
  }
}

// -------------------------------------------------------------- live updates

function connectStream() {
  const stream = new EventSource(`${API}/stream`);
  const refresh = () => { route(); };

  // Only re-render when the change could be on screen — an unrelated channel
  // getting a post should not yank the page out from under someone reading.
  stream.addEventListener('thread.created', (event) => {
    const data = JSON.parse(event.data);
    const channel = state.channels.find((c) => c.id === data.channelId);
    if (channel) channel.threadCount += 1;
    renderChannelNav();
    if (window.location.hash === `#/c/${channel?.slug}` || window.location.hash === '#/') refresh();
  });
  stream.addEventListener('reply.created', (event) => {
    const data = JSON.parse(event.data);
    if (window.location.hash === `#/t/${data.threadId}`) refresh();
  });
  stream.addEventListener('thread.updated', (event) => {
    const data = JSON.parse(event.data);
    if (window.location.hash === `#/t/${data.threadId}`) refresh();
  });
  stream.addEventListener('presence.changed', () => {
    if (window.location.hash === '#/people') refresh();
  });
  stream.addEventListener('wave.sent', (event) => {
    const data = JSON.parse(event.data);
    if (state.me && data.toUserId === state.me.id) {
      state.unreadWaves += 1;
      renderAccount();
      toast('Somebody waved at you.');
    }
  });
  // EventSource reconnects on its own; nothing to do but note the gap.
  stream.onerror = () => {};
}

// ---------------------------------------------------------------- bootstrap

async function loadChannels() {
  const { channels } = await api('/channels');
  state.channels = channels;
  renderChannelNav();
}

async function loadWaves() {
  if (!state.me) return;
  try {
    const { unread } = await api('/waves');
    state.unreadWaves = unread;
    renderAccount();
  } catch { /* not signed in any more; the next action will say so */ }
}

document.getElementById('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if (q) go(`#/search/${encodeURIComponent(q)}`);
});

window.addEventListener('hashchange', route);

(async function start() {
  try {
    const { user } = await api('/me');
    state.me = user;
  } catch { state.me = null; }
  renderAccount();
  await loadChannels();
  await loadWaves();
  await route();
  connectStream();
})();
