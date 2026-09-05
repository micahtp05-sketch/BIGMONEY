/**
 * Prints a fresh VAPID key pair as the two lines .env needs.
 *
 *   npm run push:keys
 *
 * Generate once per Commons and keep the private key private: every browser
 * that turns notifications on is bound to the public half, so changing the
 * pair later means everyone has to turn them on again.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.org   # an address a push service can reach you at');
