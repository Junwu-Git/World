// world-engine-ui-ball.js — 悬浮球、卫星按钮、顶部状态条（自 world-engine-ui.js 拆出的自包含聚簇）
// 与主 UI 的耦合收窄为显式依赖注入：主模块加载完成后调用 init() 传入闭包别名；
// 注入前内部函数不会被调用（主 UI 对本模块的调用都发生在运行期，不在加载期）。
// 依赖面（12 项）：getEngineFace / callEngineFace / callEngineFaceAction / switchEngineFace /
//   togglePanel / setEvolvingUI / buildPanel / refresh / showToast / 引擎面注册表 /
//   ENGINE_ACTION_FAILED / isEvolving 与 _currentView 的只读 getter。
window.WORLD_ENGINE_UI_BALL = (function() {
  const evolution = window.WORLD_ENGINE_EVOLUTION;
  let _deps = null;
  function deps() {
    if (!_deps) throw new Error('[世界引擎] 悬浮球模块依赖尚未注入');
    return _deps;
  }
  let getEngineFace, callEngineFace, callEngineFaceAction, switchEngineFace, togglePanel,
      setEvolvingUI, buildPanel, refresh, showToast, _engineFaceRegistry, ENGINE_ACTION_FAILED;

  function init(d) {
    _deps = d;
    getEngineFace = d.getEngineFace;
    callEngineFace = d.callEngineFace;
    callEngineFaceAction = d.callEngineFaceAction;
    switchEngineFace = d.switchEngineFace;
    togglePanel = d.togglePanel;
    setEvolvingUI = d.setEvolvingUI;
    buildPanel = d.buildPanel;
    refresh = d.refresh;
    showToast = d.showToast;
    _engineFaceRegistry = d.engineFaceRegistry;
    ENGINE_ACTION_FAILED = d.engineActionFailed;
  }

  let inputButtonObserver = null;
  let inputButtonRetryTimer = null;
  const WE_BALL_POS_KEY = 'we-ball-pos';
  let _ballStatusTimer = null;

  function getFaceSettings() {
    const face = getEngineFace();
    return callEngineFace(face, 'getSettings', {}) || {};
  }

  function updateBallControls() {
    const ball = document.getElementById('we-input-btn');
    if (!ball) return;
    const face = getEngineFace();
    const active = Boolean(callEngineFace(face, 'isRunning', false));
    const runningLabel = String(callEngineFace(face, 'getRunningLabel', '') || '');
    const fwd = ball.querySelector('#we-sat-forward');
    const redo = ball.querySelector('#we-sat-redo');
    const abort = ball.querySelector('#we-sat-abort');
    const power = ball.querySelector('#we-sat-power');
    const engineSwitch = ball.querySelector('#we-sat-engine-switch');
    if (fwd) {
      fwd.style.display = face.showForward === true ? '' : 'none';
      fwd.classList.toggle('we-sat-off', active);
      fwd.title = face.forwardTitle || `向前推进${face.label}`;
    }
    if (redo) {
      redo.classList.toggle('we-sat-off', active);
      redo.title = `重新推演${face.label}`;
    }
    if (abort) {
      abort.classList.toggle('we-sat-off', !active);
      abort.title = active && runningLabel ? `停止${runningLabel}` : `停止${face.label}推演`;
    }
    if (power) {
      power.classList.toggle('on', getFaceSettings().engineEnabled === false);
      power.style.display = typeof face.setEnabled === 'function' ? '' : 'none';
      power.title = `开关${face.label}推演与注入`;
    }
    if (engineSwitch) {
      const targetId = face.id === 'memory' ? 'world' : 'memory';
      const target = getEngineFace(targetId);
      const targetActive = Boolean(callEngineFace(target, 'isRunning', false));
      const targetRunningLabel = String(callEngineFace(target, 'getRunningLabel', '') || '');
      engineSwitch.dataset.targetEngine = target.id;
      engineSwitch.dataset.engineRunning = targetActive ? 'true' : 'false';
      engineSwitch.classList.toggle('we-sat-target-world', target.id === 'world');
      engineSwitch.classList.toggle('we-sat-target-memory', target.id === 'memory');
      engineSwitch.classList.toggle('we-sat-engine-running', targetActive);
      engineSwitch.title = targetActive
        ? `${target.label}正在${targetRunningLabel || '推演'} · 点击切换查看`
        : `切换到${target.label}`;
      engineSwitch.setAttribute('aria-label', engineSwitch.title);
    }
    ball.classList.toggle('we-ball-evolving', active);
    ball.title = active && runningLabel
      ? `${face.label}：正在进行${runningLabel}`
      : `${face.label}：单击打开面板`;
    ball.setAttribute('aria-label', ball.title);
    if (active) ball.classList.remove('we-ball-success', 'we-ball-fail');
  }

  function syncBallFace() {
    const ball = document.getElementById('we-input-btn');
    if (!ball) return;
    const face = getEngineFace();
    for (const registered of _engineFaceRegistry.values()) {
      if (registered.ballClass) ball.classList.remove(registered.ballClass);
    }
    if (face.ballClass) ball.classList.add(face.ballClass);
    ball.dataset.engineFace = face.id;
    ball.title = `${face.label}：单击打开面板`;
    ball.setAttribute('aria-label', ball.title);
    updateBallControls();
  }

  function loadBallPos() {
    try {
      const raw = localStorage.getItem(WE_BALL_POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.left === 'number' && typeof p.top === 'number') return p;
      }
    } catch (_) {}
    return null;
  }

  function saveBallPos(left, top, tucked, side) {
    try { localStorage.setItem(WE_BALL_POS_KEY, JSON.stringify({ left, top, tucked: !!tucked, side: side || null })); } catch (_) {}
  }

  // 侧边吸附参数
  const WE_TUCK_EDGE = 28;    // 距边缘多近算「吸附」
  const WE_TUCK_HANDLE = 15;  // 缩进后露出的小条宽度
  const WE_TUCK_INSET = 8;    // 拉出后距边缘的留白

  function applyBallTuck(ball, side) {
    const vw = window.innerWidth;
    const size = ball.offsetWidth || 52;
    ball.classList.add('we-ball-tucked');
    ball.classList.toggle('we-ball-tucked-left', side === 'left');
    ball.classList.toggle('we-ball-tucked-right', side === 'right');
    ball.style.left = (side === 'left' ? (WE_TUCK_HANDLE - size) : (vw - WE_TUCK_HANDLE)) + 'px';
  }

  function untuckBall(ball) {
    const pos = loadBallPos() || {};
    const vw = window.innerWidth, vh = window.innerHeight, size = ball.offsetWidth || 52;
    let left = typeof pos.left === 'number' ? pos.left : (vw - size - 18);
    let top = typeof pos.top === 'number' ? pos.top : (vh - size - 90);
    left = Math.max(4, Math.min(left, vw - size - 4));
    top = Math.max(4, Math.min(top, vh - size - 4));
    ball.classList.remove('we-ball-tucked', 'we-ball-tucked-left', 'we-ball-tucked-right');
    ball.style.left = left + 'px';
    ball.style.top = top + 'px';
    saveBallPos(left, top, false, null);
  }

  function applyBallPos(ball) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const size = ball.offsetWidth || 52;
    let pos = loadBallPos();
    if (!pos) pos = { left: vw - size - 44, top: vh - size - 90 };
    // 钳制进可视区域，避免拖出屏幕后找不到
    pos.left = Math.max(4, Math.min(pos.left, vw - size - 4));
    pos.top = Math.max(4, Math.min(pos.top, vh - size - 4));
    ball.style.top = pos.top + 'px';
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
    if (pos.tucked && (pos.side === 'left' || pos.side === 'right')) {
      ball.style.left = pos.left + 'px';   // 记录的是「拉出后」的位置
      applyBallTuck(ball, pos.side);        // 视觉上缩到边缘
    } else {
      ball.classList.remove('we-ball-tucked', 'we-ball-tucked-left', 'we-ball-tucked-right');
      ball.style.left = pos.left + 'px';
    }
  }

  function makeBallDraggable(ball) {
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const onDown = (e) => {
      const pt = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      sx = pt.clientX; sy = pt.clientY;
      const rect = ball.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      ball.classList.add('we-ball-dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    };
    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - sx, dy = pt.clientY - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (e.cancelable) e.preventDefault();
      const size = ball.offsetWidth || 52;
      let left = Math.max(4, Math.min(ox + dx, window.innerWidth - size - 4));
      let top = Math.max(4, Math.min(oy + dy, window.innerHeight - size - 4));
      ball.style.left = left + 'px';
      ball.style.top = top + 'px';
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      ball.classList.remove('we-ball-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      if (!moved) return;
      const vw = window.innerWidth, size = ball.offsetWidth || 52;
      const left = parseFloat(ball.style.left) || 0;
      const top = parseFloat(ball.style.top) || 0;
      if (left <= WE_TUCK_EDGE) {                          // 贴左缘 → 缩进左侧
        saveBallPos(WE_TUCK_INSET, top, true, 'left');
        applyBallTuck(ball, 'left');
      } else if (left >= vw - size - WE_TUCK_EDGE) {        // 贴右缘 → 缩进右侧
        saveBallPos(vw - size - WE_TUCK_INSET, top, true, 'right');
        applyBallTuck(ball, 'right');
      } else {
        saveBallPos(left, top, false, null);
      }
    };
    ball.addEventListener('mousedown', onDown);
    ball.addEventListener('touchstart', onDown, { passive: true });
    // 点击处理：拖动后不算点击；已缩进则「拉出来」而非开面板
    ball.addEventListener('click', (e) => {
      if (moved) { e.preventDefault(); e.stopImmediatePropagation(); moved = false; return; }
      if (ball.classList.contains('we-ball-tucked')) {
        e.preventDefault(); e.stopImmediatePropagation();
        untuckBall(ball);
      }
    }, true);
  }

  function observeInputButton() {
    if (inputButtonObserver || !document.body) return;
    inputButtonObserver = new MutationObserver(() => {
      if (!document.getElementById('we-input-btn')) {
        clearTimeout(inputButtonRetryTimer);
        inputButtonRetryTimer = setTimeout(buildInputButton, 50);
      }
    });
    inputButtonObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 解析推演状态文本 → 切换地球形态 + 进度环
  function setBallState(text, isError) {
    const ball = document.getElementById('we-input-btn');
    if (!ball) return;
    const ring = ball.querySelector('.we-ball-ring');
    const badge = ball.querySelector('.we-ball-badge');
    // 悬浮球不显示状态文字（文字走屏幕顶部横幅）

    ball.classList.remove('we-ball-evolving', 'we-ball-success', 'we-ball-fail');
    clearTimeout(_ballStatusTimer);

    const count = ball.querySelector('.we-ball-count');
    const clearCount = () => {
      ball.classList.remove('we-ball-counting');
      if (count) count.textContent = '';
      if (ring) ring.style.setProperty('--we-ring-pct', '0deg');
    };

    if (/回填中/.test(text)) {
      // 批量回填：地球持续旋转 + 右下角显示「批/总」进度
      ball.classList.add('we-ball-evolving');
      if (badge) badge.textContent = '';
      const mb = /(\d+)\s*\/\s*(\d+)/.exec(text);
      if (mb && ring) {
        const cur = Number(mb[1]), total = Number(mb[2]) || 1;
        const pct = Math.max(0, Math.min(1, cur / total));
        ring.style.setProperty('--we-ring-pct', (pct * 360) + 'deg');
        ball.classList.add('we-ball-counting');
        if (count) count.textContent = `${cur}/${total}`;
      } else {
        clearCount();
      }
    } else if (/推演中/.test(text)) {
      ball.classList.add('we-ball-evolving');
      if (badge) badge.textContent = '';
      clearCount(); // 推演进行中不展示轮次计数，避免残留旧的 N/X
    } else if (isError || /失败|异常/.test(text)) {
      ball.classList.add('we-ball-fail');
      if (badge) badge.textContent = '✕';
      _ballStatusTimer = setTimeout(() => clearBallBadge(), 6000);
    } else if (/完成/.test(text)) {
      ball.classList.add('we-ball-success');
      if (badge) badge.textContent = '✓';
      clearCount(); // 推演完成 → 计数已归零，清掉进度环与数字
      _ballStatusTimer = setTimeout(() => clearBallBadge(), 4000);
    }

    // 解析「第 N/X 轮」→ 进度环 + 数字（仅未到推演的提示态才显示）
    const m = /第\s*(\d+)\s*\/\s*(\d+)\s*轮/.exec(text || '');
    if (ring && m) {
      const cur = Number(m[1]), total = Number(m[2]) || 1;
      const pct = Math.max(0, Math.min(1, cur / total));
      ring.style.setProperty('--we-ring-pct', (pct * 360) + 'deg');
      ball.classList.toggle('we-ball-counting', cur > 0 && cur < total);
      if (count) count.textContent = (cur < total) ? `${cur}/${total}` : '';
    }
  }

  function clearBallBadge() {
    const ball = document.getElementById('we-input-btn');
    if (!ball) return;
    ball.classList.remove('we-ball-success', 'we-ball-fail');
    const badge = ball.querySelector('.we-ball-badge');
    if (badge) badge.textContent = '';
  }

  // 屏幕正上方状态横幅：显示约 5s 后淡出
  let _topStatusTimer = null;
  function showTopStatus(text, isError) {
    if (!document.body || !text) return;
    let el = document.getElementById('we-top-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'we-top-status';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('we-top-status-error', !!isError);
    el.classList.add('show');
    clearTimeout(_topStatusTimer);
    _topStatusTimer = setTimeout(() => { el.classList.remove('show'); }, 5000);
  }

  // 给悬浮球的五颗卫星按钮绑事件；阻止冒泡，避免触发拖拽 / 打开面板
  function wireSatellites(ball) {
    const wire = (id, fn) => {
      const el = ball.querySelector('#' + id);
      if (!el) return;
      const stop = e => e.stopPropagation();
      el.addEventListener('mousedown', stop);
      el.addEventListener('touchstart', stop, { passive: true });
      el.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        if (el.classList.contains('we-sat-off')) return;
        fn();
      });
    };
    wire('we-sat-forward', () => {
      callEngineFaceAction(getEngineFace(), 'forward');
    });
    wire('we-sat-redo', () => {
      callEngineFaceAction(getEngineFace(), 'redo');
    });
    wire('we-sat-abort', () => {
      const face = getEngineFace();
      const done = result => { if (result !== ENGINE_ACTION_FAILED) showToast('已发送停止信号'); };
      const result = callEngineFaceAction(face, 'abort');
      if (result && typeof result.then === 'function') result.then(done);
      else done(result);
    });

    // 「插头」跟随当前球面：世界面改 world_engine_settings，记忆面改 memory_engine_settings。
    // 每个已注册引擎各自管理总开关，且不改写用户选好的推演模式与注入选项。
    //   不用 we-sat-off(wire 内会拦 we-sat-off 不可点);用 .on class 标关闭态,power 永远可点。
    wire('we-sat-power', () => {
      const face = getEngineFace();
      const turnOff = getFaceSettings().engineEnabled !== false;
      const finish = result => {
        if (result === ENGINE_ACTION_FAILED) return;
        updateBallControls();
        showToast(turnOff ? `已关闭${face.label}推演与注入` : `已开启${face.label}推演与注入`);
        if (deps().currentView() === 'settings') refresh();
      };
      const result = callEngineFaceAction(face, 'setEnabled', !turnOff);
      if (result && typeof result.then === 'function') result.then(finish);
      else finish(result);
    });
    wire('we-sat-engine-switch', () => {
      const shortcut = ball.querySelector('#we-sat-engine-switch');
      switchEngineFace(shortcut?.dataset.targetEngine || (getEngineFace().id === 'memory' ? 'world' : 'memory'));
    });
  }

  function buildInputButton() {
    if (!document.body) return;

    let btn = document.getElementById('we-input-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'we-input-btn';
      btn.type = 'button';
      btn.title = '世界引擎';
      btn.setAttribute('aria-label', '世界引擎');
      btn.className = 'we-ball';
      btn.innerHTML =
        '<span class="we-ball-orbit"></span>' +
        '<span class="we-ball-ring"></span>' +
        '<span class="we-ball-core"><span class="we-ball-globe"></span><span class="we-ball-memory"><span class="we-memory-scan"></span></span></span>' +
        '<span class="we-ball-count"></span>' +
        '<span class="we-ball-badge"></span>' +
        '<span class="we-ball-tip"></span>' +
        '<span class="we-sat we-sat-up" id="we-sat-forward" role="button" title="向前推进"><i class="fa-solid fa-forward"></i></span>' +
        '<span class="we-sat we-sat-right we-sat-off" id="we-sat-abort" role="button" title="停止推演"><i class="fa-solid fa-stop"></i></span>' +
        '<span class="we-sat we-sat-down" id="we-sat-redo" role="button" title="重新推进"><i class="fa-solid fa-rotate-right"></i></span>' +
        '<span class="we-sat we-sat-left" id="we-sat-power" role="button" title="插上=关闭推演与注入 / 拔下=开启"><i class="fa-solid fa-power-off"></i></span>' +
        '<span class="we-sat we-sat-lower-right we-sat-engine-switch" id="we-sat-engine-switch" role="button"></span>';
      btn.onclick = () => togglePanel();
      document.body.appendChild(btn);
      wireSatellites(btn);
      syncBallFace();
      applyBallPos(btn);
      makeBallDraggable(btn);
      window.addEventListener('resize', () => applyBallPos(btn));
      setEvolvingUI(deps().isEvolving() || Boolean(evolution?.isRunning?.()));
    } else if (btn.parentElement !== document.body) {
      document.body.appendChild(btn);
      applyBallPos(btn);
    }

    // 兼容旧的外部状态接口：保留隐藏元素，转发到地球状态机
    let statusIndicator = document.getElementById('we-external-status');
    if (!statusIndicator) {
      statusIndicator = document.createElement('span');
      statusIndicator.id = 'we-external-status';
      statusIndicator.style.display = 'none';
      document.body.appendChild(statusIndicator);
    }

    window.__WE_SetExternalStatus = function(text, isError) {
      const el = document.getElementById('we-external-status');
      if (el) el.textContent = text;
      setBallState(text || '', !!isError);
      // 进度类（第 N/X 轮/天、回填中 i/M）只在悬浮球上显示；其余状态走屏幕顶部横幅
      if (text && !/第\s*\d+\s*\/\s*\d+\s*[轮天]/.test(text) && !/回填中/.test(text)) {
        showTopStatus(text, !!isError);
      }
    };

    buildPanel();
    observeInputButton();
  }

  return { init, syncBallFace, updateBallControls, buildInputButton };
})();
