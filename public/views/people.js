// #/people — the owners' mini CMS (SPEC §17): who is here, which team they are on, and
// the account actions (reset password, move team, disable). The API is requireOwner —
// if a member somehow lands on this route, every call 403s and we say so, plainly.

import { $, html, setHtml, toast } from '../lib/ui.js';

const GROUP_NEW = '__new__';

function memberMeta(team) {
  if (team.home) return 'Home team';
  return team.members.length <= 1 ? 'Solo' : `${team.members.length} members`;
}

// The home team is the owners' alone (the API refuses a friend there), so it is never
// offered as a place to add or move someone.
function teamOptions(teams, currentTeamId) {
  return teams.filter((t) => !t.home).map(
    (t) => html`<option value="${t.id}" ${t.id === currentTeamId ? 'selected' : ''}>${t.name}</option>`
  );
}

function groupOptions(teams) {
  return html`<option value="">New solo group</option>
    <option value="${GROUP_NEW}">New shared group…</option>
    ${teams.filter((t) => !t.home).map((t) => html`<option value="${t.id}">${t.name}</option>`)}`;
}

function personRow(member, teams, teamId) {
  const isOwnerRow = member.role === 'owner';
  const disabled = !!member.disabled_at;
  return html`<div class="entry person-entry" data-person="${member.id}">
    <div class="person-row">
      <span class="person-name">${member.name}</span>
      <span class="mono small muted">${member.email}</span>
      ${isOwnerRow ? html`<span class="pill">Owner</span>` : ''}
      ${disabled ? html`<span class="pill pill-rejected">Disabled</span>` : ''}
    </div>
    ${isOwnerRow
      ? ''
      : html`<div class="person-actions">
          <button type="button" class="btn btn-sm" data-reset-password="${member.id}">Reset password</button>
          <label class="field"><span class="label">Move to</span>
            <select data-move="${member.id}" aria-label="Move ${member.name} to">${teamOptions(teams, teamId)}</select>
            <span class="small muted">Their calls, notes, visits and places move with them.</span>
          </label>
          <button type="button" class="btn btn-sm" data-toggle-disabled="${member.id}">${disabled ? 'Enable' : 'Disable'}</button>
        </div>`}
  </div>`;
}

function teamBlock(team, teams) {
  const canDelete = !team.home && team.members.length === 0;
  return html`<section class="block people-team" data-team="${team.id}">
    <div class="people-team-head">
      <button type="button" class="people-team-rename" data-rename-team="${team.id}">${team.name}</button>
      <span class="small muted">${memberMeta(team)}</span>
      ${canDelete ? html`<button type="button" class="btn btn-sm btn-ghost" data-delete-team="${team.id}">Delete</button>` : ''}
    </div>
    ${team.members.length ? team.members.map((m) => personRow(m, teams, team.id)) : html`<p class="empty">Nobody here yet.</p>`}
  </section>`;
}

export async function mountPeople(el, ctx) {
  const { api } = ctx;
  let alive = true;
  let teams = [];

  setHtml(el, html`<p class="loading">Loading people…</p>`);
  try {
    const res = await api.get('/api/people');
    teams = res.teams || [];
  } catch (err) {
    if (!alive) return () => {};
    setHtml(
      el,
      err.status === 403
        ? html`<p class="empty">Only the owners manage people.</p>`
        : html`<p class="empty">Could not load people: ${err.message}</p>`
    );
    return () => {
      alive = false;
    };
  }
  if (!alive) return () => {};

  setHtml(
    el,
    html`<div class="people-page">
      <div class="section-head"><h1>People</h1></div>
      <div id="people-teams"></div>
      <section class="block" style="margin-top:14px">
        <h3>Add person</h3>
        <form id="form-add-person">
          <label class="field"><span class="label">Name</span>
            <input type="text" name="name" maxlength="120" required /></label>
          <label class="field"><span class="label">Email</span>
            <input type="email" name="email" maxlength="200" required /></label>
          <label class="field"><span class="label">Password</span>
            <input type="text" name="password" maxlength="200" minlength="8" required placeholder="At least 8 characters" /></label>
          <label class="field"><span class="label">Group</span>
            <select name="group" id="add-person-group">${groupOptions(teams)}</select></label>
          <label class="field" id="new-team-name-field" hidden><span class="label">Group name</span>
            <input type="text" name="team_name" maxlength="80" placeholder="Ronnie &amp; Janel" /></label>
          <button class="btn btn-primary" type="submit">Add person</button>
        </form>
      </section>
    </div>`
  );

  const teamsEl = $('#people-teams', el);
  const groupSelect = $('#add-person-group', el);
  const teamNameField = $('#new-team-name-field', el);

  function renderTeams() {
    setHtml(teamsEl, teams.map((t) => teamBlock(t, teams)));
  }
  renderTeams();

  async function reload() {
    try {
      const res = await api.get('/api/people');
      if (!alive) return;
      teams = res.teams || [];
      renderTeams();
      const keep = groupSelect.value;
      setHtml(groupSelect, groupOptions(teams));
      if ([...groupSelect.options].some((o) => o.value === keep)) groupSelect.value = keep;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // --- team rename: tap the name, type, Enter or blur saves, Escape cancels ---

  el.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-rename-team]');
    if (!btn) return;
    const id = Number(btn.dataset.renameTeam);
    const team = teams.find((t) => t.id === id);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'people-team-rename-input';
    input.maxLength = 80;
    input.value = team?.name || '';
    input.setAttribute('aria-label', `Rename ${team?.name || 'team'}`);
    btn.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const save = async () => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (!next || next === team?.name) return renderTeams();
      try {
        await api.patch(`/api/teams/${id}`, { name: next });
        toast('Team renamed');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
        renderTeams();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        settled = true;
        renderTeams();
      }
    });
    input.addEventListener('blur', save);
  });

  // --- delete an empty non-home team: a second tap confirms -------------------

  el.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-delete-team]');
    if (!btn) return;
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirm delete';
      btn.classList.add('btn-confirm');
      return;
    }
    btn.disabled = true;
    try {
      await api.del(`/api/teams/${btn.dataset.deleteTeam}`);
      toast('Team deleted');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      delete btn.dataset.confirm;
      btn.textContent = 'Delete';
      btn.classList.remove('btn-confirm');
    }
  });

  // --- reset password: tap, type the new one, Save ----------------------------

  el.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-reset-password]');
    if (!btn) return;
    const id = btn.dataset.resetPassword;
    const wrap = document.createElement('span');
    wrap.className = 'person-reset-inline';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'person-reset-input';
    input.placeholder = 'New password (min 8 chars)';
    input.minLength = 8;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'New password');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-sm';
    save.textContent = 'Save';
    wrap.append(input, save);
    btn.replaceWith(wrap);
    input.focus();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') renderTeams();
      else if (e.key === 'Enter') {
        e.preventDefault();
        save.click();
      }
    });
    save.addEventListener('click', async () => {
      if (input.value.length < 8) {
        toast('Password must be at least 8 characters', 'error');
        return;
      }
      save.disabled = true;
      try {
        await api.patch(`/api/people/${id}`, { password: input.value });
        toast('Password reset — their old session is signed out');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
        save.disabled = false;
      }
    });
  });

  // --- move to another team ----------------------------------------------------

  el.addEventListener('change', async (event) => {
    const select = event.target.closest('select[data-move]');
    if (!select) return;
    const id = select.dataset.move;
    select.disabled = true;
    try {
      await api.patch(`/api/people/${id}`, { team_id: Number(select.value) });
      toast('Moved');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
      await reload(); // snap the select back to the true state
    }
  });

  // --- disable / enable ---------------------------------------------------------

  el.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-toggle-disabled]');
    if (!btn) return;
    const id = btn.dataset.toggleDisabled;
    const currentlyDisabled = btn.textContent.trim() === 'Enable';
    if (!currentlyDisabled && btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirm disable';
      btn.classList.add('btn-confirm');
      return;
    }
    btn.disabled = true;
    try {
      await api.patch(`/api/people/${id}`, { disabled: !currentlyDisabled });
      toast(currentlyDisabled ? 'Enabled' : 'Disabled — their session is signed out');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      delete btn.dataset.confirm;
      btn.textContent = currentlyDisabled ? 'Enable' : 'Disable';
      btn.classList.remove('btn-confirm');
    }
  });

  // --- group select: "New shared group…" reveals the name field ---------------

  groupSelect.addEventListener('change', () => {
    teamNameField.hidden = groupSelect.value !== GROUP_NEW;
  });

  // --- add person ---------------------------------------------------------------

  $('#form-add-person', el).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type=submit]');
    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    const group = form.elements.group.value;

    if (!name || !email || password.length < 8) {
      toast('Fill in a name, email and a password of at least 8 characters', 'error');
      return;
    }
    const body = { name, email, password };
    if (group === GROUP_NEW) {
      const teamName = form.elements.team_name.value.trim();
      if (!teamName) {
        toast('Name the new group', 'error');
        return;
      }
      body.team_name = teamName;
    } else if (group) {
      body.team_id = Number(group);
    }

    button.disabled = true;
    try {
      await api.post('/api/people', body);
      toast(`${name} added`);
      form.reset();
      teamNameField.hidden = true;
      await reload();
    } catch (err) {
      toast(err.status === 409 ? 'That email already has an account' : err.message, 'error');
    }
    button.disabled = false;
  });

  return () => {
    alive = false;
  };
}

export default mountPeople;
