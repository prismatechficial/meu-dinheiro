/* Meu Dinheiro — controle de gastos, receitas e plano do mês.
   Tudo fica salvo no próprio celular (localStorage). */
'use strict';

const KEY = 'meu-dinheiro.v1';
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
const INCOME_SOURCES =['Salário', 'Clientes / vendas', 'Extra', 'Outros'];
const ICONS = ['🏠', '🛒', '🚗', '💡', '💊', '📚', '🎉', '🍔', '🛍️', '📺', '📦', '🐶', '👶', '💳', '✈️', '💼', '🎁', '⛽', '💇', '📱'];

// ---------- estado ----------
let S = load();
let ui = { tab: 'home', month: ym(new Date()), filter: 'all' };

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.categories) {
      if (!Array.isArray(s.pots)) s.pots = defaultPots(s.goalPct || 20); // dados da versão anterior
      return s;
    }
  } catch (e) { /* começa do zero */ }
  return { setupDone: false, income: 0, goalPct: 20, categories: [], pots: defaultPots(20), tx: [] };
}
function save() { localStorage.setItem(KEY, JSON.stringify(S)); }

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
  // Durante o mês usa a renda prevista enquanto o dinheiro não entrou todo.
  const incomeBase = status === 'past' ? income : Math.max(income, S.income);

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
  return { m, dim, status, elapsed, daysLeft, txs, income, spent, incomeBase, cats, projSpent,
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
    out.push({ lv: 'info', i: '💰', t: 'Registre o que entrou', x: `Ainda não há entradas neste mês. Estou usando sua renda prevista de ${money(S.income)} nos cálculos.` });
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
function render() {
  if (!S.setupDone) { renderOnboarding(); $('#tabs').innerHTML = ''; return; }
  renderTabs();
  const v = { home: viewHome, tx: viewTx, plan: viewPlan, budget: viewBudget }[ui.tab];
  $('#app').innerHTML = v();
  window.scrollTo(0, 0);
}

function monthBar() {
  return `<div class="monthbar"><button data-act="prev" aria-label="Mês anterior">‹</button>
    <strong>${monthName(ui.month)}</strong><button data-act="next" aria-label="Próximo mês">›</button></div>`;
}

function renderTabs() {
  const t = (id, ic, l) => `<button data-tab="${id}" class="${ui.tab === id ? 'on' : ''}"><span>${ic}</span>${l}</button>`;
  $('#tabs').innerHTML = t('home', '🏠', 'Início') + t('tx', '📄', 'Lançamentos') +
    `<button class="fab" data-act="add" aria-label="Novo lançamento">+</button>` +
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
    const name = t.type === 'in' ? (t.src || 'Entrada') : (c ? c.name : 'Sem categoria');
    html += `<button class="tx" data-edit="${t.id}"><div class="em" style="width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:var(--bg)">${icon}</div>
      <div class="grow"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc || name)}</div><div class="small muted">${esc(name)}</div></div>
      <div class="v num ${t.type}">${t.type === 'in' ? '+' : '−'} ${money(t.amount)}</div></button>`;
  });
  if (lastDay) html += '</div>';
  const f = (id, l) => `<button data-filter="${id}" class="${ui.filter === id ? 'on' : ''}">${l}</button>`;
  return `${monthBar()}
  <div class="kpis"><div class="card"><span class="small muted">Entradas</span><b class="num in">${money(st.income)}</b></div>
  <div class="card"><span class="small muted">Saídas</span><b class="num">${money(st.spent)}</b></div></div>
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
  return `<h1>Orçamento mensal</h1>
  <div class="card">
    <label class="f" style="margin-top:0">Quanto você ganha por mês (renda prevista)</label>
    <input class="in-f num" id="inc" inputmode="decimal" value="${fmtInput(S.income)}">
    <label class="f">Quanto quer sobrar por mês</label>
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
  <h2>Seus dados</h2>
  <div class="card small muted">Tudo fica salvo só neste celular. Faça um backup de vez em quando.
    <button class="btn ghost" data-act="export">Baixar backup</button>
    <button class="btn ghost" data-act="import" style="margin-top:10px">Restaurar backup</button>
    <button class="btn danger" data-act="reset" style="margin-top:10px">Apagar tudo e recomeçar</button>
  </div>`;
}

function renderOnboarding() {
  $('#app').innerHTML = `<div class="onb">
    <div class="logo">💚</div><h1 style="font-size:28px;margin-bottom:6px">Meu Dinheiro</h1>
    <p class="muted" style="margin-top:0">Vamos montar seu plano. Diga quanto você ganha e quanto quer sobrar — o app calcula quanto pode gastar em cada área.</p>
    <div class="card">
      <label class="f" style="margin-top:0">Quanto você ganha por mês?</label>
      <input class="in-f money num" id="oInc" inputmode="decimal" placeholder="R$ 0,00">
      <div class="small muted" style="margin-top:6px">Some salário, clientes e outras rendas. Pode ser uma média.</div>
      <label class="f">Quanto quer sobrar todo mês?</label>
      <div class="chips" id="oGoal">${GOAL_OPTS.map((p) => `<button class="chip ${p === 20 ? 'on' : ''}" data-ogoal="${p}">${p}%</button>`).join('')}</div>
      ${goalCustomField('oGoalCustom', '')}
      <div class="small muted" id="oHint" style="margin-top:10px"></div>
      <button class="btn" data-act="start">Criar meu plano</button>
    </div></div>`;
  let pct = 20;
  const hint = () => {
    const v = parseMoney($('#oInc').value);
    $('#oHint').innerHTML = v > 0 ? `Você vai guardar <b>${money(v * pct / 100)}</b> e terá <b>${money(v - v * pct / 100)}</b> para gastar no mês.` : '';
  };
  $('#oInc').addEventListener('input', hint);
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
    const v = parseMoney($('#oInc').value);
    if (!(v > 0)) { toast('Informe quanto você ganha por mês'); $('#oInc').focus(); return; }
    S.income = v; S.goalPct = pct; S.pots = defaultPots(pct); S.setupDone = true;
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
  let src = t ? t.src : INCOME_SOURCES[0];
  const defDate = t ? t.date : (ui.month === ym(new Date()) ? today() : ui.month + '-01');
  const draw = () => {
    const chips = type === 'out'
      ? S.categories.map((c) => `<button class="chip ${cat === c.id ? 'on' : ''}" data-cat="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('')
      : INCOME_SOURCES.map((s) => `<button class="chip ${src === s ? 'on' : ''}" data-src="${esc(s)}">${esc(s)}</button>`).join('');
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
      } else toast('Entrada registrada');
    } else if (b.id === 'txDel') {
      if (!confirm('Excluir este lançamento?')) return;
      S.tx = S.tx.filter((x) => x.id !== t.id); save(); closeSheet(); render(); toast('Lançamento excluído');
    }
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
      if (!d.categories || !Array.isArray(d.tx)) throw new Error();
      if (!confirm('Substituir os dados atuais pelo backup?')) return;
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
  switch (b.dataset.act) {
    case 'newpot': newPotSheet(); break;
    case 'prev': ui.month = shiftMonth(ui.month, -1); render(); break;
    case 'next': ui.month = shiftMonth(ui.month, 1); render(); break;
    case 'add': txSheet(null); break;
    case 'auto': distribute(); save(); render(); toast('Limites redistribuídos'); break;
    case 'newcat': newCatSheet(); break;
    case 'export': exportData(); break;
    case 'import': importData(); break;
    case 'reset':
      if (confirm('Apagar TODOS os dados deste app? Isso não pode ser desfeito.')) { localStorage.removeItem(KEY); S = load(); ui.tab = 'home'; render(); }
      break;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'goalCustom') {
    const p = parseGoal(e.target.value);
    if (p === null) { toast('Digite um valor entre 1 e 90%'); return; }
    setGoalTotal(p); save(); render(); toast(`Meta: sobrar ${money(goal())} (${p}%). Toque em "Redistribuir" para ajustar os limites.`);
  }
  if (e.target.id === 'inc') { S.income = parseMoney(e.target.value); save(); render(); toast('Renda atualizada. Toque em "Redistribuir" para ajustar os limites.'); }
  const d = e.target.dataset || {};
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
