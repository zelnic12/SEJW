# Brand logos

Logos for the "Shop by Brand" row on the homepage. Drop a file in here and it is
picked up automatically — nothing to register, and no brand list to edit.

**Filename must be the brand slug**: the brand name from the catalog, lowercased,
with every run of non-alphanumeric characters replaced by `-`.

| Brand in the catalog | Filename |
|---|---|
| `Aero` | `aero.svg` |
| `PowerCell` | `powercell.svg` |
| `Smart Home Co` | `smart-home-co.svg` |

Accepted formats: `.svg`, `.png`, `.webp`, `.jpg`, `.jpeg` (SVG preferred — it
stays sharp at any size). Logos are displayed at roughly 96×40 px, so a wide
wordmark on a transparent background works best.

Any brand **without** a file here renders as its name in a bordered pill instead,
so the row always looks intentional. `GET /api/brand-logos` reports what's
available (see `server/src/routes/brand-logos.js`); the result is cached for a
minute, so a newly added file appears within 60s.
