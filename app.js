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
  const NBSP = '\u00a0';  // неразрывный пробел: «₽» и «л» не уедут на новую строку
  const rub = (n) => num(n, n % 1 ? 2 : 0) + NBSP + '₽';
  const lit = (n) => num(n, 0) + NBSP + 'л';
  const perL = (n) => num(n, 2) + NBSP + '₽/л';
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
  let frozen = false;  // после «Сбросить всё» ничего не сохраняем
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    if (frozen) return;
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* без хранилища работаем в памяти */ }
  }

  // ── состояние экрана ──
  const ui = {
    screen: 'home',
    online: true,
    error: null,    // ошибка загрузки данных экрана
    notice: null    // подсказка вверху экрана: { kind: 'warn' | 'err', text }
  };

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
  const NET_TEXT = {
    sending: 'Нет связи. Заказ сохранён и уйдёт один раз, когда связь вернётся.'
  };
  function drawNet() {
    $net.hidden = ui.online;
    $net.textContent = NET_TEXT[ui.screen] ||
      'Нет связи. ' + (S.syncAt ? 'Данные на ' + time(S.syncAt) + ', обновим сами.' : 'Повторим сами.');
  }

  const ERRORS = {
    NETWORK_ERROR: 'нет связи',
    STATION_NOT_FOUND: 'АЗС не найдена',
    INVALID_REQUEST: 'в заказе не хватает данных',
    FUEL_NOT_AVAILABLE: 'на этой колонке нет такого топлива'
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
  function go(screen, notice) {
    ui.screen = screen;
    ui.error = null;
    ui.notice = notice || null;
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
      <main class="body">
        ${ui.notice ? `<div class="note ${ui.notice.kind}">${ui.notice.text}</div>` : ''}
        ${body}
      </main>
      ${bottom ? `<footer class="bar">${bottom}</footer>` : ''}`;
  }

  // Пока данных нет: «загружаем…» или ошибка с кнопкой повтора.
  function waiting(text) {
    return ui.error
      ? `<div class="note err">Не получилось: ${esc(errText(ui.error))}.</div>
         <button class="btn alt" data-act="retry">Повторить</button>`
      : `<p class="muted">${text}</p>`;
  }

  // Загрузка данных экрана: одна за раз, ошибка попадает в ui.error,
  // после загрузки перерисовываем — если водитель всё ещё на этом экране.
  const loading = {};
  async function fetchFor(screen, fn) {
    if (loading[screen]) return;
    loading[screen] = true;
    try {
      await fn();
      ui.error = null;
      save();
    } catch (e) {
      ui.error = e;
    }
    loading[screen] = false;
    if (ui.screen === screen) render();
  }

  // Одна подписка на все кнопки: data-act — имя действия, data-arg — его аргумент.
  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled) ACTIONS[el.dataset.act](el.dataset.arg);
  });
  ACTIONS.go = go;
  ACTIONS.retry = () => { ui.error = null; render(); refresh(); };

  // ── главный экран ──
  LOADERS.home = () => fetchFor('home', async () => {
    S.trip = await retry('getTrip', []);
  });

  SCREENS.home = () => {
    const t = S.trip;
    if (!t) return page({ title: 'Заправка в рейсе', body: waiting('Загружаем рейс…') });
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
  // Расстояние в км: на десятках километров хватает плоского приближения.
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180));
  // «Колесо АЗС №516 (трасса М-7, 154 км)» → «Колесо №516»: трасса и километр и так есть в адресе.
  const short = (name) => name.replace(' АЗС', '').replace(/\s*\(.*\)$/, '');
  const addr = (s) => esc(s.address).replace(/ км/g, '&nbsp;км');

  // АЗС не выбираем сами по координатам: по API водитель в 8 км от ближайшей,
  // хотя говорит, что уже стоит на ней (README, расхождение 11). Показываем ближайшие сверху.
  LOADERS.stations = () => fetchFor('stations', async () => {
    if (!S.me) S.me = await retry('getDriverLocation', []);
    const all = await retry('getStations', []);
    S.near = all
      .filter((s) => s.prices.diesel)
      .map((s) => Object.assign({}, s, { km: km(S.me, s) }))
      .filter((s) => s.km <= 60)
      .sort((a, b) => a.km - b.km)
      .slice(0, 15);
    S.nearAt = Date.now();
  });

  SCREENS.stations = () => {
    const list = S.near;
    if (!list) return page({ title: 'Где заправляемся?', back: 'home', body: waiting('Ищем АЗС рядом…') });
    const cheapest = Math.min(...list.map((s) => s.prices.diesel));
    return page({
      title: 'Где заправляемся?',
      back: 'home',
      body: `
        <p class="muted">АЗС сервиса рядом, ближайшие сверху. Цена — за литр дизеля${ui.online ? '' : ', на ' + time(S.nearAt)}.</p>
        ${list.map((s) => `
          <button class="st" data-act="station" data-arg="${s.id}">
            <b>${esc(short(s.name))}</b>
            <b>${perL(s.prices.diesel)}</b>
            <span class="muted">${addr(s)}</span>
            <span class="muted">${num(Math.round(s.km * 10) / 10, 0)}&nbsp;км</span>
            ${s.prices.diesel === cheapest ? '<span class="badge">дешевле всех рядом</span>' : ''}
          </button>`).join('')}`
    });
  };

  ACTIONS.station = (id) => {
    S.draft = { stationId: id };
    save();
    go('pumps');
  };

  // ── выбор колонки ──
  // Топливо называем одинаково для всех сетей, а название сети — мелко рядом (README, расхождение 16).
  const FUELS = {
    diesel: 'Дизель', diesel_premium: 'Дизель премиум', diesel_winter: 'Дизель зимний',
    ai92: 'АИ-92', ai95: 'АИ-95', ai100: 'АИ-100', propane: 'Пропан'
  };
  const sortFuels = (codes) => Object.keys(FUELS).filter((c) => codes.includes(c));
  // На «Колесе» колонки подписаны буквами, а API ждёт номер (README, расхождение 7).
  const LETTERS = 'АБВГДЕЖЗИК';
  const lettered = (st) => st.brand === 'Колесо';

  // Свежие данные АЗС при каждом входе: колонки и цены могли измениться.
  LOADERS.pumps = () => fetchFor('pumps', async () => {
    S.station = await retry('getStation', [S.draft.stationId]);
  });
  const station = () => (S.station && S.station.id === S.draft.stationId ? S.station : null);

  SCREENS.pumps = () => {
    const st = station();
    if (!st) return page({ title: 'У какой колонки стоите?', back: 'stations', body: waiting('Загружаем колонки…') });
    return page({
      title: 'У какой колонки стоите?',
      back: 'stations',
      body: `
        <div class="muted"><b>${esc(short(st.name))}</b> · ${addr(st)}</div>
        ${lettered(st) ? '<div class="note warn">На «Колесе» колонки подписаны буквами: А — первая, Б — вторая и так далее.</div>' : ''}
        <div class="tiles">
          ${st.pumps.map((p) => {
            const free = p.status === 'free';
            const state = free ? sortFuels(p.fuels).map((c) => FUELS[c]).join(' · ') : p.status === 'busy' ? 'занята' : 'не работает';
            return `
              <button class="tile" data-act="pump" data-arg="${p.number}"${free ? '' : ' disabled'}>
                <span class="big">${lettered(st) ? LETTERS[p.number - 1] : p.number}</span>
                ${lettered(st) ? `<span class="muted">колонка ${p.number}</span>` : ''}
                <span class="fuels">${state}</span>
                ${free && !p.fuels.includes('diesel') ? '<span class="nodiesel">нет дизеля</span>' : ''}
              </button>`;
          }).join('')}
        </div>`
    });
  };

  ACTIONS.pump = (n) => {
    const p = station().pumps.find((x) => x.number === Number(n));
    S.draft.pump = p.number;
    S.draft.fuel = sortFuels(p.fuels)[0];  // дизель, если он есть на колонке: он идёт первым в FUELS
    S.draft.liters = null;
    save();
    go('volume');
  };

  // ── топливо и объём ──
  // Объём — в литрах: их принимает API, в них ограничение АЗС, так считает водитель (README, расхождение 6).
  const pumpName = (st, n) => (lettered(st) ? `${LETTERS[n - 1]} (${n})` : String(n));

  // Сколько можно залить: меньшее из ограничения АЗС и того, на что хватит лимита (README, расхождение 5).
  function bounds(st, fuel) {
    const price = st.prices[fuel];
    const byLimit = Math.floor(S.trip.limitLeft / price);
    return { price, byLimit, min: st.litersMin, max: Math.min(st.litersMax, byLimit) };
  }
  const clamp = (v, b) => Math.max(b.min, Math.min(b.max, v));

  // От остатка лимита зависит максимум, поэтому на этом экране перечитываем рейс.
  LOADERS.volume = () => fetchFor('volume', async () => {
    S.trip = await retry('getTrip', []);
    if (S.draft.liters && station()) S.draft.liters = clamp(S.draft.liters, bounds(station(), S.draft.fuel));
  });

  SCREENS.volume = () => {
    const st = station();
    const d = S.draft;
    if (!st || !S.trip) return page({ title: 'Сколько заливаем?', back: 'pumps', body: waiting('Загружаем…') });
    const pump = st.pumps.find((p) => p.number === d.pump);
    const b = bounds(st, d.fuel);
    const L = d.liters;
    const sum = L ? round2(L * b.price) : 0;
    const byLimit = b.byLimit < st.litersMax;  // что ограничивает сильнее: лимит или АЗС
    const presets = [b.max, 100, 50].filter((v, i) => i === 0 || (v < b.max && v >= b.min));
    return page({
      title: 'Сколько заливаем?',
      back: 'pumps',
      body: `
        <div class="muted"><b>${esc(short(st.name))}</b> · колонка ${pumpName(st, pump.number)}</div>
        <div class="chips">
          ${sortFuels(pump.fuels).map((c) => {
            const own = st.fuels.find((f) => f.code === c).name;  // как топливо называет сеть
            return `
              <button class="chip${c === d.fuel ? ' on' : ''}" data-act="fuel" data-arg="${c}">
                <b>${FUELS[c]}</b>
                <span class="muted">${own === FUELS[c] ? '' : esc(own) + ' · '}${perL(st.prices[c])}</span>
              </button>`;
          }).join('')}
        </div>
        ${b.max < b.min
          ? `<div class="note err">Лимита не хватает даже на ${lit(b.min)}: доступно ${rub(S.trip.limitLeft)}.</div>`
          : `<div class="stepper">
               <button class="btn alt" data-act="step" data-arg="-10"${!L || L <= b.min ? ' disabled' : ''} aria-label="Меньше на 10 литров">−10</button>
               <div class="val">${L ? lit(L) : '—'}</div>
               <button class="btn alt" data-act="step" data-arg="10"${L >= b.max ? ' disabled' : ''} aria-label="Больше на 10 литров">+10</button>
             </div>
             <div class="presets">
               ${presets.map((v, i) => `<button class="btn alt${v === L ? ' on' : ''}" data-act="liters" data-arg="${v}">${i ? '' : 'Макс. '}${lit(v)}</button>`).join('')}
             </div>`}
        <section class="card">
          <div class="row"><span>АЗС отпускает за раз</span><b${byLimit ? '' : ' class="hl"'}>до ${lit(st.litersMax)}</b></div>
          <div class="row"><span>Лимита хватит на</span><b${byLimit ? ' class="hl"' : ''}>${lit(b.byLimit)}</b></div>
          <div class="row"><span>Цена</span><b>${perL(b.price)}</b></div>
          <div class="row"><span>Сумма</span><b>${L ? rub(sum) : '—'}</b></div>
          <p class="muted">Спишут по цене в приложении, даже если на табло она на копейку другая.
            На время заправки сумма заблокируется на лимите, а спишут только за залитое.</p>
        </section>`,
      bottom: `<button class="btn" data-act="order"${L ? '' : ' disabled'}>${L ? `Заправить ${lit(L)} · ${rub(sum)}` : 'Выберите объём'}</button>`
    });
  };

  ACTIONS.fuel = (code) => {
    S.draft.fuel = code;
    if (S.draft.liters) S.draft.liters = clamp(S.draft.liters, bounds(station(), code));
    save();
    render();
  };
  ACTIONS.step = (delta) => {
    S.draft.liters = clamp((S.draft.liters || 0) + Number(delta), bounds(station(), S.draft.fuel));
    save();
    render();
  };
  ACTIONS.liters = (v) => {
    S.draft.liters = Number(v);
    save();
    render();
  };
  // ── заказ ──
  // Заказ живёт в S.order и переживает перезагрузку:
  //   S.order без id — заказ отправлен, ответа сервера ещё нет;
  //   S.order с id   — заказ принят, его состояние — в S.fueling (последний ответ сервера).
  const newRequestId = () => 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const homeButton = '<button class="btn alt" data-act="go" data-arg="home">На главную</button>';

  ACTIONS.order = () => {
    if (S.order) return go('sending');  // заказ уже есть — второй не создаём (README, расхождение 14)
    const st = station();
    const d = S.draft;
    // clientRequestId создаём и сохраняем ДО отправки. Если ответ потеряется или страница
    // перезагрузится, повтор с тем же id вернёт уже созданный заказ, а не создаст второй.
    S.order = {
      req: { stationId: st.id, pump: d.pump, fuel: d.fuel, liters: d.liters, price: st.prices[d.fuel], clientRequestId: newRequestId() },
      at: Date.now(),
      what: `${short(st.name)} · колонка ${pumpName(st, d.pump)}`,
      fuelName: FUELS[d.fuel],
      limitBefore: S.trip.limitLeft  // чтобы на итоге проверить, вернулся ли холд
    };
    save();
    go('sending');  // экран с кнопкой исчезает сразу: второму нажатию некуда попасть
  };

  // Отправка. Повторяем только при потере связи и всегда с тем же clientRequestId.
  let sending = false;
  LOADERS.sending = async function send() {
    const o = S.order;
    if (sending || !o || o.id) return;
    sending = true;
    ui.error = null;
    render();
    try {
      accept(await retry('startFueling', [o.req], 4));
    } catch (e) {
      if (e.code === NET) ui.error = e;  // заказ остаётся сохранённым: дошлём, когда связь вернётся
      else rejected(e);                  // сервер отказал: заказа нет, холда нет
    }
    sending = false;
    if (ui.screen === 'sending') render();
  };

  function accept(f) {
    S.order.id = f.id;
    S.mine = (S.mine || []).concat(f.id).slice(-20);  // свои заказы: getActiveFueling видит только последний
    S.fueling = f;
    save();
    go('fueling');
  }

  // Сервер отказал. Возвращаем водителя туда, где это можно исправить, и объясняем, что случилось.
  function rejected(e) {
    const req = S.order.req;
    S.order = null;
    save();
    const st = station();
    const d = e.details || {};
    const fixLiters = () => { if (S.draft.liters) S.draft.liters = clamp(S.draft.liters, bounds(st, S.draft.fuel)); };
    if (e.code === 'PRICE_CHANGED') {
      // Новая цена с сервера. Подтверждение — новое нажатие «Заправить» с новой суммой.
      st.prices[req.fuel] = d.newPrice;
      st.fuels.find((f) => f.code === req.fuel).price = d.newPrice;
      fixLiters();
      return go('volume', { kind: 'warn', text: `Цена изменилась: было ${perL(d.oldPrice)}, стало ${perL(d.newPrice)}. Проверьте сумму и нажмите «Заправить» ещё раз.` });
    }
    if (e.code === 'LIMIT_EXCEEDED') {
      S.trip.limitLeft = d.available;
      fixLiters();
      return go('volume', { kind: 'warn', text: `Доступно только ${rub(d.available)} — максимум объёма пересчитан.` });
    }
    if (e.code === 'INVALID_LITERS') {
      fixLiters();
      return go('volume', { kind: 'warn', text: `АЗС принимает от ${lit(d.min)} до ${lit(d.max)} за один заказ.` });
    }
    if (e.code === 'PUMP_BUSY') {
      return go('pumps', { kind: 'warn', text: `АЗС считает колонку ${pumpName(st, req.pump)} занятой. Если вы стоите у неё — попробуйте через минуту или выберите другую.` });
    }
    go('volume', { kind: 'err', text: 'Заказ не принят: ' + esc(errText(e)) + '.' });
  }

  SCREENS.sending = () => {
    const o = S.order;
    if (!o) return page({ title: 'Заказ', body: '<p class="muted">Активного заказа нет.</p>', bottom: homeButton });
    return page({
      title: 'Отправляем заказ',
      body: `
        <section class="card">
          <div class="muted">${esc(o.what)}</div>
          <div class="route">${o.fuelName} · ${lit(o.req.liters)}</div>
          <div class="muted">${rub(round2(o.req.liters * o.req.price))} по ${perL(o.req.price)}</div>
        </section>
        ${ui.error
          ? '<div class="note warn">Нет связи. Заказ сохранён и уйдёт один раз, как только связь вернётся. Нажимать ещё раз не нужно.</div>'
          : '<p class="muted">Отправляем на АЗС… Заказ уйдёт один раз, даже если связь моргнёт.</p>'}`,
      bottom: (ui.error ? '<button class="btn" data-act="retry">Проверить сейчас</button>' : '') + homeButton
    });
  };

  // ── заправка ──
  SCREENS.fueling = () => page({
    title: 'Заправка',
    body: `<p class="muted">Заказ ${esc(S.fueling.id)}: ${esc(S.fueling.status)}. Экран в работе.</p>`
  });

  // ── отладочная панель: index.html?debug ──
  // Для показа: выключить связь посреди заправки, убрать случайные сбои API, начать сначала.
  function mountDebug() {
    const bar = document.createElement('div');
    bar.id = 'dbg';
    document.body.prepend(bar);
    // «Связь: нет» переживает перезагрузку вкладки — чтобы показать запуск без связи.
    debug.offline = sessionStorage.getItem('dbg.offline') === '1';
    if (debug.offline) setOnline(false);
    const draw = () => {
      bar.innerHTML = `<b>Отладка</b>
        <button data-d="net">Связь: ${debug.offline ? 'нет' : 'есть'}</button>
        <button data-d="err">Сбои API: ${api.config.networkErrors ? 'вкл' : 'выкл'}</button>
        <button data-d="reset">Сбросить всё</button>`;
    };
    bar.addEventListener('click', (e) => {
      const d = e.target.dataset.d;
      if (d === 'net') {
        debug.offline = !debug.offline;
        sessionStorage.setItem('dbg.offline', debug.offline ? '1' : '');
        if (debug.offline) setOnline(false); else refresh();
      }
      if (d === 'err') api.config.networkErrors = !api.config.networkErrors;
      if (d === 'reset') {
        frozen = true;
        api.reset();
        localStorage.removeItem(KEY);
        location.reload();
      }
      draw();
    });
    draw();
  }

  // ── запуск ──
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  if (/[?&]debug/.test(location.search)) mountDebug();
  go('home');
})();
