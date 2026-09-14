// ---- Seed script ----
// Loads the catalog into Postgres. Idempotent: clears product tables first,
// then inserts products and a placeholder image per product. Orders/customers
// are left untouched.
import 'dotenv/config';
import { pathToFileURL } from "node:url";
import { pool, withTransaction } from "./pool.js";
import { SEED_PRODUCTS } from "../data/seed-products.js";
import { refuseInProduction } from "./demo-guard.js";

export async function seed() {
  await withTransaction(async (client) => {
    // Reset product data (cascades to product_images). Restart identity so
    // seeded ids match the catalog ids.
    await client.query("TRUNCATE product_images, products RESTART IDENTITY CASCADE");

    // A few demo promotional prices so the discount UI is visible out of the box.
    // (Admins can change or clear these from the dashboard.)
    const DEMO_SALES = { 1: 1299.00, 4: 799.00, 8: 229.00 };

    for (const p of SEED_PRODUCTS) {
      const salePrice = p.salePrice ?? DEMO_SALES[p.id] ?? null;
      // Preserve the catalog id explicitly so frontend links stay stable.
      await client.query(
        `INSERT INTO products (id, name, brand, category, price, sale_price, rating, emoji, stock, description, specs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [p.id, p.name, p.brand, p.category, p.price, salePrice, p.rating, p.emoji, p.stock, p.description, JSON.stringify(p.specs)]
      );

      // A placeholder image row per product (emoji-based; swap for real URLs later).
      await client.query(
        `INSERT INTO product_images (product_id, url, alt, position)
         VALUES ($1,$2,$3,$4)`,
        [p.id, `emoji:${p.emoji}`, p.name, 0]
      );
    }

    // Keep the SERIAL sequence ahead of the seeded ids.
    await client.query(
      "SELECT setval(pg_get_serial_sequence('products','id'), (SELECT MAX(id) FROM products))"
    );

    // Demo homepage carousel slides — inserted ONLY when the table is empty so
    // re-seeding never clobbers (or resurrects) admin-managed banners.
    const { rows: bannerCount } = await client.query("SELECT COUNT(*)::int AS n FROM banners");
    if (bannerCount[0].n === 0) {
      const DEMO_BANNERS = [
        {
          headline: "Promo laptop pilihan",
          subtext: "Hemat sampai 20% untuk laptop kerja & kuliah. Garansi resmi, stok terbatas.",
          ctaText: "Lihat laptop",
          ctaLink: "category.html?name=Laptops",
          backgroundColor: "#C8102E",
        },
        {
          headline: "Audio jernih, harga bersahabat",
          subtext: "Headphone dan speaker dari brand terpercaya, siap kirim hari ini.",
          ctaText: "Belanja audio",
          ctaLink: "category.html?name=Audio",
          backgroundColor: "#1F2937",
        },
        {
          headline: "Gratis pengiriman se-Indonesia",
          subtext: "Untuk semua pesanan di atas nilai minimum. Produk original, garansi resmi.",
          ctaText: "Mulai belanja",
          ctaLink: "#catalog",
          backgroundColor: "#0F766E",
        },
      ];
      let position = 0;
      for (const b of DEMO_BANNERS) {
        await client.query(
          `INSERT INTO banners (headline, subtext, cta_text, cta_link, background_color, position, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [b.headline, b.subtext, b.ctaText, b.ctaLink, b.backgroundColor, position++]
        );
      }
      console.log(`✓ Seeded ${DEMO_BANNERS.length} homepage banners`);
    }
  });

  console.log(`✓ Seeded ${SEED_PRODUCTS.length} products (+ images)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // This truncates the product catalog — never against a production database.
  refuseInProduction("the demo product seed");
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(err => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
