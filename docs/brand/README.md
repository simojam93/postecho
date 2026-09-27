# PostEcho icon

A geometric **P** whose bowl sends out two fading echo arcs: a post that echoes. Silver `#e6e8ec` on the app's background `#08080a` (the app's palette, never orange).

- `web/src/app/icon.svg`: the rounded tile browsers show in tabs (Next's `icon` file convention).
- `web/src/app/favicon.ico`: 16/32/48 PNG-in-ICO for anything that asks for `/favicon.ico`.
- `web/src/app/apple-icon.png`: 180×180, full bleed (iOS applies its own mask).
- `icon-preview.png`: the tile large, then 64/32/16 on a dark and a light tab bar, and 16/32 enlarged.

Regenerate every file from the one drawing in `postecho-mark.mjs`:

```bash
node docs/brand/render-icons.mjs <output-folder>
```

(`render-icons.mjs` loads `sharp` from `web/node_modules`.)
