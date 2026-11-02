/*
 * Прототип «Заправка в рейсе»: сценарий водителя от главного экрана до итога.
 * Подключается после fake-api.js, без библиотек. Устройство:
 *   S       — то, что должно пережить перезагрузку и пропажу связи (localStorage);
 *   ui      — состояние экрана: что открыто, есть ли связь, какая ошибка;
 *   call()  — единственная точка обращения к FakeApi;
 *   SCREENS — экраны: функции, которые возвращают HTML;
 *   LOADERS — загрузка данных для экрана, запускается при входе на экран и при возврате связи;
 *   ACTIONS — обработчики кнопок, кнопки ссылаются на них через data-act.
 */
(function () {
  'use strict';

  const api = window.FakeApi;
  const $app = document.getElementById('app');
  const $net = document.getElementById('net');

  // ── форматирование ──
  const round2 = (n) => Math.round(n * 100) / 100;
  const num = (n, digits) => n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
  const rub = (n) => num(n, n % 1 ? 2 : 0) + ' ₽';
  const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const dateRu = (iso) => { const [, m, d] = iso.split('-'); return Number(d) + ' ' + MONTHS[m - 1]; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');

  // ── состояние, которое переживает перезагрузку ──
  const KEY = 'zapravka.app.v1';
  const S = Object.assign({
    trip: null,  // последний ответ getTrip: показываем его, пока нет связи
    syncAt: 0    // когда в последний раз получили ответ сервера
  }, load());
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* без хранилища работаем в памяти */ }
  }

  // ── состояние экрана ──
  const ui = { screen: 'home', online: true, error: null };

  // ── связь ──
  const NET = 'NETWORK_ERROR';
  const debug = { offline: false };  // переключатель «Связь: нет» в отладочной панели
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let fails = 0;         // неудачных запросов подряд: один сбой — ещё не «нет связи»
  let healTimer = null;  // пока связи нет, периодически обновляем экран

  // Все запросы идут через call(): здесь видно, есть ли связь.
  async function call(method, ...args) {
    if (debug.offline) {
      await sleep(500);
      setOnline(false);
      throw Object.assign(new Error('Нет связи'), { code: NET });
    }
    try {
      const res = await api[method](...args);
      fails = 0;
      S.syncAt = Date.now();
      setOnline(true);
      return res;
    } catch (e) {
      if (e.code === NET && ++fails >= 2) setOnline(false);
      throw e;
    }
  }

  // Повторяем только потерю связи: «колонка занята» от повтора не исчезнет.
  async function retry(method, args, tries) {
    for (let i = 1; ; i++) {
      try {
        return await call(method, ...args);
      } catch (e) {
        if (e.code !== NET || i >= (tries || 3)) throw e;
        await sleep(1000 * i);
      }
    }
  }

  function setOnline(v) {
    if (ui.online === v) return;
    ui.online = v;
    clearInterval(healTimer);
    if (!v) healTimer = setInterval(refresh, 10000);
    drawNet();
  }
  function drawNet() {
    $net.hidden = ui.online;
    $net.textContent = 'Нет связи. ' + (S.syncAt ? 'Данные на ' + time(S.syncAt) + ', обновим сами.' : 'Повторим сами.');
  }

  const ERRORS = {
    NETWORK_ERROR: 'нет связи'
  };
  const errText = (e) => ERRORS[e.code] || e.message;

  // ── экраны ──
  const SCREENS = {};
  const LOADERS = {};
  const ACTIONS = {};

  function render() {
    $app.innerHTML = SCREENS[ui.screen]();
    drawNet();
  }
  function go(screen) {
    ui.screen = screen;
    ui.error = null;
    render();
    window.scrollTo(0, 0);
    refresh();
  }
  function refresh() {
    if (LOADERS[ui.screen]) LOADERS[ui.screen]();
  }

  // Каркас экрана: заголовок, содержимое и кнопки внизу.
  function page({ title, back, body, bottom }) {
    return `
      <header class="top">
        ${back ? `<button class="back" data-act="go" data-arg="${back}" aria-label="Назад">←</button>` : ''}
        <h1>${title}</h1>
      </header>
      <main class="body">${body}</main>
      ${bottom ? `<footer class="bar">${bottom}</footer>` : ''}`;
  }

  // Одна подписка на все кнопки: data-act — имя действия, data-arg — его аргумент.
  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled) ACTIONS[el.dataset.act](el.dataset.arg);
  });
  ACTIONS.go = go;

  // ── главный экран ──
  let tripLoading = false;
  LOADERS.home = async function () {
    if (tripLoading) return;
    tripLoading = true;
    try {
      S.trip = await retry('getTrip', []);
      ui.error = null;
      save();
    } catch (e) {
      ui.error = e;
    }
    tripLoading = false;
    if (ui.screen === 'home') render();
  };

  SCREENS.home = () => {
    const t = S.trip;
    if (!t) {
      return page({
        title: 'Заправка в рейсе',
        body: ui.error
          ? `<div class="note err">Не удалось загрузить рейс: ${esc(errText(ui.error))}.</div>
             <button class="btn alt" data-act="go" data-arg="home">Повторить</button>`
          : '<p class="muted">Загружаем рейс…</p>'
      });
    }
    // API не отдаёт сумму в холде и историю заказов (README, расхождение 3),
    // поэтому показываем то, что можно вычислить: сколько из лимита уже недоступно.
    const used = round2(t.limitTotal - t.limitLeft);
    const left = Math.max(0, Math.min(100, (t.limitLeft / t.limitTotal) * 100));
    return page({
      title: 'Заправка в рейсе',
      body: `
        <section class="card">
          <div class="muted">Текущий рейс · ${dateRu(t.date)}</div>
          <div class="route">${esc(t.from)} → ${esc(t.to)}</div>
          <div class="muted">Тягач ${esc(t.truck)}</div>
        </section>
        <section class="card">
          <div class="muted">Доступно на топливо</div>
          <div class="limit">${rub(t.limitLeft)}</div>
          <div class="muted">из ${rub(t.limitTotal)} на весь рейс — туда и обратно</div>
          <div class="progress"><i style="width:${left}%"></i></div>
          <div class="row"><span>Потрачено и заблокировано</span><b>${rub(used)}</b></div>
          <details>
            <summary>Почему доступно меньше?</summary>
            <p>Когда вы заказываете заправку, сумма заказа блокируется на лимите — это холд.
              После заправки спишут только за залитое, остальное вернётся на лимит.
              Если заправка не состоялась, холд снимут целиком.</p>
          </details>
        </section>`,
      bottom: '<button class="btn" data-act="go" data-arg="stations">Заправиться</button>'
    });
  };

  // ── выбор АЗС ──
  SCREENS.stations = () => page({
    title: 'Где заправляемся?',
    back: 'home',
    body: '<p class="muted">Экран в работе.</p>'
  });

  // ── запуск ──
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  go('home');
})();
