/* Meu Dinheiro — controle de gastos, receitas e plano do mês.
   Tudo fica salvo no próprio celular (localStorage), criptografado por perfil com a senha de cada pessoa. */
'use strict';

const LEGACY_KEY = 'meu-dinheiro.v1'; // versão sem senha: migrada para um perfil na primeira abertura
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => BRL.format(Math.round(v * 100) / 100);
const moneyShort = (v) => money(v).replace(',00', '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = (sel) => document.querySelector(sel);

// grupo: 'ess' = essencial (necessidades), 'est' = estilo de vida (desejos)
// fixo: gasto que costuma ser cobrado de uma vez no mês (aluguel, contas)
const DEFAULT_CATS = [
  { name: 'Moradia', icon: '🏠', group: 'ess', fixed: true, w: 25 },
  { name: 'Alimentação', icon: '🛒', group: 'ess', fixed: false, w: 15 },
  { name: 'Transporte', icon: '🚗', group: 'ess', fixed: false, w: 9 },
  { name: 'Contas (luz, água, internet)', icon: '💡', group: 'ess', fixed: true, w: 7 },
  { name: 'Saúde', icon: '💊', group: 'ess', fixed: false, w: 4 },
  { name: 'Educação', icon: '📚', group: 'ess', fixed: true, w: 3 },
  { name: 'Lazer', icon: '🎉', group: 'est', fixed: false, w: 10 },
  { name: 'Restaurantes e delivery', icon: '🍔', group: 'est', fixed: false, w: 9 },
  { name: 'Compras', icon: '🛍️', group: 'est', fixed: false, w: 9 },
  { name: 'Assinaturas', icon: '📺', group: 'est', fixed: true, w: 3 },
  { name: 'Outros', icon: '📦', group: 'est', fixed: false, w: 6 },
];
const GOAL_OPTS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70];
const goalCustomField = (id, val) => `<div class="row" style="margin-top:10px"><span class="small muted grow">Outro valor:</span>
  <input class="in-f num" id="${id}" inputmode="decimal" placeholder="ex.: 12" value="${val}" style="width:90px;text-align:right;padding:9px 10px"><span class="muted">%</span></div>`;
// aceita de 1% a 90%, com até 1 casa decimal (ex.: 12,5)
function parseGoal(s) {
  const v = parseFloat(String(s).replace(',', '.'));
  return isFinite(v) && v >= 1 && v <= 90 ? Math.round(v * 10) / 10 : null;
}
const ICONS = ['🏠', '🛒', '🚗', '💡', '💊', '📚', '🎉', '🍔', '🛍️', '📺', '📦', '🐶', '👶', '💳', '✈️', '💼', '🎁', '⛽', '💇', '📱'];

// ---------- estado ----------
let ui = { tab: 'home', month: ym(new Date()), filter: 'all' };
let session = null; // perfil aberto: { profile, key } — a chave só existe na memória
let S = blank();

function blank() {
  return { setupDone: false, income: 0, goalPct: 20, categories: [], pots: defaultPots(20), incomes: [], tx: [], books: [], readGoal: 1 };
}
// Completa dados de versões anteriores do app.
function normalize(s) {
  if (!s || !s.categories) return blank();
  if (!Array.isArray(s.pots)) s.pots = defaultPots(s.goalPct || 20);
  if (!Array.isArray(s.incomes)) s.incomes = s.income > 0 ? [{ id: uid(), name: 'Salário', kind: 'fixo', amount: s.income }] : [];
  if (!Array.isArray(s.books)) s.books = [];
  if (!(s.readGoal > 0)) s.readGoal = 1;
  if (!Array.isArray(s.tx)) s.tx = [];
  return s;
}

// ---------- perfis com senha ----------
// Cada perfil guarda os dados criptografados (AES-GCM 256). A chave vem da senha (PBKDF2-SHA256),
// então sem a senha certa os dados não podem ser lidos — nem por quem mexer no celular.
const PROFILES_KEY = 'meu-dinheiro.perfis';
const dataKey = (id) => 'meu-dinheiro.dados.' + id;
const PBKDF2_ITER = 250000;
const getProfiles = () => { try { return JSON.parse(localStorage.getItem(PROFILES_KEY)) || []; } catch (e) { return []; } };
const setProfiles = (p) => localStorage.setItem(PROFILES_KEY, JSON.stringify(p));
function b64(buf) {
  const a = new Uint8Array(buf); let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptStr(key, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(str));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decryptStr(key, rec) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct));
  return new TextDecoder().decode(pt);
}
async function createProfile(name, pass, data) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const profile = { id: uid(), name, salt: b64(salt), iter: PBKDF2_ITER, created: today() };
  const key = await deriveKey(pass, salt, PBKDF2_ITER);
  localStorage.setItem(dataKey(profile.id), JSON.stringify(await encryptStr(key, JSON.stringify(data))));
  setProfiles([...getProfiles(), profile]);
  return { profile, key };
}
// Devolve a sessão se a senha estiver certa; null se estiver errada.
async function openProfile(profile, pass) {
  const key = await deriveKey(pass, unb64(profile.salt), profile.iter);
  try {
    const raw = await decryptStr(key, JSON.parse(localStorage.getItem(dataKey(profile.id))));
    return { session: { profile, key }, data: normalize(JSON.parse(raw)) };
  } catch (e) { return null; }
}
let saving = Promise.resolve();
function save() {
  if (!session) return;
  const snap = JSON.stringify(S), sess = session;
  saving = saving.then(async () => localStorage.setItem(dataKey(sess.profile.id), JSON.stringify(await encryptStr(sess.key, snap))))
    .catch(() => toast('Não foi possível salvar. Verifique o espaço do celular.'));
}
async function lockApp() {
  await saving;
  session = null; S = blank(); ui.tab = 'home'; lockUi = { mode: 'list', sel: null };
  closeSheet(); render();
}
// Bloqueia sozinho se o app ficar mais de 5 minutos em segundo plano.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (session && hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) lockApp();
});

// ---------- entradas: salário, valores fixos e serviços variáveis ----------
// kind 'fixo' = valor certo todo mês (salário, aluguel recebido, pró-labore)
// kind 'variavel' = serviços/vendas que variam; amount é a META de lucro do mês
const fixedIncome = () => S.incomes.filter((i) => i.kind === 'fixo').reduce((a, i) => a + i.amount, 0);
const variableGoal = () => S.incomes.filter((i) => i.kind === 'variavel').reduce((a, i) => a + i.amount, 0);
// S.income guarda a renda prevista do mês (fixos + metas variáveis), usada em todos os cálculos.
function syncIncome() { S.income = Math.round((fixedIncome() + variableGoal()) * 100) / 100; }
function incomeName(src) {
  const i = S.incomes.find((x) => x.id === src);
  return i ? i.name : (src && src !== 'outros' ? src : 'Outras entradas');
}
function receivedFor(item, txs) {
  return txs.filter((t) => t.type === 'in' && (t.src === item.id || t.src === item.name)).reduce((a, t) => a + t.amount, 0);
}

// ---------- destinos do dinheiro guardado ----------
const POT_ICONS = ['🛟', '📈', '🏦', '✈️', '🎓', '🏡', '🚗', '🎁', '👶', '💍'];
function round1(v) { return Math.round(v * 10) / 10; }
function defaultPots(total) {
  const half = round1(total / 2);
  return [
    { id: uid(), name: 'Reserva de emergência', icon: '🛟', pct: half },
    { id: uid(), name: 'Investimentos', icon: '📈', pct: round1(total - half) },
  ];
}
// A meta total de sobra é sempre a soma dos destinos.
function syncGoal() { if (S.pots.length) S.goalPct = round1(S.pots.reduce((a, p) => a + p.pct, 0)); }
// Mudar a meta total reparte proporcionalmente entre os destinos.
function setGoalTotal(total) {
  const sum = S.pots.reduce((a, p) => a + p.pct, 0);
  if (S.pots.length) {
    S.pots.forEach((p) => { p.pct = sum > 0 ? round1((p.pct * total) / sum) : round1(total / S.pots.length); });
    S.pots[0].pct = round1(S.pots[0].pct + total - S.pots.reduce((a, p) => a + p.pct, 0));
  }
  S.goalPct = total;
}
const potValue = (p) => Math.round(S.income * p.pct) / 100;
const pctOfIncome = (v) => (S.income > 0 ? round1((v / S.income) * 100) : 0);
const fmtPct = (v) => String(v).replace('.', ',');

function goal() { return Math.round(S.income * S.goalPct) / 100; }
function spendable() { return Math.max(0, S.income - goal()); }

function distribute() {
  const total = spendable();
  const sumW = S.categories.reduce((a, c) => a + (c.w || 1), 0) || 1;
  S.categories.forEach((c) => { c.budget = Math.round((total * (c.w || 1)) / sumW / 10) * 10; });
  // ajusta arredondamento na maior categoria
  const diff = total - S.categories.reduce((a, c) => a + c.budget, 0);
  if (S.categories.length) {
    const big = S.categories.reduce((a, c) => (c.budget > a.budget ? c : a));
    big.budget = Math.max(0, big.budget + diff);
  }
}

// ---------- datas ----------
function ym(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function today() { const d = new Date(); return ym(d) + '-' + String(d.getDate()).padStart(2, '0'); }
function shiftMonth(m, n) { const [y, mo] = m.split('-').map(Number); return ym(new Date(y, mo - 1 + n, 1)); }
function monthName(m) {
  const [y, mo] = m.split('-').map(Number);
  const s = new Date(y, mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function dayLabel(iso) {
  if (iso === today()) return 'Hoje';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' });
}

// ---------- cálculos do mês ----------
function stats(m) {
  const [y, mo] = m.split('-').map(Number);
  const dim = new Date(y, mo, 0).getDate();
  const cur = ym(new Date());
  const status = m === cur ? 'current' : m < cur ? 'past' : 'future';
  const elapsed = status === 'current' ? new Date().getDate() : status === 'past' ? dim : 0;
  const daysLeft = status === 'current' ? dim - elapsed + 1 : status === 'future' ? dim : 0;

  const txs = S.tx.filter((t) => t.date.startsWith(m));
  const income = txs.filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0);
  const spent = txs.filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0);
  const incs = S.incomes.map((i) => {
    const got = receivedFor(i, txs);
    let proj = i.amount;
    if (status === 'past') proj = got;
    else if (status === 'current') proj = i.kind === 'fixo' ? Math.max(got, i.amount) : (elapsed >= 5 ? Math.max(got, (got / elapsed) * dim) : Math.max(got, i.amount));
    return { ...i, got, proj, missing: Math.max(0, i.amount - got) };
  });
  const otherIn = income - incs.reduce((a, i) => a + i.got, 0); // entradas fora da lista (extras)
  // Durante o mês: fixos contam pelo valor previsto; serviços variáveis pelo ritmo real de faturamento.
  const incomeBase = status === 'past' ? income : Math.max(income, incs.reduce((a, i) => a + i.proj, 0) + otherIn);

  const cats = S.categories.map((c) => {
    const s = txs.filter((t) => t.type === 'out' && t.cat === c.id).reduce((a, t) => a + t.amount, 0);
    let proj = s;
    if (status === 'current') {
      proj = c.fixed ? Math.max(s, c.budget) : (elapsed >= 3 ? (s / elapsed) * dim : Math.max(s, c.budget));
    } else if (status === 'future') proj = c.budget;
    return { ...c, spent: s, proj, left: c.budget - s, pct: c.budget ? s / c.budget : (s > 0 ? 9 : 0) };
  });
  const orphan = txs.filter((t) => t.type === 'out' && !S.categories.some((c) => c.id === t.cat)).reduce((a, t) => a + t.amount, 0);
  const projSpent = cats.reduce((a, c) => a + c.proj, 0) + orphan;
  const budgetTotal = S.categories.reduce((a, c) => a + c.budget, 0);
  const canStillSpend = incomeBase - goal() - spent;
  const perDay = daysLeft > 0 ? canStillSpend / daysLeft : 0;
  return { m, dim, status, elapsed, daysLeft, txs, income, spent, incomeBase, cats, projSpent, incs,
    projLeft: incomeBase - projSpent, left: income - spent, budgetTotal, canStillSpend, perDay };
}

function level(pct, c, st) {
  if (pct > 1) return 'bad';
  if (pct >= 0.85) return 'warn';
  if (st.status === 'current' && !c.fixed && c.proj > c.budget * 1.05 && st.elapsed >= 5) return 'warn';
  return 'good';
}

// ---------- o que fazer: análises ----------
function insights(st) {
  const out = [];
  const g = goal();
  if (st.status === 'future') {
    out.push({ lv: 'info', i: '🗓️', t: 'Mês ainda não começou', x: `Plano: guardar ${money(g)} e gastar no máximo ${money(spendable())}.` });
    return out;
  }
  if (st.budgetTotal > spendable() + 1) {
    out.push({ lv: 'bad', i: '⚖️', t: 'Seu orçamento está maior do que a renda permite',
      x: `As categorias somam ${money(st.budgetTotal)}, mas para sobrar ${money(g)} você só pode gastar ${money(spendable())}. Corte ${money(st.budgetTotal - spendable())} na aba Orçamento.` });
  }
  if (st.status === 'current' && st.income === 0) {
    out.push({ lv: 'info', i: '💰', t: 'Registre o que entrou', x: `Ainda não há entradas neste mês. Estou usando sua renda prevista de ${money(S.income)} (fixos + metas dos serviços) nos cálculos.` });
  }

  // Metas de lucro dos serviços variáveis
  st.incs.filter((i) => i.kind === 'variavel' && i.amount > 0).forEach((i) => {
    if (i.got >= i.amount) {
      out.push({ lv: 'good', i: '🎯', t: `Meta de ${i.name} batida: ${money(i.got)}`, x: `A meta era ${money(i.amount)}. O que passar disso é dinheiro extra — considere mandar parte para seus investimentos.` });
    } else if (st.status === 'past') {
      out.push({ lv: 'warn', i: '🎯', t: `${i.name}: faturou ${money(i.got)} de ${money(i.amount)}`, x: `Faltaram ${money(i.missing)}. Se for comum, ajuste a meta ou o orçamento do próximo mês.` });
    } else if (st.status === 'current' && st.elapsed >= 5 && i.proj < i.amount * 0.9) {
      const perWeek = (i.missing / st.daysLeft) * 7;
      out.push({ lv: 'warn', i: '🎯', t: `${i.name}: no ritmo atual você fatura ${money(i.proj)} de ${money(i.amount)}`,
        x: `Para bater a meta, precisa de mais ${money(i.missing)} — cerca de ${money(perWeek)} por semana. Nesse ritmo entram ${money(i.amount - i.proj)} a menos que o planejado — a previsão de sobra e o limite por dia já consideram isso.` });
    }
  });
  const fx = fixedIncome(), vg = variableGoal();
  if (vg > 0 && st.status === 'current' && fx < st.budgetTotal) {
    const varGot = st.incs.filter((i) => i.kind === 'variavel').reduce((a, i) => a + i.got, 0);
    if (varGot < st.budgetTotal - fx) {
      out.push({ lv: 'info', i: '🧱', t: `Sua renda fixa (${money(fx)}) não cobre todos os gastos`,
        x: `Você depende de faturar pelo menos ${money(st.budgetTotal - fx)} nos serviços para pagar o orçamento (já entrou ${money(varGot)}). Priorize as contas fixas até esse dinheiro entrar.` });
    }
  }

  // Projeção do fechamento
  if (st.status === 'current' && st.spent > 0) {
    if (st.projLeft >= g) {
      out.push({ lv: 'good', i: '✅', t: `No ritmo atual você fecha o mês sobrando ${money(st.projLeft)}`, x: `Sua meta é ${money(g)}. Continue assim.` });
    } else {
      const falta = g - st.projLeft;
      out.push({ lv: st.projLeft < 0 ? 'bad' : 'warn', i: '📉',
        t: st.projLeft < 0 ? `No ritmo atual você fecha o mês no vermelho (${money(st.projLeft)})` : `No ritmo atual você sobra só ${money(st.projLeft)}`,
        x: st.perDay > 0
          ? `Faltam ${money(falta)} para a meta de ${money(g)}. Para chegar lá, gaste no máximo ${money(st.perDay)} por dia até o fim do mês.`
          : `Este mês a meta de ${money(g)} já não fecha: mesmo sem gastar mais nada, sobrariam ${money(st.incomeBase - st.spent)}. Gaste só o essencial até o fim do mês e veja abaixo onde cortar no próximo.` });
    }
  }
  if (st.status === 'past') {
    const ok = st.left >= g;
    out.push({ lv: ok ? 'good' : 'warn', i: ok ? '🏆' : '📋', t: ok ? `Meta batida: sobrou ${money(st.left)}` : `Sobrou ${money(st.left)} (meta era ${money(g)})`,
      x: ok ? 'Ótimo mês. Mantenha o mesmo plano.' : 'Veja abaixo onde passou do limite e ajuste o orçamento do próximo mês.' });
  }

  // Categorias estouradas / em risco
  const over = st.cats.filter((c) => c.spent > c.budget && c.budget >= 0).sort((a, b) => (b.spent - b.budget) - (a.spent - a.budget));
  // Sobra disponível em categorias variáveis, priorizando "estilo de vida" (mais fácil de cortar)
  const room = st.cats.filter((c) => !c.fixed && c.left > 0).map((c) => ({ ...c, avail: c.left }))
    .sort((a, b) => (a.group === b.group ? b.left - a.left : a.group === 'est' ? -1 : 1));
  over.forEach((c) => {
    const ex = c.spent - c.budget;
    let tip = `Limite era ${money(c.budget)}.`;
    if (st.status === 'current') {
      const fonte = room.find((r) => r.avail >= Math.min(ex, 50));
      tip = (c.fixed ? 'Ajuste esse limite na aba Orçamento se o valor mudou. ' : 'Pare de gastar nessa categoria este mês. ') +
        (fonte ? `Compense segurando ${money(Math.min(ex, fonte.avail))} em ${fonte.name}.` : '');
      if (fonte) fonte.avail -= Math.min(ex, fonte.avail);
    }
    out.push({ lv: 'bad', i: c.icon, t: `${c.name} passou ${money(ex)} do limite`, x: tip.trim() });
  });
  if (st.status === 'current') {
    st.cats.filter((c) => c.spent <= c.budget && !c.fixed && st.elapsed >= 5 && c.proj > c.budget * 1.05)
      .sort((a, b) => (b.proj - b.budget) - (a.proj - a.budget)).slice(0, 3)
      .forEach((c) => {
        out.push({ lv: 'warn', i: c.icon, t: `${c.name}: no ritmo atual fecha em ${money(c.proj)}`,
          x: `O limite é ${money(c.budget)}. Gaste até ${money(c.left / st.daysLeft)} por dia nos próximos ${st.daysLeft} dias.` });
      });
  }

  // Maior gasto
  const top = [...st.cats].sort((a, b) => b.spent - a.spent)[0];
  if (top && top.spent > 0 && st.txs.filter((t) => t.type === 'out').length >= 5) {
    const share = top.spent / st.spent;
    if (share >= 0.35 && !top.fixed) {
      out.push({ lv: 'info', i: '🔎', t: `${Math.round(share * 100)}% dos seus gastos foram em ${top.name}`, x: 'É aqui que um corte pequeno faz mais diferença no fim do mês.' });
    }
  }

  // Comparação com o mês anterior
  const prev = S.tx.filter((t) => t.date.startsWith(shiftMonth(st.m, -1)));
  const prevSpent = prev.filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0);
  if (st.status === 'current' && prevSpent > 0 && st.elapsed >= 7) {
    const prevSameDay = prev.filter((t) => t.type === 'out' && Number(t.date.slice(8)) <= st.elapsed).reduce((a, t) => a + t.amount, 0);
    if (prevSameDay > 0) {
      const d = st.spent - prevSameDay;
      out.push({ lv: d > 0 ? 'warn' : 'good', i: '↔️', t: d > 0 ? `Você está gastando ${money(d)} a mais que no mês passado` : `Você está gastando ${money(-d)} a menos que no mês passado`,
        x: `Comparando até o dia ${st.elapsed} de cada mês.` });
    }
  }

  if (!out.some((o) => o.lv === 'bad' || o.lv === 'warn') && st.spent > 0 && st.status === 'current') {
    out.push({ lv: 'good', i: '👏', t: 'Todas as categorias dentro do limite', x: 'Registre cada gasto no dia em que acontecer para manter os números certos.' });
  }
  if (st.spent === 0 && st.status === 'current') {
    out.push({ lv: 'info', i: '✍️', t: 'Comece registrando seus gastos', x: 'Toque no botão + sempre que gastar. Em poucos dias o app mostra para onde o dinheiro está indo.' });
  }
  return out;
}

// ---------- telas ----------
// ---------- tela de entrada: perfis e senha ----------
let lockUi = { mode: 'list', sel: null };
function renderLock() {
  $('#tabs').innerHTML = '';
  if (!window.crypto || !crypto.subtle) {
    $('#app').innerHTML = `<div class="onb"><div class="logo">🔒</div><h1>Meu Dinheiro</h1>
      <p class="muted">Abra o app pelo endereço seguro (https) para usar os perfis com senha.</p></div>`;
    return;
  }
  const profiles = getProfiles();
  const legacy = localStorage.getItem(LEGACY_KEY);
  const creating = !profiles.length || lockUi.mode === 'new';
  const header = `<div class="logo">🔒</div><h1 style="font-size:28px;margin-bottom:6px">Meu Dinheiro</h1>`;
  if (creating) {
    const first = !profiles.length;
    $('#app').innerHTML = `<div class="onb">${header}
      <p class="muted" style="margin-top:0">${first && legacy ? 'Agora o app tem perfis com senha. Crie o seu — seus dados atuais vão para ele e ficam protegidos.' : first ? 'Crie seu perfil. Cada pessoa que usar o app tem o próprio perfil e a própria senha.' : 'Novo perfil para outra pessoa. Os dados dela ficam separados dos seus e protegidos pela senha dela.'}</p>
      <div class="card">
        <label class="f" style="margin-top:0">Nome</label><input class="in-f" id="lkName" maxlength="24" placeholder="Ex.: Matheus">
        <label class="f">Senha</label><input class="in-f" id="lkPass" type="password" autocomplete="new-password" placeholder="Mínimo 4 caracteres">
        <label class="f">Repita a senha</label><input class="in-f" id="lkPass2" type="password" autocomplete="new-password">
        <div class="small muted" style="margin-top:10px">⚠️ Guarde bem a senha: se esquecer, não há como recuperar os dados desse perfil.</div>
        <button class="btn" id="lkCreate">${first && legacy ? 'Criar perfil e proteger meus dados' : 'Criar perfil'}</button>
        ${first ? '' : '<button class="btn ghost" id="lkBack" style="margin-top:10px">Voltar</button>'}
      </div></div>`;
    $('#lkName').focus({ preventScroll: true });
    $('#lkCreate').onclick = async () => {
      const name = $('#lkName').value.trim(), p1 = $('#lkPass').value, p2 = $('#lkPass2').value;
      if (!name) { toast('Informe o nome'); return; }
      if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast('Já existe um perfil com esse nome'); return; }
      if (p1.length < 4) { toast('A senha precisa ter pelo menos 4 caracteres'); return; }
      if (p1 !== p2) { toast('As senhas não são iguais'); return; }
      busy('#lkCreate', 'Criando…');
      let data = blank();
      if (first && legacy) { try { data = normalize(JSON.parse(legacy)); } catch (e) { /* começa do zero */ } }
      session = await createProfile(name, p1, data);
      S = data;
      if (first && legacy) localStorage.removeItem(LEGACY_KEY); // dados agora só existem criptografados
      lockUi = { mode: 'list', sel: null }; ui.tab = 'home'; render();
      toast(`Olá, ${name}! Perfil criado.`);
    };
    if ($('#lkBack')) $('#lkBack').onclick = () => { lockUi = { mode: 'list', sel: null }; render(); };
    return;
  }
  const sel = profiles.find((p) => p.id === lockUi.sel) || (profiles.length === 1 ? profiles[0] : null);
  $('#app').innerHTML = `<div class="onb">${header}
    <p class="muted" style="margin-top:0">${sel ? 'Digite a senha para entrar.' : 'Quem está usando?'}</p>
    <div class="card">
      ${profiles.map((p) => `<button class="tx" data-prof="${p.id}" style="${sel && sel.id === p.id ? 'font-weight:700' : ''}">
        <div style="width:40px;height:40px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-weight:750;flex:none">${esc(p.name.charAt(0).toUpperCase())}</div>
        <div class="grow">${esc(p.name)}</div><span class="muted">${sel && sel.id === p.id ? '🔓' : '›'}</span></button>`).join('')}
      ${sel ? `<label class="f">Senha de ${esc(sel.name)}</label>
        <input class="in-f" id="lkPass" type="password" autocomplete="current-password">
        <button class="btn" id="lkEnter">Entrar</button>` : ''}
    </div>
    <button class="btn ghost" id="lkNew" style="margin-top:4px">+ Novo perfil</button></div>`;
  document.querySelectorAll('[data-prof]').forEach((b) => { b.onclick = () => { lockUi.sel = b.dataset.prof; render(); }; });
  $('#lkNew').onclick = () => { lockUi = { mode: 'new', sel: null }; render(); };
  if (sel) {
    const enter = async () => {
      const pass = $('#lkPass').value;
      if (!pass) { toast('Digite a senha'); return; }
      busy('#lkEnter', 'Abrindo…');
      const r = await openProfile(sel, pass);
      if (!r) {
        lockUi.fails = (lockUi.fails || 0) + 1;
        await new Promise((res) => setTimeout(res, Math.min(8000, 500 * 2 ** lockUi.fails))); // atrasa tentativas seguidas
        render(); toast('Senha incorreta'); return;
      }
      session = r.session; S = r.data; lockUi = { mode: 'list', sel: null }; ui.tab = 'home'; render();
    };
    $('#lkEnter').onclick = enter;
    $('#lkPass').onkeydown = (e) => { if (e.key === 'Enter') enter(); };
    $('#lkPass').focus({ preventScroll: true });
  }
}
function changePassSheet() {
  openSheet(`<h1 style="margin-top:0">Mudar senha</h1>
    <label class="f">Senha atual</label><input class="in-f" id="cpOld" type="password" autocomplete="current-password">
    <label class="f">Nova senha</label><input class="in-f" id="cpNew" type="password" autocomplete="new-password" placeholder="Mínimo 4 caracteres">
    <label class="f">Repita a nova senha</label><input class="in-f" id="cpNew2" type="password" autocomplete="new-password">
    <button class="btn" id="cpSave">Salvar nova senha</button>`);
  $('#sheet').onclick = async (e) => {
    if (!e.target.closest('#cpSave')) return;
    const n1 = $('#cpNew').value;
    if (n1.length < 4) { toast('A nova senha precisa ter pelo menos 4 caracteres'); return; }
    if (n1 !== $('#cpNew2').value) { toast('As senhas novas não são iguais'); return; }
    busy('#cpSave', 'Salvando…');
    await saving;
    const p = session.profile;
    if (!(await openProfile(p, $('#cpOld').value))) { toast('Senha atual incorreta'); changePassSheet(); return; }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(n1, salt, PBKDF2_ITER);
    localStorage.setItem(dataKey(p.id), JSON.stringify(await encryptStr(key, JSON.stringify(S))));
    const np = { ...p, salt: b64(salt), iter: PBKDF2_ITER };
    setProfiles(getProfiles().map((x) => (x.id === p.id ? np : x)));
    session = { profile: np, key };
    closeSheet(); toast('Senha alterada');
  };
}
function deleteProfileSheet() {
  const p = session.profile;
  openSheet(`<h1 style="margin-top:0">Excluir perfil ${esc(p.name)}</h1>
    <p class="small muted">Todos os gastos, entradas, metas e livros deste perfil serão apagados deste celular. Isso não pode ser desfeito. Os outros perfis continuam como estão.</p>
    <label class="f">Digite sua senha para confirmar</label><input class="in-f" id="dpPass" type="password" autocomplete="current-password">
    <button class="btn danger" id="dpGo">Excluir meu perfil</button>`);
  $('#sheet').onclick = async (e) => {
    if (!e.target.closest('#dpGo')) return;
    busy('#dpGo', 'Verificando…');
    await saving;
    if (!(await openProfile(p, $('#dpPass').value))) { toast('Senha incorreta'); deleteProfileSheet(); return; }
    localStorage.removeItem(dataKey(p.id));
    setProfiles(getProfiles().filter((x) => x.id !== p.id));
    session = null; S = blank(); lockUi = { mode: 'list', sel: null }; closeSheet(); render();
    toast('Perfil excluído');
  };
}
function busy(sel, label) { const b = $(sel); if (b) { b.disabled = true; b.textContent = label; b.style.opacity = '.6'; } }

function render() {
  if (!session) { renderLock(); return; }
  if (!S.setupDone) { renderOnboarding(); $('#tabs').innerHTML = ''; return; }
  renderTabs();
  const v = { home: viewHome, tx: viewTx, plan: viewPlan, budget: viewBudget, read: viewRead, avg: viewAvg }[ui.tab];
  $('#app').innerHTML = v();
  window.scrollTo(0, 0);
}

function monthBar() {
  const me = session ? session.profile.name : '';
  return `<div class="row between" style="margin:0 0 6px"><span class="small muted">👤 ${esc(me)}</span>
    <button class="chip" data-act="lock" style="padding:5px 10px;font-size:13px">🔒 Bloquear / trocar perfil</button></div>
  <div class="monthbar"><button data-act="prev" aria-label="Mês anterior">‹</button>
    <strong>${monthName(ui.month)}</strong><button data-act="next" aria-label="Próximo mês">›</button></div>`;
}

function renderTabs() {
  const t = (id, ic, l) => `<button data-tab="${id}" class="${ui.tab === id ? 'on' : ''}"><span>${ic}</span>${l}</button>`;
  $('#tabs').innerHTML = t('home', '🏠', 'Início') + t('tx', '📄', 'Extrato') + t('read', '📚', 'Leitura') +
    `<button class="fab" data-act="${ui.tab === 'read' ? 'newbook' : 'add'}" aria-label="${ui.tab === 'read' ? 'Novo livro' : 'Novo lançamento'}">+</button>` +
    t('plan', '🎯', 'Plano') + t('budget', '🧮', 'Orçamento');
}

function catRow(c, st) {
  const lv = level(c.pct, c, st);
  const tag = c.spent > c.budget ? `<span class="tag bad">passou ${moneyShort(c.spent - c.budget)}</span>`
    : `<span class="tag ${lv}">resta ${moneyShort(c.left)}</span>`;
  return `<div class="cat"><div class="row"><div class="em">${c.icon}</div><div class="grow">
    <div class="row between"><b class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</b>${tag}</div>
    <div class="small muted num">${money(c.spent)} de ${money(c.budget)}</div>
    <div class="bar ${lv}"><i style="width:${Math.min(100, c.pct * 100)}%"></i></div></div></div></div>`;
}

function viewHome() {
  const st = stats(ui.month);
  const g = goal();
  const res = st.status === 'past' ? st.left : st.income - st.spent;
  let daily = '';
  if (st.status === 'current') {
    const v = st.perDay;
    daily = `<div class="card daily"><div class="ico">${v > 0 ? '💸' : '🛑'}</div><div class="grow">
      <div class="small muted">Você pode gastar por dia</div>
      <div class="v num" style="color:${v > 0 ? 'var(--ink)' : 'var(--bad)'}">${money(Math.max(0, v))}</div>
      <div class="small muted">${v > 0 ? `nos próximos ${st.daysLeft} dias para sobrar ${money(g)}` : `Você já gastou o que podia. Evite novos gastos para não comer a meta de ${money(g)}.`}</div>
      </div></div>`;
  }
  const incRows = st.incs.filter((i) => i.amount > 0 || i.got > 0).map((i) => {
    const pct = i.amount ? i.got / i.amount : 1;
    const done = i.got >= i.amount;
    const tag = done ? `<span class="tag good">${i.kind === 'variavel' ? 'meta batida' : 'recebido'}</span>`
      : `<span class="tag ${i.kind === 'variavel' ? 'info' : 'warn'}">falta ${moneyShort(i.missing)}</span>`;
    return `<div class="cat"><div class="row"><div class="em">${i.kind === 'variavel' ? '🎯' : '💼'}</div><div class="grow">
      <div class="row between"><b class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.name)}</b>${tag}</div>
      <div class="small muted num">${money(i.got)} de ${money(i.amount)} · ${i.kind === 'variavel' ? 'meta de lucro' : 'fixo'}</div>
      <div class="bar"><i style="width:${Math.min(100, pct * 100)}%;background:${i.kind === 'variavel' ? 'var(--info)' : 'var(--good)'}"></i></div></div></div></div>`;
  }).join('');
  const ins = insights(st).slice(0, 3).map(insCard).join('');
  const cats = st.cats.filter((c) => c.budget > 0 || c.spent > 0).sort((a, b) => b.pct - a.pct).map((c) => catRow(c, st)).join('');
  const goalPct = g > 0 ? Math.max(0, Math.min(1, (st.status === 'current' ? st.projLeft : res) / g)) : 0;
  return `${monthBar()}
  <div class="card hero">
    <div class="lbl">${st.status === 'past' ? 'Sobrou no mês' : 'Saldo do mês até agora'}</div>
    <div class="big num">${money(res)}</div>
    <div class="split">
      <div><span class="small">Entrou</span><b class="num">${money(st.income)}</b></div>
      <div><span class="small">Saiu</span><b class="num">${money(st.spent)}</b></div>
    </div>
    <div class="small" style="margin-top:12px;opacity:.9">Meta de sobra: ${money(g)}${st.status === 'current' && st.spent > 0 ? ` · previsão: ${money(st.projLeft)}` : ''}</div>
    <div class="bar" style="background:rgba(255,255,255,.25)"><i style="width:${goalPct * 100}%;background:#fff"></i></div>
  </div>
  ${daily}
  <h2>O que fazer agora</h2>${ins}
  ${insights(st).length > 3 ? `<button class="btn ghost" data-tab="plan" style="margin-top:0">Ver plano completo</button>` : ''}
  ${avgCard()}
  ${readCard()}
  ${incRows ? `<h2>Entradas e metas de lucro</h2><div class="card">${incRows}</div>` : ''}
  <h2>Limites por categoria</h2><div class="card">${cats || '<div class="empty">Sem categorias</div>'}</div>`;
}

function insCard(o) {
  return `<div class="ins ${o.lv}"><div class="n">${o.i}</div><div><div class="t">${esc(o.t)}</div><div class="x">${esc(o.x)}</div></div></div>`;
}

function viewTx() {
  const st = stats(ui.month);
  let list = [...st.txs];
  if (ui.filter !== 'all') list = list.filter((t) => t.type === ui.filter);
  list.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  let html = '', lastDay = '';
  list.forEach((t) => {
    if (t.date !== lastDay) { if (lastDay) html += '</div>'; html += `<div class="day">${dayLabel(t.date)}</div><div class="card" style="padding:4px 12px">`; lastDay = t.date; }
    const c = S.categories.find((x) => x.id === t.cat);
    const icon = t.type === 'in' ? '💰' : (c ? c.icon : '📦');
    const name = t.type === 'in' ? incomeName(t.src) : (c ? c.name : 'Sem categoria');
    html += `<button class="tx" data-edit="${t.id}"><div class="em" style="width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:var(--bg)">${icon}</div>
      <div class="grow"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc || name)}</div><div class="small muted">${esc(name)}</div></div>
      <div class="v num ${t.type}">${t.type === 'in' ? '+' : '−'} ${money(t.amount)}</div></button>`;
  });
  if (lastDay) html += '</div>';
  const f = (id, l) => `<button data-filter="${id}" class="${ui.filter === id ? 'on' : ''}">${l}</button>`;
  return `${monthBar()}
  <div class="kpis"><div class="card"><span class="small muted">Entradas</span><b class="num in">${money(st.income)}</b></div>
  <div class="card"><span class="small muted">Saídas</span><b class="num">${money(st.spent)}</b></div></div>
  <button class="btn ghost" data-tab="avg" style="margin-top:10px">📊 Ver média de entradas dos últimos 4 meses</button>
  <div class="seg" style="margin:14px 0 4px">${f('all', 'Todos')}${f('out', 'Saídas')}${f('in', 'Entradas')}</div>
  ${html || '<div class="empty">Nenhum lançamento neste mês.<br>Toque no + para adicionar.</div>'}`;
}

function viewPlan() {
  const st = stats(ui.month);
  const g = goal();
  const fixed = S.categories.filter((c) => c.fixed && c.budget > 0);
  const variable = S.categories.filter((c) => !c.fixed);
  const varTotal = variable.reduce((a, c) => a + c.budget, 0);
  const fixedTotal = fixed.reduce((a, c) => a + c.budget, 0);
  const ess = S.categories.filter((c) => c.group === 'ess').reduce((a, c) => a + c.budget, 0);
  const est = S.categories.filter((c) => c.group === 'est').reduce((a, c) => a + c.budget, 0);
  const inc = S.income || 1;
  const pc = (v) => Math.round((v / inc) * 100) + '%';

  const steps = [
    { t: `Separe ${money(g)} assim que o dinheiro entrar`, x: (S.pots.length ? S.pots.map((p) => `${p.icon} ${p.name}: ${money(potValue(p))}`).join(' · ') + '. ' : '') + 'Faça as transferências no dia em que receber. O que sobra é o que você pode gastar — não o contrário.' },
    ...(variableGoal() > 0 ? [{
      t: `Bata a meta de lucro: ${money(variableGoal())} em serviços`,
      x: `Isso dá ${money((variableGoal() / st.dim) * 7)} por semana. ` + S.incomes.filter((i) => i.kind === 'variavel').map((i) => `🎯 ${i.name}: ${money(i.amount)}`).join(' · ') +
        `. Sua renda fixa é ${money(fixedIncome())}${fixedIncome() < fixedTotal + g ? ' — ela não cobre contas fixas + meta de sobra, então o mês depende dos serviços' : ''}.`,
    }] : []),
    { t: `Pague os gastos fixos: ${money(fixedTotal)}`, x: fixed.map((c) => `${c.icon} ${c.name}: ${money(c.budget)}`).join(' · ') || 'Nenhum gasto fixo cadastrado.' },
    { t: `Gasto do dia a dia: até ${money(varTotal / st.dim)} por dia`, x: `Isso dá ${money((varTotal / st.dim) * 7)} por semana para ${variable.map((c) => c.name.toLowerCase()).slice(0, 4).join(', ')}${variable.length > 4 ? ' e outros' : ''}.` },
    { t: 'Registre cada gasto no mesmo dia', x: 'Leva 5 segundos no botão +. Sem registro, o app não consegue te avisar a tempo.' },
    { t: 'Confira a aba Início 1 vez por semana', x: 'Se alguma categoria ficar amarela, segure nela até o fim do mês.' },
  ];
  const stepsHtml = steps.map((s, i) => `<div class="step"><div class="k">${i + 1}</div><div><div class="t">${esc(s.t)}</div><div class="small muted">${esc(s.x)}</div></div></div>`).join('');

  const splitRow = (l, v, ideal, color) => `<div style="margin:10px 0"><div class="row between small"><b>${l}</b><span class="muted num">${money(v)} · ${pc(v)} <span class="muted">(ideal ${ideal})</span></span></div>
    <div class="bar"><i style="width:${Math.min(100, (v / inc) * 100)}%;background:${color}"></i></div></div>`;

  return `${monthBar()}
  <h1>Plano do mês</h1>
  <div class="card">${stepsHtml}</div>
  <h2>Análise e alertas</h2>
  ${insights(st).map(insCard).join('')}
  <h2>Divisão da sua renda (${money(S.income)})</h2>
  <div class="card">
    ${splitRow('Essenciais', ess, 'até 50%', 'var(--info)')}
    ${splitRow('Estilo de vida', est, 'até 30%', 'var(--warn)')}
    ${splitRow('Guardar / investir', g, '20% ou mais', 'var(--good)')}
    <div class="small muted" style="margin-top:8px">Regra 50/30/20: no máximo metade da renda no essencial, até 30% em desejos e pelo menos 20% guardado.${ess / inc > 0.55 ? ' Seus essenciais estão acima de 50% — vale rever moradia, transporte ou contas.' : ''}</div>
  </div>`;
}

// ---------- leitura: meta de livros por mês ----------
const bookPct = (b) => (b.pages > 0 ? Math.min(1, (b.current || 0) / b.pages) : 0);
const finishedIn = (m) => S.books.filter((b) => b.finished && b.finished.startsWith(m));
function readStats(m) {
  const st = stats(m);
  const done = finishedIn(m).length;
  const reading = S.books.filter((b) => !b.finished).sort((a, b) => bookPct(b) - bookPct(a));
  const main = reading[0];
  const left = main ? Math.max(0, main.pages - (main.current || 0)) : 0;
  const perDay = main && st.status === 'current' && st.daysLeft > 0 ? Math.ceil(left / st.daysLeft) : 0;
  return { st, done, reading, main, left, perDay, goal: S.readGoal };
}

function readCard() {
  const r = readStats(ui.month);
  if (!S.books.length && r.st.status !== 'current') return '';
  const ok = r.done >= r.goal;
  let x;
  if (ok) x = 'Meta de leitura do mês batida! 🎉';
  else if (r.main && r.st.status === 'current') x = `${esc(r.main.title)}: página ${r.main.current || 0} de ${r.main.pages} · ${r.perDay} pág./dia para terminar no mês`;
  else if (r.st.status === 'current') x = 'Toque para escolher o livro do mês';
  else x = `${r.done} de ${r.goal} livro${r.goal > 1 ? 's' : ''} concluído${r.goal > 1 ? 's' : ''}`;
  return `<button class="card daily" data-tab="read" style="width:100%;text-align:left">
    <div class="ico">📚</div><div class="grow"><div class="small muted">Leitura do mês</div>
    <div class="v num" style="font-size:20px">${r.done} de ${r.goal} livro${r.goal > 1 ? 's' : ''}</div>
    <div class="small muted">${x}</div>
    ${r.main && !ok ? `<div class="bar"><i style="width:${bookPct(r.main) * 100}%;background:var(--info)"></i></div>` : ''}</div></button>`;
}

function bookRow(b) {
  const p = bookPct(b);
  const tag = b.finished ? `<span class="tag good">concluído ${new Date(b.finished + 'T12:00').toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}/${b.finished.slice(2, 4)}</span>`
    : `<span class="tag info">${Math.round(p * 100)}%</span>`;
  return `<button class="tx" data-book="${b.id}"><div class="em" style="width:40px;height:52px;border-radius:8px;display:grid;place-items:center;background:var(--bg);font-size:22px;flex:none">${b.finished ? '✅' : '📖'}</div>
    <div class="grow" style="min-width:0"><div class="row between"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.title)}</b>${tag}</div>
    <div class="small muted">${b.author ? esc(b.author) + ' · ' : ''}pág. ${b.current || 0} de ${b.pages}${b.notes && b.notes.length ? ` · ${b.notes.length} anotaç${b.notes.length > 1 ? 'ões' : 'ão'}` : ''}</div>
    <div class="bar"><i style="width:${p * 100}%;background:${b.finished ? 'var(--good)' : 'var(--info)'}"></i></div></div></button>`;
}

// ---------- média de entradas dos últimos 4 meses ----------
// De onde veio cada entrada: o item (Salário, Serviços…) ou, nos serviços, o nome do cliente/trabalho na descrição.
function sourceKey(t) {
  const it = S.incomes.find((i) => i.id === t.src);
  if (it && it.kind === 'variavel' && t.desc) return t.desc.split(' — ')[0].trim();
  return incomeName(t.src);
}
function avgStats(endM, n = 4) {
  const months = [];
  for (let k = n - 1; k >= 0; k--) months.push(shiftMonth(endM, -k));
  const cur = ym(new Date());
  const rows = months.map((m) => {
    const ins = S.tx.filter((t) => t.type === 'in' && t.date.startsWith(m));
    const fixo = ins.filter((t) => (S.incomes.find((i) => i.id === t.src) || {}).kind === 'fixo').reduce((a, t) => a + t.amount, 0);
    const total = ins.reduce((a, t) => a + t.amount, 0);
    return { m, total, fixo, varia: total - fixo, partial: m === cur, future: m > cur };
  });
  const used = rows.filter((r) => r.total > 0 && !r.future);
  const k = used.length || 1;
  const avg = used.reduce((a, r) => a + r.total, 0) / k;
  const avgFixo = used.reduce((a, r) => a + r.fixo, 0) / k;
  const avgVar = used.reduce((a, r) => a + r.varia, 0) / k;
  const best = used.reduce((a, r) => (!a || r.total > a.total ? r : a), null);
  const worst = used.reduce((a, r) => (!a || r.total < a.total ? r : a), null);
  const src = {};
  S.tx.filter((t) => t.type === 'in' && used.some((r) => t.date.startsWith(r.m))).forEach((t) => {
    const key = sourceKey(t);
    src[key] = src[key] || { name: key, total: 0, months: new Set() };
    src[key].total += t.amount; src[key].months.add(t.date.slice(0, 7));
  });
  const sources = Object.values(src).sort((a, b) => b.total - a.total);
  return { months, rows, used, avg, avgFixo, avgVar, best, worst, sources };
}

function avgCard() {
  const a = avgStats(ui.month);
  if (!a.used.length) return '';
  return `<button class="card daily" data-tab="avg" style="width:100%;text-align:left">
    <div class="ico">📊</div><div class="grow"><div class="small muted">Média de entradas · últimos 4 meses</div>
    <div class="v num" style="font-size:20px">${money(a.avg)}</div>
    <div class="small muted">Fixo ${money(a.avgFixo)} + trabalhos ${money(a.avgVar)} · toque para ver</div></div></button>`;
}

function viewAvg() {
  const a = avgStats(ui.month);
  const short = (m) => { const s = monthName(m).split(' '); return s[0].slice(0, 3) + '/' + s[2].slice(2); };
  const max = Math.max(1, ...a.rows.map((r) => r.total));
  const bars = a.rows.map((r) => `<div style="margin:12px 0">
    <div class="row between small"><b>${monthName(r.m).split(' ')[0]}${r.partial ? ' <span class="muted" style="font-weight:400">(em andamento)</span>' : ''}</b>
      <span class="num ${r.total >= a.avg ? 'in' : ''}" style="font-weight:650">${money(r.total)}</span></div>
    <div class="bar" style="height:14px;display:flex"><i style="width:${(r.fixo / max) * 100}%;background:var(--good);border-radius:99px 0 0 99px"></i><i style="width:${(r.varia / max) * 100}%;background:var(--info);border-radius:0 99px 99px 0"></i></div>
    </div>`).join('');
  const n = a.used.length;
  const plan = S.income;
  const vg = variableGoal();
  const vars = S.incomes.filter((i) => i.kind === 'variavel');
  let compare = '';
  if (plan > 0 && n) {
    const d = plan - a.avg;
    if (d > a.avg * 0.05) {
      compare = `<div class="ins warn"><div class="n">⚠️</div><div><div class="t">Seu plano conta com ${money(d)} a mais do que você costuma receber</div>
        <div class="x">Renda prevista: ${money(plan)} · média real: ${money(a.avg)}. Se os trabalhos não renderem acima da média, a sobra do mês fica menor que a meta.</div></div></div>`;
    } else if (-d > a.avg * 0.05) {
      compare = `<div class="ins good"><div class="n">💪</div><div><div class="t">Você costuma receber ${money(-d)} a mais do que o planejado</div>
        <div class="x">Renda prevista: ${money(plan)} · média real: ${money(a.avg)}. Dá para aumentar a meta de sobra ou de investimentos.</div></div></div>`;
    } else {
      compare = `<div class="ins good"><div class="n">✅</div><div><div class="t">Seu plano está realista</div><div class="x">Renda prevista de ${money(plan)}, bem perto da média real de ${money(a.avg)}.</div></div></div>`;
    }
  }
  const useBtn = vars.length === 1 && n && Math.abs(vars[0].amount - a.avgVar) >= 10
    ? `<button class="btn ghost" data-act="useavg">Usar ${money(Math.round(a.avgVar / 10) * 10)} como meta de "${esc(vars[0].name)}"</button>` : '';
  const srcRows = a.sources.map((s) => `<div class="bud"><div class="grow"><div style="font-weight:600">${esc(s.name)}</div>
    <div class="small muted">${s.months.size} de ${n} ${n === 1 ? 'mês' : 'meses'} · média ${money(s.total / n)}/mês</div></div>
    <b class="num">${money(s.total)}</b></div>`).join('');
  return `${monthBar()}
  <div class="row" style="margin:-4px 0 6px"><button class="chip" data-tab="home">‹ Voltar</button></div>
  <h1>Média de entradas</h1>
  <div class="card hero">
    <div class="lbl">Média por mês · ${short(a.months[0])} a ${short(a.months[3])}</div>
    <div class="big num">${money(a.avg)}</div>
    <div class="split">
      <div><span class="small">Fixo (salário…)</span><b class="num">${money(a.avgFixo)}</b></div>
      <div><span class="small">Trabalhos</span><b class="num">${money(a.avgVar)}</b></div>
    </div>
    <div class="small" style="margin-top:10px;opacity:.9">${n ? `Calculado com ${n} ${n === 1 ? 'mês' : 'meses'} com entradas registradas.` : 'Nenhuma entrada registrada nesses meses.'}</div>
  </div>
  ${n ? `<div class="kpis">
    <div class="card"><span class="small muted">Melhor mês</span><b class="num in">${money(a.best.total)}</b><span class="small muted">${monthName(a.best.m).split(' ')[0]}</span></div>
    <div class="card"><span class="small muted">Mês mais fraco</span><b class="num">${money(a.worst.total)}</b><span class="small muted">${monthName(a.worst.m).split(' ')[0]}</span></div></div>` : ''}
  <h2>Mês a mês</h2>
  <div class="card">${bars}
    <div class="row small muted" style="gap:14px;margin-top:6px"><span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--good)"></span> Fixo</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--info)"></span> Trabalhos</span></div></div>
  ${compare ? `<h2>Comparando com seu plano</h2>${compare}${useBtn}` : ''}
  ${srcRows ? `<h2>De onde veio o dinheiro</h2><div class="card">${srcRows}</div>` : ''}`;
}

function viewRead() {
  const r = readStats(ui.month);
  const year = ui.month.slice(0, 4);
  const yearDone = S.books.filter((b) => b.finished && b.finished.startsWith(year)).length;
  // Conta a meta a partir do mês em que você começou a usar a leitura (primeiro livro cadastrado).
  const firstM = S.books.map((b) => (b.started || b.finished || '').slice(0, 7)).filter(Boolean).sort()[0] || ym(new Date());
  const fromM = firstM.startsWith(year) ? Number(firstM.slice(5, 7)) : 1;
  const toM = year === String(new Date().getFullYear()) ? new Date().getMonth() + 1 : 12;
  const monthsSoFar = Math.max(1, toM - fromM + 1);
  const doneMonth = finishedIn(ui.month);
  const finishedOther = S.books.filter((b) => b.finished && !b.finished.startsWith(ui.month)).sort((a, b) => b.finished.localeCompare(a.finished));
  let tip = '';
  if (r.st.status === 'current' && r.done < r.goal) {
    if (r.main) tip = `<div class="ins ${r.perDay > 40 ? 'warn' : 'info'}"><div class="n">⏱️</div><div><div class="t">Leia ${r.perDay} páginas por dia</div>
      <div class="x">Faltam ${r.left} páginas de "${esc(r.main.title)}" e ${r.st.daysLeft} dia${r.st.daysLeft > 1 ? 's' : ''} no mês.${r.perDay > 40 ? ' É bastante — reserve um horário fixo, como antes de dormir.' : ''}</div></div></div>`;
    else tip = `<div class="ins info"><div class="n">📖</div><div><div class="t">Escolha o livro do mês</div><div class="x">Toque no + para cadastrar o livro que você vai ler.</div></div></div>`;
  }
  return `${monthBar()}
  <h1>Leitura</h1>
  <div class="card hero">
    <div class="lbl">Meta: ${r.goal} livro${r.goal > 1 ? 's' : ''} por mês</div>
    <div class="big num">${r.done} de ${r.goal}</div>
    <div class="bar" style="background:rgba(255,255,255,.25)"><i style="width:${Math.min(1, r.done / r.goal) * 100}%;background:#fff"></i></div>
    <div class="small" style="margin-top:10px;opacity:.9">Em ${year}: ${yearDone} livro${yearDone === 1 ? '' : 's'} concluído${yearDone === 1 ? '' : 's'} (meta até agora: ${monthsSoFar * r.goal})</div>
  </div>
  ${tip}
  <h2>Lendo agora</h2>
  <div class="card" style="padding:4px 12px">${r.reading.map(bookRow).join('') || '<div class="empty">Nenhum livro em andamento.</div>'}</div>
  <button class="btn" data-act="newbook" style="margin-top:0">+ Cadastrar livro</button>
  ${doneMonth.length ? `<h2>Concluídos em ${monthName(ui.month).split(' ')[0].toLowerCase()}</h2><div class="card" style="padding:4px 12px">${doneMonth.map(bookRow).join('')}</div>` : ''}
  ${finishedOther.length ? `<h2>Outros concluídos</h2><div class="card" style="padding:4px 12px">${finishedOther.map(bookRow).join('')}</div>` : ''}
  <h2>Meta mensal</h2>
  <div class="card"><div class="chips">${[1, 2, 3, 4, 5].map((n) => `<button class="chip ${S.readGoal === n ? 'on' : ''}" data-readgoal="${n}">${n} livro${n > 1 ? 's' : ''}</button>`).join('')}</div></div>`;
}

function bookFormSheet(id) {
  const b = id ? S.books.find((x) => x.id === id) : null;
  openSheet(`<h1 style="margin-top:0">${b ? 'Editar livro' : 'Novo livro'}</h1>
    <label class="f">Título</label><input class="in-f" id="bkTitle" maxlength="80" value="${esc(b ? b.title : '')}" placeholder="Ex.: O Poder do Hábito">
    <label class="f">Autor (opcional)</label><input class="in-f" id="bkAuthor" maxlength="60" value="${esc(b ? b.author : '')}">
    <div class="row" style="gap:10px"><div class="grow"><label class="f">Total de páginas</label><input class="in-f num" id="bkPages" inputmode="numeric" value="${b ? b.pages : ''}" placeholder="300"></div>
      <div class="grow"><label class="f">Estou na página</label><input class="in-f num" id="bkCur" inputmode="numeric" value="${b ? b.current || 0 : 0}"></div></div>
    <button class="btn" id="bkSave">${b ? 'Salvar' : 'Cadastrar livro'}</button>`);
  if (!b) $('#bkTitle').focus({ preventScroll: true });
  $('#sheet').onclick = (e) => {
    if (!e.target.closest('#bkSave')) return;
    const title = $('#bkTitle').value.trim();
    const pages = parseInt($('#bkPages').value, 10);
    const cur = Math.max(0, parseInt($('#bkCur').value, 10) || 0);
    if (!title) { toast('Informe o título'); return; }
    if (!(pages > 0)) { toast('Informe o total de páginas'); return; }
    if (cur > pages) { toast('A página atual passa do total do livro'); return; }
    if (b) Object.assign(b, { title, author: $('#bkAuthor').value.trim(), pages, current: cur });
    else S.books.push({ id: uid(), title, author: $('#bkAuthor').value.trim(), pages, current: cur, started: today(), finished: null, notes: [] });
    const book = b || S.books[S.books.length - 1];
    if (cur === pages && !book.finished) book.finished = today();
    save(); render(); bookSheet(book.id);
  };
}

function bookSheet(id) {
  const b = S.books.find((x) => x.id === id);
  if (!b) { closeSheet(); return; }
  const notes = [...(b.notes || [])].sort((x, y) => (y.date + y.id).localeCompare(x.date + x.id));
  openSheet(`<div class="row"><div class="grow"><h1 style="margin:0">${esc(b.title)}</h1>${b.author ? `<div class="muted small">${esc(b.author)}</div>` : ''}</div>
      <span class="tag ${b.finished ? 'good' : 'info'}">${b.finished ? 'concluído' : Math.round(bookPct(b) * 100) + '%'}</span></div>
    <div class="bar" style="margin:12px 0 4px"><i style="width:${bookPct(b) * 100}%;background:${b.finished ? 'var(--good)' : 'var(--info)'}"></i></div>
    <div class="small muted">Página ${b.current || 0} de ${b.pages} · faltam ${Math.max(0, b.pages - (b.current || 0))}</div>
    <label class="f">Em que página você está?</label>
    <div class="row"><input class="in-f num" id="bsCur" inputmode="numeric" value="${b.current || 0}" style="width:100px;text-align:center">
      <div class="chips">${[10, 20, 50].map((n) => `<button class="chip" data-plus="${n}">+${n}</button>`).join('')}</div></div>
    <button class="btn ghost" id="bsUpd" style="margin-top:10px">Atualizar página</button>
    <button class="btn ${b.finished ? 'ghost' : ''}" id="bsDone" style="margin-top:10px">${b.finished ? '↩︎ Marcar como não concluído' : '✅ Concluí este livro'}</button>
    <h2>Anotações</h2>
    <textarea class="in-f" id="bsNote" rows="3" maxlength="2000" placeholder="O que você aprendeu, frases marcantes, ideias…" style="resize:vertical"></textarea>
    <div class="row" style="margin-top:8px"><span class="small muted">Página</span><input class="in-f num" id="bsNotePg" inputmode="numeric" value="${b.current || ''}" style="width:80px;text-align:center">
      <button class="btn" id="bsAddNote" style="margin:0;flex:1;padding:11px">Salvar anotação</button></div>
    <div style="margin-top:8px">${notes.map((n) => `<div class="card" style="background:var(--bg);margin:8px 0;padding:12px">
      <div class="row between small muted"><span>${new Date(n.date + 'T12:00').toLocaleDateString('pt-BR')}${n.page ? ` · pág. ${n.page}` : ''}</span>
      <button class="x" data-delnote="${n.id}" aria-label="Apagar anotação" style="width:26px;height:26px">×</button></div>
      <div style="white-space:pre-wrap;margin-top:4px">${esc(n.text)}</div></div>`).join('') || '<div class="small muted">Nenhuma anotação ainda.</div>'}</div>
    <div class="row" style="gap:10px;margin-top:14px"><button class="btn ghost" id="bsEdit" style="margin:0">Editar livro</button>
      <button class="btn danger" id="bsDel" style="margin:0">Excluir</button></div>`);
  $('#sheet').onclick = (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const setCur = (v) => {
      b.current = Math.max(0, Math.min(b.pages, v));
      if (b.current === b.pages && !b.finished) { b.finished = today(); toast(`🎉 "${b.title}" concluído!`); }
      else toast(`Página ${b.current} de ${b.pages}`);
      save(); render(); bookSheet(b.id);
    };
    if (t.dataset.plus) { $('#bsCur').value = Math.min(b.pages, (parseInt($('#bsCur').value, 10) || 0) + Number(t.dataset.plus)); }
    else if (t.id === 'bsUpd') setCur(parseInt($('#bsCur').value, 10) || 0);
    else if (t.id === 'bsDone') {
      if (b.finished) b.finished = null;
      else { b.finished = today(); b.current = b.pages; toast(`🎉 "${b.title}" concluído!`); }
      save(); render(); bookSheet(b.id);
    } else if (t.id === 'bsAddNote') {
      const text = $('#bsNote').value.trim();
      if (!text) { toast('Escreva a anotação'); return; }
      const page = parseInt($('#bsNotePg').value, 10);
      (b.notes = b.notes || []).push({ id: uid(), date: today(), page: page > 0 ? page : null, text });
      save(); render(); bookSheet(b.id); toast('Anotação salva');
    } else if (t.dataset.delnote) {
      if (!confirm('Apagar esta anotação?')) return;
      b.notes = b.notes.filter((n) => n.id !== t.dataset.delnote); save(); bookSheet(b.id);
    } else if (t.id === 'bsEdit') bookFormSheet(b.id);
    else if (t.id === 'bsDel') {
      if (!confirm(`Excluir "${b.title}" e todas as anotações dele?`)) return;
      S.books = S.books.filter((x) => x !== b); save(); closeSheet(); render(); toast('Livro excluído');
    }
  };
}

function viewBudget() {
  const sum = S.categories.reduce((a, c) => a + c.budget, 0);
  const diff = spendable() - sum;
  const pairRow = (icon, name, sub, pct, value, pctAttr, valAttr, delAttr) => `<div class="bud2">
    <div class="row"><span style="font-size:20px">${icon}</span>
      <div class="grow"><div style="font-weight:600;font-size:15px">${esc(name)}</div><div class="small muted">${sub}</div></div>
      <button class="x" ${delAttr} aria-label="Remover">×</button></div>
    <div class="pair"><input class="in-f num" inputmode="decimal" ${pctAttr} value="${fmtPct(pct)}"><span class="muted small">% da renda</span>
      <span class="muted small" style="margin-left:auto">R$</span><input class="in-f num" inputmode="decimal" ${valAttr} value="${fmtInput(value)}"></div></div>`;
  const rows = S.categories.map((c) => pairRow(c.icon, c.name, (c.group === 'ess' ? 'Essencial' : 'Estilo de vida') + (c.fixed ? ' · conta fixa' : ''),
    pctOfIncome(c.budget), c.budget, `data-budpct="${c.id}"`, `data-bud="${c.id}"`, `data-delcat="${c.id}"`)).join('');
  const pots = S.pots.map((p) => pairRow(p.icon, p.name, 'Guardar todo mês', p.pct, potValue(p),
    `data-potpct="${p.id}"`, `data-potval="${p.id}"`, `data-delpot="${p.id}"`)).join('');
  const incRow = (i) => `<div class="bud"><span style="font-size:20px">${i.kind === 'variavel' ? '🎯' : '💼'}</span>
    <div class="grow"><div style="font-weight:600;font-size:15px">${esc(i.name)}</div><div class="small muted">${i.kind === 'variavel' ? 'meta de lucro do mês' : 'valor fixo por mês'}</div></div>
    <input class="in-f num" inputmode="decimal" data-incval="${i.id}" value="${fmtInput(i.amount)}">
    <button class="x" data-delinc="${i.id}" aria-label="Remover">×</button></div>`;
  const fixos = S.incomes.filter((i) => i.kind === 'fixo').map(incRow).join('');
  const vars = S.incomes.filter((i) => i.kind === 'variavel').map(incRow).join('');
  return `<h1>Orçamento mensal</h1>
  <h2 style="margin-top:6px">Suas entradas do mês</h2>
  <div class="card">
    <div class="small muted" style="font-weight:600">💼 Salário e valores fixos</div>
    ${fixos || '<div class="small muted" style="padding:8px 0">Nenhum valor fixo.</div>'}
    <button class="btn ghost" data-act="newinc" data-kind="fixo" style="margin-top:8px">+ Salário ou valor fixo</button>
    <div class="small muted" style="font-weight:600;margin-top:18px">🎯 Serviços e vendas variáveis (meta de lucro)</div>
    ${vars || '<div class="small muted" style="padding:8px 0">Nenhum serviço variável.</div>'}
    <button class="btn ghost" data-act="newinc" data-kind="variavel" style="margin-top:8px">+ Serviço variável</button>
    <div class="row between" style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line)">
      <span class="small muted">Fixo ${money(fixedIncome())} + metas ${money(variableGoal())}</span><b class="num">${money(S.income)}</b></div>
  </div>
  <div class="card">
    <label class="f" style="margin-top:0">Quanto quer sobrar por mês</label>
    <div class="chips" id="goalChips">${GOAL_OPTS.map((p) => `<button class="chip ${S.goalPct === p ? 'on' : ''}" data-goal="${p}">${p}%</button>`).join('')}</div>
    ${goalCustomField('goalCustom', GOAL_OPTS.includes(S.goalPct) ? '' : fmtPct(S.goalPct))}
    <div class="small muted" style="margin-top:10px">Meta: <b>${money(goal())}</b> por mês · Para gastar: <b>${money(spendable())}</b></div>
  </div>
  <h2>Para onde vai o que você guarda</h2>
  <div class="card">
    <div class="small muted" style="margin-bottom:4px">Defina quanto da renda vai para cada objetivo. A soma vira sua meta de sobra (${fmtPct(S.goalPct)}%).</div>
    ${pots || '<div class="empty">Nenhum destino. Toque abaixo para criar.</div>'}
    <button class="btn ghost" data-act="newpot">+ Novo destino (viagem, carro, aposentadoria…)</button>
  </div>
  <h2>Limite por categoria</h2>
  <div class="card">
    <div class="row between small" style="margin-bottom:6px"><span class="muted">Distribuído</span>
      <span class="tag ${Math.abs(diff) < 1 ? 'good' : diff > 0 ? 'info' : 'bad'}">${Math.abs(diff) < 1 ? 'Tudo certo' : diff > 0 ? `faltam distribuir ${money(diff)}` : `passou ${money(-diff)}`}</span></div>
    ${rows}
    <button class="btn ghost" data-act="auto">Redistribuir automaticamente</button>
    <button class="btn ghost" data-act="newcat" style="margin-top:10px">+ Nova categoria</button>
  </div>
  <h2>Perfil e senha</h2>
  <div class="card small muted">Perfil: <b style="color:var(--ink)">${esc(session.profile.name)}</b>. Seus dados ficam criptografados com a sua senha e
    separados dos outros perfis. O app se bloqueia sozinho depois de 5 minutos fora dele.
    <button class="btn ghost" data-act="lock">🔒 Bloquear / trocar de perfil</button>
    <button class="btn ghost" data-act="chpass" style="margin-top:10px">Mudar minha senha</button>
  </div>
  <h2>Seus dados</h2>
  <div class="card small muted">Tudo fica salvo só neste celular. Faça um backup de vez em quando —
    o arquivo de backup <b>não</b> tem senha, então guarde-o num lugar seguro.
    <button class="btn ghost" data-act="export">Baixar backup</button>
    <button class="btn ghost" data-act="import" style="margin-top:10px">Importar arquivo / restaurar backup</button>
    <button class="btn danger" data-act="reset" style="margin-top:10px">Apagar meus dados e recomeçar</button>
    <button class="btn danger" data-act="delprofile" style="margin-top:10px">Excluir meu perfil</button>
  </div>`;
}

function renderOnboarding() {
  $('#app').innerHTML = `<div class="onb">
    <div class="logo">💚</div><h1 style="font-size:28px;margin-bottom:6px">Meu Dinheiro</h1>
    <p class="muted" style="margin-top:0">Vamos montar seu plano. Diga o que entra no mês e quanto quer sobrar — o app calcula quanto pode gastar em cada área.</p>
    <div class="card">
      <label class="f" style="margin-top:0">💼 Salário</label>
      <input class="in-f num" id="oSal" inputmode="decimal" placeholder="R$ 0,00">
      <label class="f">💼 Outros valores fixos por mês (opcional)</label>
      <input class="in-f num" id="oFix" inputmode="decimal" placeholder="Pró-labore, aluguel recebido, pensão…">
      <label class="f">🎯 Meta de lucro com serviços / vendas (opcional)</label>
      <input class="in-f num" id="oVar" inputmode="decimal" placeholder="Quanto quer faturar no mês">
      <div class="small muted" style="margin-top:6px">Depois você pode separar por serviço e adicionar mais itens na aba Orçamento.</div>
      <div class="row between" style="margin-top:12px"><span class="small muted">Total previsto no mês</span><b class="num" id="oTot">R$ 0,00</b></div>
      <label class="f">Quanto quer sobrar todo mês?</label>
      <div class="chips" id="oGoal">${GOAL_OPTS.map((p) => `<button class="chip ${p === 20 ? 'on' : ''}" data-ogoal="${p}">${p}%</button>`).join('')}</div>
      ${goalCustomField('oGoalCustom', '')}
      <div class="small muted" id="oHint" style="margin-top:10px"></div>
      <button class="btn" data-act="start">Criar meu plano</button>
    </div>
    <button class="btn ghost" data-act="import" style="margin-top:4px">Importar arquivo / restaurar backup</button></div>`;
  let pct = 20;
  const vals = () => ({ sal: parseMoney($('#oSal').value), fix: parseMoney($('#oFix').value), vr: parseMoney($('#oVar').value) });
  const hint = () => {
    const { sal, fix, vr } = vals(); const v = sal + fix + vr;
    $('#oTot').textContent = money(v);
    $('#oHint').innerHTML = v > 0 ? `Você vai guardar <b>${money(v * pct / 100)}</b> e terá <b>${money(v - v * pct / 100)}</b> para gastar no mês.` : '';
  };
  ['#oSal', '#oFix', '#oVar'].forEach((s) => $(s).addEventListener('input', hint));
  $('#oGoal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ogoal]'); if (!b) return;
    pct = Number(b.dataset.ogoal);
    document.querySelectorAll('[data-ogoal]').forEach((x) => x.classList.toggle('on', x === b));
    $('#oGoalCustom').value = '';
    hint();
  });
  $('#oGoalCustom').addEventListener('input', (e) => {
    const p = parseGoal(e.target.value);
    if (p === null) return;
    pct = p;
    document.querySelectorAll('[data-ogoal]').forEach((x) => x.classList.toggle('on', Number(x.dataset.ogoal) === p));
    hint();
  });
  $('[data-act="start"]').addEventListener('click', () => {
    const { sal, fix, vr } = vals();
    if (!(sal + fix + vr > 0)) { toast('Informe seu salário, valores fixos ou meta de serviços'); $('#oSal').focus(); return; }
    S.incomes = [];
    if (sal > 0) S.incomes.push({ id: uid(), name: 'Salário', kind: 'fixo', amount: sal });
    if (fix > 0) S.incomes.push({ id: uid(), name: 'Outros valores fixos', kind: 'fixo', amount: fix });
    if (vr > 0) S.incomes.push({ id: uid(), name: 'Serviços / vendas', kind: 'variavel', amount: vr });
    syncIncome(); S.goalPct = pct; S.pots = defaultPots(pct); S.setupDone = true;
    S.categories = DEFAULT_CATS.map((c) => ({ id: uid(), ...c, budget: 0 }));
    distribute(); save(); render();
    toast('Plano criado! Toque no + para registrar gastos');
  });
}

// ---------- folha de lançamento ----------
function openSheet(html) {
  $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  $('#sheetBg').classList.add('open');
  void $('#sheet').offsetWidth; // força o navegador a aplicar a posição inicial antes da animação
  $('#sheet').classList.add('open');
}
function closeSheet() { $('#sheet').classList.remove('open'); $('#sheetBg').classList.remove('open'); }

function txSheet(id) {
  const t = id ? S.tx.find((x) => x.id === id) : null;
  let type = t ? t.type : 'out';
  let cat = t ? t.cat : null;
  // Entradas importadas guardam o nome da origem (ex.: "Feiras") até existir um item com esse nome.
  const srcOf = (s) => (S.incomes.find((i) => i.id === s || i.name === s) || { id: s || 'outros' }).id;
  let src = t ? srcOf(t.src) : (S.incomes[0] ? S.incomes[0].id : 'outros');
  const defDate = t ? t.date : (ui.month === ym(new Date()) ? today() : ui.month + '-01');
  const draw = () => {
    const chips = type === 'out'
      ? S.categories.map((c) => `<button class="chip ${cat === c.id ? 'on' : ''}" data-cat="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('')
      : [...S.incomes.map((i) => ({ id: i.id, l: `${i.kind === 'variavel' ? '🎯' : '💼'} ${i.name}` })),
        ...(src && src !== 'outros' && !S.incomes.some((i) => i.id === src) ? [{ id: src, l: `📥 ${src}` }] : []),
        { id: 'outros', l: '➕ Outra entrada' }]
        .map((s) => `<button class="chip ${src === s.id ? 'on' : ''}" data-src="${esc(s.id)}">${esc(s.l)}</button>`).join('');
    $('#txChips').innerHTML = chips;
    $('#txLbl').textContent = type === 'out' ? 'Categoria' : 'De onde veio';
    document.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === type));
  };
  openSheet(`<div class="seg"><button data-type="out">Gasto</button><button data-type="in">Entrada</button></div>
    <label class="f">Valor</label><input class="in-f money num" id="txAmt" inputmode="decimal" placeholder="R$ 0,00" value="${t ? fmtInput(t.amount) : ''}">
    <label class="f" id="txLbl">Categoria</label><div class="chips" id="txChips"></div>
    <label class="f">Descrição (opcional)</label><input class="in-f" id="txDesc" maxlength="60" placeholder="Ex.: mercado, Uber, cliente João" value="${esc(t ? t.desc : '')}">
    <label class="f">Data</label><input class="in-f" id="txDate" type="date" value="${defDate}">
    <button class="btn" id="txSave">${t ? 'Salvar alterações' : 'Adicionar'}</button>
    ${t ? '<button class="btn danger" id="txDel" style="margin-top:10px">Excluir lançamento</button>' : ''}`);
  draw();
  if (!t) $('#txAmt').focus({ preventScroll: true });
  $('#sheet').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.type) { type = b.dataset.type; draw(); }
    else if (b.dataset.cat) { cat = b.dataset.cat; draw(); }
    else if (b.dataset.src) { src = b.dataset.src; draw(); }
    else if (b.id === 'txSave') {
      const amount = parseMoney($('#txAmt').value);
      if (!(amount > 0)) { toast('Informe o valor'); return; }
      if (type === 'out' && !cat) { toast('Escolha a categoria'); return; }
      const date = $('#txDate').value || today();
      const rec = { id: t ? t.id : uid(), type, amount, date, desc: $('#txDesc').value.trim(), cat: type === 'out' ? cat : null, src: type === 'in' ? src : null };
      if (t) Object.assign(t, rec); else S.tx.push(rec);
      save(); closeSheet(); ui.month = date.slice(0, 7); render();
      if (type === 'out') {
        const st = stats(ui.month); const c = st.cats.find((x) => x.id === cat);
        toast(c && c.spent > c.budget ? `⚠️ ${c.name} passou do limite` : c ? `Restam ${money(c.left)} em ${c.name}` : 'Salvo');
      } else {
        const it = stats(ui.month).incs.find((i) => i.id === src);
        toast(it && it.kind === 'variavel' ? (it.got >= it.amount ? `🎯 Meta de ${it.name} batida!` : `${it.name}: ${money(it.got)} de ${money(it.amount)} — faltam ${money(it.missing)}`) : 'Entrada registrada');
      }
    } else if (b.id === 'txDel') {
      if (!confirm('Excluir este lançamento?')) return;
      S.tx = S.tx.filter((x) => x.id !== t.id); save(); closeSheet(); render(); toast('Lançamento excluído');
    }
  };
}

function newIncomeSheet(kind) {
  const v = kind === 'variavel';
  openSheet(`<h1 style="margin-top:0">${v ? '🎯 Novo serviço variável' : '💼 Novo valor fixo'}</h1>
    <p class="small muted" style="margin-top:0">${v ? 'Serviços, vendas ou clientes que variam no mês. Coloque quanto quer faturar — essa é sua meta de lucro.' : 'Algo que entra todo mês no mesmo valor: salário, pró-labore, aluguel recebido, pensão.'}</p>
    <label class="f">Nome</label><input class="in-f" id="niName" maxlength="30" placeholder="${v ? 'Ex.: Sites, Consultoria, Vendas Shopee' : 'Ex.: Salário, Pró-labore, Aluguel do apto'}">
    <label class="f">${v ? 'Meta de lucro no mês' : 'Valor por mês'}</label><input class="in-f money num" id="niAmt" inputmode="decimal" placeholder="R$ 0,00">
    <button class="btn" id="niSave">Adicionar</button>`);
  $('#sheet').onclick = (e) => {
    if (!e.target.closest('#niSave')) return;
    const name = $('#niName').value.trim(), amount = parseMoney($('#niAmt').value);
    if (!name) { toast('Dê um nome'); return; }
    if (!(amount > 0)) { toast('Informe o valor'); return; }
    S.incomes.push({ id: uid(), name, kind, amount });
    syncIncome(); save(); closeSheet(); render();
    toast(`Renda prevista: ${money(S.income)}. Toque em "Redistribuir" para ajustar os limites.`);
  };
}

function newPotSheet() {
  let icon = POT_ICONS[2];
  openSheet(`<h1 style="margin-top:0">Novo destino para guardar</h1>
    <label class="f">Nome</label><input class="in-f" id="npName" maxlength="30" placeholder="Ex.: Viagem, Carro novo, Aposentadoria">
    <label class="f">Ícone</label><div class="chips" id="npIcons"></div>
    <label class="f">Quanto da renda guardar por mês</label>
    <div class="chips" id="npChips">${[1, 2, 3, 5, 10, 15, 20].map((p) => `<button class="chip" data-nppct="${p}">${p}%</button>`).join('')}</div>
    <div class="row" style="margin-top:10px"><input class="in-f num" id="npPct" inputmode="decimal" placeholder="0" style="width:90px;text-align:right"><span class="muted">%</span>
      <span class="small muted grow" id="npHint" style="text-align:right"></span></div>
    <button class="btn" id="npSave">Criar destino</button>`);
  const hint = () => { $('#npHint').textContent = `= ${money(S.income * parseMoney($('#npPct').value) / 100)} por mês`; };
  const draw = () => { $('#npIcons').innerHTML = POT_ICONS.map((i) => `<button class="chip ${i === icon ? 'on' : ''}" data-ic="${i}">${i}</button>`).join(''); };
  draw(); hint();
  $('#npPct').addEventListener('input', hint);
  $('#sheet').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ic) { icon = b.dataset.ic; draw(); }
    else if (b.dataset.nppct) { $('#npPct').value = b.dataset.nppct; hint(); }
    else if (b.id === 'npSave') {
      const name = $('#npName').value.trim();
      const pct = parseMoney($('#npPct').value);
      if (!name) { toast('Dê um nome'); return; }
      if (!(pct > 0) || S.goalPct + pct > 90) { toast('Escolha um % válido'); return; }
      S.pots.push({ id: uid(), name, icon, pct: round1(pct) });
      syncGoal(); save(); closeSheet(); render();
      toast(`Meta de sobra agora: ${fmtPct(S.goalPct)}%. Toque em "Redistribuir" para ajustar os limites.`);
    }
  };
}

function newCatSheet() {
  let icon = ICONS[0], group = 'est', fixed = false;
  openSheet(`<h1 style="margin-top:0">Nova categoria</h1>
    <label class="f">Nome</label><input class="in-f" id="ncName" maxlength="30" placeholder="Ex.: Pet, Academia">
    <label class="f">Ícone</label><div class="chips" id="ncIcons"></div>
    <label class="f">Tipo</label><div class="seg" id="ncGroup"><button data-g="ess">Essencial</button><button data-g="est">Estilo de vida</button></div>
    <label class="f">Como é cobrado</label><div class="seg" id="ncFixed"><button data-fx="0">Varia no mês</button><button data-fx="1">Fixo (1x no mês)</button></div>
    <label class="f">Limite mensal</label><input class="in-f num" id="ncBud" inputmode="decimal" placeholder="R$ 0,00">
    <button class="btn" id="ncSave">Criar categoria</button>`);
  const draw = () => {
    $('#ncIcons').innerHTML = ICONS.map((i) => `<button class="chip ${i === icon ? 'on' : ''}" data-ic="${i}">${i}</button>`).join('');
    document.querySelectorAll('[data-g]').forEach((b) => b.classList.toggle('on', b.dataset.g === group));
    document.querySelectorAll('[data-fx]').forEach((b) => b.classList.toggle('on', (b.dataset.fx === '1') === fixed));
  };
  draw();
  $('#sheet').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ic) icon = b.dataset.ic;
    else if (b.dataset.g) group = b.dataset.g;
    else if (b.dataset.fx) fixed = b.dataset.fx === '1';
    else if (b.id === 'ncSave') {
      const name = $('#ncName').value.trim();
      if (!name) { toast('Dê um nome'); return; }
      S.categories.push({ id: uid(), name, icon, group, fixed, w: 3, budget: parseMoney($('#ncBud').value) || 0 });
      save(); closeSheet(); render(); toast('Categoria criada'); return;
    }
    draw();
  };
}

// ---------- utilidades ----------
function parseMoney(s) {
  s = String(s || '').replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const v = parseFloat(s);
  return isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
function fmtInput(v) { return v ? v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''; }
let toastT;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400);
}
function exportData() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `meu-dinheiro-backup-${today()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importData() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    try {
      const d = JSON.parse(await inp.files[0].text());
      // Arquivo só com lançamentos: junta aos dados atuais, sem apagar nada.
      if (d.kind === 'meu-dinheiro-lancamentos' && Array.isArray(d.tx)) {
        const novos = d.tx.filter((t) => t && t.id && t.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && !S.tx.some((x) => x.id === t.id));
        if (!novos.length) { toast('Esses lançamentos já estão no app'); return; }
        const tot = novos.reduce((a, t) => a + (t.type === 'in' ? t.amount : 0), 0);
        if (!confirm(`Adicionar ${novos.length} lançamentos${d.label ? ` (${d.label})` : ''}? Entradas somam ${money(tot)}. Nada do que já existe será apagado.`)) return;
        const firstVar = S.incomes.find((i) => i.kind === 'variavel');
        novos.forEach((t) => {
          const name = String(t.src || '').slice(0, 40);
          let src = null, desc = String(t.desc || '');
          if (t.type === 'in') {
            const it = S.incomes.find((i) => i.name.toLowerCase() === name.toLowerCase());
            // Trabalho sem item próprio conta na meta do serviço variável; o nome vai na descrição.
            if (it) src = it.id;
            else if (firstVar) { src = firstVar.id; desc = desc ? `${name} — ${desc}` : name; }
            else src = name || 'outros';
          }
          S.tx.push({ id: t.id, type: t.type === 'in' ? 'in' : 'out', amount: Math.round(t.amount * 100) / 100, date: t.date,
            desc: desc.slice(0, 60), cat: t.type === 'in' ? null : t.cat || null, src });
        });
        save(); render(); toast(`${novos.length} lançamentos adicionados`);
        return;
      }
      if (!d.categories || !Array.isArray(d.tx)) throw new Error();
      if (!confirm('Substituir os dados atuais pelo backup?')) return;
      if (!Array.isArray(d.pots)) d.pots = defaultPots(d.goalPct || 20);
      if (!Array.isArray(d.incomes)) d.incomes = d.income > 0 ? [{ id: uid(), name: 'Salário', kind: 'fixo', amount: d.income }] : [];
      if (!Array.isArray(d.books)) d.books = S.books || [];
      if (!(d.readGoal > 0)) d.readGoal = 1;
      S = d; save(); render(); toast('Backup restaurado');
    } catch (e) { toast('Arquivo de backup inválido'); }
  };
  inp.click();
}

// ---------- eventos ----------
document.addEventListener('click', (e) => {
  if (e.target.closest('#sheet')) return;
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) { ui.tab = b.dataset.tab; render(); return; }
  if (b.dataset.edit) { txSheet(b.dataset.edit); return; }
  if (b.dataset.filter) { ui.filter = b.dataset.filter; render(); return; }
  if (b.dataset.goal) { setGoalTotal(Number(b.dataset.goal)); save(); render(); toast(`Meta: sobrar ${money(goal())}. Toque em "Redistribuir" para ajustar os limites.`); return; }
  if (b.dataset.delcat) {
    const c = S.categories.find((x) => x.id === b.dataset.delcat);
    if (confirm(`Remover a categoria "${c.name}"? Os gastos já lançados nela continuam contando no total.`)) {
      S.categories = S.categories.filter((x) => x !== c); save(); render();
    }
    return;
  }
  if (b.dataset.delpot) {
    const p = S.pots.find((x) => x.id === b.dataset.delpot);
    if (confirm(`Remover o destino "${p.name}"? A meta de sobra diminui ${fmtPct(p.pct)}%.`)) {
      S.pots = S.pots.filter((x) => x !== p); syncGoal(); save(); render();
    }
    return;
  }
  if (b.dataset.delinc) {
    const i = S.incomes.find((x) => x.id === b.dataset.delinc);
    if (confirm(`Remover "${i.name}" das entradas? Os valores já lançados continuam contando.`)) {
      S.incomes = S.incomes.filter((x) => x !== i); syncIncome(); save(); render();
    }
    return;
  }
  if (b.dataset.book) { bookSheet(b.dataset.book); return; }
  if (b.dataset.readgoal) { S.readGoal = Number(b.dataset.readgoal); save(); render(); return; }
  if (b.dataset.act === 'useavg') {
    const v = S.incomes.filter((i) => i.kind === 'variavel');
    if (v.length !== 1) return;
    const val = Math.round(avgStats(ui.month).avgVar / 10) * 10;
    if (!confirm(`Mudar a meta de "${v[0].name}" para ${money(val)} por mês?`)) return;
    v[0].amount = val; syncIncome(); save(); render();
    toast(`Meta atualizada. Renda prevista: ${money(S.income)}. Toque em "Redistribuir" no Orçamento para ajustar os limites.`);
    return;
  }
  switch (b.dataset.act) {
    case 'newbook': bookFormSheet(null); break;
    case 'newpot': newPotSheet(); break;
    case 'newinc': newIncomeSheet(b.dataset.kind); break;
    case 'prev': ui.month = shiftMonth(ui.month, -1); render(); break;
    case 'next': ui.month = shiftMonth(ui.month, 1); render(); break;
    case 'add': txSheet(null); break;
    case 'auto': distribute(); save(); render(); toast('Limites redistribuídos'); break;
    case 'newcat': newCatSheet(); break;
    case 'export': exportData(); break;
    case 'import': importData(); break;
    case 'reset':
      if (confirm(`Apagar TODOS os dados do perfil ${session.profile.name} e recomeçar? Isso não pode ser desfeito. Os outros perfis não são afetados.`)) { S = blank(); save(); ui.tab = 'home'; render(); }
      break;
    case 'lock': lockApp(); break;
    case 'chpass': changePassSheet(); break;
    case 'delprofile': deleteProfileSheet(); break;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'goalCustom') {
    const p = parseGoal(e.target.value);
    if (p === null) { toast('Digite um valor entre 1 e 90%'); return; }
    setGoalTotal(p); save(); render(); toast(`Meta: sobrar ${money(goal())} (${p}%). Toque em "Redistribuir" para ajustar os limites.`);
  }
  const d = e.target.dataset || {};
  if (d.incval) {
    const i = S.incomes.find((x) => x.id === d.incval);
    i.amount = parseMoney(e.target.value); syncIncome(); save(); render();
    toast(`Renda prevista: ${money(S.income)}. Toque em "Redistribuir" para ajustar os limites.`);
  }
  if (d.bud) {
    const c = S.categories.find((x) => x.id === d.bud);
    c.budget = parseMoney(e.target.value); save(); render();
  }
  if (d.budpct) {
    const c = S.categories.find((x) => x.id === d.budpct);
    c.budget = Math.round(S.income * Math.min(100, parseMoney(e.target.value))) / 100; save(); render();
  }
  if (d.potpct || d.potval) {
    const p = S.pots.find((x) => x.id === (d.potpct || d.potval));
    const pct = d.potpct ? parseMoney(e.target.value) : pctOfIncome(parseMoney(e.target.value));
    const others = S.pots.reduce((a, x) => a + (x === p ? 0 : x.pct), 0);
    p.pct = round1(Math.max(0, Math.min(90 - others, pct)));
    syncGoal(); save(); render();
    toast(`Meta de sobra agora: ${fmtPct(S.goalPct)}% (${money(goal())}). Toque em "Redistribuir" para ajustar os limites.`);
  }
});
$('#sheetBg').addEventListener('click', closeSheet);

render();
