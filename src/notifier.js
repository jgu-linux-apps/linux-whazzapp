'use strict';
/* Desktop notifications through org.freedesktop.Notifications, using the gdbus tool (in every Ubuntu).

   Chromium's own web notifications cannot be removed from GNOME's notification list after a click
   (the same problem linux-google-chat had with Gio.Notification). Here every notification gets its
   number from GNOME Shell, so the app closes it itself with CloseNotification: after a click, when the
   chat is read in the window, and when nothing is unread any more. */
const { spawn, execFile } = require('child_process');

const BUS = ['--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications'];
const IFACE = 'org.freedesktop.Notifications';

// GVariant text format: a double-quoted string accepts the same escapes as JSON (\" \\ \n \uXXXX).
const gstr = (s) => JSON.stringify(String(s == null ? '' : s));

function parseSignal(line) {
  let m = /\.ActionInvoked \(uint32 (\d+), '([^']*)'\)/.exec(line);
  if (m) return { type: 'action', id: Number(m[1]), action: m[2] };
  m = /\.NotificationClosed \(uint32 (\d+), uint32 (\d+)\)/.exec(line);
  if (m) return { type: 'closed', id: Number(m[1]), reason: Number(m[2]) };
  return null;
}

function notifyArgs({ appName, desktopEntry, replaceId, icon, title, body, image, actionLabel }) {
  const hints = [`"desktop-entry": <${gstr(desktopEntry)}>`, `"category": <"im.received">`];
  if (image) hints.push(`"image-path": <${gstr(image)}>`);
  return ['call', ...BUS, '--method', `${IFACE}.Notify`,
    gstr(appName), `uint32 ${replaceId >>> 0}`, gstr(icon), gstr(title), gstr(body),
    `[${gstr('default')}, ${gstr(actionLabel || 'Open')}]`, `{${hints.join(', ')}}`, 'int32 -1'];
}

class Notifier {
  constructor({ appName, desktopEntry, icon, actionLabel, onAction, onClosed, gdbus = 'gdbus' }) {
    Object.assign(this, { appName, desktopEntry, icon, actionLabel, onAction, onClosed, gdbus });
    this.mine = new Set();          // numbers of our notifications (signals are broadcast to everyone)
    this.monitor = null;
    this.stopped = false;
  }

  start() {
    if (this.monitor || this.stopped) return;
    let buf = '';
    const p = this.monitor = spawn(this.gdbus, ['monitor', ...BUS], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const sig = parseSignal(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!sig || !this.mine.has(sig.id)) continue;
        if (sig.type === 'action') this.onAction && this.onAction(sig.id, sig.action);
        else { this.mine.delete(sig.id); this.onClosed && this.onClosed(sig.id, sig.reason); }
      }
    });
    const again = () => { this.monitor = null; if (!this.stopped) setTimeout(() => this.start(), 2000); };
    p.on('exit', again);
    p.on('error', () => {});
  }

  stop() { this.stopped = true; if (this.monitor) this.monitor.kill(); }

  /** Shows (or replaces) a notification; resolves to GNOME's number, or 0 when it failed. */
  show({ title, body, image, replaceId = 0 }) {
    const args = notifyArgs({ appName: this.appName, desktopEntry: this.desktopEntry, icon: this.icon,
      actionLabel: this.actionLabel, replaceId, title, body, image });
    return new Promise((resolve) => {
      execFile(this.gdbus, args, { timeout: 5000 }, (err, out) => {
        const m = !err && /\(uint32 (\d+),\)/.exec(out || '');
        const id = m ? Number(m[1]) : 0;
        if (id) this.mine.add(id);
        resolve(id);
      });
    });
  }

  close(id) {
    if (!id) return;
    this.mine.delete(id);
    execFile(this.gdbus, ['call', ...BUS, '--method', `${IFACE}.CloseNotification`, `uint32 ${id >>> 0}`],
      { timeout: 5000 }, () => {});
  }
}

module.exports = { Notifier, parseSignal, notifyArgs, gstr };
