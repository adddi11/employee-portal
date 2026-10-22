/* login.js — handles authentication + demo autofill */
document.querySelectorAll('.demo-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.getElementById('email').value = chip.dataset.email;
    document.getElementById('password').value = 'Password@123';
    document.getElementById('login-btn').focus();
  });
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-err');
  err.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Signing in…';
  refreshLucide();
  const fail = (msg) => {
    err.textContent = msg;
    err.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="log-in"></i> Sign in';
    refreshLucide();
  };
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value.trim().toLowerCase(),
        password: document.getElementById('password').value,
      }),
    });
    /* Parse defensively: a crashed backend (e.g. Vercel cold start without
       MONGODB_URI) can return an empty or non-JSON body — never blow up here. */
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON body */ }
    if (!res.ok || !data.token) {
      throw new Error(data.error || (
        res.status >= 500
          ? 'Server error — if this is your Vercel deployment, verify the MONGODB_URI environment variable (README §3)'
          : `Login failed (${res.status}) — please try again`));
    }
    Auth.save(data.token, data.user);
    localStorage.setItem('zt_employee', JSON.stringify(data.employee || null));
    toast(`Welcome back, ${data.user.name.split(' ')[0]}!`, 'ok');
    setTimeout(() => { location.href = 'index.html'; }, 350);
  } catch (ex) {
    fail(ex.name === 'TypeError'
      ? 'Cannot reach the server — refresh the page, or check that the backend is running'
      : ex.message);
  }
});

refreshLucide();
