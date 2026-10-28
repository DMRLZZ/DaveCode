import { BRAND_MARK_SVG } from '../brand';

/**
 * Pages served by the local sign-in server. Plain HTML with inline styles; the only script is
 * the e-mail form, allowed by a per-response nonce.
 */

const STYLE = `
:root{color-scheme:dark;--bg:#000;--fg:#f5f5f5;--muted:#8a8a8a;--line:#262626;--field:#0d0d0d}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{width:100%;max-width:360px}
.mark{display:block;width:40px;height:40px;margin-bottom:28px;color:var(--fg)}
.mark svg{width:100%;height:100%}
h1{font-size:22px;font-weight:600;letter-spacing:-.01em;margin-bottom:6px}
.lede{color:var(--muted);margin-bottom:28px}
.stack{display:grid;gap:10px}
a.btn,button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:44px;
border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;
text-decoration:none;cursor:pointer}
a.btn:hover,button:hover{border-color:#525252}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}
button.primary:hover{background:#d4d4d4}
button:disabled{opacity:.5;cursor:default}
a.btn svg{width:18px;height:18px;flex:none}
.or{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px;margin:22px 0}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
input{width:100%;height:44px;border-radius:8px;border:1px solid var(--line);background:var(--field);
color:var(--fg);font:inherit;padding:0 12px}
input:focus{outline:none;border-color:var(--fg)}
.switch{margin-top:18px;font-size:14px;color:var(--muted);text-align:center}
.switch button{display:inline;width:auto;height:auto;border:0;padding:0;color:var(--fg);
text-decoration:underline;text-underline-offset:3px;background:none}
.status{min-height:21px;margin-top:14px;font-size:14px;color:var(--muted)}
.status.error{color:#ff8a8a}
.foot{margin-top:36px;font-size:12px;color:var(--muted)}
@media (prefers-reduced-motion:no-preference){a.btn,button,input{transition:border-color .15s,background .15s}}
`;

const GOOGLE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1a5.98 5.98 0 0 1 0-11.96c1.84 0 3.07.78 3.78 1.46l2.58-2.49C16.71 3.65 14.56 2.7 12 2.7a9.3 9.3 0 1 0 0 18.6c5.37 0 8.93-3.77 8.93-9.09 0-.61-.07-1.08-.16-1.55z"/></svg>';
const GITHUB =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>';

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function shell(title: string, body: string, nonce?: string, script?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head><body><main>
<span class="mark">${BRAND_MARK_SVG}</span>${body}</main>
${script && nonce ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

/** Same-origin endpoints only; `base` is the per-sign-in path prefix (`/s/<token>`). */
const FORM_SCRIPT = (base: string) => `
const form=document.getElementById('email');const status=document.getElementById('status');
const submit=document.getElementById('submit');const toggle=document.getElementById('toggle');
const title=document.getElementById('title');const prompt=document.getElementById('prompt');
let mode='signin';
function render(){const up=mode==='signup';title.textContent=up?'Create your account':'Sign in to DaveCode';
submit.textContent=up?'Create account':'Continue';prompt.textContent=up?'Already have an account?':'New to DaveCode?';
toggle.textContent=up?'Sign in':'Create an account';
document.getElementById('password').autocomplete=up?'new-password':'current-password';
status.textContent='';status.className='status';}
toggle.addEventListener('click',()=>{mode=mode==='signin'?'signup':'signin';render();});
form.addEventListener('submit',async(e)=>{e.preventDefault();submit.disabled=true;status.className='status';
status.textContent=mode==='signup'?'Creating your account…':'Signing in…';
try{const r=await fetch('${base}/email',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({mode,email:form.email.value,password:form.password.value})});
const j=await r.json();
if(j.ok){location.replace('${base}/done');return;}
if(j.confirm){status.textContent='Check your inbox and open the confirmation link. This page can stay open.';return;}
status.className='status error';status.textContent=j.error||'Something went wrong. Try again.';}
catch{status.className='status error';status.textContent='DaveCode stopped waiting. Run davecode login again.';}
finally{submit.disabled=false;}});render();`;

export function loginPage(base: string, providers: readonly string[], nonce: string): string {
  const buttons = [
    providers.includes('google')
      ? `<a class="btn" href="${base}/oauth/google">${GOOGLE}Continue with Google</a>`
      : '',
    providers.includes('github')
      ? `<a class="btn" href="${base}/oauth/github">${GITHUB}Continue with GitHub</a>`
      : '',
  ].join('');
  const body = `<h1 id="title">Sign in to DaveCode</h1>
<p class="lede">Continue with Google, GitHub or your email.</p>
${buttons ? `<div class="stack">${buttons}</div><p class="or">or</p>` : ''}
<form id="email" class="stack" novalidate>
<div><label for="address">Email</label><input id="address" name="email" type="email" autocomplete="email" required></div>
<div><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" required></div>
<button id="submit" class="primary" type="submit">Continue</button>
</form>
<p class="switch"><span id="prompt">New to DaveCode?</span> <button id="toggle" type="button">Create an account</button></p>
<p id="status" class="status" role="status" aria-live="polite"></p>
<p class="foot">You will return to your terminal when you are signed in.</p>`;
  return shell('Sign in · DaveCode', body, nonce, FORM_SCRIPT(base));
}

export function donePage(who: string | undefined): string {
  return shell(
    'Signed in · DaveCode',
    `<h1>You are signed in</h1><p class="lede">${who ? `${escapeHtml(who)}. ` : ''}Return to your terminal; you can close this tab.</p>`,
  );
}

export function errorPage(base: string, message: string): string {
  return shell(
    'Sign-in failed · DaveCode',
    `<h1>Sign-in did not finish</h1><p class="lede">${escapeHtml(message)}</p>
<div class="stack"><a class="btn" href="${base}/">Try again</a></div>`,
  );
}

/** Content-Security-Policy for these pages: no external resources, one nonce-bound script. */
export function pagePolicy(nonce?: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "connect-src 'self'",
    'img-src data:',
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}
