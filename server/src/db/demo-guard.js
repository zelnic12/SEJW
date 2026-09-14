// Safety rail for the DESTRUCTIVE demo seeds.
//
// `npm run seed` truncates the product catalog and `npm run seed:orders` clears
// orders and customers. Both are fine locally and catastrophic against a live
// database, so their CLI entry points refuse to run when NODE_ENV=production.
//
// Deliberately NOT applied to `npm run migrate` or `npm run seed:admin`: the
// first only applies schema and the second bootstraps the admin account, so both
// are expected to run in production.
//
// The check lives in the scripts' CLI blocks rather than inside the exported
// seed() / seedOrders() functions, so calling those programmatically (a fixture
// builder, a test harness) is still possible without tripping the guard.

/**
 * Exit with a clear message when running against a production environment.
 * @param {string} what human-readable name of the script, used in the message
 */
export function refuseInProduction(what) {
  if (process.env.NODE_ENV !== "production") return;

  console.error(
    `\n✖ Refusing to run ${what} in production.\n` +
    `  NODE_ENV=production is set, and this script would overwrite real data.\n` +
    `  Set NODE_ENV=development to override if this is intentional.\n`
  );
  process.exit(1);
}
