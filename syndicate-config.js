/* Capital 7 Syndicate 24 — shared Firebase config.
 * Same Firebase project as Alice AI Office Hub / Build A Trust 24
 * (alice-ai-office-hub); syndicate data lives in syndicate-namespaced
 * collections (see firestore-syndicate.rules). Public web config — the
 * same values the trust site ships in its own pages. */
window.SYNDICATE_FIREBASE_CONFIG = {
  apiKey: "AIzaSyC8bhvvZqzLYofItADseipOn7ZCRXTrdNc",
  authDomain: "alice-ai-office-hub.firebaseapp.com",
  projectId: "alice-ai-office-hub",
  storageBucket: "alice-ai-office-hub.firebasestorage.app",
  messagingSenderId: "185381825362",
  appId: "1:185381825362:web:901ee0f7ec4581088c688b"
};
/* Master-user (admin) allowlist — enforced again in Firestore rules. */
window.SYNDICATE_ADMIN_EMAILS = [
  "capital7logistics@gmail.com",
  "capital7lllc@gmail.com",
  "gutterprotectpro@gmail.com"
];
/* Membership presentation (copied from the Build A Trust 24 pattern).
 * Checkout URLs stay UNSET until Madison creates the $20/mo product —
 * the site never invents a payment link. While a URL is empty the plan
 * buttons run the honest placeholder (scroll to free sign-up + notice). */
window.SYNDICATE_PLANS = {
  priceDisplay: "$20/mo",
  monthlyLabel: "Capital 7 Syndicate 24 — Monthly",
  checkoutMonthlyUrl: "",
  checkoutUrl: ""
};
