import { openStore } from '../lib/store.mjs';
import { validateEmail } from '../lib/auth.mjs';

const email = validateEmail(process.argv[2]);
const db = openStore();
const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
if (!user?.verified) {
  console.error('Create an account and verify its email in the app first, then run: npm run admin -- you@example.com');
  process.exitCode = 1;
} else {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  console.log(`Admin access granted to ${email}. Refresh the app to open the admin workspace.`);
}
db.close();
