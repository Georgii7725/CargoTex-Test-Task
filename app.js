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
  const perL = (n) => num(n, 2) + NBSP + '₽/\u2060л';  // \u2060 — без переноса после «/»
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
    notice: null,   // подсказка вверху экрана: { kind: 'warn' | 'err', text }
    busy: false,    // идёт действие с запросом (отмена): кнопки неактивны
    confirm: false  // открыт вопрос «Отменить заказ?»
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
    sending: 'Нет связи. Заказ сохранён и уйдёт один раз, когда связь вернётся.',
    fueling: 'Нет связи. Заправка идёт на стороне АЗС — покажем, где она, как только связь вернётся.'
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
    ui.confirm = false;
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

  // Загрузка данных экрана: одна за раз для одного ключа (экран или экран + АЗС), ошибка
  // попадает в ui.error, после загрузки перерисовываем — если водитель всё ещё на этом экране.
  const loading = {};
  async function fetchFor(screen, fn, key = screen) {
    if (loading[key]) return;
    loading[key] = true;
    try {
      await fn();
      ui.error = null;
      save();
    } catch (e) {
      ui.error = e;
    }
    loading[key] = false;
    if (ui.screen === screen) render();
  }

  // Одна подписка на все кнопки: data-act — имя действия, data-arg — его аргумент.
  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled) ACTIONS[el.dataset.act](el.dataset.arg);
  });
  ACTIONS.go = go;
  ACTIONS.retry = () => { ui.error = null; render(); refresh(); };

  // Действие с запросом к серверу: пока оно идёт, кнопки неактивны, повторные нажатия ничего не делают.
  async function once(fn) {
    if (ui.busy) return;
    ui.busy = true;
    render();
    try {
      await fn();
    } finally {
      ui.busy = false;
      render();
    }
  }

  // Строка «подпись — значение» в карточках.
  const row = (label, value, cls) => `<div class="row"><span>${label}</span><b${cls ? ` class="${cls}"` : ''}>${value}</b></div>`;

  // Рейс и остаток лимита. tripAt — когда получили: по нему видно, свежий ли остаток.
  async function loadTrip() {
    S.trip = await retry('getTrip', []);
    S.tripAt = Date.now();
  }

  // ── главный экран ──
  LOADERS.home = () => fetchFor('home', loadTrip);

  SCREENS.home = () => {
    const t = S.trip;
    if (!t) return page({ title: 'Заправка в рейсе', body: waiting('Загружаем рейс…') });
    // API не отдаёт сумму в холде и историю заказов (README, расхождение 3),
    // поэтому показываем то, что можно вычислить: сколько из лимита уже недоступно.
    const used = round2(t.limitTotal - t.limitLeft);
    const left = Math.max(0, Math.min(100, (t.limitLeft / t.limitTotal) * 100));
    const o = S.order;
    const f = S.fueling;
    const holding = f && !isFinal(f);  // холд своего активного заказа показываем отдельной строкой
    return page({
      title: 'Заправка в рейсе',
      body: `
        ${o ? `
        <section class="card current">
          <div class="muted">Текущий заказ</div>
          <div class="route">${esc(o.what)}</div>
          <div class="muted">${f ? STATUS[f.status] : 'Ждём ответа АЗС'}</div>
        </section>` : ''}
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
          ${row('Потрачено и заблокировано', rub(used))}
          ${holding ? row('Из них в холде сейчас', rub(f.amountHeld)) : ''}
          <details>
            <summary>Почему доступно меньше?</summary>
            <p>Когда вы заказываете заправку, сумма заказа блокируется на лимите — это холд.
              После заправки спишут только за залитое, остальное вернётся на лимит.
              Если заправка не состоялась, холд снимут целиком.</p>
          </details>
        </section>`,
      // Пока есть незакрытый заказ, новый не начинаем — только возвращаемся к нему (README, расхождение 14).
      bottom: o
        ? '<button class="btn" data-act="toOrder">К текущему заказу</button>'
        : '<button class="btn" data-act="go" data-arg="stations">Заправиться</button>'
    });
  };

  ACTIONS.toOrder = () => go(!S.order.id ? 'sending' : isFinal(S.fueling) ? 'result' : 'fueling');

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
      .filter((s) => s.km <= 60)  // все в 60 км нужны и для подсказки «Дальше дешевле»
      .sort((a, b) => a.km - b.km);
    S.nearAt = Date.now();
  });

  SCREENS.stations = () => {
    const list = S.near && S.near.slice(0, 15);
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
  // Ответ про АЗС, от которой водитель уже ушёл к другой, не должен затереть новую.
  async function loadStation() {
    const id = S.draft.stationId;
    const st = await retry('getStation', [id]);
    if (id === S.draft.stationId) S.station = st;
  }
  LOADERS.pumps = () => fetchFor('pumps', loadStation, 'pumps:' + S.draft.stationId);
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
    // После «Поехать туда» топливо и объём уже выбраны — сохраняем их.
    // Иначе — дизель, если он есть на колонке (он первый в FUELS), а объём выбирает водитель.
    if (!p.fuels.includes(S.draft.fuel)) S.draft.fuel = sortFuels(p.fuels)[0];
    S.draft.liters = S.draft.liters || null;
    if (S.draft.liters && S.trip) S.draft.liters = clamp(S.draft.liters, bounds(station(), S.draft.fuel));
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

  // Мера из README, п. 3: переплата видна до заказа. В прототипе упрощённо — самая дешёвая АЗС
  // в 30 км от выбранной, без учёта направления: маршрута рейса в API нет, только названия городов.
  const CHEAPER_KM = 30;
  const CHEAPER_BY = 1;  // ₽/л: порог из практики диспетчера («там дешевле на рубль»)
  function cheaper(st, fuel) {
    const best = (S.near || [])
      .filter((s) => s.id !== st.id && s.prices[fuel] && km(st, s) <= CHEAPER_KM)
      .sort((a, b) => a.prices[fuel] - b.prices[fuel])[0];
    return best && st.prices[fuel] - best.prices[fuel] >= CHEAPER_BY ? best : null;
  }

  // От остатка лимита зависит максимум, поэтому на этом экране перечитываем рейс.
  // АЗС подгружаем, если пришли сюда не через выбор колонки («Заказать снова», рефрижератор).
  LOADERS.volume = () => fetchFor('volume', async () => {
    if (!station()) await loadStation();
    await loadTrip();
    if (S.draft.liters) S.draft.liters = clamp(S.draft.liters, bounds(station(), S.draft.fuel));
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
    const alt = d.here ? null : cheaper(st, d.fuel);
    const diff = alt ? round2(b.price - alt.prices[d.fuel]) : 0;
    return page({
      title: d.reefer ? 'Бак рефрижератора' : 'Сколько заливаем?',
      back: 'pumps',
      body: `
        ${d.reefer ? '<div class="note info">Второй заказ — для бака рефрижератора. Лимит общий с тягачом.</div>' : ''}
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
        ${alt ? `
        <section class="card overpay">
          <b>Дальше дешевле: ${esc(short(alt.name))}</b>
          <div class="muted">${num(Math.round(km(st, alt) * 10) / 10, 0)}&nbsp;км отсюда · ${perL(alt.prices[d.fuel])}, здесь ${perL(b.price)}</div>
          <div class="over">${L ? `Переплата ${rub(Math.round(L * diff))} за ${lit(L)}` : `Здесь дороже на ${perL(diff)}`}</div>
          <div class="two">
            <button class="btn alt" data-act="goCheaper" data-arg="${alt.id}">Поехать туда</button>
            <button class="btn alt" data-act="stayHere">Залить здесь</button>
          </div>
        </section>` : ''}
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
  // «Поехать туда»: другая АЗС, топливо и объём сохраняются, колонку выбрать на месте.
  ACTIONS.goCheaper = (id) => {
    S.draft = { stationId: id, fuel: S.draft.fuel, liters: S.draft.liters };
    save();
    go('pumps');
  };
  // «Залить здесь»: водитель решил сам — на этой АЗС карточку больше не показываем.
  ACTIONS.stayHere = () => {
    S.draft.here = true;
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
      what: `${short(st.name)} · колонка ${pumpName(st, d.pump)}${d.reefer ? ' · рефрижератор' : ''}`,
      fuelName: FUELS[d.fuel],
      limitBefore: S.trip.limitLeft  // чтобы на итоге проверить, вернулся ли холд
    };
    save();
    go('sending');  // экран с кнопкой исчезает сразу: второму нажатию некуда попасть
  };

  // Заказ, который не подтвердился за 3 минуты, сам не отправляем: водитель мог уже уехать от колонки.
  const STALE = 3 * 60 * 1000;
  const stale = (o) => !o.cancel && Date.now() - o.at > STALE;

  // Отправка. Повторяем только при потере связи и всегда с тем же clientRequestId.
  let sending = false;
  LOADERS.sending = async function send() {
    const o = S.order;
    if (sending || !o || o.id || stale(o)) return;
    sending = true;
    ui.error = null;
    render();
    let f = null;
    let err = null;
    try {
      f = await retry('startFueling', [o.req], 4);
    } catch (e) {
      err = e;
    } finally {
      sending = false;
    }
    // Отказом считаем только ошибку самого запроса: принятый сервером заказ терять нельзя.
    if (f) return accept(f);
    if (err.code !== NET) return rejected(err);  // сервер отказал: заказа нет, холда нет
    ui.error = err;                              // заказ остаётся сохранённым: дошлём, когда связь вернётся
    if (ui.screen === 'sending') render();
  };

  function accept(f) {
    const cancel = S.order.cancel;
    S.order.id = f.id;
    S.mine = (S.mine || []).concat(f.id).slice(-20);  // свои заказы: getActiveFueling видит только последний
    S.fueling = f;
    // Сервер уже заблокировал сумму заказа: показываем это сразу, не дожидаясь нового getTrip.
    if (S.trip && S.tripAt < f.createdAt) S.trip.limitLeft = round2(S.trip.limitLeft - f.amountHeld);
    save();
    if (cancel && cancellable(f)) return cancelNow();  // водитель отменил, пока не было связи
    if (isFinal(f)) return go('result');
    go('fueling', cancel ? { kind: 'warn', text: CANT_CANCEL } : null);
  }

  // Сервер отказал. Возвращаем водителя туда, где это можно исправить, и объясняем, что случилось.
  function rejected(e) {
    const req = S.order.req;
    S.order = null;
    save();
    const st = station();
    if (!st) return go('home', { kind: 'err', text: 'Заказ не принят: ' + esc(errText(e)) + '.' });
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
    let text;
    let bottom;
    if (o.cancel) {
      text = '<div class="note warn">Отменяем. Как только будет связь, проверим заказ и снимем его, если он успел дойти до АЗС.</div>';
      bottom = homeButton;
    } else if (stale(o)) {
      text = `<div class="note warn">Заказ от ${time(o.at)} так и не подтвердился. Вы всё ещё у колонки?</div>`;
      bottom = '<button class="btn" data-act="resend">Да, отправить</button><button class="btn danger" data-act="drop">Нет, отменить заказ</button>';
    } else {
      text = ui.error
        ? '<div class="note warn">Нет связи. Заказ сохранён и уйдёт один раз, как только связь вернётся. Нажимать ещё раз не нужно.</div>'
        : '<p class="muted">Отправляем на АЗС… Заказ уйдёт один раз, даже если связь моргнёт.</p>';
      bottom = (ui.error ? '<button class="btn" data-act="retry">Проверить сейчас</button>' : '') +
        '<button class="btn danger" data-act="drop">Отменить заказ</button>' + homeButton;
    }
    return page({
      title: 'Отправляем заказ',
      body: `
        <section class="card">
          <div class="muted">${esc(o.what)}</div>
          <div class="route">${o.fuelName} · ${lit(o.req.liters)}</div>
          <div class="muted">${rub(round2(o.req.liters * o.req.price))} по ${perL(o.req.price)}</div>
        </section>
        ${text}`,
      bottom
    });
  };

  ACTIONS.resend = () => {
    S.order.at = Date.now();
    save();
    refresh();
  };
  // Дошёл ли заказ до сервера, неизвестно. Поэтому не гадаем: отправляем его с тем же
  // clientRequestId — сервер вернёт уже созданный или создаст — и сразу снимаем (см. accept).
  ACTIONS.drop = () => {
    S.order.cancel = true;
    save();
    render();
    refresh();
  };

  // ── заправка ──
  const isFinal = (f) => f.status === 'completed' || f.status === 'cancelled';
  // Отменить можно только до начала налива: так работает API (README, расхождение 8).
  const cancellable = (f) => f.status === 'accepted' || f.status === 'waiting_nozzle';
  const CANT_CANCEL = 'Налив уже начался — отменить нельзя. Чтобы остановить, повесьте пистолет: спишут только за залитое.';
  const STATUS = {
    accepted: 'АЗС подтверждает заказ',
    waiting_nozzle: 'Колонка ждёт пистолет',
    fueling: 'Идёт налив',
    completed: 'Заправка завершена',
    cancelled: 'Заказ отменён'
  };

  // Колонка ждёт пистолет: со слов диспетчера «секунд сорок», в API — до 60 с (README, расхождение 9).
  // Отсчёт ведём от меньшего: лучше поторопить водителя, чем дать колонке выключиться.
  const NOZZLE_WAIT = 40;
  function nozzleLeft(f) {
    const s = Math.ceil(NOZZLE_WAIT - (Date.now() - f.createdAt) / 1000 + 3);  // ожидание начинается на 3-й секунде
    return s > 0 ? `Колонка ждёт ещё ${s} с` : 'Колонка может выключиться в любую секунду';
  }
  setInterval(() => {
    const el = document.getElementById('cd');
    if (el && S.fueling) el.textContent = nozzleLeft(S.fueling);
  }, 1000);

  // Опрос заправки: раз в 1,5 с, без связи — всё реже, до 10 с.
  // Заправка идёт на стороне АЗС и без нас: первый же ответ после обрыва покажет, где она сейчас.
  let pollTimer = null;
  let polling = false;
  let pollFails = 0;
  let pollAgain = false;  // просили обновить, пока шёл запрос (например, вернулась связь) — повторим сразу
  LOADERS.fueling = async function poll() {
    clearTimeout(pollTimer);
    if (polling) { pollAgain = true; return; }
    const was = S.fueling;
    if (!was || isFinal(was)) return;
    polling = true;
    try {
      S.fueling = await call('getFueling', was.id);
      pollFails = 0;
      save();
    } catch (e) {
      pollFails++;
      if (e.code === 'NOT_FOUND') {
        polling = false;
        S.order = null;
        S.fueling = null;
        save();
        return go('home', { kind: 'err', text: 'Заказ не найден на сервере. Если лимит заблокирован, позвоните диспетчеру.' });
      }
    }
    polling = false;
    const f = S.fueling;
    if (isFinal(f)) return go('result');
    // Перерисовываем, только если что-то изменилось: иначе кнопки пересоздавались бы под пальцем.
    const changed = f.status !== was.status || f.currentLiters !== was.currentLiters;
    if (changed && (ui.screen === 'fueling' || ui.screen === 'home')) render();
    pollTimer = setTimeout(poll, pollAgain ? 0 : Math.min(10000, 1500 * 2 ** pollFails));
    pollAgain = false;
  };

  SCREENS.fueling = () => {
    const f = S.fueling;
    const o = S.order || {};
    let state;
    if (f.status === 'accepted') {
      state = `
        <div class="state"><b>АЗС подтверждает заказ…</b><p class="muted">Обычно это несколько секунд.</p></div>`;
    } else if (f.status === 'waiting_nozzle') {
      state = `
        <div class="state">
          <b>Вставьте пистолет в бак</b>
          <p class="countdown" id="cd">${nozzleLeft(f)}</p>
          <p class="muted">Колонка включена. Не успеете — она выключится, деньги вернутся на лимит.</p>
        </div>`;
    } else {
      state = `
        <div class="state">
          <b>Идёт налив</b>
          <div class="val">${lit(f.currentLiters)}</div>
          <p class="muted">из ${lit(f.liters)} · примерно ${rub(round2(f.currentLiters * f.price))}</p>
          <div class="progress"><i style="width:${Math.min(100, (f.currentLiters / f.liters) * 100)}%"></i></div>
        </div>
        ${ui.notice ? '' : '<div class="note warn">Отменить уже нельзя. Чтобы остановить налив, повесьте пистолет — спишут только за залитое.</div>'}`;
    }
    const off = ui.busy ? ' disabled' : '';
    let bottom = homeButton;
    if (cancellable(f) && ui.confirm) {
      bottom = `
        <div class="confirm"><b>Отменить заказ?</b> Колонка выключится, ${rub(f.amountHeld)} вернутся на лимит.</div>
        <button class="btn danger" data-act="cancelYes"${off}>${ui.busy ? 'Отменяем…' : 'Да, отменить'}</button>
        <button class="btn alt" data-act="cancelNo"${off}>Нет, продолжить заправку</button>`;
    } else if (cancellable(f)) {
      bottom = `<button class="btn danger" data-act="cancelAsk"${off}>Отменить заказ</button>` + homeButton;
    }
    return page({
      title: 'Заправка',
      body: `
        <section class="card">
          <div class="muted">${esc(o.what || f.stationName)}</div>
          <div class="route">${esc(o.fuelName || f.fuelName)} · ${lit(f.liters)}</div>
          <div class="muted">Заблокировано на лимите ${rub(f.amountHeld)} — спишут только за залитое.</div>
        </section>
        ${state}`,
      bottom
    });
  };

  ACTIONS.cancelAsk = () => { ui.confirm = true; render(); };
  ACTIONS.cancelNo = () => { ui.confirm = false; render(); };
  ACTIONS.cancelYes = () => once(async () => {
    ui.confirm = false;
    await cancelNow();
  });

  async function cancelNow() {
    try {
      S.fueling = await retry('cancelFueling', [S.fueling.id], 4);
    } catch (e) {
      if (e.code === 'CANNOT_CANCEL') {
        // Пока шёл запрос, налив начался или заказ завершился: узнаём, как на самом деле.
        try { S.fueling = await retry('getFueling', [S.fueling.id]); } catch (e2) { /* покажем последнее известное */ }
        ui.notice = { kind: 'warn', text: CANT_CANCEL };
      } else {
        ui.notice = { kind: 'err', text: 'Отмена не дошла: ' + esc(errText(e)) + '. Попробуйте ещё раз.' };
      }
    }
    save();
    if (isFinal(S.fueling)) go('result');
    else if (ui.screen !== 'fueling') go('fueling', ui.notice);
  }

  // ── итог ──
  // Свой итог для каждого исхода: в макете был только успех (README, расхождение 10).
  const REASONS = {
    DRIVER_CANCELLED: ['Заказ отменён', 'Вы отменили заказ до начала налива. Деньги не списаны.'],
    PUMP_TIMEOUT: ['Колонка не дождалась пистолета', 'Колонка выключилась: пистолет нужно вставить сразу, как она включится. Деньги не списаны.'],
    STATION_NO_RESPONSE: ['АЗС не ответила', 'Заказ не дошёл до колонки. Деньги не списаны — попробуйте ещё раз или выберите другую колонку.']
  };

  // Остаток лимита после заказа берём с сервера: так видно, вернулся ли холд на самом деле
  // (по API — сразу, со слов диспетчера — «к утру», README, расхождение 4).
  LOADERS.result = () => fetchFor('result', loadTrip);

  SCREENS.result = () => {
    const f = S.fueling;
    const o = S.order || {};
    const done = f.status === 'completed';
    const spent = done ? f.factAmount : 0;
    const back = round2(f.amountHeld - spent);       // столько должно вернуться на лимит
    const fresh = S.trip && S.tripAt > f.updatedAt;  // остаток получен уже после окончания заказа
    // Остаток меньше ожидаемого — значит, часть холда ещё не вернулась.
    const held = fresh && o.limitBefore != null ? round2(o.limitBefore - spent - S.trip.limitLeft) : 0;
    const under = done && f.factLiters < f.liters;
    const [title, text] = done ? ['Заправка завершена', ''] : REASONS[f.reason] || ['Заказ отменён', ''];
    return page({
      title: 'Итог',
      body: `
        <div class="center">
          <div class="icon ${done ? 'ok' : 'warn'}">${done ? '✓' : '!'}</div>
          <div class="big">${title}</div>
          <div class="muted">${esc(o.what || f.stationName)} · ${esc(o.fuelName || f.fuelName)}</div>
          ${text ? `<p>${text}</p>` : ''}
        </div>
        <section class="card">
          ${done ? row('Залито', lit(f.factLiters) + (under ? ` из ${lit(f.liters)}` : '')) + row('Списано', rub(spent)) : ''}
          ${back > 0 ? row(held > 0.01 ? 'Вернётся на лимит' : 'Вернулось на лимит', rub(back)) : ''}
          ${row('Остаток лимита', fresh ? rub(S.trip.limitLeft) : 'обновится при связи')}
        </section>
        ${under ? `<div class="note warn">Залито меньше заказанного: бак полон или колонка остановилась. За недолитые ${lit(round2(f.liters - f.factLiters))} не списали.</div>` : ''}
        ${held > 0.01 ? `<div class="note warn">${rub(held)} пока заблокированы — АЗС подтвердит возврат позже, обычно к утру.</div>` : ''}
        ${done ? `<p class="muted">Чек АЗС пришлёт диспетчеру на почту. Номер заказа: ${esc(f.id)}.</p>` : ''}`,
      bottom: done
        ? '<button class="btn" data-act="done">На главную</button><button class="btn alt" data-act="reefer">Заправить рефрижератор</button>'
        : '<button class="btn" data-act="again">Заказать снова</button><button class="btn alt" data-act="done">На главную</button>'
    });
  };

  // Заказ закрыт. Новый можно начать с теми же АЗС и колонкой.
  function closeOrder(draft) {
    S.order = null;
    S.fueling = null;
    if (draft) S.draft = draft;
    save();
  }
  ACTIONS.done = () => {
    closeOrder();
    go('home');
  };
  ACTIONS.again = () => {
    const f = S.fueling;
    closeOrder({ stationId: f.stationId, pump: f.pump, fuel: f.fuel, liters: f.liters });
    go('volume');
  };
  // Рефрижератор — отдельный заказ после первого, лимит общий (README, расхождение 13).
  ACTIONS.reefer = () => {
    const f = S.fueling;
    closeOrder({ stationId: f.stationId, pump: f.pump, fuel: f.fuel, liters: null, reefer: true });
    go('volume');
  };

  // ── отладочная панель: index.html?debug ──
  // Для показа: выключить связь посреди заправки, выбрать исход заказа, убрать случайные сбои API, начать сначала.

  // «Вставить пистолет» в API нельзя: исход выбирается случайно при создании заказа
  // (fake-api.js, стр. 266–267). На время заказа подставляем API нужное «случайное» число.
  // Все значения больше порогов «колонка занята» (0,08), «цена изменилась» (0,25) и «ответ потерян» (0,1).
  const OUTCOMES = [['случайно', null], ['налив', 0.5], ['недолив', 0.7], ['нет пистолета', 0.85], ['АЗС молчит', 0.99]];

  function mountDebug() {
    const bar = document.createElement('div');
    bar.id = 'dbg';
    document.body.prepend(bar);
    debug.outcome = 0;
    const realStart = api.startFueling;
    api.startFueling = async (req) => {
      const forced = OUTCOMES[debug.outcome][1];
      if (forced === null) return realStart(req);
      const random = Math.random;
      Math.random = () => forced;
      try {
        return await realStart(req);
      } finally {
        Math.random = random;
      }
    };
    // «Связь: нет» переживает перезагрузку вкладки — чтобы показать запуск без связи.
    debug.offline = sessionStorage.getItem('dbg.offline') === '1';
    if (debug.offline) setOnline(false);
    const draw = () => {
      bar.innerHTML = `<b>Отладка</b>
        <button data-d="net">Связь: ${debug.offline ? 'нет' : 'есть'}</button>
        <button data-d="outcome">Исход: ${OUTCOMES[debug.outcome][0]}</button>
        <button data-d="err">Сбои API: ${api.config.networkErrors ? 'вкл' : 'выкл'}</button>
        <button data-d="reset">Сбросить всё</button>`;
    };
    bar.addEventListener('click', (e) => {
      const d = e.target.dataset.d;
      if (d === 'outcome') debug.outcome = (debug.outcome + 1) % OUTCOMES.length;
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
  // Продолжаем с того места, где остановились: перезагрузка, разряженный телефон
  // или обрыв связи не должны терять заказ и не должны создавать второй.
  function boot() {
    const o = S.order;
    if (o && !o.id) return go('sending');  // ответ на заказ не дошёл: дошлём с тем же clientRequestId
    if (o && S.fueling) return go(isFinal(S.fueling) ? 'result' : 'fueling');
    go('home');
    adopt();
  }

  // Сервер может знать о незавершённом заказе, которого нет в телефоне (данные стёрлись,
  // заказ сделан с другого телефона). Показываем его — тогда водитель не закажет второй.
  async function adopt() {
    try {
      const f = await retry('getActiveFueling', []);
      if (!f || S.order) return;
      S.order = { id: f.id, at: f.createdAt, what: f.stationName, fuelName: f.fuelName };
      S.fueling = f;
      save();
      go('fueling', { kind: 'warn', text: 'Нашёлся незавершённый заказ — продолжаем следить за ним.' });
    } catch (e) {
      /* без связи — проверим при следующем запуске */
    }
  }

  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  if (/[?&]debug/.test(location.search)) mountDebug();
  boot();
})();
