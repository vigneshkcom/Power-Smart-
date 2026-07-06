# Assets

Static media for the site — Vercel serves everything here directly at a public
URL, which is required for anything embedded in an email (email clients can't
load local files, only real `https://` links).

## Folders

- **`assets/logo/`** — PowerSmart logo files (PNG/SVG, any variants: light/dark,
  icon-only, full lockup). Used to replace the placeholder logo currently
  built into `index.html`/`tools/index.html`.
- **`assets/email/`** — images for quote emails once we design them (header
  banner, product photos, icons, signature images, etc).

## How to upload (no local git needed)

1. Go to the folder on GitHub, e.g.
   https://github.com/vigneshkcom/Power-Smart-/tree/main/assets/email
2. Click **Add file → Upload files**
3. Drag your image(s) in, then **Commit directly to the `main` branch**

## Getting the public URL after upload

Once a file is on `main`, Vercel auto-deploys it and it's reachable at:

```
https://smokealarms.powersmartco.com.au/assets/email/<filename>
https://smokealarms.powersmartco.com.au/assets/logo/<filename>
```

(Also reachable via the same paths on `power-smart-two.vercel.app`.)

Give me the filename(s) once uploaded and I'll wire them into the email
template / swap the logo — no need to paste the image itself into chat.

## Notes

- Keep filenames simple: lowercase, hyphens, no spaces (`logo-full.svg`, not
  `Logo Full (1).svg`).
- SVG preferred for the logo (scales cleanly); PNG/JPG fine for photos.
- Keep individual files under a few MB — large images slow down email load.
