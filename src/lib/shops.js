/**
 * Shop allowlist gate. In beta we restrict incoming webhooks to a configured
 * allowlist so that an accidental webhook from another store (or a malicious
 * one that can forge our HMAC, unlikely but cheap mitigation) doesn't trigger
 * real calls.
 *
 * Set ALLOWED_SHOPS in .env as comma-separated shop domains:
 *   ALLOWED_SHOPS=your-shop.myshopify.com,another-store.myshopify.com
 *
 * If unset, defaults to open (all shops allowed) — matches legacy behavior.
 */

const parsed = (() => {
  const raw = process.env.ALLOWED_SHOPS || '';
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list;
})();

export const ALLOWED_SHOPS = parsed;
export const ALLOWLIST_ACTIVE = parsed.length > 0;

export function isShopAllowed(shop) {
  if (!ALLOWLIST_ACTIVE) return true; // no list = open
  if (!shop) return false;
  return parsed.includes(String(shop).trim().toLowerCase());
}
