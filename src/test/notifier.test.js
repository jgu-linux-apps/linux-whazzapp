// Tests for notifier.js (Node.js, no Electron, no D-Bus): node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { parseSignal, notifyArgs, gstr } = require('../notifier');

test('parseSignal reads gdbus monitor lines', () => {
  assert.deepStrictEqual(
    parseSignal("/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 41, 'default')"),
    { type: 'action', id: 41, action: 'default' });
  assert.deepStrictEqual(
    parseSignal('/org/freedesktop/Notifications: org.freedesktop.Notifications.NotificationClosed (uint32 7, uint32 2)'),
    { type: 'closed', id: 7, reason: 2 });
  assert.strictEqual(parseSignal('Monitoring signals on object /org/freedesktop/Notifications'), null);
});

test('gstr makes GVariant string literals', () => {
  assert.strictEqual(gstr('a "b" \\ c\nd'), '"a \\"b\\" \\\\ c\\nd"');
  assert.strictEqual(gstr(null), '""');
});

test('notifyArgs: replace id, hints and a dash-safe timeout', () => {
  const a = notifyArgs({ appName: 'Linux WhazzApp', desktopEntry: 'linux-whazzapp', replaceId: 42, icon: 'linux-whazzapp',
    title: '-x', body: 'b', image: '/tmp/i.png', actionLabel: 'Otwórz' });
  assert.ok(a.includes('uint32 42'));
  assert.ok(a.includes('"-x"'));                      // quoted, so gdbus does not read it as an option
  assert.ok(a.includes('int32 -1'));
  assert.ok(a.some((x) => x.includes('"image-path": <"/tmp/i.png">') && x.includes('"desktop-entry": <"linux-whazzapp">')));
});
