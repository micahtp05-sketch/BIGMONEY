# Commons: the simple-UI standard

Who we build for: **a nervous 70-year-old on a tablet, using this for the first time,
who will close the tab rather than ask what a word means.**

Every rule below is checkable by looking at one screen or running one command.
Rules are binding. "It reads better the long way" is not an exemption.

---

## 1. Words we do not use

Left column is banned in user-facing text. Right column is the only replacement.
One word per row — do not invent a third.

| Never say | Always say |
|---|---|
| channel | category |
| thread | post |
| reply (noun or button) | answer |
| topic / topics | subjects |
| tag / tags | subjects |
| wave / waves / "Waved." | hello / hellos |
| "Open to chat right now" | "I'm free to talk" |
| accepted answer / "✓ answered" / "This solved it" | "the answer that worked" |
| helpful / "👍 3" / "3 solved" | thanks / "3 thanks" |
| RSVP / "I'll be there" | "I'm coming" |
| waitlist | waiting list |
| moderation / report / "pending review" | "Report a problem" / "We are checking this" |
| meetup | get-together |
| handle | username |
| display name | your name |
| bio / "About you" | "A bit about you" |
| neighbourhood | your area |
| skills / "skill badges" | "what you can help with" |
| self-declared / vetted / licensed | "they said so themselves" / "checked" |
| kind (of category) | "What is it for?" |
| capacity / "Max (0 = any)" | "How many people can come" |
| comparables | similar items |
| confidence (on a price) | "how sure we are" |
| estimate | rough price |
| composer / "Start a post" | "Write a post" |
| lede / excerpt | (internal only — never on screen) |
| Former member | "Someone who has left" |
| "Search everything…" | "Search" |
| weigh in | "say what they think" |
| low-effort | easy |

Emoji are decoration only. An emoji may sit **beside** a word; it may never **be** the word.

---

## 2. Word budgets

Hard maximums. Count them. Over budget = rewrite, not ship.

| Thing | Max words | Also |
|---|---|---|
| Category name | **3** | and ≤ 20 characters |
| Category one-line hint | **8** | one sentence, ends in a full stop |
| Button label | **3** | starts with a verb |
| Empty-state message | **12** | max 2 sentences, one of which says what to do next |
| Page heading (h1) | **4** | |
| Page intro line under the heading | **15** | or delete it |
| Field label | **4** | |
| Placeholder | **6** | an example only, never an instruction |
| Any single sentence, anywhere | **15** | |

A page's whole visible body copy (excluding user posts) must be **under 60 words**.

---

## 3. Reading level

Target: **reading age 9** (UK plain-English standard). Short Anglo-Saxon verbs beat
long Latinate ones. One idea per sentence. No semicolons. No em-dash asides —
if the aside matters, make it its own sentence; if it doesn't, cut it.

Real strings from this codebase, and their replacements:

| Now | Ship this |
|---|---|
| "Describe the problem, add what you have already tried." | "Tell us what is wrong." |
| "let people who own the same thing weigh in" | "other owners can say what they think" |
| "Nobody on Commons is vetted or licensed" | "Nobody here has been checked" |
| "They are self-declared and shown as such — Commons verifies nothing." | "People say this themselves. We do not check it." |
| "Attach a price estimate from a photo" | "Add a photo to get a rough price" |
| "Low-effort meetups in public places." | "Easy get-togethers in public places." |
| "Nobody has flagged themselves as free to chat right now." | "Nobody is free to talk right now." |
| "3 comparables · 62% confidence" | "Based on 3 similar items" |

---

## 4. Accessibility floor

Numbers, not intentions.

1. **Tap targets: 44 × 44 CSS px minimum**, with **8 px** clear space between adjacent targets.
2. **Body text: 16 px minimum**; 18 px preferred for paragraphs. **Nothing on screen below 14 px, ever** — including chips, bylines, counts and captions.
3. **Form controls: 16 px minimum** font size (below that, iOS zooms the page on focus and the person is lost).
4. **Line height 1.5 minimum** on body copy.
5. **Contrast: 7:1 for body text**, 4.5:1 absolute floor for anything smaller than large; **3:1 for large text** (≥ 24 px, or ≥ 18.66 px bold) and for control borders, focus rings and icons.
6. **Focus-visible is mandatory.** Every interactive element shows a ring of **≥ 2 px** at **≥ 3:1** against what is behind it. `outline: none` is banned unless the same rule supplies a replacement ring.
7. **Icon-only controls are banned.** Every button carries a visible word. Reason: an emoji has no fixed meaning, renders differently or not at all across devices, is read aloud unpredictably, and its tooltip does not exist on a touchscreen — so an icon-only button is a button our reader cannot identify.
8. **Every input has a visible `<label>`**, placed above the field and tied to it by `for`/`id` or by wrapping. A placeholder is never a label. Rules and warnings ("at least 10 characters", "never your address") live in visible help text, not in a placeholder that vanishes on the first keystroke.
9. **Headings in order.** Exactly one `<h1>` per page — the main view's title. No skipped levels (`h1` → `h3` is a bug). Sidebar section headings are `h2`.
10. **Nothing may be revealed only on hover.** No `title=` attribute as the sole carrier of meaning; no hover-only text, price, status or explanation. Touch has no hover.
11. **Colour is never the only signal.** Status carries a word as well as a colour or a dot.
12. **No native `prompt()`, `confirm()` or `alert()`** for anything a person must read or type — they are unlabelled, unstyled and untranslatable. Use an in-page form with a real label and a named cancel button.
13. **The main action on a page is visible on load**, never folded inside a `<details>`, accordion or "show more".
14. **`aria-live` is scoped to the message it announces**, never to the whole page container.
15. **Six categories maximum** in the main list, visible without scrolling on a 768 px-tall tablet.

---

## 5. Pre-publish checklist

Answer yes to all fifteen, or it does not ship.

1. Does every button on the screen contain a word I can read? (look)
2. Is the main action visible without scrolling, tapping or expanding anything? (look)
3. Can I count 3 words or fewer on every button? (look)
4. Are there 6 or fewer categories, each named in 3 words or fewer? (look)
5. Is every category hint 8 words or fewer? `grep -c . src/community/seed.ts` then read the descriptions
6. Does every input have a visible label sitting above it? (look)
7. Does the page have exactly one `<h1>` and no skipped heading levels? Run the browser's accessibility tree, or `grep -n "'h1'\|<h1" public/commons.js public/index.html`
8. Does `grep -n "outline: *none" public/commons.css` return nothing?
9. Does `grep -n "font-size: *\([0-9]\|1[0-3]\)px\|font: *1[0-5]px" public/commons.css` return nothing?
10. Does `grep -n "title:" public/commons.js` return nothing that carries meaning found nowhere else?
11. Does `grep -n "prompt(\|confirm(\|alert(" public/commons.js` return nothing?
12. Does `grep -nP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B50}\x{2705}]" public/commons.js public/index.html` show only emoji that sit next to a word?
13. Does `grep -niE "channel|thread|reply|topic|wave|RSVP|helpful|handle|bio|neighbourhood|moderat" public/commons.js public/index.html` return only code identifiers, never user-facing text?
14. Tab through the whole page — is the focused element obvious at every single stop? (look)
15. Do all touch targets clear 44 px, measured in devtools with a 44 × 44 overlay? (look)

---

## 6. Audit of the current build

**Audited 2026-08-31 against commit `20e81c9` — the pre-rewrite state.**
The categories and the frontend are being rewritten as this is written, so line
numbers and strings below describe the build *before* those rewrites. Any item
already fixed by that work is a win, not a false positive.

Ranked by how much each one hurts a nervous first-time user.

### The eight that matter most

1. **`public/commons.js:381-382`** — the primary action is hidden. The whole post form is wrapped in `el('details', { class: 'card' }, el('summary', { text: isHelp ? 'Ask this channel for help' : 'Start a post' }), …)`. A person who came here to ask for help sees a closed grey strip, not a button. **Fix:** a permanently visible `Ask a question` button as the first thing under the category heading. Never `<details>` for the main action.

2. **`public/commons.css:15`** — `font: 15px/1.55 …` sets the entire app one pixel below the 16 px floor, which also makes every text input trigger iOS zoom-on-focus. **Fix:** `font: 18px/1.6 …`, and never below 16 px on inputs.

3. **`public/commons.js:157`** — `'👋'` is the entire content of the waves button; its only label is `title: 'Waves from other members'` (line 155). On a tablet there is no hover, so this is an unlabelled button leading to a page the person cannot name. **Fix:** `text: 'Hellos'` with the count as a visible number beside it; drop the `title`.

4. **`public/commons.css:5` + `:105`, `:116`, `:62`, `:53`** — `--faint: #6b7484` measures **3.69:1** on `--panel` and **3.46:1** on `--panel-2`, failing 4.5:1 outright, and it is applied at 11–12 px to `.byline`, `.person .handle`, `.navlink .count` and `.navgroup h3`. Small *and* low-contrast is the worst pairing for older eyes. **Fix:** delete `--faint`; use `--muted` (#9aa3b2, 6.84:1) at 16 px minimum.

5. **`public/commons.css:35`** — `input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }` removes the focus ring and replaces it with a 1 px border tint. A keyboard user loses their place in the form. **Fix:** `:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }` and delete the `outline: none`.

6. **`public/commons.js:515` and `:637`** — `prompt('What is wrong with this post?')` and `prompt(\`Send ${person.displayName} a wave. Add a line if you like:\`)`. A bare OS dialog is the single most frightening thing you can show a nervous user, and reporting abuse is exactly when they are least able to cope with one. Same problem at `:424` and `:499` with `confirm('Delete this thread?')`. **Fix:** in-page forms with visible labels and two named buttons (`Send report` / `Cancel`).

7. **`public/commons.js:247`** — the home page opens with 38 words: *"Three things live here: somewhere to ask people nearby for help with the house, standing groups you can belong to, and low-effort ways to spend time with other people. Pick a channel on the left, or start below."* This is the first thing anyone reads and it is 23 words over budget, uses "channel", and describes the app instead of offering an action. **Fix:** heading "Welcome", one line of ≤ 15 words, then three big buttons: *Ask for help* / *Join a group* / *Find company*.

8. **`public/commons.js:198`** — `title: channel.description` puts every category's only explanation in a hover tooltip. On the sidebar nav this means the person choosing where to post gets no help at all on a touchscreen. **Fix:** render the hint as visible text under the category name (8 words, per §2).

### The rest

- `public/commons.js:100` — `title: 'Self-declared on their profile — not verified'` hides the *only* warning that a claimed skill is unchecked, behind hover, in 11 px chip text reading `says they know plumbing`. **Fix:** visible line, "They say they know about plumbing. We have not checked."
- `public/commons.js:202` — `el('span', { class: 'star', title: 'Matches a skill on your profile', text: '★' })` — an icon-only, hover-only, 11 px (`commons.css:65`) signal. **Fix:** remove it or write the words.
- `public/commons.js:469-470, 474, 480` — `text: \`👍 ${reply.helpfulCount}\`` with `title: 'This was useful'`. Emoji-as-label. **Fix:** `Say thanks (3)`.
- `public/commons.js:121, 460, 486, 103` — four different names for one idea: `'✓ answered'`, `'✓ this is what worked'`, `'This solved it'` / `'Unmark'`, `` `${author.helpfulCount} solved` ``. **Fix:** one phrase everywhere — "the answer that worked".
- `public/commons.js:567, 576` — `"I'll be there"` / `"Can't make it"` / `'Join the waitlist'` / `'Sign in to RSVP'`. Four labels, one of them jargon. **Fix:** `I'm coming` / `I can't come` / `Join the waiting list` / `Sign in to come`.
- `public/commons.js:580-583` — going vs. waiting list is carried by `class: 'chip topic'` vs `class: 'chip'` plus `title: 'Waitlist' | 'Going'`: colour-only and hover-only at once. **Fix:** two labelled lists with headings.
- `public/commons.css:28` — `button.ghost { padding: 5px 8px; }` gives a ~35 px tall target; `:19-23` gives the default button ~41 px; `:55-59` gives `.navlink` ~36 px. All three miss 44 px. **Fix:** `min-height: 44px` on every button and nav link.
- `public/commons.css:38` — `label.field > span { font-size: 12px; color: var(--muted); }` renders every form label at 12 px. **Fix:** 16 px, `--text` colour, `font-weight: 600`.
- `public/commons.css:87` — `.chip { font-size: 11px; }` is the smallest text in the app and carries answered-state, price, tags and skill claims. **Fix:** 14 px minimum, or stop using chips for meaning.
- `public/commons.css:103-104` — `.excerpt` at 13 px with `-webkit-line-clamp: 2` silently truncates the post preview mid-sentence. **Fix:** 16 px, and clamp on a word boundary or not at all.
- `public/index.html:15` + `public/commons.js:229` — two `<h1>` elements on every page (`<h1 class="brand">Commons…` in the sidebar, plus the view's own). `public/index.html:27` then uses `<h3>Around here</h3>` with no `h2` above it. **Fix:** sidebar brand becomes a `<p>`; nav headings become `h2`.
- `public/index.html:40` — `<main id="view" aria-live="polite">` wraps the entire page, and `show()` (`commons.js:223`) replaces all of it on every route change, so a screen reader re-reads the whole page on every click. **Fix:** move `aria-live` to the toast only.
- `public/index.html:19` — `placeholder="Search everything…"` with `aria-label="Search"` and no visible label. **Fix:** visible `Search` label; placeholder ≤ 6 words or none.
- `public/index.html:35-37` — a 19-word liability notice in `.small .muted` (13 px, `--muted`) pinned to the bottom of the sidebar: *"Nobody on Commons is vetted or licensed — treat advice as experience, not expertise."* Important, unreadable, and Latinate. **Fix:** "Nobody here has been checked. Take advice as a neighbour's, not an expert's." at 16 px.
- `public/commons.js:788` — `placeholder: 'At least 10 characters'` is the only statement of the password rule and it disappears the moment typing starts; `:786` labels the field `'handle'` in lowercase while the visible label says `Handle`. `:672` hides a safety rule — `'Rough area only — never your address'` — in the same disappearing slot. **Fix:** visible help text under each field.
- `public/commons.js:749` — `placeholder: 'Topics, comma separated — these drive the skill badges'` is 9 words of jargon explaining an invisible mechanism. **Fix:** label "What subjects?", placeholder "plumbing, sewing".
- `public/commons.js:309` — field label `'Max (0 = any)'`. **Fix:** "How many people can come" with an empty field meaning no limit.
- `public/commons.js:115` — `` `${estimate.sampleSize} comparables · ${Math.round(estimate.confidence * 100)}% confidence` ``. **Fix:** "Based on 3 similar items."
- `public/commons.js:852` — the error page reads `header('That did not work', error.message)` and prints raw server text such as `'You are doing that too quickly. Give it a minute.'` or `'No such thread.'` (`src/community/routes.ts:132, 144`). **Fix:** one plain sentence plus a big "Go back" button; never surface a raw API string.
- `public/commons.js:170` — the presence checkbox reads `'Open to chat right now'`; `:610` and `:623` repeat it as a heading and as lowercase `'open to chat'`. **Fix:** "I'm free to talk", identically in all three places.
- `public/commons.js:735` — `'Nothing matched. Try a plainer word — people describe problems, not categories.'` tells the person their search was wrong. **Fix:** "Nothing found. Try another word." plus a browse button.
- `public/commons.js:596, 613` — empty states at 19 and 22 words that name places ("Walks & Coffee") and UI parts ("the toggle is in the sidebar") the reader may not be able to find. **Fix:** ≤ 12 words with a button that does the thing.
- `src/community/seed.ts:50, 58, 106, 114` (pre-rewrite) — category hints of 23, 20, 21 and 14 words, e.g. *"Nobody needs to own a tile saw. Ask for the thing you need for an afternoon, or offer what is in your garage."* Fourteen categories in the sidebar, several named as riddles (`'Is It Worth Fixing?'`, `"The Cook's Table"`, `'Makers & Menders'`, `'The Front Porch'`). **Fix:** six categories, dull literal names of ≤ 3 words, hints of ≤ 8 words. *(The in-flight seed rewrite already does this.)*
- `public/index.html:6` — `<title>Commons — neighbours, experts, and company</title>` claims "experts" that §1 and the site's own disclaimer deny. **Fix:** "Commons — help from people near you".
