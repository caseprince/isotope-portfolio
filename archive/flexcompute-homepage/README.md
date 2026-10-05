# flexcompute.com homepage archive

A static snapshot of https://www.flexcompute.com/ as served on 2026-10-05, from deploy
`be4385ebe5f` of `flexcompute/flex` (PR #22050). It loads nothing from another origin
and carries no analytics, consent manager, forms or tracking IDs.

Serve the directory over HTTP from any path; every asset reference is relative.

- **Links** go to the live site, as absolute URLs.
- **`?hl=<tag>`** localizes the hero exactly as on the live site: `de fr es pt it pl ru
  ja ko zh-Hans zh-Hant ar he`. Japanese, Korean, Chinese, Arabic and Hebrew use local
  Noto subsets in `assets/fonts/hero-i18n/`, cut to the characters each translation uses.
- **Search** opens the same panel. A query hands off to
  `https://www.flexcompute.com/search/?q=…`, by Enter or the suggestion row.
- `assets/css/home.css` is the site's stylesheets merged and purged against this page.
- `<meta name="robots" content="noindex">` keeps the copy from competing with the live
  homepage in search results.
