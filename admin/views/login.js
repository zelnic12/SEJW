// Login screen. Renders into the whole document body area and calls onSuccess
// once a token has been obtained and stored.
import { api, auth } from "../components/api.js";
import { esc } from "../components/format.js";

export function renderLogin(host, onSuccess) {
  host.innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="loginForm">
        <div class="login-brand"><span class="brand-mark has-img"><img src="assets/logo.svg" alt="Sinar Elektronik" /></span> <span class="brand-name">Sinar <span>Elektronik</span></span></div>
        <h1>Admin sign in</h1>
        <p class="login-sub">Sign in to manage products, orders and analytics.</p>
        <div class="form-field">
          <label for="lgUser">Username</label>
          <input id="lgUser" name="username" autocomplete="username" required />
        </div>
        <div class="form-field">
          <label for="lgPass">Password</label>
          <input id="lgPass" name="password" type="password" autocomplete="current-password" required />
        </div>
        <p class="form-error" id="lgErr" hidden></p>
        <button class="btn btn-primary btn-block" id="lgBtn" type="submit">Sign in</button>
      </form>
    </div>`;

  const form = host.querySelector("#loginForm");
  const err = host.querySelector("#lgErr");
  const btn = host.querySelector("#lgBtn");

  form.addEventListener("submit", async e => {
    e.preventDefault();
    err.hidden = true;
    const username = host.querySelector("#lgUser").value.trim();
    const password = host.querySelector("#lgPass").value;
    if (!username || !password) {
      err.textContent = "Enter your username and password."; err.hidden = false; return;
    }
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const { token } = await api.login(username, password);
      auth.setToken(token);
      onSuccess();
    } catch (e2) {
      err.textContent = e2.message || "Sign in failed."; err.hidden = false;
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });

  host.querySelector("#lgUser").focus();
}
