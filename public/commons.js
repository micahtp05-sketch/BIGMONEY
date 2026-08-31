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
};

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
  return el('button', { class: 'post', onclick: () => go(`#/p/${post.id}`) },
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
    return;
  }
  host.append(el('button', {
    class: 'quiet', text: 'Sign out',
    onclick: async () => {
      await api('/auth/logout', { method: 'POST' });
      state.me = null;
      state.unreadHellos = 0;
      renderAccount(); renderNav(); go('#/');
      say('You are signed out.');
    },
  }));
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
    items.push(['#/hellos', 'Hellos', state.unreadHellos]);
    items.push(['#/you', 'You']);
  } else {
    items.push(['#/in', 'Join']);
  }
  host.replaceChildren(...items.map(([href, label, badge]) => el('li', {},
    el('a', { href, 'aria-current': here === href ? 'page' : null },
      label,
      badge ? el('span', { class: 'badge', text: String(badge) }) : null),
  )));
}

// -------------------------------------------------------------------- views

const view = () => document.getElementById('view');
/** replaceChildren stringifies null, so every variadic call goes through here. */
function replaceKids(host, ...nodes) {
  host.replaceChildren(...nodes.flat().filter(Boolean));
}

function show(...nodes) {
  replaceKids(view(), ...nodes);
  window.scrollTo(0, 0);
}

function signInFirst(what) {
  if (state.me) return false;
  show(
    el('h1', { text: 'Please sign in' }),
    el('p', { class: 'hint', text: `You need an account to ${what}.` }),
    el('button', { class: 'primary', text: 'Sign in or join', onclick: () => go('#/in') }),
  );
  return true;
}

/** Home: the six categories, split into the two things people come here for. */
function viewHome() {
  const card = (c) => el('button', { class: `cat ${c.kind}`, onclick: () => go(`#/c/${c.slug}`) },
    el('span', { class: 'nm', text: c.name }),
    el('span', { class: 'hn', text: c.description }),
    el('span', { class: 'ct', text: c.threadCount === 1 ? '1 post' : `${c.threadCount} posts` }),
  );
  const ask = state.categories.filter((c) => isHelp(c.kind));
  const meet = state.categories.filter((c) => !isHelp(c.kind));
  show(
    el('h1', { text: 'What do you need?' }),
    el('h2', { text: 'Ask for help', style: 'margin-top:8px' }),
    el('div', { class: 'cats' }, ...ask.map(card)),
    el('h2', { text: 'Meet people' }),
    el('div', { class: 'cats' }, ...meet.map(card)),
  );
}

async function viewCategory(slug) {
  const { channel, threads } = await api(`/channels/${encodeURIComponent(slug)}`);
  if (isHelp(channel.kind)) return showQuestions(channel, threads);
  return showChat(channel, threads);
}

/** A help category reads as questions with answers. */
function showQuestions(category, posts) {
  show(
    el('h1', { text: category.name }),
    el('p', { class: 'hint', text: category.description }),
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
    el('h2', { style: 'margin:0 0 14px', text: 'Ask a question' }),
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

  return el('div', { class: 'msg' },
    who(post.author, post.createdAt, post.authorTopics),
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
  const node = el('div', { class: `answer${reply.accepted ? ' worked' : ''}` },
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
      class: `quiet${reply.accepted ? ' on' : ''}`,
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

async function viewPeople() {
  const { people } = await api('/people');
  const free = people.filter((p) => p.openToChat);
  const rest = people.filter((p) => !p.openToChat);
  show(
    el('h1', { text: 'People' }),
    free.length
      ? el('div', {}, el('h2', { style: 'margin-top:8px', text: 'Free to talk now' }), el('div', { class: 'people' }, ...free.map(personCard)))
      : el('p', { class: 'hint', text: 'Nobody is free to talk right now.' }),
    el('h2', { text: 'Everyone' }),
    rest.length ? el('div', { class: 'people' }, ...rest.map(personCard)) : el('p', { class: 'hint', text: 'Nobody else yet.' }),
  );
}

function personCard(person) {
  return el('div', { class: 'person' },
    el('h3', {}, el('a', { href: `#/u/${encodeURIComponent(person.handle)}`, text: person.displayName })),
    el('p', { class: 'who', style: 'margin:0 0 8px' },
      el('span', { text: person.neighborhood || 'No area given' })),
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

async function viewPerson(handle) {
  const { user, threads } = await api(`/people/${encodeURIComponent(handle)}`);
  show(
    el('h1', { text: user.displayName }),
    el('div', { class: 'card' },
      el('p', { class: 'hint', style: 'margin:0 0 8px', text: user.neighborhood || 'No area given' }),
      user.bio ? el('p', { style: 'margin:0 0 10px', text: user.bio }) : null,
      user.skills.length
        ? el('p', { class: 'row', style: 'gap:8px; margin:0 0 10px' },
            el('span', { class: 'hint', text: 'Can help with:' }),
            ...user.skills.map((s) => el('span', { class: 'tag knows', text: s })))
        : null,
      user.helpfulCount ? el('p', { class: 'hint', style: 'margin:0 0 10px', text: `${user.helpfulCount} answers that worked.` }) : null,
      state.me && state.me.id !== user.id ? helloButton(user) : null,
    ),
    el('h2', { text: 'Their posts' }),
    threads.length ? el('div', {}, ...threads.map(postCard)) : el('p', { class: 'hint', text: 'Nothing yet.' }),
  );
}

function viewYou() {
  if (signInFirst('see your page')) return;
  const me = state.me;
  const name = el('input', { type: 'text', id: 'p-name', value: me.displayName, maxlength: 60 });
  const area = el('input', { type: 'text', id: 'p-area', value: me.neighborhood, maxlength: 80 });
  const about = el('textarea', { id: 'p-about', maxlength: 500 }); about.value = me.bio;
  const canHelp = el('input', { type: 'text', id: 'p-help', value: me.skills.join(', ') });
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
        el('span', { class: 'help', text: 'Separate them with commas. Shown next to your answers. Nobody checks these.' }),
        canHelp),
      el('div', { class: 'row' }, save), note,
    ),
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
  const password = el('input', { type: 'password', id: 'j-pass', autocomplete: 'current-password' });
  const note = el('p', { style: 'margin:0' });
  const nameField = el('label', { class: 'field' }, el('span', { class: 'lab', text: 'Your name' }), name);
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
    note.replaceChildren();
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const body = mode === 'signup'
        ? { handle: username.value.trim(), displayName: name.value.trim() || undefined, password: password.value }
        : { handle: username.value.trim(), password: password.value };
      const { user } = await api(`/auth/${mode}`, { method: 'POST', body });
      state.me = user;
      renderAccount(); renderNav();
      await Promise.all([loadCategories(), loadHellos()]);
      say(`Welcome, ${user.displayName}.`);
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
        el('span', { class: 'help', text: 'Letters and numbers. This is how people see you.' }),
        username),
      nameField,
      el('label', { class: 'field' },
        el('span', { class: 'lab', text: 'Password' }),
        el('span', { class: 'help', text: 'At least 10 characters. There is no email, so it cannot be reset.' }),
        password),
      el('div', { class: 'row' }, submit, swap),
      note,
    ),
  );
}

// ------------------------------------------------------------------ routing

async function route() {
  const hash = window.location.hash || '#/';
  renderNav();
  try {
    if (hash.startsWith('#/c/')) return await viewCategory(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/p/')) return await viewPost(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/u/')) return await viewPerson(decodeURIComponent(hash.slice(4)));
    if (hash.startsWith('#/plan/')) return viewPlan(decodeURIComponent(hash.slice(7)));
    if (hash.startsWith('#/find/')) return await viewSearch(decodeURIComponent(hash.slice(7)));
    if (hash === '#/meet') return await viewMeetups();
    if (hash === '#/people') return await viewPeople();
    if (hash === '#/you') return viewYou();
    if (hash === '#/hellos') return await viewHellos();
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
    if (hash() === `#/c/${category?.slug}` || hash() === '#/') route();
  });
  stream.addEventListener('reply.created', (event) => {
    const data = JSON.parse(event.data);
    const category = state.categories.find((c) => c.id === data.channelId);
    if (hash() === `#/p/${data.threadId}` || hash() === `#/c/${category?.slug}`) route();
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
    if (hash() === `#/p/${data.threadId}`) route();
    else say('You have a new private message about a get-together.');
  });
  stream.addEventListener('wave.sent', (event) => {
    const data = JSON.parse(event.data);
    if (state.me && data.toUserId === state.me.id) {
      state.unreadHellos += 1;
      renderNav();
      say('Somebody said hello to you.');
    }
  });
  stream.onerror = () => {}; // EventSource retries on its own.
}

// ---------------------------------------------------------------- bootstrap

async function loadCategories() {
  const { channels } = await api('/channels');
  state.categories = channels;
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

(async function start() {
  try {
    const { user } = await api('/me');
    state.me = user;
  } catch { state.me = null; }
  renderAccount();
  await loadCategories();
  await loadHellos();
  await route();
  connectStream();
})();
