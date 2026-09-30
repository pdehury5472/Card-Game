// Dasa Gandia Cross-Platform Web Client
const BROKERS = [
  { host: "broker.emqx.io", port: 8084, path: "/mqtt", useSSL: true },
  { host: "broker.hivemq.com", port: 8884, path: "/mqtt", useSSL: true }
];

let currentBrokerIndex = 0;
let client = null;
let roomCode = "";
let localPlayerId = "web_" + Math.random().toString(36).substring(2, 9);
let localPlayerName = "iPhone Player";
let localSeat = "SEAT_1";
let isMyTurn = false;
let selectedBid = 0;
let highestBid = 0;

window.addEventListener('DOMContentLoaded', () => {
  setupUIEventListeners();
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room') || urlParams.get('r');
  if (roomParam) {
    document.getElementById('input-room-code').value = roomParam;
  }
  const nameParam = urlParams.get('name') || urlParams.get('player');
  if (nameParam) {
    document.getElementById('input-player-name').value = nameParam;
  }
  const seatParam = urlParams.get('seat');
  if (seatParam && ['SEAT_0', 'SEAT_1', 'SEAT_2', 'SEAT_3'].includes(seatParam)) {
    document.getElementById('select-seat').value = seatParam;
  }
});

function setupUIEventListeners() {
  document.getElementById('btn-join-room').onclick = () => {
    const code = document.getElementById('input-room-code').value.trim();
    const name = document.getElementById('input-player-name').value.trim();
    const seat = document.getElementById('select-seat').value;
    if (!code || code.length < 3) {
      alert("Please enter a valid Room Code");
      return;
    }
    roomCode = code;
    localPlayerName = name || "iPhone Player";
    localSeat = seat;
    document.getElementById('header-room-code').textContent = roomCode;
    document.getElementById('join-modal').style.display = 'none';
    connectToMqttBroker();
  };

  document.getElementById('btn-chat').onclick = () => {
    document.getElementById('chat-modal').style.display = 'flex';
  };
  document.getElementById('btn-close-chat').onclick = () => {
    document.getElementById('chat-modal').style.display = 'none';
  };
  document.getElementById('btn-rules').onclick = () => {
    document.getElementById('rules-modal').style.display = 'flex';
  };
  document.getElementById('btn-close-rules').onclick = () => {
    document.getElementById('rules-modal').style.display = 'none';
  };

  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.onclick = () => {
      sendChatMessage(btn.textContent, true);
    };
  });

  document.getElementById('btn-send-chat').onclick = () => {
    const input = document.getElementById('chat-input-text');
    const msg = input.value.trim();
    if (msg) {
      sendChatMessage(msg, false);
      input.value = '';
    }
  };

  initBidSelector();

  document.querySelectorAll('.colour-btn').forEach(btn => {
    btn.onclick = () => {
      const suit = btn.getAttribute('data-suit');
      sendTrumpSelection(suit);
      document.getElementById('colour-modal').style.display = 'none';
    };
  });
}

function connectToMqttBroker() {
  updateStatus("Connecting to Cloud Relay...", "status-connecting");
  const broker = BROKERS[currentBrokerIndex];
  const clientId = `dg_web_${localPlayerId}_${Math.floor(Math.random() * 1000)}`;

  try {
    client = new Paho.MQTT.Client(broker.host, broker.port, broker.path, clientId);
  } catch (e) {
    tryNextBroker();
    return;
  }

  client.onConnectionLost = (resp) => {
    updateStatus("Disconnected. Reconnecting...", "status-error");
    setTimeout(tryNextBroker, 2500);
  };

  client.onMessageArrived = (message) => {
    handleIncomingMqttMessage(message.payloadString);
  };

  const connectOptions = {
    useSSL: broker.useSSL,
    timeout: 5,
    keepAliveInterval: 20,
    cleanSession: true,
    onSuccess: onMqttConnected,
    onFailure: (err) => {
      tryNextBroker();
    }
  };

  client.connect(connectOptions);
}

function tryNextBroker() {
  currentBrokerIndex = (currentBrokerIndex + 1) % BROKERS.length;
  connectToMqttBroker();
}

function onMqttConnected() {
  updateStatus("🟢 Connected to Room", "status-connected");
  const topic = `dg_room_v2/${roomCode}`;
  client.subscribe(topic, { qos: 1 });

  // Send Who Is Here probe
  const probeFrame = `DG0|WHO_IS_HERE|${roomCode}|${localPlayerId}|${Date.now()}|${localPlayerName}`;
  sendRawFrame(probeFrame);

  // Send Join Action to Host
  sendAction({
    actionType: "JOIN",
    playerId: localPlayerId,
    name: localPlayerName,
    seat: localSeat,
    avatarId: 1,
    platform: "Safari_Web"
  });

  // Request sync
  setTimeout(() => {
    const reqSyncFrame = `DG0|REQ_STATE|${roomCode}|${localPlayerId}|${Date.now()}|{}`;
    sendRawFrame(reqSyncFrame);
  }, 500);
}

function sendRawFrame(frame) {
  if (!client || !client.isConnected()) return;
  const topic = `dg_room_v2/${roomCode}`;
  const msg = new Paho.MQTT.Message(frame);
  msg.destinationName = topic;
  msg.qos = 1;
  client.send(msg);
}

function sendAction(actionObj) {
  const jsonStr = JSON.stringify(actionObj);
  const msgId = "m_" + Math.random().toString(36).substring(2, 9);
  const frame = `DG0|ACTION|${roomCode}|${localPlayerId}|${msgId}|${jsonStr}`;
  sendRawFrame(frame);
}

function handleIncomingMqttMessage(payload) {
  if (!payload || !payload.startsWith("DG0|")) return;
  const parts = payload.split("|");
  if (parts.length < 6) return;

  const cmd = parts[1];
  const senderId = parts[3];
  if (senderId === localPlayerId) return;

  const body = parts.slice(5).join("|");

  switch (cmd) {
    case "STATE":
      try {
        const state = JSON.parse(body);
        applyGameState(state);
      } catch (e) {}
      break;

    case "ACTION":
      try {
        const action = JSON.parse(body);
        handleAction(action);
      } catch (e) {}
      break;

    case "CHAT":
      try {
        const chat = JSON.parse(body);
        addChatMessage(chat.senderName || "Player", chat.message || "", chat.isEmoji);
      } catch (e) {}
      break;
  }
}

function applyGameState(state) {
  if (state.roomCode && state.roomCode !== roomCode) return;

  if (state.team1Score !== undefined && state.team2Score !== undefined) {
    document.getElementById('score-t1').textContent = state.team1Score;
    document.getElementById('score-t2').textContent = state.team2Score;
  }

  if (state.trumpSuit) {
    const suitSymbols = { 'SPADES': '♠', 'HEARTS': '♥', 'DIAMONDS': '♦', 'CLUBS': '♣', 'BERANGA': '👑', 'BOARD': '🃏' };
    document.getElementById('center-trump-icon').textContent = suitSymbols[state.trumpSuit] || '♠';
    document.getElementById('center-trump-name').textContent = state.trumpSuit;
  }

  if (state.currentBid) {
    document.getElementById('center-high-bid').textContent = `${state.currentBid} Pts`;
  }

  if (state.players) {
    renderSeats(state.players, state.currentTurnSeat);
  }

  if (state.currentTrickCards) {
    renderTrickCards(state.currentTrickCards);
  }

  isMyTurn = (state.currentTurnSeat === localSeat);
  const turnInd = document.getElementById('turn-indicator');
  if (isMyTurn) {
    turnInd.textContent = "👉 YOUR TURN TO PLAY!";
    turnInd.style.color = "#00E676";
  } else {
    turnInd.textContent = `Waiting for ${state.currentTurnSeat || 'player'}...`;
    turnInd.style.color = "#81C784";
  }

  if (state.handCards) {
    renderHandCards(state.handCards, isMyTurn);
  }

  if (state.gamePhase === "BIDDING" && state.biddingSeat === localSeat) {
    showBiddingModal();
  } else {
    document.getElementById('bidding-modal').style.display = 'none';
  }

  if (state.gamePhase === "CHOOSE_COLOUR" && state.colourChooserSeat === localSeat) {
    document.getElementById('colour-modal').style.display = 'flex';
  } else {
    document.getElementById('colour-modal').style.display = 'none';
  }

  if (state.statusText) {
    document.getElementById('status-banner').textContent = state.statusText;
  }
}

function handleAction(action) {
  const type = (action.actionType || action.type || "").toUpperCase();
  if (type === "SYNC_SEATS" && action.seatPlayersJson) {
    try {
      const players = JSON.parse(action.seatPlayersJson);
      renderSeats(players, null);
    } catch (e) {}
  }
}

function renderSeats(players, turnSeat) {
  players.forEach(pl => {
    let seatDomId = "seat-bottom";
    if (pl.seat === "SEAT_1") seatDomId = "seat-right";
    if (pl.seat === "SEAT_2") seatDomId = "seat-top";
    if (pl.seat === "SEAT_3") seatDomId = "seat-left";
    if (pl.seat === localSeat) seatDomId = "seat-bottom";

    const el = document.getElementById(seatDomId);
    if (!el) return;

    el.querySelector('.seat-name').textContent = `${pl.name} (${pl.platform || 'APK'})`;
    el.querySelector('.seat-details').textContent = `Bid: ${pl.bid || 0} | Won: ${pl.tricksWon || 0}`;

    if (pl.seat === turnSeat) {
      el.classList.add('active-turn');
    } else {
      el.classList.remove('active-turn');
    }
  });
}

function renderTrickCards(trickCards) {
  const container = document.getElementById('trick-arena');
  container.innerHTML = '';
  trickCards.forEach((tc, idx) => {
    const cardEl = createCardElement(tc.card, false);
    cardEl.style.position = 'absolute';
    cardEl.style.transform = `scale(0.85) rotate(${(idx - 1.5) * 12}deg)`;
    container.appendChild(cardEl);
  });
}

function renderHandCards(cards, canPlay) {
  const container = document.getElementById('cards-container');
  if (!container) return;

  if (canPlay) {
    container.classList.add('active-turn');
  } else {
    container.classList.remove('active-turn');
  }

  container.innerHTML = '';

  cards.forEach(card => {
    const cardEl = createCardElement(card, canPlay);
    if (canPlay) {
      cardEl.onclick = () => {
        playSelectedCard(card, cardEl);
      };
    }
    container.appendChild(cardEl);
  });
}

function createCardElement(card, isPlayable) {
  const div = document.createElement('div');
  const isRed = (card.suit === 'HEARTS' || card.suit === 'DIAMONDS');
  div.className = `card-item ${isRed ? 'red' : 'black'} ${isPlayable ? 'playable-turn' : ''}`;

  const suitSymbols = { 'SPADES': '♠', 'HEARTS': '♥', 'DIAMONDS': '♦', 'CLUBS': '♣' };
  const sym = suitSymbols[card.suit] || '♠';
  const rank = (card.rank === 'TEN') ? '10' : (card.rank || 'A')[0];

  div.innerHTML = `
    <div class="card-corner corner-top">
      <span class="card-rank">${rank}</span>
      <span class="card-suit">${sym}</span>
    </div>
    <div class="card-center">
      <span>${sym}</span>
      ${card.isJoker ? `<span class="joker-crown">${card.isHeart2 ? '👑' : '⭐'}</span>` : ''}
    </div>
    <div class="card-corner corner-bottom">
      <span class="card-rank">${rank}</span>
      <span class="card-suit">${sym}</span>
    </div>
    ${card.isMainGandaCard ? `<span class="key-ganda-badge">G</span>` : ''}
  `;
  return div;
}

function playSelectedCard(card, cardEl) {
  if (!isMyTurn) return;

  const container = document.getElementById('cards-container');
  if (container) {
    container.classList.add('played');
    container.classList.remove('active-turn');
    setTimeout(() => {
      container.classList.remove('played');
    }, 350);
  }

  if (cardEl) {
    cardEl.classList.add('playing');
  }

  sendAction({
    actionType: "PLAY_CARD",
    seat: localSeat,
    card: {
      suit: card.suit,
      rank: card.rank
    }
  });

  isMyTurn = false;
  const turnInd = document.getElementById('turn-indicator');
  if (turnInd) {
    turnInd.textContent = "Played! Waiting for next player...";
  }
}

function initBidSelector() {
  const row = document.getElementById('bid-selector-row');
  row.innerHTML = '';
  for (let i = 0; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.className = `bid-opt-btn ${i === 0 ? 'active' : ''}`;
    btn.textContent = i;
    btn.onclick = () => {
      document.querySelectorAll('.bid-opt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedBid = i;
      document.getElementById('selected-bid-label').textContent = `Bid: ${i} Pts`;
    };
    row.appendChild(btn);
  }

  document.getElementById('btn-submit-bid').onclick = () => {
    sendAction({
      actionType: "SUBMIT_BID",
      seat: localSeat,
      bid: selectedBid
    });
    document.getElementById('bidding-modal').style.display = 'none';
  };
}

function showBiddingModal() {
  document.getElementById('bidding-modal').style.display = 'flex';
}

function sendTrumpSelection(suit) {
  sendAction({
    actionType: "CHOOSE_COLOUR",
    seat: localSeat,
    suit: suit
  });
}

function sendChatMessage(text, isEmoji) {
  const chatObj = {
    senderName: localPlayerName,
    message: text,
    isEmoji: isEmoji,
    seat: localSeat
  };
  const jsonStr = JSON.stringify(chatObj);
  const msgId = "c_" + Math.random().toString(36).substring(2, 9);
  const frame = `DG0|CHAT|${roomCode}|${localPlayerId}|${msgId}|${jsonStr}`;
  sendRawFrame(frame);
  addChatMessage("You", text, isEmoji);
}

function addChatMessage(sender, text, isEmoji) {
  const history = document.getElementById('chat-history');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg';
  msgDiv.innerHTML = `<span class="chat-sender">${sender}:</span> <span>${text}</span>`;
  history.appendChild(msgDiv);
  history.scrollTop = history.scrollHeight;
}

function updateStatus(text, pillClass) {
  const pill = document.getElementById('conn-pill');
  if (!pill) return;
  pill.textContent = text;
  pill.className = `status-pill ${pillClass}`;
}