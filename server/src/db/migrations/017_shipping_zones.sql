-- ============================================================================
-- Migration 017 — Jabodetabek shipping zones
-- ADDITIVE / idempotent.
--
-- Delivery is limited to Greater Jakarta and priced per kecamatan. The order
-- keeps the zone id plus a snapshot of the city/district, so history survives a
-- zone being renamed or removed later (same principle as the order item price
-- snapshots).
-- ============================================================================

CREATE TABLE IF NOT EXISTS shipping_zones (
  id            SERIAL PRIMARY KEY,
  city_name     TEXT        NOT NULL,       -- kota/kabupaten, groups the dropdown
  district_name TEXT        NOT NULL,       -- kecamatan, what the customer picks
  shipping_fee  NUMERIC(12,2) NOT NULL CHECK (shipping_fee >= 0),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per kecamatan (case-insensitive, so "Menteng" can't be added twice).
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_zones_city_district
  ON shipping_zones (lower(city_name), lower(district_name));
-- The checkout dropdown reads "active zones, grouped by city".
CREATE INDEX IF NOT EXISTS idx_shipping_zones_active
  ON shipping_zones (is_active, city_name, district_name);

-- Which zone a delivery order was priced against.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_zone_id INTEGER REFERENCES shipping_zones (id) ON DELETE SET NULL;
-- Kecamatan snapshot; the city already goes in the existing ship_city column.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS ship_district TEXT;

-- ---------------------------------------------------------------------------
-- Starting coverage: the main kecamatan across Jakarta's 5 kota, Bogor, Depok,
-- Tangerang, Tangerang Selatan and Bekasi. Not exhaustive by design — the owner
-- adds/edits the rest from the admin Shipping zones page.
--
-- Fees are placeholder starting values (flat per city, higher for the outer
-- kabupaten) meant to be adjusted to the store's real courier rates.
--
-- Inserted only when the table is empty, so a zone the owner deletes doesn't
-- come back on the next boot.
-- ---------------------------------------------------------------------------
INSERT INTO shipping_zones (city_name, district_name, shipping_fee)
SELECT z.city_name, z.district_name, z.shipping_fee
  FROM (VALUES
    -- ---- DKI Jakarta ----
    ('Jakarta Pusat', 'Gambir',              18000),
    ('Jakarta Pusat', 'Menteng',             18000),
    ('Jakarta Pusat', 'Tanah Abang',         18000),
    ('Jakarta Pusat', 'Senen',               18000),
    ('Jakarta Pusat', 'Cempaka Putih',       18000),
    ('Jakarta Pusat', 'Kemayoran',           18000),
    ('Jakarta Pusat', 'Sawah Besar',         18000),
    ('Jakarta Pusat', 'Johar Baru',          18000),

    ('Jakarta Selatan', 'Kebayoran Baru',    18000),
    ('Jakarta Selatan', 'Kebayoran Lama',    18000),
    ('Jakarta Selatan', 'Cilandak',          18000),
    ('Jakarta Selatan', 'Pasar Minggu',      18000),
    ('Jakarta Selatan', 'Pancoran',          18000),
    ('Jakarta Selatan', 'Mampang Prapatan',  18000),
    ('Jakarta Selatan', 'Tebet',             18000),
    ('Jakarta Selatan', 'Setiabudi',         18000),
    ('Jakarta Selatan', 'Jagakarsa',         20000),
    ('Jakarta Selatan', 'Pesanggrahan',      20000),

    ('Jakarta Barat', 'Grogol Petamburan',   18000),
    ('Jakarta Barat', 'Palmerah',            18000),
    ('Jakarta Barat', 'Taman Sari',          18000),
    ('Jakarta Barat', 'Tambora',             18000),
    ('Jakarta Barat', 'Kebon Jeruk',         20000),
    ('Jakarta Barat', 'Kembangan',           20000),
    ('Jakarta Barat', 'Cengkareng',          20000),
    ('Jakarta Barat', 'Kalideres',           20000),

    ('Jakarta Timur', 'Matraman',            18000),
    ('Jakarta Timur', 'Jatinegara',          18000),
    ('Jakarta Timur', 'Kramat Jati',         20000),
    ('Jakarta Timur', 'Duren Sawit',         20000),
    ('Jakarta Timur', 'Pulo Gadung',         20000),
    ('Jakarta Timur', 'Pasar Rebo',          20000),
    ('Jakarta Timur', 'Cakung',              22000),
    ('Jakarta Timur', 'Ciracas',             22000),
    ('Jakarta Timur', 'Cipayung',            22000),
    ('Jakarta Timur', 'Makasar',             20000),

    ('Jakarta Utara', 'Tanjung Priok',       20000),
    ('Jakarta Utara', 'Kelapa Gading',       20000),
    ('Jakarta Utara', 'Pademangan',          20000),
    ('Jakarta Utara', 'Penjaringan',         20000),
    ('Jakarta Utara', 'Koja',                22000),
    ('Jakarta Utara', 'Cilincing',           22000),

    -- ---- Depok ----
    ('Depok', 'Beji',                        25000),
    ('Depok', 'Pancoran Mas',                25000),
    ('Depok', 'Cimanggis',                   25000),
    ('Depok', 'Sukmajaya',                   25000),
    ('Depok', 'Cinere',                      25000),
    ('Depok', 'Limo',                        27000),
    ('Depok', 'Sawangan',                    27000),
    ('Depok', 'Cilodong',                    27000),
    ('Depok', 'Tapos',                       27000),

    -- ---- Kota Tangerang ----
    ('Tangerang', 'Tangerang',               25000),
    ('Tangerang', 'Cipondoh',                25000),
    ('Tangerang', 'Ciledug',                 25000),
    ('Tangerang', 'Karang Tengah',           25000),
    ('Tangerang', 'Larangan',                25000),
    ('Tangerang', 'Pinang',                  25000),
    ('Tangerang', 'Cibodas',                 27000),
    ('Tangerang', 'Batuceper',               27000),
    ('Tangerang', 'Benda',                   27000),
    ('Tangerang', 'Neglasari',               27000),
    ('Tangerang', 'Periuk',                  27000),
    ('Tangerang', 'Jatiuwung',               27000),

    -- ---- Tangerang Selatan ----
    ('Tangerang Selatan', 'Ciputat',         25000),
    ('Tangerang Selatan', 'Ciputat Timur',   25000),
    ('Tangerang Selatan', 'Pondok Aren',     25000),
    ('Tangerang Selatan', 'Pamulang',        27000),
    ('Tangerang Selatan', 'Serpong',         27000),
    ('Tangerang Selatan', 'Serpong Utara',   27000),
    ('Tangerang Selatan', 'Setu',            30000),

    -- ---- Kota Bekasi ----
    ('Bekasi Kota', 'Bekasi Barat',          25000),
    ('Bekasi Kota', 'Bekasi Selatan',        25000),
    ('Bekasi Kota', 'Bekasi Timur',          25000),
    ('Bekasi Kota', 'Bekasi Utara',          25000),
    ('Bekasi Kota', 'Pondok Gede',           25000),
    ('Bekasi Kota', 'Jatiasih',              27000),
    ('Bekasi Kota', 'Rawalumbu',             27000),
    ('Bekasi Kota', 'Medan Satria',          27000),
    ('Bekasi Kota', 'Bantargebang',          30000),
    ('Bekasi Kota', 'Mustika Jaya',          30000),
    ('Bekasi Kota', 'Jatisampurna',          30000),
    ('Bekasi Kota', 'Pondok Melati',         27000),

    -- ---- Kabupaten Bekasi ----
    ('Bekasi Kabupaten', 'Tambun Selatan',   32000),
    ('Bekasi Kabupaten', 'Tambun Utara',     32000),
    ('Bekasi Kabupaten', 'Cibitung',         35000),
    ('Bekasi Kabupaten', 'Setu',             35000),
    ('Bekasi Kabupaten', 'Cikarang Barat',   40000),
    ('Bekasi Kabupaten', 'Cikarang Utara',   40000),
    ('Bekasi Kabupaten', 'Cikarang Selatan', 40000),
    ('Bekasi Kabupaten', 'Cikarang Pusat',   40000),

    -- ---- Kota Bogor ----
    ('Bogor Kota', 'Bogor Tengah',           32000),
    ('Bogor Kota', 'Bogor Utara',            32000),
    ('Bogor Kota', 'Bogor Selatan',          35000),
    ('Bogor Kota', 'Bogor Barat',            35000),
    ('Bogor Kota', 'Bogor Timur',            35000),
    ('Bogor Kota', 'Tanah Sareal',           32000)
  ) AS z(city_name, district_name, shipping_fee)
 WHERE NOT EXISTS (SELECT 1 FROM shipping_zones);
