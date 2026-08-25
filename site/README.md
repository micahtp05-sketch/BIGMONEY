# site

A website with no purpose yet — scaffolding only, so that whatever this becomes
starts from a working, accessible, themed baseline instead of a blank directory.

```bash
cd site
npm start        # http://localhost:4000
npm run dev      # same, restarts on file change
```

There is nothing to install. No dependencies, no build step, no framework.

## What's here

```
site/
  server.mjs           ~70-line static server (Node's http module, zero deps)
  public/
    index.html         Homepage
    about.html         What this is and what it deliberately omits
    styleguide.html    Live render of every design token
    404.html           Served with a real 404 status
    styles.css         Design tokens + reset + layout + components
    app.js             Theme toggle, nav current-page marking
```

## Routing

URLs are extensionless. The server tries, in order:

1. the exact path, when it has a file extension (`/styles.css`)
2. the path plus `.html` (`/about` → `public/about.html`)
3. `index.html` inside the path as a directory (`/docs` → `public/docs/index.html`)

Anything unmatched gets `public/404.html` with a 404 status. Paths that try to
escape `public/` are rejected with a 403.

Adding a page means adding one file — no route table to update.

## Theming

The palette lives in one token block at the top of `styles.css`. Dark mode is
defined twice on purpose:

- under `@media (prefers-color-scheme: dark)`, guarded by
  `:root:not([data-theme="light"])`, so the system setting is the default
- under `:root[data-theme="dark"]`, so an explicit toggle wins in both directions

An inline script in each page's `<head>` applies the stored choice before first
paint, so the page never flashes the wrong palette. Every `localStorage` access
is wrapped in `try/catch` — in a private window the toggle simply stops
persisting rather than throwing.

## Giving it a purpose

1. Replace `Untitled` in each page's `<title>`, header brand, and footer.
2. Set the palette and type scale in the token block in `styles.css`.
3. Rewrite `index.html` around the real subject; delete the cards you don't need.
4. Add pages as `public/<name>.html`.

The style guide page renders the tokens live, so it doubles as a check that a
palette change reads correctly in both themes before you commit to it.

## Deliberately absent

Analytics, contact forms, social links, cookie banners, and any CMS. Each of
those depends on what the site turns out to be, so none are pre-empted.

## Relationship to the rest of this repo

Independent. The root of this repository is BIGMONEY, a price-estimate API;
`site/` shares nothing with it — no dependencies, no build, no runtime overlap.
It can be moved to its own repository by copying the directory.
