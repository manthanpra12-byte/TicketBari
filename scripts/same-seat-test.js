// Proves that two users can never hold the same seat.
// 10 different users try to hold seat A1 of show 2 at the same moment.
// Expected result: exactly 1 succeeds (HTTP 200) and 9 are refused (HTTP 409).
//
// Run it (Docker, no Node needed on your laptop):
//   docker run --rm -e BASE_URL=http://host.docker.internal:8080 -v "${PWD}/scripts:/s" node:20-alpine node /s/same-seat-test.js
// Or with Node 20 installed:
//   node scripts/same-seat-test.js

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const USERS = 10;

async function tryHold(user) {
  const res = await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ show_id: 2, user_id: user, seats: ['A1'] }),
  });
  return { user, status: res.status };
}

async function main() {
  const results = await Promise.all(
    Array.from({ length: USERS }, (_, i) => tryHold(`user${i + 1}`))
  );

  results.forEach((r) => console.log(`${r.user}: HTTP ${r.status}`));

  const won = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status === 409).length;
  console.log(`\nwon: ${won}, refused: ${refused}, other: ${USERS - won - refused}`);

  if (won === 1) {
    console.log('PASS: exactly one user got the seat');
  } else {
    console.log('FAIL: expected exactly one winner (if you ran this before, wait 5 minutes or run: docker compose down -v)');
    process.exit(1);
  }
}

main();
