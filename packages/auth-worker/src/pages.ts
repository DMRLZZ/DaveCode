/**
 * The sign-in pages, served from auth.davecode.app like Claude Code's and Codex's. Plain
 * server-rendered forms: no scripts, no external resources. The CLI only runs a loopback
 * listener for the final redirect.
 */

const MARK =
  '<svg viewBox="0 0 1214 1214" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" fill-rule="evenodd" d="M324.3 1096.5C324.6 1095.4 326.5 1088.3 328.5 1080.8C341.4 1031.3 375.8 953.4 419.7 874.0C445.8 826.9 448.4 822.4 471.8 783.0C501.5 733.1 530.1 687.6 556.4 648.5C563.7 637.5 569.7 628.4 569.5 628.2C569.4 628.1 563.1 631.7 555.4 636.3C513.8 661.4 468.0 683.9 411.0 707.5C337.2 737.9 321.7 744.7 296.0 757.2C241.9 783.5 199.1 809.4 152.0 844.3C119.5 868.4 98.8 885.9 71.3 912.4C64.0 919.5 58.0 925.0 58.0 924.7C58.0 923.1 64.7 902.4 68.8 891.0C116.1 762.1 215.0 644.2 351.0 554.8C385.2 532.3 411.6 516.9 445.5 499.4C521.4 460.4 589.4 435.7 636.0 430.0C676.8 425.1 715.1 437.0 743.9 463.6C763.4 481.6 779.0 509.9 785.2 538.5C787.7 550.1 788.7 579.7 787.1 592.5C782.6 626.4 769.7 661.5 746.5 702.0C717.7 752.5 675.6 806.9 627.0 856.4C599.5 884.4 575.9 905.4 542.5 931.6C510.0 957.1 500.7 964.2 432.5 1015.0C409.4 1032.3 382.6 1052.5 373.0 1060.0C354.5 1074.4 327.4 1095.5 325.1 1097.4C324.0 1098.3 323.8 1098.1 324.3 1096.5ZM783.2 1017.8C797.1 999.5 820.2 966.0 831.7 947.5C868.5 888.3 888.8 840.5 903.4 778.5C917.9 716.9 921.2 643.7 912.0 591.0C904.6 549.3 889.7 511.9 866.7 477.5C856.6 462.3 853.1 457.8 837.4 439.6C817.4 416.6 806.6 402.0 800.5 389.5C793.6 375.5 791.7 368.1 791.7 356.0C791.7 335.3 799.3 319.6 819.0 299.9C849.7 269.2 900.2 247.9 956.8 241.9C963.0 241.2 967.7 240.3 967.3 239.9C966.1 238.8 948.5 236.3 933.0 234.9C913.6 233.2 875.2 234.3 859.0 237.0C839.7 240.2 827.8 242.9 813.0 247.5C753.9 265.9 700.6 300.9 659.2 348.5C648.9 360.4 636.6 376.5 632.4 383.5C630.3 387.1 629.0 388.2 624.7 389.6C603.8 396.4 554.6 417.6 513.5 437.5C447.6 469.4 395.4 496.8 341.5 528.1L337.5 530.4L339.5 527.9C340.6 526.6 346.2 520.3 352.0 514.0C374.4 489.6 390.2 470.8 411.2 443.5C429.3 419.9 444.6 398.2 488.5 333.5C510.5 301.0 529.1 278.0 550.9 256.3C593.0 214.1 640.3 183.6 691.5 165.5C727.7 152.8 756.5 147.7 792.5 147.7C854.3 147.8 906.4 164.9 954.1 200.6C967.5 210.8 974.1 214.6 981.5 217.0C991.4 220.1 1022.1 231.9 1038.5 238.8C1061.9 248.7 1099.0 267.4 1097.7 268.7C1097.4 268.9 1089.3 268.5 1079.7 267.9C1033.7 264.7 984.5 274.1 946.2 293.4C932.3 300.4 915.0 313.0 903.4 324.5C881.0 346.6 870.0 369.6 870.0 394.4C870.0 413.7 876.8 433.1 894.7 465.2C908.8 490.3 914.6 501.1 922.8 517.5C961.3 594.3 980.0 662.5 980.0 725.4C980.0 770.9 967.3 818.9 944.4 860.4C927.6 890.8 912.0 911.0 882.5 940.6C856.5 966.7 828.5 989.7 797.0 1010.7C779.6 1022.2 780.0 1022.0 783.2 1017.8Z"/></svg>';

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
.status{margin-top:14px;font-size:14px;color:var(--muted)}
.status.error{color:#ff8a8a}
.switch a{color:var(--fg);text-decoration:underline;text-underline-offset:3px}
.foot{margin-top:36px;font-size:12px;color:var(--muted)}
@media (prefers-reduced-motion:no-preference){a.btn,button,input{transition:border-color .15s,background .15s}}
`;

const GOOGLE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1a5.98 5.98 0 0 1 0-11.96c1.84 0 3.07.78 3.78 1.46l2.58-2.49C16.71 3.65 14.56 2.7 12 2.7a9.3 9.3 0 1 0 0 18.6c5.37 0 8.93-3.77 8.93-9.09 0-.61-.07-1.08-.16-1.55z"/></svg>';
const GITHUB =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>';

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function shell(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head><body><main>
<span class="mark">${MARK}</span>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PAGE_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** No scripts or external resources; forms only post back here. */
const PAGE_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export interface LoginForm {
  /** The CLI's loopback callback and PKCE challenge, carried through every step. */
  redirectTo: string;
  challenge: string;
  mode: 'signin' | 'signup';
  providers: { google: boolean; github: boolean; email: boolean };
  email?: string;
  error?: string;
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function loginPage(form: LoginForm): Response {
  const carry = { redirect_to: form.redirectTo, code_challenge: form.challenge };
  const oauth = (provider: string) =>
    `/auth/v1/authorize?${escapeHtml(query({ provider, ...carry, code_challenge_method: 's256' }))}`;
  const up = form.mode === 'signup';
  const buttons = [
    form.providers.google
      ? `<a class="btn" href="${oauth('google')}">${GOOGLE}Continue with Google</a>`
      : '',
    form.providers.github
      ? `<a class="btn" href="${oauth('github')}">${GITHUB}Continue with GitHub</a>`
      : '',
  ].join('');
  const other = `/login?${escapeHtml(query({ ...carry, mode: up ? 'signin' : 'signup' }))}`;
  const email = form.providers.email
    ? `<form class="stack" method="post" action="/login">
<input type="hidden" name="redirect_to" value="${escapeHtml(form.redirectTo)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(form.challenge)}">
<input type="hidden" name="mode" value="${form.mode}">
<div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(form.email ?? '')}"></div>
<div><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" autocomplete="${up ? 'new-password' : 'current-password'}" required></div>
<button class="primary" type="submit">${up ? 'Create account' : 'Continue'}</button>
</form>
<p class="switch">${up ? 'Already have an account?' : 'New to DaveCode?'} <a href="${other}">${up ? 'Sign in' : 'Create an account'}</a></p>`
    : '';
  const body = `<h1>${up ? 'Create your DaveCode account' : 'Sign in to DaveCode'}</h1>
<p class="lede">Continue with Google, GitHub or your email.</p>
${buttons ? `<div class="stack">${buttons}</div>${email ? '<p class="or">or</p>' : ''}` : ''}${email}
${form.error ? `<p class="status error" role="alert">${escapeHtml(form.error)}</p>` : ''}
<p class="foot">You will return to your terminal when you are signed in.</p>`;
  return shell(up ? 'Create account · DaveCode' : 'Sign in · DaveCode', body);
}

export function messagePage(title: string, message: string): Response {
  return shell(
    `${title} · DaveCode`,
    `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p>`,
  );
}
