'use strict';

/**
 * Phase 6 unit tests — productionisation.
 *
 * Four things get covered here, all of them the sort of thing that is only ever
 * exercised on the production box and so would otherwise never be tested:
 *
 *   1. the fail-fast production config check
 *   2. the admin password: default detection + POST /api/auth/change-password,
 *      driven over real HTTP against a real Express app on an ephemeral port
 *   3. size-based log rotation
 *   4. the VACUUM INTO backup + its 14-copy retention
 *
 * Nothing here touches the real data/ directory: every test runs against a
 * throwaway temp dir.
 *   npm test --workspace=server
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

// point config at a scratch database BEFORE anything requires it
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgcrm-p6-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DATA_DIR = TMP_DIR;
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';
process.env.SESSION_SECRET = 'test-secret-not-the-default-one';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const config = require('../src/config');
const logger = require('../src/logger');
const adminUser = require('../src/services/adminUser');
const backup = require('../scripts/backup-db');

before(() => {
  runMigrations();
  config.seedSettingDefaults();
});

after(() => {
  closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('production config fail-fast', () => {
  const base = {
    NODE_ENV: 'production',
    SESSION_SECRET: 'a-perfectly-long-random-production-secret',
    SESSION_SECRET_IS_DEFAULT: false,
  };

  test('a production boot with a real SESSION_SECRET has no problems', () => {
    assert.deepEqual(config.productionConfigProblems(base), []);
  });

  test('a missing SESSION_SECRET is fatal, and says how to make one', () => {
    const problems = config.productionConfigProblems({
      ...base,
      SESSION_SECRET: 'sg-crm-dev-secret-change-me',
      SESSION_SECRET_IS_DEFAULT: true,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /SESSION_SECRET is not set/);
    assert.match(problems[0], /randomBytes/); // the copy-pasteable fix
  });

  test('a too-short SESSION_SECRET is also rejected', () => {
    const problems = config.productionConfigProblems({
      ...base,
      SESSION_SECRET: 'short',
      SESSION_SECRET_IS_DEFAULT: false,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /shorter than 16/);
  });

  test('development is never blocked, however bad the config', () => {
    assert.deepEqual(
      config.productionConfigProblems({
        NODE_ENV: 'development',
        SESSION_SECRET: '',
        SESSION_SECRET_IS_DEFAULT: true,
      }),
      []
    );
  });
});

// ---------------------------------------------------------------------------

describe('admin password', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM admin_user').run();
  });

  test('a freshly bootstrapped admin is flagged as using the default password', () => {
    adminUser.ensureAdminUser();
    assert.equal(adminUser.isUsingDefaultPassword(), true);
    assert.equal(adminUser.publicAdmin(adminUser.getAdmin()).password_is_default, true);
  });

  test('changing the password clears the flag and the old one stops working', () => {
    const admin = adminUser.ensureAdminUser();
    adminUser.changePassword(admin.id, 'a-much-better-password');

    assert.equal(adminUser.isUsingDefaultPassword(), false);
    assert.equal(adminUser.verifyCredentials(admin.username, 'admin123'), null);
    assert.ok(adminUser.verifyCredentials(admin.username, 'a-much-better-password'));
  });

  test('the public shape still never leaks the hash', () => {
    adminUser.ensureAdminUser();
    const pub = adminUser.publicAdmin(adminUser.getAdmin());
    assert.deepEqual(Object.keys(pub).sort(), ['id', 'last_login_at', 'password_is_default', 'username']);
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/auth/change-password', () => {
  let server;
  let origin;

  before(async () => {
    getDb().prepare('DELETE FROM admin_user').run();
    adminUser.ensureAdminUser();
    const { createApp } = require('../src/index');
    const app = createApp(getDb());
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  /** Minimal cookie jar — fetch does not keep one. */
  let cookie = null;
  async function call(pathname, body) {
    const res = await fetch(origin + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  test('is rejected without a session', async () => {
    const res = await call('/api/auth/change-password', {
      current_password: 'admin123',
      new_password: 'something-else',
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'unauthorized');
  });

  test('logging in reports that the password is still the default', async () => {
    const res = await call('/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.password_is_default, true);
  });

  test('the wrong current password is refused even with a valid session', async () => {
    const res = await call('/api/auth/change-password', {
      current_password: 'not-the-password',
      new_password: 'a-good-new-password',
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /current password is not correct/);
  });

  test('a short new password is refused', async () => {
    const res = await call('/api/auth/change-password', {
      current_password: 'admin123',
      new_password: 'short',
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /at least 8 characters/);
  });

  test('reusing the current password is refused', async () => {
    const res = await call('/api/auth/change-password', {
      current_password: 'admin123',
      new_password: 'admin123',
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /different/);
  });

  test('a valid change succeeds, keeps the session and clears the default flag', async () => {
    const res = await call('/api/auth/change-password', {
      current_password: 'admin123',
      new_password: 'correct-horse-battery',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.user.password_is_default, false);

    // the (regenerated) session is still good
    const me = await call('/api/auth/me');
    assert.equal(me.json.user.username, 'admin');
    assert.equal(me.json.user.password_is_default, false);
  });

  test('the old password no longer logs in and the new one does', async () => {
    cookie = null;
    const bad = await call('/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.equal(bad.status, 401);

    cookie = null;
    const good = await call('/api/auth/login', { username: 'admin', password: 'correct-horse-battery' });
    assert.equal(good.status, 200);
  });
});

// ---------------------------------------------------------------------------

describe('log rotation', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(TMP_DIR, 'logs-'));
    file = path.join(dir, 'app.log');
  });

  test('does nothing while the file is under the limit', () => {
    fs.writeFileSync(file, 'x'.repeat(100));
    assert.equal(logger.rotateIfNeeded(file, { maxBytes: 1024, keep: 3 }), false);
    assert.equal(fs.existsSync(`${file}.1`), false);
  });

  test('does nothing when there is no file yet', () => {
    assert.equal(logger.rotateIfNeeded(file, { maxBytes: 1, keep: 3 }), false);
  });

  test('rolls once the file is over the limit', () => {
    fs.writeFileSync(file, 'y'.repeat(2048));
    assert.equal(logger.rotateIfNeeded(file, { maxBytes: 1024, keep: 3 }), true);
    assert.equal(fs.existsSync(file), false); // the destination reopens it
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 2048);
  });

  test('shifts older generations down and drops everything past `keep`', () => {
    fs.writeFileSync(`${file}.1`, 'gen1');
    fs.writeFileSync(`${file}.2`, 'gen2');
    fs.writeFileSync(`${file}.3`, 'gen3'); // keep = 3, so this one must die
    fs.writeFileSync(file, 'current');

    assert.equal(logger.rotateFiles(file, 3), true);

    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'current');
    assert.equal(fs.readFileSync(`${file}.2`, 'utf8'), 'gen1');
    assert.equal(fs.readFileSync(`${file}.3`, 'utf8'), 'gen2');
    assert.equal(fs.existsSync(`${file}.4`), false);
  });

  test('the test process itself writes no log file', () => {
    // NODE_ENV=test and no LOG_FILE — the suite must not litter data/logs
    assert.equal(logger.logFile, null);
  });
});

// ---------------------------------------------------------------------------

describe('database backup', () => {
  let outDir;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(TMP_DIR, 'backups-'));
  });

  test('VACUUM INTO produces a readable, intact copy with the same rows', () => {
    getDb().prepare('DELETE FROM admin_user').run();
    adminUser.ensureAdminUser();
    const sourceCount = getDb().prepare('SELECT count(*) AS n FROM admin_user').get().n;

    const result = backup.runBackup({ dbPath: process.env.DB_PATH, outDir, keep: 14 });

    assert.equal(result.ok, true);
    assert.equal(result.integrity, 'ok');
    assert.ok(result.tables > 10, `expected the whole schema, got ${result.tables} tables`);
    assert.ok(fs.existsSync(result.file));

    const Database = require('better-sqlite3');
    const copy = new Database(result.file, { readonly: true });
    try {
      assert.equal(copy.prepare('SELECT count(*) AS n FROM admin_user').get().n, sourceCount);
      assert.equal(copy.prepare('SELECT count(*) AS n FROM settings').get().n,
        getDb().prepare('SELECT count(*) AS n FROM settings').get().n);
    } finally {
      copy.close();
    }
  });

  test('two backups in the same second do not collide', () => {
    const now = new Date('2026-08-01T01:00:00');
    const a = backup.runBackup({ dbPath: process.env.DB_PATH, outDir, keep: 14, now });
    const b = backup.runBackup({ dbPath: process.env.DB_PATH, outDir, keep: 14, now });
    assert.equal(a.file, b.file); // same timestamp -> same name, rewritten
    assert.equal(b.integrity, 'ok');
  });

  test('retention keeps the newest 14 and prunes the rest', () => {
    for (let i = 1; i <= 20; i += 1) {
      fs.writeFileSync(path.join(outDir, `crm-202601${String(i).padStart(2, '0')}-030000.db`), 'fake');
    }
    const pruned = backup.pruneBackups(outDir, 14);
    const left = fs.readdirSync(outDir).sort();

    assert.equal(pruned.length, 6);
    assert.equal(left.length, 14);
    assert.equal(left[0], 'crm-20260107-030000.db'); // 1..6 gone
    assert.equal(left[13], 'crm-20260120-030000.db');
  });

  test('retention never touches anything that is not a timestamped backup', () => {
    fs.writeFileSync(path.join(outDir, 'crm-manual-before-upgrade.db'), 'precious');
    fs.writeFileSync(path.join(outDir, 'notes.txt'), 'precious');
    for (let i = 1; i <= 20; i += 1) {
      fs.writeFileSync(path.join(outDir, `crm-202602${String(i).padStart(2, '0')}-030000.db`), 'fake');
    }
    backup.pruneBackups(outDir, 3);

    assert.ok(fs.existsSync(path.join(outDir, 'crm-manual-before-upgrade.db')));
    assert.ok(fs.existsSync(path.join(outDir, 'notes.txt')));
    assert.equal(fs.readdirSync(outDir).filter((f) => backup.NAME_RE.test(f)).length, 3);
  });

  test('a missing database fails loudly rather than writing an empty backup', () => {
    assert.throws(
      () => backup.runBackup({ dbPath: path.join(TMP_DIR, 'nope.db'), outDir }),
      /database not found/
    );
    assert.equal(fs.readdirSync(outDir).length, 0);
  });

  test('backup names sort chronologically', () => {
    const early = backup.timestampName(new Date('2026-01-02T03:04:05'));
    const late = backup.timestampName(new Date('2026-11-12T13:14:15'));
    assert.equal(early, 'crm-20260102-030405.db');
    assert.equal(late, 'crm-20261112-131415.db');
    assert.ok(early < late);
    assert.ok(backup.NAME_RE.test(early));
  });
});
