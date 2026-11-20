/* ideaflow person reminders: pure logic, no DOM, no dependencies.
 *
 * Shared by remind.html (browser global `Remind`) and the node tests
 * (`require("./remind.js")`). Every function takes `now` (ms) explicitly so the
 * rules are testable without clocks.
 *
 * Rules (see PRESENCE.md for the why):
 *   reminder  = entry whose text matches  ^remind <name> (of|about|to) <rest>
 *               and <name> resolves through people.jsonl aliases.
 *   pending   = status "new" and (never fired, or snoozed and the snooze ended).
 *   report    = newest presence line per person; older than 10 min = absent.
 *   match     = my report and theirs are both fresh, both on Wi-Fi, same AP
 *               (bssid), or same ssid when either side only had an ssid.
 *   suppress  = 2 h after the last fire for that person, released early once
 *               either side has reported a different network since that fire.
 */
(function (root) {
  "use strict";

  const STALE_MS = 10 * 60 * 1000;
  const SUPPRESS_MS = 2 * 60 * 60 * 1000;
  const SNOOZE_MS = 60 * 60 * 1000;
  const REMIND_RE = /^\s*remind\s+(.+?)\s+(of|about|to)\s+([\s\S]+?)\s*$/i;

  // ---- parsing ----------------------------------------------------------

  // Split one physical line into JSON objects. Tolerates two objects glued on
  // one line (an old phone-Shortcut bug) by scanning braces outside strings.
  function splitObjects(line) {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth++ === 0) start = i; }
      else if (c === "}" && depth > 0 && --depth === 0) {
        try { out.push(JSON.parse(line.slice(start, i + 1))); } catch (_) { /* skip */ }
      }
    }
    return out;
  }

  function parseJSONL(text) {
    const out = [];
    for (const line of String(text || "").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { out.push(...splitObjects(line)); }
    }
    return out;
  }

  // Last occurrence of an id wins: status edits rewrite a line in place, and a
  // union merge can leave the old copy behind.
  function latestById(entries) {
    const m = new Map();
    for (const e of entries) if (e && e.id) m.set(String(e.id), e);
    return [...m.values()];
  }

  function ms(ts) {
    const t = Date.parse(ts || "");
    return isNaN(t) ? NaN : t;
  }

  // ---- people & reminders ----------------------------------------------

  function norm(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function aliasIndex(people) {
    const idx = new Map();
    for (const p of people) {
      if (!p || !p.id) continue;
      for (const a of [p.id, p.name, ...(p.aliases || [])]) {
        const k = norm(a);
        if (k && !idx.has(k)) idx.set(k, p.id);
      }
    }
    return idx;
  }

  function parseReminder(text, idx) {
    const m = REMIND_RE.exec(String(text || ""));
    if (!m) return null;
    const name = norm(m[1]);
    return { name, person: idx.get(name) || null, verb: m[2].toLowerCase(), rest: m[3] };
  }

  function isPending(e, now) {
    if (!e || e.status !== "new") return false;
    const fired = ms(e.fired_at);
    if (isNaN(fired)) return true;
    const snooze = ms(e.snooze_until);
    // Snoozed after firing and the snooze has run out: eligible once more.
    return !isNaN(snooze) && snooze > fired && now >= snooze;
  }

  // ---- presence ---------------------------------------------------------

  function netKey(r) {
    if (!r) return null;
    if (r.bssid && r.match_by !== "ssid") return "bssid:" + r.bssid;
    if (r.ssid) return "ssid:" + r.ssid;
    return null; // cellular / Wi-Fi off
  }

  function latestReports(presence, now) {
    const by = new Map();
    for (const r of presence) {
      if (!r || !r.person) continue;
      const t = ms(r.ts);
      if (isNaN(t)) continue;
      const cur = by.get(r.person);
      if (!cur || t >= cur._t) by.set(r.person, Object.assign({}, r, { _t: t }));
    }
    for (const r of by.values()) {
      r.age_ms = now - r._t;
      r.stale = r.age_ms > STALE_MS;
      r.on_wifi = netKey(r) !== null;
    }
    return by;
  }

  // Same AP when both sides know their BSSID; otherwise fall back to SSID.
  function sameNetwork(a, b) {
    if (!a || !b || a.stale || b.stale || !a.on_wifi || !b.on_wifi) return null;
    const ab = a.bssid && a.match_by !== "ssid", bb = b.bssid && b.match_by !== "ssid";
    if (ab && bb) return a.bssid === b.bssid ? "bssid" : null;
    if (a.ssid && b.ssid && a.ssid === b.ssid) return "ssid";
    return null;
  }

  // ---- suppression ------------------------------------------------------

  function suppression(personId, meId, reminders, presence, now) {
    let last = NaN;
    for (const r of reminders) {
      if (r.person !== personId) continue;
      const f = ms(r.entry.fired_at);
      if (!isNaN(f) && !(f <= last)) last = f;
    }
    if (isNaN(last)) return { suppressed: false };
    const until = last + SUPPRESS_MS;
    if (now >= until) return { suppressed: false, last_fired: last };

    // Released early if either side moved off the shared network after the fire.
    const atFire = {};
    const after = [];
    for (const r of presence) {
      if (!r || (r.person !== personId && r.person !== meId)) continue;
      const t = ms(r.ts);
      if (isNaN(t)) continue;
      if (t <= last) {
        if (!atFire[r.person] || t >= atFire[r.person].t) atFire[r.person] = { t, key: netKey(r) };
      } else after.push({ person: r.person, key: netKey(r) });
    }
    for (const a of after) {
      const before = atFire[a.person];
      if (!before || a.key !== before.key) {
        return { suppressed: false, released: true, last_fired: last };
      }
    }
    return { suppressed: true, until, last_fired: last };
  }

  // ---- the whole picture ------------------------------------------------

  function evaluate({ entries, people, presence, me, now }) {
    now = now == null ? Date.now() : now;
    const idx = aliasIndex(people);
    const meId = me || (people.find((p) => p.me) || {}).id || null;
    const all = latestById(entries);

    const reminders = [];
    const unresolved = [];
    for (const e of all) {
      const r = parseReminder(e.text, idx);
      if (!r) continue;
      const item = { entry: e, person: r.person, name: r.name, verb: r.verb, rest: r.rest,
                     pending: isPending(e, now) };
      if (r.person) reminders.push(item);
      else if (item.pending) unresolved.push(item);
    }

    const reports = latestReports(presence, now);
    const mine = meId ? reports.get(meId) || null : null;

    const rows = [];
    for (const p of people) {
      if (!p || !p.id || p.id === meId) continue;
      const rep = reports.get(p.id) || null;
      const pend = reminders.filter((r) => r.person === p.id && r.pending);
      const match = sameNetwork(mine, rep);
      const sup = suppression(p.id, meId, reminders, presence, now);
      let state;
      if (!mine) state = "no report from me";
      else if (mine.stale) state = "my report stale";
      else if (!mine.on_wifi) state = "me off Wi-Fi";
      else if (!rep) state = "never reported";
      else if (rep.stale) state = "stale";
      else if (!rep.on_wifi) state = "off Wi-Fi";
      else if (!match) state = "different network";
      else if (sup.suppressed) state = "suppressed";
      else if (!pend.length) state = "nearby, nothing pending";
      else state = "FIRE";
      rows.push({
        person: p, report: rep, match, state, suppression: sup, pending: pend,
        fire: state === "FIRE" ? pend : [],
      });
    }
    return { me: meId, mine, rows, unresolved, reminders, now };
  }

  // ---- writes (pure text transforms on entries.jsonl) -------------------

  function iso(t) { return new Date(t).toISOString(); }

  // Rewrite the last line carrying `id`, leaving every other byte untouched.
  function editEntry(text, id, patch) {
    const lines = String(text).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(id)) continue;
      const objs = lines[i].trim() ? (function () {
        try { return [JSON.parse(lines[i])]; } catch (_) { return splitObjects(lines[i]); }
      })() : [];
      const hit = objs.findIndex((o) => o && String(o.id) === String(id));
      if (hit < 0) continue;
      objs[hit] = patch(Object.assign({}, objs[hit]));
      lines[i] = objs.map((o) => JSON.stringify(o)).join("\n");
      return lines.join("\n");
    }
    throw new Error("entry not found: " + id);
  }

  const actions = {
    fire: (text, id, now) => editEntry(text, id, (e) => { e.fired_at = iso(now); return e; }),
    done: (text, id, now) => editEntry(text, id, (e) => {
      e.status = "triaged";
      e.triaged_at = iso(now);
      if (!e.fired_at) e.fired_at = iso(now);
      return e;
    }),
    snooze: (text, id, now) => editEntry(text, id, (e) => {
      if (!e.fired_at) e.fired_at = iso(now);
      e.snooze_until = iso(now + SNOOZE_MS);
      return e;
    }),
  };

  // Same scheme the phone Shortcut uses: lowercase, pad single-digit octets,
  // sha256(salt + ":" + value), hex. Raw BSSIDs never reach the public repo.
  function normBssid(b) {
    return String(b || "").trim().toLowerCase().replace(/\b([0-9a-f])\b/g, "0$1");
  }

  const api = {
    STALE_MS, SUPPRESS_MS, SNOOZE_MS,
    parseJSONL, splitObjects, latestById, aliasIndex, parseReminder, isPending,
    netKey, latestReports, sameNetwork, suppression, evaluate, editEntry, actions,
    normBssid,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Remind = api;
})(typeof self !== "undefined" ? self : this);
