const deckElement = document.getElementById("deck");
const collectionPanel = document.getElementById("collectionPanel");
const likesCountElement = document.getElementById("likesCount");
const passesCountElement = document.getElementById("passesCount");
const refreshButton = document.getElementById("refreshButton");
const tabHome = document.getElementById("tabHome");
const tabLiked = document.getElementById("tabLiked");
const tabSkipped = document.getElementById("tabSkipped");
const cardTemplate = document.getElementById("cardTemplate");

const SWIPE_THRESHOLD = 110;
const STACK_SIZE = 3;
const PREFETCH_THRESHOLD = 3;
const FETCH_BATCH_SIZE = 8;
const HISTORY_LIMIT = 250;

const tabButtons = [tabSkipped, tabHome, tabLiked];
const initialSeedFromUrl = readSeedFromUrl();

const state = {
  pool: [],
  deck: [],
  likedCards: [],
  skippedCards: [],
  busy: false,
  loading: false,
  activeTab: "home",
  seed: initialSeedFromUrl || createSeed(),
  batch: 0,
  fixedSeedMode: Boolean(initialSeedFromUrl)
};

let pointer = {
  active: false,
  startX: 0,
  startY: 0,
  deltaX: 0,
  deltaY: 0,
  pointerId: null,
  cardElement: null
};

init();

refreshButton.addEventListener("click", handleRefresh);
window.addEventListener("keydown", handleKeyControls);

for (const button of tabButtons) {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
}

async function init() {
  persistSeedToUrl(state.seed);
  updateCounters();
  setStatus("Загружаем карточки WB...");
  await topUpPool(FETCH_BATCH_SIZE);
  await refillDeck();
  renderDeck();
  setActiveTab("home", false);
  void topUpPool(FETCH_BATCH_SIZE);
}

async function handleRefresh() {
  if (state.loading) {
    return;
  }

  if (!state.fixedSeedMode) {
    state.seed = createSeed();
    persistSeedToUrl(state.seed);
  }
  state.batch = 0;
  state.pool = [];
  state.deck = [];
  setActiveTab("home", false);
  setStatus("Обновляем подборку...");
  await topUpPool(FETCH_BATCH_SIZE);
  await refillDeck();
  renderDeck();
}

async function topUpPool(targetCount) {
  if (state.loading || state.pool.length >= targetCount) {
    return;
  }

  state.loading = true;

  try {
    const knownArticles = new Set([
      ...state.pool.map((card) => card.article),
      ...state.deck.map((card) => card.article)
    ]);

    const maxRetries = 5;

    for (let retry = 0; retry < maxRetries && state.pool.length < targetCount; retry += 1) {
      const currentBatch = state.batch;
      const params = new URLSearchParams({
        count: String(targetCount),
        seed: state.seed,
        batch: String(currentBatch)
      });

      try {
        const response = await fetch(`/api/random-cards?${params.toString()}`, {
          headers: { Accept: "application/json" }
        });

        const payload = await response.json();
        state.batch += 1;

        if (!response.ok) {
          continue;
        }

        const cards = Array.isArray(payload.cards) ? payload.cards : [];
        for (const card of cards) {
          if (!knownArticles.has(card.article)) {
            knownArticles.add(card.article);
            state.pool.push(card);
          }
        }

        if (cards.length > 0) {
          break;
        }
      } catch (_error) {
        // Move to next batch even when this request failed,
        // otherwise a single bad batch can block the endless feed.
        state.batch += 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ошибка сети";
    setStatus(`Не вышло загрузить карточки: ${message}`);
  } finally {
    state.loading = false;
  }
}

async function refillDeck() {
  let emptyRefillAttempts = 0;

  while (state.deck.length < STACK_SIZE && emptyRefillAttempts < 8) {
    if (state.pool.length === 0) {
      await topUpPool(FETCH_BATCH_SIZE);
      if (state.pool.length === 0) {
        emptyRefillAttempts += 1;
        continue;
      }
    }

    const nextCard = state.pool.shift();
    if (!nextCard) {
      emptyRefillAttempts += 1;
      continue;
    }
    state.deck.push(nextCard);
    emptyRefillAttempts = 0;
  }
}

function renderDeck() {
  deckElement.innerHTML = "";

  if (state.deck.length === 0) {
    setStatus("Карточки закончились. Нажми обновление сверху.");
    return;
  }

  for (let depth = Math.min(STACK_SIZE - 1, state.deck.length - 1); depth >= 0; depth -= 1) {
    const cardData = state.deck[depth];
    const cardElement = createCardElement(cardData, depth);
    if (depth === 0) {
      wireSwipeEvents(cardElement);
    }
    deckElement.append(cardElement);
  }

  if (state.activeTab === "home") {
    const topCard = state.deck[0];
    setStatus(`Артикул ${topCard.article}`);
  }
}

function createCardElement(card, depth) {
  const fragment = cardTemplate.content.cloneNode(true);
  const cardElement = fragment.querySelector(".wb-card");

  cardElement.classList.add(`depth-${depth}`);
  if (depth === 0) {
    cardElement.classList.add("is-top");
  }

  const media = fragment.querySelector(".card-media");
  media.src = card.imageUrl;
  media.alt = card.title;
  media.onerror = () => {
    media.src = "https://images.wbstatic.net/c516x688/new/no_photo.svg";
  };

  fragment.querySelector(".profile-title").textContent = card.title;
  fragment.querySelector(".card-article").textContent = `Артикул ${card.article}`;
  fragment.querySelector(".profile-subtitle").textContent = `${card.brand} · ${card.category}`;
  fragment.querySelector(".match-badge").textContent = formatMatchBadge(card.price);

  const copyButton = fragment.querySelector(".distance-copy");
  copyButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copyArticle(card.article);
  });

  const link = fragment.querySelector(".card-link");
  link.href = card.wbUrl;

  return cardElement;
}

function wireSwipeEvents(cardElement) {
  cardElement.addEventListener("pointerdown", (event) => onPointerDown(event, cardElement));
  cardElement.addEventListener("pointermove", onPointerMove);
  cardElement.addEventListener("pointerup", onPointerUp);
  cardElement.addEventListener("pointercancel", onPointerCancel);
  cardElement.addEventListener("pointerleave", onPointerCancel);
}

function onPointerDown(event, cardElement) {
  if (state.busy || state.activeTab !== "home") {
    return;
  }
  if (event.target.closest("a, button")) {
    return;
  }

  pointer.active = true;
  pointer.startX = event.clientX;
  pointer.startY = event.clientY;
  pointer.deltaX = 0;
  pointer.deltaY = 0;
  pointer.pointerId = event.pointerId;
  pointer.cardElement = cardElement;

  cardElement.classList.add("dragging");
  cardElement.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!pointer.active || event.pointerId !== pointer.pointerId || !pointer.cardElement) {
    return;
  }

  pointer.deltaX = event.clientX - pointer.startX;
  pointer.deltaY = event.clientY - pointer.startY;
  applyDragTransform(pointer.cardElement, pointer.deltaX, pointer.deltaY);
}

function onPointerUp(event) {
  if (!pointer.active || event.pointerId !== pointer.pointerId || !pointer.cardElement) {
    return;
  }

  pointer.cardElement.releasePointerCapture(event.pointerId);
  pointer.cardElement.classList.remove("dragging");

  const { deltaX, deltaY, cardElement } = pointer;
  resetPointer();

  if (Math.abs(deltaX) > SWIPE_THRESHOLD) {
    const direction = deltaX > 0 ? "right" : "left";
    animateSwipe(cardElement, direction, deltaY);
  } else {
    resetCardPosition(cardElement);
  }
}

function onPointerCancel(event) {
  if (!pointer.active || event.pointerId !== pointer.pointerId || !pointer.cardElement) {
    return;
  }

  const cardElement = pointer.cardElement;
  resetPointer();
  resetCardPosition(cardElement);
}

function triggerSwipe(direction) {
  if (state.busy || state.deck.length === 0 || state.activeTab !== "home") {
    return;
  }

  const topCard = deckElement.querySelector(".wb-card.is-top");
  if (!topCard) {
    return;
  }

  animateSwipe(topCard, direction, 0);
}

function animateSwipe(cardElement, direction, currentOffsetY) {
  state.busy = true;
  cardElement.classList.add("swipe-away");
  const targetX = direction === "right" ? window.innerWidth * 1.25 : -window.innerWidth * 1.25;
  const rotation = direction === "right" ? 16 : -16;
  cardElement.style.transform = `translate(${targetX}px, ${currentOffsetY}px) rotate(${rotation}deg)`;
  cardElement.style.opacity = "0";

  window.setTimeout(async () => {
    await finalizeSwipe(direction);
    state.busy = false;
  }, 280);
}

async function finalizeSwipe(direction) {
  const swipedCard = state.deck[0];

  if (swipedCard) {
    if (direction === "right") {
      state.likedCards.unshift(swipedCard);
      state.likedCards = state.likedCards.slice(0, HISTORY_LIMIT);
    } else {
      state.skippedCards.unshift(swipedCard);
      state.skippedCards = state.skippedCards.slice(0, HISTORY_LIMIT);
    }
  }

  updateCounters();

  state.deck.shift();
  await refillDeck();
  renderDeck();

  if (state.pool.length <= PREFETCH_THRESHOLD) {
    void topUpPool(FETCH_BATCH_SIZE);
  }
}

function applyDragTransform(cardElement, deltaX, deltaY) {
  const rotation = deltaX * 0.05;
  const dampedY = deltaY * 0.3;
  cardElement.style.transform = `translate(${deltaX}px, ${dampedY}px) rotate(${rotation}deg)`;

  const leftBadge = cardElement.querySelector(".swipe-left");
  const rightBadge = cardElement.querySelector(".swipe-right");
  const strength = Math.min(Math.abs(deltaX) / SWIPE_THRESHOLD, 1);

  if (deltaX < 0) {
    leftBadge.style.opacity = String(strength);
    leftBadge.style.transform = `translateY(${(1 - strength) * -8}px)`;
    rightBadge.style.opacity = "0";
  } else if (deltaX > 0) {
    rightBadge.style.opacity = String(strength);
    rightBadge.style.transform = `translateY(${(1 - strength) * -8}px)`;
    leftBadge.style.opacity = "0";
  } else {
    leftBadge.style.opacity = "0";
    rightBadge.style.opacity = "0";
  }
}

function resetCardPosition(cardElement) {
  cardElement.style.transform = "";
  cardElement.style.opacity = "";
  const leftBadge = cardElement.querySelector(".swipe-left");
  const rightBadge = cardElement.querySelector(".swipe-right");
  leftBadge.style.opacity = "0";
  rightBadge.style.opacity = "0";
  leftBadge.style.transform = "";
  rightBadge.style.transform = "";
}

function resetPointer() {
  pointer = {
    active: false,
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
    pointerId: null,
    cardElement: null
  };
}

function handleKeyControls(event) {
  if (state.activeTab !== "home") {
    return;
  }
  if (event.key === "ArrowRight") {
    triggerSwipe("right");
  }
  if (event.key === "ArrowLeft") {
    triggerSwipe("left");
  }
}

function setActiveTab(tab, shouldRenderPanel = true) {
  state.activeTab = tab;

  for (const button of tabButtons) {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  }

  const isHome = tab === "home";
  deckElement.hidden = !isHome;
  collectionPanel.hidden = isHome;

  if (isHome) {
    if (state.deck[0]) {
      setStatus(`Артикул ${state.deck[0].article}`);
    } else {
      setStatus("Карточки закончились. Нажми обновление сверху.");
    }
    return;
  }

  if (shouldRenderPanel) {
    renderCollectionPanel(tab);
  }
}

function renderCollectionPanel(tab) {
  const isLiked = tab === "liked";
  const title = isLiked ? "Лайкнутые" : "Скипнутые";
  const items = isLiked ? state.likedCards : state.skippedCards;

  collectionPanel.innerHTML = "";

  const heading = document.createElement("h2");
  heading.className = "collection-header";
  heading.textContent = title;

  const subtitle = document.createElement("p");
  subtitle.className = "collection-subtitle";
  subtitle.textContent = `Всего: ${items.length}`;

  collectionPanel.append(heading, subtitle);

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "collection-empty";
    empty.textContent = isLiked
      ? "Пока нет лайкнутых карточек."
      : "Пока нет скипнутых карточек.";
    collectionPanel.append(empty);
    setStatus(`${title}: 0`);
    return;
  }

  const list = document.createElement("ul");
  list.className = "collection-list";

  for (const item of items.slice(0, 30)) {
    const li = document.createElement("li");
    li.className = "collection-item";

    const name = document.createElement("h3");
    name.textContent = item.title;

    const meta = document.createElement("p");
    meta.className = "collection-meta";
    const metaPrice = Number.isFinite(item.price) ? formatCompactPrice(item.price) : "цена на WB";
    meta.textContent = `Артикул ${item.article} · ${metaPrice}`;

    const actions = document.createElement("div");
    actions.className = "collection-actions";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "collection-copy";
    copy.textContent = "Скопировать";
    copy.addEventListener("click", () => {
      void copyArticle(item.article);
    });

    const open = document.createElement("a");
    open.className = "collection-link";
    open.href = item.wbUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Открыть";

    actions.append(copy, open);
    li.append(name, meta, actions);
    list.append(li);
  }

  collectionPanel.append(list);
  setStatus(`${title}: ${items.length}`);
}

function setStatus(text) {
  void text;
}

function updateCounters() {
  likesCountElement.textContent = formatCount(state.likedCards.length);
  passesCountElement.textContent = formatCount(state.skippedCards.length);

  if (state.activeTab === "liked" || state.activeTab === "skipped") {
    renderCollectionPanel(state.activeTab);
  }
}

function formatCount(value) {
  if (value > 99) {
    return "99+";
  }
  return String(value);
}

function formatMatchBadge(price) {
  if (!Number.isFinite(price)) {
    return "Цена на WB";
  }
  return formatCompactPrice(price);
}

function formatCompactPrice(price) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(price);
}

async function copyArticle(article) {
  const text = String(article);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement("input");
      input.value = text;
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setStatus(`Артикул ${text} скопирован`);
  } catch (_error) {
    setStatus(`Не удалось скопировать артикул ${text}`);
  }
}

function readSeedFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const seed = params.get("seed");
  if (!seed) {
    return "";
  }
  return sanitizeSeed(seed);
}

function sanitizeSeed(value) {
  const prepared = String(value).trim().slice(0, 64);
  return /^[a-zA-Z0-9_-]+$/.test(prepared) ? prepared : "";
}

function createSeed() {
  return `wb-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`;
}

function persistSeedToUrl(seed) {
  const next = sanitizeSeed(seed);
  if (!next) {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("seed", next);
  window.history.replaceState(null, "", url.toString());
}
