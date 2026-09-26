// #/login — email + password, no signup (SPEC §5).

import { html, setHtml, $, toast } from '../lib/ui.js';

export async function mountLogin(el, ctx) {
  const { api, store, navigate } = ctx;

  setHtml(
    el,
    html`<div class="login-wrap">
      <h1>Dream House</h1>
      <p class="muted small">Private villa search for Philipp and Abigaïl.</p>
      <form id="login-form" novalidate>
        <label class="field">
          <span class="label">Email</span>
          <input type="email" name="email" autocomplete="username" required autocapitalize="none" />
        </label>
        <label class="field">
          <span class="label">Password</span>
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <p class="small" id="login-error" role="alert" style="color: var(--danger); min-height: 18px"></p>
        <button class="btn btn-primary" type="submit" style="width: 100%">Sign in</button>
      </form>
    </div>`
  );

  const form = $('#login-form', el);
  const error = $('#login-error', el);

  async function submit(event) {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      error.textContent = 'Email and password are required.';
      return;
    }

    button.disabled = true;
    error.textContent = '';
    try {
      await api.post('/api/login', { email, password }, { skipAuthRedirect: true });
      const me = await api.get('/api/me');
      store.set({ user: me.user, users: me.users || [], team: me.team || null });
      const { areas } = await api.get('/api/areas');
      store.set({ areas });
      ctx.refreshCounts?.();
      toast(`Welcome back, ${me.user.name.split(' ')[0]}`);
      navigate('/', { replace: true });
    } catch (err) {
      error.textContent =
        err.status === 429 ? 'Too many attempts — wait a few minutes.' : 'That email and password do not match.';
      button.disabled = false;
    }
  }

  form.addEventListener('submit', submit);
  form.email.focus();

  return () => form.removeEventListener('submit', submit);
}

export default mountLogin;
