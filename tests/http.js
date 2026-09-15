process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_smoke?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_API_KEY = '123';
process.env.CLOUDINARY_API_SECRET = 'secret';
process.env.FRONTEND_URL = 'http://localhost:5173';

const app = require('../server/app');
const User = require('../server/src/models/user.model');
const RolePermission = require('../server/src/models/rolePermission.model');
const { DEFAULT_GRANTS } = require('../server/src/utils/permissions');
const { permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/v1`;

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };

  console.log('\n== Auth');
  const noAuth = await call('GET', '/reports/dashboard');
  ok('No token -> 401', noAuth.status === 401, noAuth.body?.code);

  const badLogin = await call('POST', '/auth/login', { body: { username: 'admin', password: 'wrongpass' } });
  ok('Wrong password -> 401', badLogin.status === 401, badLogin.body?.code);

  // the smoke test created admin with password 'test1234'
  const login = await call('POST', '/auth/login', { body: { username: 'admin', password: 'test1234' } });
  ok('Admin login 200', login.status === 200);
  const adminToken = login.body?.data?.accessToken;
  ok('Access token received', Boolean(adminToken));
  ok('Permissions came through too', Array.isArray(login.body?.data?.permissions) && login.body.data.permissions.length > 40,
     `${login.body?.data?.permissions?.length} keys`);

  const dash = await call('GET', '/reports/dashboard', { token: adminToken });
  ok('Admin dashboard 200', dash.status === 200, `outstanding ₹${dash.body?.data?.outstanding?.total}`);

  console.log('\n== Create an Accountant');
  await User.deleteOne({ username: 'accounts' });
  const created = await call('POST', '/users', { token: adminToken, body: { name: 'Sanjay Pawar', username: 'accounts', role: 'Accountant' } });
  ok('User created (201)', created.status === 201);
  const tempPass = created.body?.data?.tempPassword;
  ok('Temp password received', Boolean(tempPass));

  const accLogin1 = await call('POST', '/auth/login', { body: { username: 'accounts', password: tempPass } });
  ok('Login with the temporary password', accLogin1.status === 200);
  ok('mustChangePassword flag on', accLogin1.body?.data?.user?.mustChangePassword === true);

  const blocked = await call('GET', '/students', { token: accLogin1.body.data.accessToken });
  ok('Everything else blocked until the password is changed', blocked.status === 403, blocked.body?.code);

  const changed = await call('POST', '/auth/change-password', {
    token: accLogin1.body.data.accessToken,
    body: { currentPassword: tempPass, newPassword: 'accounts@2026' },
  });
  ok('Password change 200', changed.status === 200);

  const accLogin = await call('POST', '/auth/login', { body: { username: 'accounts', password: 'accounts@2026' } });
  const accToken = accLogin.body?.data?.accessToken;
  ok('Login with the new password', accLogin.status === 200);

  // Reset to defaults to keep the test repeatable — the previous run
  // leaves salary.view granted (which is exactly what should persist).
  await RolePermission.updateOne({ role: 'Accountant' }, { $set: { permissions: DEFAULT_GRANTS.Accountant } });
  permissionCache.clear();

  console.log('\n== Permission enforcement');
  const feeList = await call('GET', '/fees/demands', { token: accToken });
  ok('Accountant can view fees (200)', feeList.status === 200);

  const salary = await call('GET', '/salary/slips', { token: accToken });
  ok('Accountant gets 403 on salary', salary.status === 403, salary.body?.code);

  const usersAsAcc = await call('GET', '/users', { token: accToken });
  ok('Accountant gets 403 on user management', usersAsAcc.status === 403, usersAsAcc.body?.code);

  const adjust = await call('POST', '/stock/adjust', { token: accToken, body: { itemId: '6a8aa77f2b55a25767517a03', delta: -1, reason: 'test' } });
  ok('Accountant gets 403 on stock adjust', adjust.status === 403, adjust.body?.code);

  console.log('\n== Admin grants access (with no deploy)');
  const grant = await call('PATCH', '/permissions/Accountant', {
    token: adminToken,
    body: { permissions: [...new Set([...(await (await fetch(`${base}/permissions`, { headers: { authorization: `Bearer ${adminToken}` } })).json()).data.grants.Accountant.permissions, 'salary.view'])] },
  });
  ok('Permission update 200', grant.status === 200, `v${grant.body?.data?.version}`);

  const salaryAgain = await call('GET', '/salary/slips', { token: accToken });
  ok('Accountant can NOW view salary (200)', salaryAgain.status === 200,
     `${salaryAgain.body?.data?.slips?.length} slips — same token, no restart`);

  console.log('\n== Locked permission');
  const tryLocked = await call('PATCH', '/permissions/Principal', {
    token: adminToken, body: { permissions: ['permission.manage'] },
  });
  ok('permission.manage grant blocked', tryLocked.status === 403, tryLocked.body?.code);

  const tryAdminRole = await call('PATCH', '/permissions/Admin', { token: adminToken, body: { permissions: [] } });
  ok('Changing Admin permissions is blocked', tryAdminRole.status === 400);

  console.log('\n== Validation');
  const badBody = await call('POST', '/students', { token: adminToken, body: { name: 'X', phone: '123' } });
  ok('Zod validation 400', badBody.status === 400, `${badBody.body?.errors?.length} field errors`);

  const badId = await call('GET', '/students/not-an-id', { token: adminToken });
  ok('Bad ObjectId -> 400', badId.status === 400);

  const nsqli = await call('POST', '/auth/login', { body: { username: { $ne: null }, password: { $ne: null } } });
  ok('NoSQL injection blocked', nsqli.status === 400 || nsqli.status === 401, `status ${nsqli.status}`);

  // -------------------------------------------------------------------------
  // WATCHER — sees everything, changes nothing.
  //
  // The point of these assertions is that the guarantee does not rest on which
  // permissions happen to be granted. A Watcher is refused every write even
  // where they hold the matching view permission, and an Admin cannot grant
  // them a write key in the first place.
  // -------------------------------------------------------------------------
  console.log('\n== Watcher: reads everything');

  const mkWatcher = await call('POST', '/users', {
    token: adminToken,
    body: { name: 'Trustee', username: 'trustee', role: 'Watcher' },
  });
  ok('Watcher account created', mkWatcher.status === 201, mkWatcher.body?.message);

  const wTemp = mkWatcher.body?.data?.tempPassword;
  const wFirst = await call('POST', '/auth/login', { body: { username: 'trustee', password: wTemp } });
  ok('Watcher can sign in', wFirst.status === 200);

  // Changing their own password is a POST, and it has to keep working — it sits
  // above the read-only gate for exactly that reason.
  const wChange = await call('POST', '/auth/change-password', {
    token: wFirst.body?.data?.accessToken,
    body: { currentPassword: wTemp, newPassword: 'watcher12345' },
  });
  ok('Watcher can change their own password', wChange.status === 200, wChange.body?.code);

  const wLogin = await call('POST', '/auth/login', { body: { username: 'trustee', password: 'watcher12345' } });
  const wToken = wLogin.body?.data?.accessToken;
  ok('Watcher signs in with the new password', wLogin.status === 200);
  ok('Watcher is flagged read-only to the client', wLogin.body?.data?.user?.readOnly === true);

  for (const [label, path] of [
    ['dashboard', '/reports/dashboard'],
    ['students', '/students'],
    ['fee demands', '/fees/demands?month=2026-08'],
    ['day book', '/reports/daybook'],
    ['outstanding', '/reports/outstanding'],
    ['salary slips', '/salary/slips?month=2026-08'],
    ['stock', '/stock/items'],
    ['purchases', '/purchases'],
    ['vendors', '/vendors'],
    ['teachers', '/teachers'],
    ['expenses', '/expenses'],
    ['enquiries', '/leads'],
    ['attendance', '/attendance/teachers'],
    ['the edit history', '/audit'],
    ['the payment queue', '/payments'],
  ]) {
    const r = await call('GET', path, { token: wToken });
    ok(`Watcher can read ${label}`, r.status === 200, `status ${r.status}`);
  }

  console.log('\n== Watcher: writes nothing');

  for (const [label, method, path, body] of [
    ['add a student', 'POST', '/students', { name: 'Nope', phone: '9876500000', class: '000000000000000000000000', admissionDate: '2026-08-01' }],
    ['collect a fee', 'POST', '/fees/collect', { studentId: '000000000000000000000000', amount: 100, mode: 'Cash' }],
    ['raise fees', 'POST', '/fees/generate', { month: '2026-08' }],
    ['mark attendance', 'POST', '/attendance/teachers', { entries: [{ teacher: '000000000000000000000000', status: 'Present' }] }],
    ['record an expense', 'POST', '/expenses', { categoryId: '000000000000000000000000', title: 'Nope', amount: 1, mode: 'Cash' }],
    ['tick a payment off', 'POST', '/payments/000000000000000000000000/verify', null],
    ['correct a payment', 'PATCH', '/payments/000000000000000000000000', { mode: 'UPI' }],
    ['edit a student', 'PATCH', '/students/000000000000000000000000', { name: 'Nope' }],
    ['mark a student left', 'DELETE', '/students/000000000000000000000000', null],
    ['pay a vendor', 'POST', '/vendors/pay', { vendorId: '000000000000000000000000', amount: 1, mode: 'Cash' }],
    ['create a user', 'POST', '/users', { name: 'Nope', username: 'nope', role: 'Watcher' }],
  ]) {
    const r = await call(method, path, { token: wToken, ...(body && { body }) });
    ok(`Watcher cannot ${label}`, r.status === 403 && r.body?.code === 'READ_ONLY_ROLE', `${r.status} ${r.body?.code}`);
  }

  // A GET that hands out the ability to write bytes elsewhere is not a read.
  const wUpload = await call('GET', '/uploads/signature?folder=bills', { token: wToken });
  ok('Watcher cannot get an upload signature', wUpload.status === 403 && wUpload.body?.code === 'READ_ONLY_ROLE',
     `${wUpload.status} ${wUpload.body?.code}`);

  console.log('\n== Watcher: the switch cannot even be flipped');

  const grantWrite = await call('PATCH', '/permissions/Watcher', {
    token: adminToken,
    body: { permissions: ['student.view', 'fee.collect'] },
  });
  ok('Admin cannot grant a write key to Watcher', grantWrite.status === 403 && grantWrite.body?.code === 'READ_ONLY_ROLE',
     grantWrite.body?.message);

  const grantReads = await call('PATCH', '/permissions/Watcher', {
    token: adminToken,
    body: { permissions: ['student.view', 'fee.view', 'report.dashboard'] },
  });
  ok('Read keys still save normally', grantReads.status === 200);

  // ...and narrowing what they can SEE does not give them a way to write.
  const stillBlocked = await call('POST', '/fees/generate', { token: wToken, body: { month: '2026-08' } });
  ok('Still refused after a permission change', stillBlocked.status === 403 && stillBlocked.body?.code === 'READ_ONLY_ROLE');

  const nowHidden = await call('GET', '/salary/slips?month=2026-08', { token: wToken });
  ok('A revoked view permission is refused as normal', nowHidden.status === 403 && nowHidden.body?.code === 'PERMISSION_DENIED',
     nowHidden.body?.code);

  console.log(`\n${'='.repeat(50)}\nPASS: ${pass}   FAIL: ${fail}`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, e.stack); process.exit(1); });
