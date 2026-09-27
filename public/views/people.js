// #/people — the owners' mini CMS (SPEC §17): who is here, which team they are on, how
// many calls each has made, and the account actions behind each person's ⋯ menu (move,
// reset password, remove). The API is requireOwner — if a member somehow lands on this
// route, every call 403s and we say so, plainly.

import { $, $$, html, setHtml, toast, icons, openSheet, closeSheet } from '../lib/ui.js';

const GROUP_NEW = '__new__';
const TEAM_NEW = '__new_team__';

function memberMeta(team) {
  if (team.home) return 'Home team';
  return team.members.length <= 1 ? 'Solo' : `${team.members.length} members`;
}

// The home team is the owners' alone (the API refuses a friend there), so it is never
// offered as a place to add or move someone.
function groupOptions(teams) {
  return html`<option value="">New solo group</option>
    <option value="${GROUP_NEW}">New shared group…</option>
    ${teams.filter((t) => !t.home).map((t) => html`<option value="${t.id}">${t.name}</option>`)}`;
}

/** Yes / Maybe / No tallies, each behind a dot in its verdict colour. */
function statsHtml(v = { yes: 0, maybe: 0, no: 0 }) {
  return html`<div class="person-stats" aria-label="Calls: ${v.yes} yes, ${v.maybe} maybe, ${v.no} no">
    <span class="person-stat person-stat-yes"><b class="mono">${v.yes}</b> Yes</span>
    <span class="person-stat person-stat-maybe"><b class="mono">${v.maybe}</b> Maybe</span>
    <span class="person-stat person-stat-no"><b class="mono">${v.no}</b> No</span>
  </div>`;
}

/** The ⋯ menu. Remove is the soft kind (SPEC §17: people are never deleted), so a removed
    person's menu offers Restore in its place. */
function personMenu(member) {
  const removed = !!member.disabled_at;
  return html`<div class="person-menu-wrap">
    <button type="button" class="icon-btn" data-person-menu="${member.id}" aria-haspopup="menu" aria-expanded="false"
      aria-label="Actions for ${member.name}">${icons.more()}</button>
    <div class="menu" role="menu" hidden>
      <button type="button" role="menuitem" data-person-action="move" data-id="${member.id}">Move…</button>
      <button type="button" role="menuitem" data-person-action="reset" data-id="${member.id}">Reset password…</button>
      <span class="menu-sep" role="separator"></span>
      ${removed
        ? html`<button type="button" role="menuitem" data-person-action="restore" data-id="${member.id}">Restore</button>`
        : html`<button type="button" role="menuitem" class="menu-danger" data-person-action="remove" data-id="${member.id}">Remove…</button>`}
    </div>
  </div>`;
}

function personRow(member) {
  const isOwnerRow = member.role === 'owner';
  const removed = !!member.disabled_at;
  return html`<div class="entry person-entry${removed ? ' is-removed' : ''}" data-person="${member.id}">
    <div class="person-row">
      <div class="person-id">
        <span class="person-name">${member.name}</span>
        <span class="mono small muted">${member.email}</span>
        ${isOwnerRow ? html`<span class="pill">Owner</span>` : ''}
        ${removed ? html`<span class="pill pill-rejected">Removed</span>` : ''}
      </div>
      ${isOwnerRow ? '' : personMenu(member)}
    </div>
    ${statsHtml(member.verdicts)}
  </div>`;
}

function teamBlock(team) {
  const canDelete = !team.home && team.members.length === 0;
  return html`<section class="block people-team" data-team="${team.id}">
    <div class="people-team-head">
      <button type="button" class="people-team-rename" data-rename-team="${team.id}">${team.name}</button>
      <span class="small muted">${memberMeta(team)}</span>
      ${canDelete ? html`<button type="button" class="btn btn-sm btn-ghost" data-delete-team="${team.id}">Delete</button>` : ''}
    </div>
    ${team.members.length ? team.members.map((m) => personRow(m)) : html`<p class="empty">Nobody here yet.</p>`}
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
    setHtml(teamsEl, teams.map((t) => teamBlock(t)));
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

  // --- the ⋯ menu: one open at a time; an outside tap or Escape closes it ------

  function closeMenus(except = null) {
    for (const menu of $$('.person-menu-wrap .menu', el)) {
      if (menu === except) continue;
      menu.hidden = true;
      menu.previousElementSibling?.setAttribute('aria-expanded', 'false');
    }
  }

  el.addEventListener('click', (event) => {
    const toggle = event.target.closest('button[data-person-menu]');
    if (!toggle) return;
    const menu = toggle.nextElementSibling;
    const open = menu.hidden;
    closeMenus(menu);
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button')?.focus();
  });
  const onDocClick = (event) => {
    if (!event.target.closest('.person-menu-wrap')) closeMenus();
  };
  const onDocKey = (event) => {
    if (event.key !== 'Escape') return;
    const open = $$('.person-menu-wrap .menu', el).find((m) => !m.hidden);
    if (!open) return;
    closeMenus();
    open.previousElementSibling?.focus();
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  function personById(id) {
    for (const team of teams) {
      const member = team.members.find((m) => m.id === id);
      if (member) return { member, team };
    }
    return null;
  }

  /** A dialog's form: `body` on top, Cancel and the one action at the bottom. */
  function dialogForm(body, submitLabel, { danger = false } = {}) {
    const form = document.createElement('form');
    form.className = 'dialog-form';
    form.noValidate = true;
    setHtml(
      form,
      html`${body}<div class="dialog-actions">
        <button type="button" class="btn" data-dialog-cancel>Cancel</button>
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>
      </div>`
    );
    $('[data-dialog-cancel]', form).addEventListener('click', closeSheet);
    return form;
  }

  /** Every dialog submits the same way: lock the button, run, close, reload. `run`
      returns false to keep the dialog open (a field still needs fixing). */
  function onDialogSubmit(form, run) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('button[type=submit]', form);
      button.disabled = true;
      try {
        if ((await run()) === false) return;
        closeSheet();
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  function openMoveDialog({ member, team }) {
    const others = teams.filter((t) => !t.home);
    const form = dialogForm(
      html`<label class="field"><span class="label">Team</span>
          <select name="team">
            ${others.map(
              (t) => html`<option value="${t.id}" ${t.id === team.id ? 'selected' : ''}>${t.name}${t.id === team.id ? ' (now)' : ''}</option>`
            )}
            <option value="${TEAM_NEW}">New team…</option>
          </select></label>
        <label class="field" data-role="new-team" hidden><span class="label">New team's name</span>
          <input type="text" name="team_name" maxlength="80" value="${member.name}" /></label>
        <p class="small muted">Their calls, notes, visits and places move with them.</p>`,
      'Move'
    );
    const select = form.elements.team;
    const newField = $('[data-role="new-team"]', form);
    select.addEventListener('change', () => {
      newField.hidden = select.value !== TEAM_NEW;
      if (!newField.hidden) form.elements.team_name.select();
    });
    onDialogSubmit(form, async () => {
      if (select.value !== TEAM_NEW && Number(select.value) === team.id) return true; // already there
      let teamId = Number(select.value);
      let teamName = others.find((t) => t.id === teamId)?.name;
      if (select.value === TEAM_NEW) {
        teamName = form.elements.team_name.value.trim();
        if (!teamName) {
          toast('Name the new team', 'error');
          return false;
        }
        teamId = (await api.post('/api/teams', { name: teamName })).id;
      }
      await api.patch(`/api/people/${member.id}`, { team_id: teamId });
      toast(select.value === TEAM_NEW ? `${member.name} has a new team: ${teamName}` : `${member.name} moved to ${teamName}`);
      return true;
    });
    openSheet(`Move ${member.name}`, form, { dialog: true });
    select.focus();
  }

  function openResetDialog({ member }) {
    const form = dialogForm(
      html`<label class="field"><span class="label">New password</span>
          <input type="text" name="password" minlength="8" maxlength="200" autocomplete="new-password"
            placeholder="At least 8 characters" required /></label>
        <p class="small muted">Their open sessions end. Tell them the new password yourself.</p>`,
      'Save'
    );
    const input = form.elements.password;
    onDialogSubmit(form, async () => {
      if (input.value.length < 8) {
        toast('Password must be at least 8 characters', 'error');
        return false;
      }
      await api.patch(`/api/people/${member.id}`, { password: input.value });
      toast(`New password saved — ${member.name} is signed out`);
      return true;
    });
    openSheet(`Reset ${member.name}'s password`, form, { dialog: true });
    input.focus();
  }

  function openRemoveDialog({ member }) {
    const form = dialogForm(
      html`<p>${member.name} can no longer sign in, and any open session ends. Their calls, notes and
          visits stay, and you can restore them from this menu.</p>`,
      'Remove',
      { danger: true }
    );
    onDialogSubmit(form, async () => {
      await api.patch(`/api/people/${member.id}`, { disabled: true });
      toast(`${member.name} removed`);
      return true;
    });
    openSheet(`Remove ${member.name}?`, form, { dialog: true });
    $('button[type=submit]', form).focus();
  }

  el.addEventListener('click', async (event) => {
    const item = event.target.closest('button[data-person-action]');
    if (!item) return;
    closeMenus();
    const found = personById(Number(item.dataset.id));
    if (!found) return;
    const action = item.dataset.personAction;
    if (action === 'move') openMoveDialog(found);
    else if (action === 'reset') openResetDialog(found);
    else if (action === 'remove') openRemoveDialog(found);
    else if (action === 'restore') {
      try {
        await api.patch(`/api/people/${found.member.id}`, { disabled: false });
        toast(`${found.member.name} restored — they can sign in again`);
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
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
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
  };
}

export default mountPeople;
