// The owners' mini CMS for people and teams (SPEC §17). Everything here is
// requireOwner: running the household is the owners' job, a friend never sees this page
// (the API 403s if they try). The two owners themselves are NOT managed here — they come
// from .env and seedUsers resets them every boot (src/auth.js) — so a PATCH that reaches
// an owner row always 400s.
//
// No hard delete of a person: their verdicts, notes and viewings carry `by`, and CLAUDE.md
// never deletes. Disabling is the removal. A team can be deleted, but only once nobody
// (disabled people included) is in it — its listing state has nothing left to belong to.

import { nowIso } from '../db.js';
import { createUser, hashPassword, voidSessions } from '../auth.js';
import { HOME_TEAM_ID, createTeam } from '../teams.js';
import { badRequest, notFound, strictSchemas } from './_common.js';

const NAME_MAX = 120;
const EMAIL_MAX = 200;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const TEAM_NAME_MAX = 80;

const MEMBER_FIELDS = 'id, name, email, role, disabled_at, created_at';
const PERSON_FIELDS = 'id, name, email, role, team_id, disabled_at, created_at';

/** person id → {yes, maybe, no}: how many of each call they have made, on any listing. */
function verdictCounts(db) {
  const out = new Map();
  for (const { by, verdict, n } of db.prepare('SELECT by, verdict, COUNT(*) AS n FROM verdicts GROUP BY by, verdict').all()) {
    if (!out.has(by)) out.set(by, { yes: 0, maybe: 0, no: 0 });
    out.get(by)[verdict] = n;
  }
  return out;
}

/** Every team, home first then by id, each with its members (empty teams included). */
function teamsWithMembers(db) {
  const teams = db.prepare(`SELECT id, name FROM teams ORDER BY (id != ${HOME_TEAM_ID}), id`).all();
  const members = db.prepare(
    `SELECT ${MEMBER_FIELDS} FROM users WHERE COALESCE(team_id, ${HOME_TEAM_ID}) = ? ORDER BY id`
  );
  const counts = verdictCounts(db);
  const withCounts = (m) => ({ ...m, verdicts: counts.get(m.id) || { yes: 0, maybe: 0, no: 0 } });
  return teams.map((t) => ({
    id: t.id, name: t.name, home: t.id === HOME_TEAM_ID, members: members.all(t.id).map(withCounts),
  }));
}

/** One person, never their password hash. */
function getPerson(db, id) {
  return db.prepare(`SELECT ${PERSON_FIELDS} FROM users WHERE id = ?`).get(id);
}

function teamExists(db, id) {
  return !!db.prepare('SELECT id FROM teams WHERE id = ?').get(id);
}

/**
 * Where a member may be put: any team but the home one. The home team is the owners —
 * its taps write the shared row (red flags, removals) and feed `learn` and the morning
 * digest — so a friend there would move what everyone sees (SPEC §17).
 */
function checkMemberTeam(db, id) {
  if (id === HOME_TEAM_ID) return 'the home team is the owners; put a friend in their own team';
  if (!teamExists(db, id)) return `unknown team: ${id}`;
  return null;
}

// Case-insensitive: an owner seeded from .env with capitals must never collide with a
// member typed in lower case (the UNIQUE constraint alone is case-sensitive).
function emailTaken(db, email, excludeId = null) {
  const norm = String(email).trim().toLowerCase();
  const row = excludeId
    ? db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(norm, excludeId)
    : db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(norm);
  return !!row;
}

// A plain shape check — enough to catch a name typed into the email field.
// Surrounding spaces are allowed here and trimmed on the way in.
const EMAIL_PATTERN = '^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$';

export default async function peopleRoutes(app, opts) {
  const { db } = opts;
  const auth = { onRequest: app.requireOwner };
  strictSchemas(app);

  // --- people ----------------------------------------------------------------

  app.get('/api/people', auth, async () => ({ teams: teamsWithMembers(db) }));

  app.post(
    '/api/people',
    {
      ...auth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['name', 'email', 'password'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: NAME_MAX },
            email: { type: 'string', minLength: 3, maxLength: EMAIL_MAX, pattern: EMAIL_PATTERN },
            password: { type: 'string', minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX },
            team_id: { type: 'integer' },
            team_name: { type: 'string', minLength: 1, maxLength: TEAM_NAME_MAX },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, email, password, team_id, team_name } = request.body;
      const trimmedName = String(name).trim();
      if (!trimmedName) return badRequest(reply, 'name is required');
      if (team_id !== undefined && team_name !== undefined) return badRequest(reply, 'team_id and team_name are exclusive');
      if (emailTaken(db, email)) return reply.code(409).send({ error: 'email_taken' });

      if (team_id !== undefined) {
        const bad = checkMemberTeam(db, team_id);
        if (bad) return badRequest(reply, bad);
      }
      const newTeam = team_id !== undefined ? null : String(team_name ?? trimmedName).trim();
      if (newTeam === '') return badRequest(reply, 'team_name is required');

      // One transaction: a failed insert (a racing duplicate email) leaves no empty team.
      const id = db.transaction(() => {
        // Neither given: a solo team named after them.
        const teamId = newTeam === null ? team_id : createTeam(db, newTeam);
        return createUser(db, { email, name: trimmedName, password, team_id: teamId, role: 'member' });
      })();
      return reply.code(201).send(getPerson(db, id));
    }
  );

  app.patch(
    '/api/people/:id',
    {
      ...auth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: NAME_MAX },
            email: { type: 'string', minLength: 3, maxLength: EMAIL_MAX, pattern: EMAIL_PATTERN },
            password: { type: 'string', minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX },
            team_id: { type: 'integer' },
            disabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!row) return notFound(reply);
      // The two owners are seeded from .env and reset every boot — this page never edits them.
      if (row.role === 'owner') return badRequest(reply, 'owners are managed in .env');

      const body = request.body;
      const updates = {};

      if (body.name !== undefined) {
        const trimmed = String(body.name).trim();
        if (!trimmed) return badRequest(reply, 'name is required');
        updates.name = trimmed;
      }
      if (body.email !== undefined) {
        if (emailTaken(db, body.email, id)) return reply.code(409).send({ error: 'email_taken' });
        updates.email = String(body.email).trim().toLowerCase();
      }
      if (body.password !== undefined) updates.password_hash = hashPassword(body.password);
      if (body.team_id !== undefined) {
        const bad = checkMemberTeam(db, body.team_id);
        if (bad) return badRequest(reply, bad);
        updates.team_id = body.team_id;
      }
      if (body.disabled === true) updates.disabled_at = nowIso();
      else if (body.disabled === false) updates.disabled_at = null;

      if (Object.keys(updates).length) {
        const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
      }
      // A password change or a disable kills every cookie issued before now — re-enabling
      // does not resurrect them, so whoever comes back has to log in again.
      if (body.password !== undefined || body.disabled === true) voidSessions(db, id);

      return getPerson(db, id);
    }
  );

  // --- teams -------------------------------------------------------------

  app.post(
    '/api/teams',
    {
      ...auth,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: TEAM_NAME_MAX } },
        },
      },
    },
    async (request, reply) => {
      const name = String(request.body.name).trim();
      if (!name) return badRequest(reply, 'name is required');
      const id = createTeam(db, name);
      return reply.code(201).send({ id, name });
    }
  );

  app.patch(
    '/api/teams/:id',
    {
      ...auth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
        body: {
          type: 'object', additionalProperties: false, required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: TEAM_NAME_MAX } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!teamExists(db, id)) return notFound(reply);
      const name = String(request.body.name).trim();
      if (!name) return badRequest(reply, 'name is required');
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, id);
      return { id, name };
    }
  );

  app.delete(
    '/api/teams/:id',
    { ...auth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } },
    async (request, reply) => {
      const { id } = request.params;
      if (id === HOME_TEAM_ID) return badRequest(reply, 'the home team cannot be deleted');
      if (!teamExists(db, id)) return notFound(reply);
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE COALESCE(team_id, ${HOME_TEAM_ID}) = ?`).get(id);
      if (n > 0) return reply.code(409).send({ error: 'team_not_empty' });
      // Nobody is on this team any more, so its pipeline overlay has nothing left to mean.
      db.prepare('DELETE FROM team_listings WHERE team_id = ?').run(id);
      db.prepare('DELETE FROM teams WHERE id = ?').run(id);
      return { ok: true };
    }
  );
}
