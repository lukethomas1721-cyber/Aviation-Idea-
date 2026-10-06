// Friend invite page: a friend joins a group trip by verifying ID and adding their own autopay. The unguessable invite
// token in the URL is the credential. Friends pay a share; they are not borrowers.
import { esc } from './lib.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('token') ?? '';
const body = $('#body');
const api = async (method, b) => {
  const r = await fetch(`/api/v1/join/${encodeURIComponent(token)}`, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Request failed');
  return j;
};

function render(i) {
  const flight = `<div class="card"><div class="route">${esc(i.route)}</div><div class="sub">${esc(i.aircraft)} · ${new Date(i.departsAt).toLocaleString()}</div><div class="sub">Invited by ${esc(i.from)}</div></div>`;
  if (i.status === 'joined') return (body.innerHTML = `<h1>You're in ✓</h1>${flight}<p>Your share will be charged by autopay each week once the group is locked. ${esc(i.from)} stays responsible for the full balance.</p>`);
  if (!i.open) return (body.innerHTML = `<h1>This invite is closed</h1>${flight}<p class="muted">Status: ${esc(i.status)}. The group may already be locked or the offer expired.</p>`);
  body.innerHTML = `<h1>Hi ${esc(i.invitee)}, join this trip</h1>${flight}
    <p class="fine">You'll pay an equal share of the down payment and of each weekly payment. You are not the borrower; ${esc(i.from)} signs the loan and is responsible for the balance, and is charged if a share fails after a short grace period.</p>
    <form id="f" class="form">
      <label class="chk full"><input type="checkbox" name="id" required> I verify my identity with JetReserve's ID provider (demo: simulated).</label>
      <label>Autopay method<select name="method"><option value="card">Card</option><option value="ach">Bank account (ACH)</option></select></label>
      <label>Last 4 digits<input name="last4" required pattern="\\d{4}" maxlength="4" value="1234"></label>
      <div class="full actions"><button class="primary">Join the group</button></div>
    </form><div id="err" class="callout bad" hidden></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { render(await api('POST', { idVerified: true, autopay: { method: e.target.method.value, last4: e.target.last4.value } })); }
    catch (err) { const el = $('#err'); el.textContent = err.message; el.hidden = false; }
  };
}
api('GET').then(render).catch((e) => (body.innerHTML = `<h1>Invite not found</h1><p class="callout bad">${esc(e.message)}</p>`));
