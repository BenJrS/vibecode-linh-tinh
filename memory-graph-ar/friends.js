// Friends sheet: your name, invite link + QR, requests, friends, blocked.
// api: from cloud.js friendsApi(). ui: { toast, appLink } supplied by app.js.

const CODE = /^[0-9a-f]{8}$/;
export const isFriendCode = s => CODE.test(s || '');

const TAGS = ['#FFD84D', '#8FE3B8', '#FF9FB2', '#9CCBFF', '#CDBBFF'];
const tint = name => TAGS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % TAGS.length];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

let qrLib;
const loadQR = () => qrLib ??= window.qrcode ? Promise.resolve() : new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
  s.onload = res; s.onerror = rej;
  document.head.append(s);
});
async function drawQR(canvas, text) {
  await loadQR();
  const qr = window.qrcode(0, 'M');
  qr.addData(text); qr.make();
  const n = qr.getModuleCount(), px = 6, quiet = 2, size = (n + quiet * 2) * px;
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#14161F';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
}

export function createFriends({ api, ui, root }) {
  let me = null, rows = [], offer = null, busy = false;

  async function load() {
    [me, rows] = await Promise.all([api.profile(), api.list()]);
    render();
  }

  // two-tap buttons: the first tap asks, the second does it
  const sure = (label, sureLabel, run, cls = 'mini') => {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.onclick = async () => {
      if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = sureLabel; return; }
      b.disabled = true;
      try { await run(); await load(); } catch (e) { ui.toast(explain(e)); b.disabled = false; }
    };
    return b;
  };
  const act = (label, run, cls = 'mini') => {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.onclick = async () => {
      b.disabled = true;
      try { await run(); await load(); } catch (e) { ui.toast(explain(e)); b.disabled = false; }
    };
    return b;
  };
  const person = (r, ...buttons) => h('li', { class: 'row-item' },
    h('span', { class: 'avatar', style: `background:${tint(r.display_name || '?')}` }, [...(r.display_name || '?')][0].toUpperCase()),
    h('span', { class: 'who' }, r.display_name || 'Người dùng'),
    h('span', { class: 'btns' }, buttons));
  const section = (title, items) => items.length
    ? h('div', { class: 'sec' }, h('h3', {}, title), h('ul', { class: 'rows' }, items)) : null;

  function render() {
    const link = ui.appLink(me.friend_code);
    const incoming = rows.filter(r => r.status === 'pending' && r.direction === 'in');
    const outgoing = rows.filter(r => r.status === 'pending' && r.direction === 'out');
    const friends = rows.filter(r => r.status === 'accepted');
    const blocked = rows.filter(r => r.status === 'blocked');

    const name = h('input', { class: 'field', value: me.display_name || '', maxlength: '40', 'aria-label': 'Tên của bạn', placeholder: 'Tên hiển thị' });
    name.onchange = async () => {
      const v = name.value.trim();
      if (!v) { name.value = me.display_name; return; }
      try { await api.setName(v); me.display_name = v; ui.toast('Đã đổi tên'); } catch (e) { ui.toast(explain(e)); }
    };
    const canvas = h('canvas', { class: 'qr', 'aria-label': 'Mã QR mời kết bạn' });
    drawQR(canvas, link).catch(() => canvas.remove());
    const share = h('button', { class: 'btn primary', type: 'button' }, navigator.share ? 'Chia sẻ link mời' : 'Chép link mời');
    share.onclick = async () => {
      const text = `Kết bạn với mình trên Memory-Graph: ${link}`;
      try {
        if (navigator.share) await navigator.share({ text });
        else { await navigator.clipboard.writeText(link); ui.toast('Đã chép link'); }
      } catch (e) { if (e?.name !== 'AbortError') ui.toast('Không chia sẻ được. Chép link thủ công bên dưới.'); }
    };

    root.replaceChildren(
      offer && h('div', { class: 'offer' },
        h('p', {}, h('b', {}, `Kết bạn với ${offer.name}?`)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn quiet', type: 'button', onclick: () => { offer = null; render(); } }, 'Bỏ qua'),
          h('button', { class: 'btn primary', type: 'button', onclick: confirmOffer }, 'Gửi lời mời'))),
      h('div', { class: 'sec first' }, h('h3', {}, 'Tên bạn bè sẽ thấy'), name),
      h('div', { class: 'sec' }, h('h3', {}, 'Mời bạn bè'),
        h('p', { class: 'meta' }, 'Người nhận mở link hoặc quét mã QR, đăng nhập rồi chấp nhận lời mời.'),
        h('div', { class: 'invite' }, canvas, h('div', {}, share, h('input', { class: 'field small', readonly: true, value: link, 'aria-label': 'Link mời', onfocus: e => e.target.select() })))),
      section('Lời mời đến', incoming.map(r => person(r, act('Chấp nhận', () => api.respond(r.id, true), 'mini primary'), act('Từ chối', () => api.respond(r.id, false))))),
      section('Bạn bè', friends.map(r => person(r, sure('Gỡ', 'Gỡ thật?', () => api.remove(r.id)), sure('Chặn', 'Chặn thật?', () => api.block(r.other))))),
      !friends.length && !incoming.length && h('p', { class: 'meta empty' }, 'Chưa có bạn bè nào. Gửi link hoặc mã QR cho một người bạn.'),
      section('Đã gửi, đang chờ', outgoing.map(r => person(r, act('Hủy lời mời', () => api.remove(r.id))))),
      section('Đã chặn', blocked.map(r => person(r, act('Bỏ chặn', () => api.remove(r.id))))),
    );
  }

  async function confirmOffer() {
    if (busy || !offer) return;
    busy = true;
    try {
      const { result, name } = await api.request(offer.code);
      ui.toast({ sent: `Đã gửi lời mời tới ${name}`, accepted: `Đã kết bạn với ${name}`, already: `Bạn và ${name} đã là bạn bè`, pending: `Lời mời tới ${name} đang chờ` }[result] || 'Xong');
      offer = null;
      await load();
    } catch (e) { ui.toast(explain(e)); offer = null; render(); }
    busy = false;
  }

  return {
    load,
    incomingCount: () => rows.filter(r => r.status === 'pending' && r.direction === 'in').length,
    // a link was opened: show who it belongs to and ask before sending anything
    async offerFor(code) {
      const name = await api.lookup(code);
      if (!name) { ui.toast('Link mời này không còn dùng được.'); return false; }
      offer = { code, name };
      return true;
    },
  };
}

export function explain(e) {
  const m = `${e?.message || e}`;
  if (/unavailable|invalid code/.test(m)) return 'Không gửi được lời mời tới người này.';
  if (/not signed in|JWT/i.test(m)) return 'Hãy đăng nhập lại rồi thử tiếp.';
  if (/Failed to fetch|NetworkError|offline/i.test(m)) return 'Không có mạng. Thử lại khi có kết nối.';
  return 'Có lỗi xảy ra. Thử lại sau.';
}
